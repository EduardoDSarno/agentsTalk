import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const DEFAULT_PORT = 4000;
// Cloud hosts such as Railway assign the port through PORT.
const PORT = Number(process.env.PORT ?? process.env.AGENT_HUB_PORT ?? DEFAULT_PORT);
// The hub owner's admin token; never put it in a repo. Teammates use personal keys instead.
const ADMIN_TOKEN = process.env.AGENT_HUB_TOKEN ?? "";
// Public Client ID of the GitHub OAuth App used for sign-in (device flow needs no secret).
const GITHUB_OAUTH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID ?? "";
const GITHUB_API = "https://api.github.com";
// GitHub permission flags that count as being on the repo's team.
const WRITE_ROLES = ["admin", "maintain", "push"];
const REPO_NAME_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const KEY_BYTES = 32;
const KEY_TTL_MS = 30 * 24 * 60 * 60_000;
const AGENT_SUFFIX = "-agent";
const LOCK_TTL_MINUTES = 20;
const LOCK_TTL_MS = LOCK_TTL_MINUTES * 60_000;
const MAX_EVENTS = 200;
const MAX_MESSAGES = 500;
const MAX_MESSAGE_CHARS = 1000;
const CHAT_READ_DEFAULT = 20;
const CHAT_READ_MAX = 100;
const RECENT_EVENTS_IN_STATUS = 10;
const HEARTBEAT_MS = 25_000;
const TASK_STATUSES = ["todo", "doing", "blocked", "done"];
// While a task is in one of these, only its owner can change it.
const OWNED_TASK_STATUSES = ["doing", "blocked"];
// Someone counts as present when the hub heard from them recently.
const ACTIVE_WINDOW_MS = 10 * 60_000;
const PRESENCE_STATUSES = ["working", "available", "away"];
const MAX_DOING_CHARS = 120;
// Routes the dashboard polls as the signed-in person; everything else comes from their agent.
const DASHBOARD_ROUTES = new Set(["/api/state", "/api/projects", "/api/me"]);
const EVERYONE = "all";
const UNKNOWN_AGENT = "unknown";
// Requests without a project (older kits) land here, so they keep working.
const DEFAULT_PROJECT = "default";
// Projects are named after GitHub repos ("owner/name"), so a slash is allowed.
const PROJECT_NAME_PATTERN = /[^a-z0-9._/-]/g;
const MENTION_PATTERN = /@([a-z0-9_-]+)/gi;
const DIR = path.dirname(fileURLToPath(import.meta.url));
// On a cloud host, point AGENT_HUB_DATA_DIR at a mounted disk so data survives redeploys.
const DATA_DIR = process.env.AGENT_HUB_DATA_DIR ?? DIR;
const DB_FILE = path.join(DATA_DIR, "agentstalk.db");
// The JSON files older versions kept; imported once into the database, then renamed.
const LEGACY_STATE_FILE = path.join(DATA_DIR, "state.json");
const LEGACY_BACKUP_FILE = `${LEGACY_STATE_FILE}.backup`;
const IMPORTED_SUFFIX = ".imported";
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const SNAPSHOT_INTERVAL_MS = 6 * 60 * 60_000;
const SNAPSHOTS_KEPT = 7;
const DB_BUSY_TIMEOUT_MS = 5000;
const DASHBOARD_FILE = path.join(DIR, "dashboard.html");

/** The open SQLite database; set by loadStore. */
let db;
/** What each project and key looked like when last written, so a save only writes what changed. */
const savedProjects = new Map();
const savedKeys = new Map();
/** Every project's chat, locks, tasks and activity, keyed by project name. */
const store = loadStore();
ensureSnapshot();
/** Open wake-up streams per project, then per agent name, used by the Claude Code channel. */
const wakeStreams = new Map();

http.createServer(handleRequest).listen(PORT, () => {
  console.log(`agentsTalk running on port ${PORT}${GITHUB_OAUTH_CLIENT_ID ? "" : " (GITHUB_OAUTH_CLIENT_ID not set: GitHub sign-in is off)"}`);
});
setInterval(sendHeartbeats, HEARTBEAT_MS);
setInterval(ensureSnapshot, SNAPSHOT_INTERVAL_MS).unref();

/**
 * Routes every HTTP request: the dashboard page, sign-in, the JSON API used by
 * hooks, channels and the dashboard, and the MCP endpoint agents connect to.
 * Callers prove who they are with a personal key in the Authorization header,
 * which fixes both their name and their project (repo), so nobody can act as
 * someone else or reach another team's repo. The admin token can still pick
 * any project and name through the query, for the hub owner.
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const branch = cleanBranch(url.searchParams.get("branch"));
  try {
    if (url.pathname === "/") return sendFile(res, DASHBOARD_FILE);
    if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, { ok: db.prepare("SELECT 1 AS ok").get().ok === 1 });
    if (req.method === "GET" && url.pathname === "/api/config") return sendJson(res, 200, { githubClientId: GITHUB_OAUTH_CLIENT_ID });
    if (req.method === "POST" && url.pathname === "/api/auth/github") return sendJson(res, 200, await signIn(await readJson(req)));
    const caller = authenticate(req);
    if (!caller) return sendJson(res, 401, { error: "Missing or unknown key. Run the agentsTalk setup in the repo to get yours." });
    if (req.method === "POST" && url.pathname === "/api/admin/revoke") {
      if (!caller.admin) throw httpError(403, "Admin access required");
      const { project: targetProject, login: targetLogin } = await readJson(req);
      if (!REPO_NAME_PATTERN.test(targetProject ?? "") || !/^[a-z0-9-]+$/i.test(targetLogin ?? "")) throw httpError(400, "Provide a GitHub repo and username");
      let revoked = 0;
      for (const [hash, record] of Object.entries(store.keys)) {
        if (record.project === cleanProject(targetProject) && record.login === cleanName(targetLogin)) { delete store.keys[hash]; revoked++; }
      }
      if (revoked) {
        saveStore();
        const streams = wakeStreams.get(cleanProject(targetProject));
        for (const name of [cleanName(targetLogin), `${cleanName(targetLogin)}${AGENT_SUFFIX}`]) {
          for (const stream of streams?.get(name) ?? []) stream.end();
        }
      }
      return sendJson(res, 200, { revoked });
    }
    const project = caller.admin ? cleanProject(url.searchParams.get("project")) : caller.project;
    // Each person acts as their agent; the dashboard asks to act as the person.
    const asHuman = url.searchParams.get("as") === "human";
    const agent = caller.admin ? cleanName(url.searchParams.get("agent")) : asHuman ? caller.login : `${caller.login}${AGENT_SUFFIX}`;
    const space = spaceFor(project);
    // The admin has no sign-in of their own, so only agents it acts as (name-agent) are recorded.
    if (caller.admin && agent.endsWith(AGENT_SUFFIX)) ensureMember(space, agent);
    // Recorded before any route answers, so even the dashboard's lightweight polls count as being present.
    const actor = DASHBOARD_ROUTES.has(url.pathname) ? (caller.admin ? undefined : caller.login) : agent;
    if (actor) touchPresence(space, actor);
    if (req.method === "GET" && url.pathname === "/api/me") return sendJson(res, 200, { login: caller.login, project, admin: caller.admin });
    if (req.method === "GET" && url.pathname === "/api/projects") return sendJson(res, 200, listProjects(caller));
    if (url.pathname === "/mcp") return await handleMcp(req, res, space, project, agent);
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, snapshot(space, project));
    if (req.method === "POST" && url.pathname === "/api/presence") {
      const body = await readJson(req);
      return sendJson(res, 200, setPresence(space, agent, body.status, body.doing));
    }
    if (req.method === "POST" && url.pathname === "/api/tasks") {
      const body = await readJson(req);
      if (typeof body.title !== "string" || !body.title.trim()) throw httpError(400, "A task needs a title");
      return sendJson(res, 200, addTask(space, agent, body.title.trim()));
    }
    const taskRoute = /^\/api\/tasks\/(\d+)$/.exec(url.pathname);
    if (req.method === "POST" && taskRoute) {
      const body = await readJson(req);
      if (!TASK_STATUSES.includes(body.status)) throw httpError(400, `status must be one of ${TASK_STATUSES.join(", ")}`);
      return sendJson(res, 200, updateTask(space, agent, Number(taskRoute[1]), body.status, body.note));
    }
    if (req.method === "GET" && url.pathname === "/api/status") return sendText(res, statusText(space, project, agent));
    if (req.method === "GET" && url.pathname === "/api/inbox") return sendText(res, formatInbox(space, agent));
    if (req.method === "GET" && url.pathname === "/api/wake") return openWakeStream(req, res, project, agent, caller.expiresAt);
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJson(req);
      return sendJson(res, 200, publicMessage(postChat(project, agent, body.text, asHuman)));
    }
    if (req.method === "POST" && url.pathname === "/api/lock") {
      const body = await readJson(req);
      return sendJson(res, 200, lockFiles(space, agent, branch, body.paths ?? [], body.reason));
    }
    if (req.method === "POST" && url.pathname === "/api/check") {
      const body = await readJson(req);
      return sendJson(res, 200, { blocked: findBlocked(space, agent, branch, body.paths ?? []) });
    }
    if (req.method === "POST" && url.pathname === "/api/unlock") {
      const body = await readJson(req);
      return sendJson(res, 200, unlockFiles(space, agent, url.searchParams.has("branch") ? branch : undefined, body.paths));
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, error.status ?? 500, { error: error?.message ?? String(error) });
  }
}

/**
 * Exchanges a GitHub sign-in for a personal agentsTalk key. GitHub is asked
 * who the person is and whether they can write to the repo; only people with
 * write access get in, so a public repo stays safe. The GitHub token is used
 * for these two checks and never stored; only a hash of the new key is kept.
 */
async function signIn({ githubToken, repo }) {
  if (!githubToken || !REPO_NAME_PATTERN.test(repo ?? "")) throw httpError(400, "Send a GitHub token and the repo as owner/name");
  const user = await githubApi("/user", githubToken);
  const repoInfo = await githubApi(`/repos/${repo}`, githubToken);
  if (!WRITE_ROLES.some((role) => repoInfo.permissions?.[role])) {
    throw httpError(403, `${user.login} can't write to ${repo} on GitHub, so they can't join its team`);
  }
  const login = cleanName(user.login);
  const project = cleanProject(repoInfo.full_name);
  const key = crypto.randomBytes(KEY_BYTES).toString("base64url");
  store.keys[hashKey(key)] = { login, project, createdAt: Date.now() };
  joinProject(spaceFor(project), login, `${login}${AGENT_SUFFIX}`);
  return { key, login, project, agent: `${login}${AGENT_SUFFIX}` };
}

/**
 * Works out who is calling from the Authorization header (or X-Agentstalk-Key,
 * which Codex's header helper uses because it can't set Authorization): a
 * personal key (person and project come from it) or the admin token.
 * Returns null for anyone else.
 */
function authenticate(req) {
  const presented = (req.headers["x-agentstalk-key"] ?? req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!presented) return null;
  if (ADMIN_TOKEN && safeEqual(presented, ADMIN_TOKEN)) return { admin: true, login: "admin" };
  const record = store.keys[hashKey(presented)];
  return record && Number.isFinite(record.createdAt) && Date.now() - record.createdAt < KEY_TTL_MS
    ? { admin: false, login: record.login, project: record.project, expiresAt: record.createdAt + KEY_TTL_MS } : null;
}

/** Calls the GitHub API as the signed-in person and returns the JSON, or fails with GitHub's reason. */
async function githubApi(route, token) {
  const response = await fetch(`${GITHUB_API}${route}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "agentsTalk" },
  });
  if (!response.ok) throw httpError(response.status === 404 ? 403 : 401, `GitHub refused ${route} (${response.status}); sign in again or check repo access`);
  return response.json();
}

/** Stores keys as hashes, so a leaked state file doesn't reveal working keys. */
function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/** Compares secrets in constant time. */
function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** An error that carries the HTTP status to answer with. */
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/**
 * Answers one MCP request. The server is stateless, so each request gets a
 * fresh MCP server bound to the calling agent and its project.
 */
async function handleMcp(req, res, space, project, agent) {
  const server = buildMcpServer(space, project, agent);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  const body = req.method === "POST" ? await readJson(req) : undefined;
  await transport.handleRequest(req, res, body);
}

/**
 * Declares the tools agents use to coordinate: see the team state, lock and
 * unlock files, manage tasks, and talk in the group chat of their project.
 */
function buildMcpServer(space, project, agent) {
  const server = new McpServer({ name: "agent-hub", version: "1.2.0" });

  server.registerTool("status", {
    description: "Call this when you start. Shows file locks, tasks, chat messages that mention you, and recent team activity.",
  }, async () => reply(statusText(space, project, agent)));

  const branchInput = z.string().optional().describe("Your current Git branch (git branch --show-current)");

  server.registerTool("lock_files", {
    description: "Lock files BEFORE editing them so teammates' agents don't edit them at the same time. Use paths relative to the repo root (e.g. src/api.ts) and pass your Git branch. Do not edit files that come back as blocked; a warning means someone changes the file on another branch, so a merge conflict is likely.",
    inputSchema: { paths: z.array(z.string()).min(1), reason: z.string().describe("What you are changing"), branch: branchInput },
  }, async ({ paths, reason, branch }) => reply(formatLockResult(lockFiles(space, agent, cleanBranch(branch), paths, reason))));

  server.registerTool("unlock_files", {
    description: "Release your locks after you have committed and pushed. Leave paths empty to release all your locks; give a branch to release only that branch's locks.",
    inputSchema: { paths: z.array(z.string()).optional(), branch: branchInput },
  }, async ({ paths, branch }) => reply(formatUnlockResult(unlockFiles(space, agent, branch === undefined ? undefined : cleanBranch(branch), paths))));

  server.registerTool("add_task", {
    description: "Add a task to the shared team board.",
    inputSchema: { title: z.string() },
  }, async ({ title }) => reply(`Added task #${addTask(space, agent, title).id}`));

  server.registerTool("update_task", {
    description: "Move a task: todo, doing, blocked (say why in the note) or done. Setting it to 'doing' claims it; a task someone else is doing or is blocked on is refused, and 'todo' releases yours.",
    inputSchema: { id: z.number().int(), status: z.enum(TASK_STATUSES), note: z.string().optional() },
  }, async ({ id, status, note }) => reply(`Task #${updateTask(space, agent, id, status, note).id} is now ${status}`));

  server.registerTool("set_status", {
    description: "Tell the team what you're doing without posting in chat: status working, available or away, plus a short 'doing' line. Shows in the dashboard's team panel. Use it for progress instead of chat.",
    inputSchema: { status: z.enum(PRESENCE_STATUSES), doing: z.string().optional() },
  }, async ({ status, doing }) => reply(`Status: ${setPresence(space, agent, status, doing).status}`));

  server.registerTool("say", {
    description: `Post one short line in the team group chat, e.g. "working on the login form". Use @name to address a teammate or their agent, @${EVERYONE} for everyone. Don't post just to acknowledge.`,
    inputSchema: { text: z.string() },
  }, async ({ text }) => reply(`Posted as #${postChat(project, agent, text).id}`));

  server.registerTool("read_chat", {
    description: "Read the latest group chat messages. Only use when you need more context than the messages that mention you.",
    inputSchema: { limit: z.number().int().min(1).max(CHAT_READ_MAX).optional() },
  }, async ({ limit }) => reply(formatChat(space.messages.slice(-(limit ?? CHAT_READ_DEFAULT)))));

  return server;
}

/**
 * Adds a chat message to a project, records who it mentions, and wakes any
 * mentioned Claude Code sessions in that project. Only humans' messages wake
 * agents, so two agents can't keep waking each other and burn tokens in a loop.
 */
function postChat(project, from, text, fromHuman = false) {
  const space = spaceFor(project);
  const clean = String(text ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!clean) throw new Error("Message is empty");
  const mentions = [...new Set([...clean.matchAll(MENTION_PATTERN)].map((match) => match[1].toLowerCase()))];
  const message = { id: space.nextMessageId++, at: Date.now(), from, text: clean, mentions, fromHuman, readBy: [] };
  space.messages.push(message);
  space.messages = space.messages.slice(-MAX_MESSAGES);
  saveStore();
  deliverWakeUps(project);
  return message;
}

/**
 * Returns the chat messages addressed to this agent (by name or @all) that it
 * hasn't received yet, and marks them received. Agents only ever get these,
 * never the whole chat, which keeps their token use low.
 */
function takeMentions(space, agent, humanOnly = false) {
  const fresh = space.messages.filter((m) =>
    m.from !== agent
    && !m.readBy.includes(agent)
    && (m.mentions.includes(agent) || m.mentions.includes(EVERYONE))
    && (!humanOnly || m.fromHuman));
  for (const message of fresh) message.readBy.push(agent);
  if (fresh.length) saveStore();
  return fresh;
}

/** Keeps a stream open for a Claude Code channel and sends any waiting mentions. */
function openWakeStream(req, res, project, agent, expiresAt) {
  res.agentsTalkExpiresAt = expiresAt;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(": connected\n\n");
  if (!wakeStreams.has(project)) wakeStreams.set(project, new Map());
  const agents = wakeStreams.get(project);
  if (!agents.has(agent)) agents.set(agent, new Set());
  agents.get(agent).add(res);
  req.on("close", () => agents.get(agent)?.delete(res));
  deliverWakeUps(project);
}

/** Pushes new human mentions to every connected channel in the project whose agent is mentioned. */
function deliverWakeUps(project) {
  const space = spaceFor(project);
  for (const [agent, streams] of wakeStreams.get(project) ?? []) {
    for (const stream of streams) {
      if (stream.agentsTalkExpiresAt && Date.now() >= stream.agentsTalkExpiresAt) { streams.delete(stream); stream.end(); }
    }
    if (!streams.size) continue;
    const mentions = takeMentions(space, agent, true);
    if (!mentions.length) continue;
    const data = `data: ${JSON.stringify(mentions.map(publicMessage))}\n\n`;
    for (const res of streams) res.write(data);
  }
}

/**
 * Locks each requested file for the agent on its branch. Another agent's
 * lock on the same branch blocks it, since both would overwrite each other.
 * Locks on other branches don't block, because that work only meets at
 * merge time; instead both agents get a one-time warning that a merge
 * conflict is likely. Re-locking your own file extends its expiry, which
 * keeps a lock alive while you keep editing.
 */
function lockFiles(space, agent, branch, paths, reason = "") {
  pruneExpiredLocks(space);
  const granted = [];
  const blocked = [];
  const warnings = [];
  for (const raw of paths) {
    const file = normalizePath(raw);
    const byBranch = (space.locks[file] ??= Object.create(null));
    const lock = byBranch[branch];
    const conflict = Object.entries(byBranch).find(([otherBranch, other]) => other.owner !== agent && (otherBranch === branch || !branch || !otherBranch));
    if (conflict) {
      blocked.push({ path: file, owner: conflict[1].owner, reason: conflict[1].reason, branch: conflict[0] });
      continue;
    }
    if (!lock) {
      logEvent(space, agent, `locked ${file}${reason ? ` (${reason})` : ""}`, branch);
      for (const [otherBranch, other] of Object.entries(byBranch)) {
        if (other.owner === agent) continue;
        warnings.push({ path: file, owner: other.owner, branch: otherBranch });
        addNotice(space, other.owner, `${agent} started changing ${file} on ${branchLabel(branch)} while you change it on ${branchLabel(otherBranch)}. Expect a merge conflict; coordinate in the chat.`);
      }
    }
    byBranch[branch] = { owner: agent, reason: reason || lock?.reason || "", expiresAt: Date.now() + LOCK_TTL_MS };
    granted.push(file);
  }
  for (const w of warnings) addNotice(space, agent, `${w.owner} is also changing ${w.path} on ${branchLabel(w.branch)}. Expect a merge conflict; coordinate in the chat.`);
  saveStore();
  return { granted, blocked, warnings };
}

/**
 * Lists which of these files another agent has locked on the same branch,
 * without locking anything. The Git pre-commit check uses it to refuse such
 * commits; locks on other branches don't count.
 */
function findBlocked(space, agent, branch, paths) {
  pruneExpiredLocks(space);
  return paths.map(normalizePath)
    .map((file) => ({ file, lock: Object.entries(space.locks[file] ?? {}).find(([otherBranch, lock]) => lock.owner !== agent && (otherBranch === branch || !branch || !otherBranch))?.[1] }))
    .filter(({ lock }) => lock && lock.owner !== agent)
    .map(({ file, lock }) => ({ path: file, owner: lock.owner, reason: lock.reason, branch }));
}

/**
 * Releases the agent's own locks: the listed files, or all of them when no
 * list is given, on one branch or, without a branch, on every branch.
 * Locks held by others are reported, never removed.
 */
function unlockFiles(space, agent, branch, paths) {
  const files = paths?.length ? paths.map(normalizePath) : Object.keys(space.locks);
  const released = [];
  const notYours = [];
  for (const file of files) {
    for (const [lockBranch, lock] of Object.entries(space.locks[file] ?? {})) {
      if (branch !== undefined && lockBranch !== branch) continue;
      if (lock.owner !== agent) {
        if (paths?.length) notYours.push(file);
        continue;
      }
      delete space.locks[file][lockBranch];
      released.push(file);
    }
    if (space.locks[file] && !Object.keys(space.locks[file]).length) delete space.locks[file];
  }
  if (released.length) logEvent(space, agent, `unlocked ${[...new Set(released)].join(", ")}`, branch ?? "");
  saveStore();
  return { released: [...new Set(released)], notYours: [...new Set(notYours)] };
}

/** Queues a short message for an agent, delivered with its next inbox check. */
function addNotice(space, agent, text) {
  (space.notices[agent] ??= []).push(text);
}

/** Returns and clears the agent's queued notices. */
function takeNotices(space, agent) {
  const notices = space.notices[agent] ?? [];
  delete space.notices[agent];
  if (notices.length) saveStore();
  return notices;
}

/**
 * Records a person and their agent as members of the project. The setup
 * script calls it with the person's GitHub name, and the dashboard builds
 * its team list and @mention suggestions from these members.
 */
function joinProject(space, human, agent) {
  const isNew = !space.members[human];
  space.members[human] = { agent, joinedAt: space.members[human]?.joinedAt ?? Date.now() };
  if (isNew) logEvent(space, human, `joined the project with ${agent}`);
  saveStore();
  return { human, agent };
}

/** Remembers that this person or agent was just heard from; kept in memory, since it goes stale in minutes. */
function touchPresence(space, name) {
  (space.presence[name] ??= { status: "", doing: "", lastSeen: 0 }).lastSeen = Date.now();
}

/**
 * Saves what a person or agent says they're doing, so teammates know when to
 * check in. "away" and "available" are overrides; "working" is also worked
 * out automatically from tasks and locks, so setting it is optional.
 */
function setPresence(space, name, status, doing = "") {
  if (!PRESENCE_STATUSES.includes(status)) throw httpError(400, `status must be one of ${PRESENCE_STATUSES.join(", ")}`);
  const entry = (space.presence[name] ??= { status: "", doing: "", lastSeen: 0 });
  Object.assign(entry, { status, doing: String(doing).slice(0, MAX_DOING_CHARS), lastSeen: Date.now() });
  saveStore();
  return { name, status: entry.status, doing: entry.doing };
}

/**
 * Describes one person or agent for the team panel. They count as "away"
 * unless the hub heard from them recently; otherwise an explicit status wins,
 * and without one they are "working" when they hold a task or locks.
 */
function describePresence(space, name, work) {
  const entry = space.presence[name];
  const lastSeen = entry?.lastSeen || null;
  const active = lastSeen !== null && Date.now() - lastSeen < ACTIVE_WINDOW_MS;
  const doing = (entry?.doing || work.doing).slice(0, MAX_DOING_CHARS);
  return { status: !active ? "away" : entry.status || (doing || work.locks ? "working" : "available"), doing, lastSeen };
}

/** What an agent is visibly doing: its task in progress and how many files it has locked. */
function workOf(space, agent) {
  const task = space.tasks.find((candidate) => candidate.owner === agent && candidate.status === "doing");
  const locks = Object.values(space.locks).reduce((count, byBranch) => count + Object.values(byBranch).filter((lock) => lock.owner === agent).length, 0);
  return { doing: task ? `#${task.id} ${task.title}` : "", locks };
}

/** Adds an agent the admin acts as to the project's team, so it shows in the team panel like a signed-in one. */
function ensureMember(space, agent) {
  if (Object.values(space.members).some((member) => member.agent === agent)) return;
  joinProject(space, agent.slice(0, -AGENT_SUFFIX.length), agent);
}

/** Adds a new task to the project's board in the first status column. */
function addTask(space, agent, title) {
  const task = { id: space.nextTaskId++, title, status: TASK_STATUSES[0], owner: "", note: "" };
  space.tasks.push(task);
  logEvent(space, agent, `added task #${task.id}: ${title}`);
  saveStore();
  return task;
}

/**
 * Moves a task to a new status. Starting work on it claims it, and while it is
 * in progress or blocked only its owner can change it, so two agents never
 * work the same task; setting it back to todo releases it. Fails with 409 when
 * someone else holds the task.
 */
function updateTask(space, agent, id, status, note) {
  const task = space.tasks.find((candidate) => candidate.id === id);
  if (!task) throw httpError(404, `Task #${id} does not exist`);
  if (task.owner && task.owner !== agent && OWNED_TASK_STATUSES.includes(task.status)) {
    throw httpError(409, `Task #${id} is ${task.status} with ${task.owner}; ask them in the chat before changing it`);
  }
  task.status = status;
  if (status === "doing") task.owner = agent;
  if (status === "todo") task.owner = "";
  if (note !== undefined) task.note = note;
  logEvent(space, agent, `moved task #${id} to ${status}${note ? ` (${note})` : ""}`);
  saveStore();
  return task;
}

/**
 * Builds the plain-text briefing agents read when they start: rules, locks,
 * tasks, messages that mention them and recent activity in their project.
 */
function statusText(space, project, agent) {
  const { locks, tasks, events } = snapshot(space, project);
  const lines = [
    `agentsTalk team hub — project "${project}", you are "${agent}".`,
    "Rules: lock files before editing; never edit a file locked by someone else; unlock after you push. Post one short line with `say` when you start something; @name addresses someone.",
    "",
    "File locks:",
    ...(locks.length ? locks.map((l) => `- ${l.path} — ${l.owner} on ${branchLabel(l.branch)}${l.reason ? ` (${l.reason})` : ""}, ${l.minutesLeft} min left`) : ["- none"]),
    "",
    "Tasks:",
    ...(tasks.length ? tasks.map((t) => `- #${t.id} [${t.status}] ${t.title}${t.owner ? ` — ${t.owner}` : ""}${t.note ? ` (${t.note})` : ""}`) : ["- none"]),
    "",
    formatInbox(space, agent) || "No new chat messages for you.",
    "",
    "Recent activity:",
    ...events.slice(0, RECENT_EVENTS_IN_STATUS).map((e) => `- ${e.agent}: ${e.text}`),
  ];
  return lines.join("\n");
}

/** Returns one project's whole state for the dashboard, without expired locks. */
function snapshot(space, project) {
  pruneExpiredLocks(space);
  const now = Date.now();
  return {
    locks: Object.entries(space.locks).flatMap(([file, byBranch]) => Object.entries(byBranch).map(([branch, lock]) => ({
      path: file,
      branch,
      owner: lock.owner,
      reason: lock.reason,
      minutesLeft: Math.ceil((lock.expiresAt - now) / 60_000),
    }))),
    tasks: space.tasks,
    // The top-level fields describe the agent; `person` describes the human behind it.
    members: Object.entries(space.members).map(([name, member]) => {
      const work = workOf(space, member.agent);
      return {
        name,
        agent: member.agent,
        ...describePresence(space, member.agent, work),
        wakeable: (wakeStreams.get(project)?.get(member.agent)?.size ?? 0) > 0,
        locks: work.locks,
        person: describePresence(space, name, { doing: "", locks: 0 }),
      };
    }),
    events: [...space.events].reverse(),
    messages: space.messages.map(publicMessage),
  };
}

/** Lists the projects that have any activity, most recently active first, for the dashboard's switcher. */
function listProjects(caller) {
  return Object.entries(store.projects)
    // People only see their own repo's project; the admin sees every project.
    .filter(([name]) => caller.admin || name === caller.project)
    .map(([name, space]) => ({
      name,
      lastActivity: Math.max(0, space.events.at(-1)?.at ?? 0, space.messages.at(-1)?.at ?? 0),
      locks: Object.keys(space.locks).length,
    }))
    .filter((project) => project.lastActivity > 0 || !caller.admin)
    .sort((a, b) => b.lastActivity - a.lastActivity);
}

/** Returns a project's space, creating an empty one the first time the project is used. */
function spaceFor(project) {
  store.projects[project] ??= emptySpace();
  return store.projects[project];
}

/** A new project's starting state. */
function emptySpace() {
  return { locks: Object.create(null), tasks: [], events: [], messages: [], notices: Object.create(null), members: Object.create(null), presence: Object.create(null), nextTaskId: 1, nextMessageId: 1 };
}

/**
 * Collects what's new for an agent, its chat mentions and hub notices such as
 * cross-branch warnings, as one text; empty when there's nothing, so a quiet
 * hub adds no tokens.
 */
function formatInbox(space, agent) {
  const notices = takeNotices(space, agent);
  return [formatMentions(takeMentions(space, agent)), notices.length ? `Hub notices:\n${notices.map((n) => `- ${n}`).join("\n")}` : ""]
    .filter(Boolean).join("\n");
}

/** Formats mentions for an agent, or returns an empty string when there are none. */
function formatMentions(messages) {
  return messages.length ? `New chat messages for you:\n${formatChat(messages)}` : "";
}

/** Formats chat messages as compact lines an agent can read cheaply. */
function formatChat(messages) {
  return messages.map((m) => `- #${m.id} ${m.from}${m.fromHuman ? " (human)" : ""}: ${m.text}`).join("\n") || "- no messages";
}

/** Strips internal read-tracking before a message leaves the server. */
function publicMessage({ readBy, ...message }) {
  return message;
}

/** Turns a lock result into a sentence an agent can act on. */
function formatLockResult({ granted, blocked, warnings }) {
  const parts = [];
  if (granted.length) parts.push(`Locked for you: ${granted.join(", ")}`);
  for (const b of blocked) parts.push(`BLOCKED: ${b.path} is locked by ${b.owner} on ${branchLabel(b.branch)}${b.reason ? ` (${b.reason})` : ""}. Do not edit it; work on something else or ask @${b.owner} with say.`);
  for (const w of warnings) parts.push(`WARNING: ${w.owner} is also changing ${w.path} on ${branchLabel(w.branch)}. You may edit it, but expect a merge conflict; coordinate with @${w.owner}.`);
  return parts.join("\n");
}

/** Turns an unlock result into a short sentence for the agent. */
function formatUnlockResult({ released, notYours }) {
  const parts = [released.length ? `Released: ${released.join(", ")}` : "You had no matching locks"];
  if (notYours.length) parts.push(`Not yours, left alone: ${notYours.join(", ")}`);
  return parts.join("\n");
}

/** Appends a line to the project's live activity feed, tagged with its branch, keeping only the newest events. */
function logEvent(space, agent, text, branch = "") {
  space.events.push({ at: Date.now(), agent, text, branch });
  space.events = space.events.slice(-MAX_EVENTS);
}

/** Drops locks whose time ran out, so a crashed session can't block a file forever. */
function pruneExpiredLocks(space) {
  const now = Date.now();
  for (const [file, byBranch] of Object.entries(space.locks)) {
    for (const [branch, lock] of Object.entries(byBranch)) {
      if (lock.expiresAt > now) continue;
      delete byBranch[branch];
      logEvent(space, lock.owner, `lock on ${file} expired`, branch);
    }
    if (!Object.keys(byBranch).length) delete space.locks[file];
  }
}

/** Names a branch for messages; locks from tools that don't report one share an unnamed branch. */
function branchLabel(branch) {
  return branch ? `branch ${branch}` : "an unnamed branch";
}

/** Keeps idle wake-up streams from being closed by proxies or the OS. */
function sendHeartbeats() {
  for (const agents of wakeStreams.values()) {
    for (const streams of agents.values()) for (const res of streams) {
      if (res.agentsTalkExpiresAt && Date.now() >= res.agentsTalkExpiresAt) res.end();
      else res.write(": ping\n\n");
    }
  }
}

/** Makes paths from different machines and agents comparable. */
function normalizePath(raw) {
  if (typeof raw !== "string" || raw.includes("\0")) throw httpError(400, "Invalid file path");
  const file = path.posix.normalize(raw.trim().replace(/\\/g, "/"));
  if (!file || file === "." || file === ".." || file.startsWith("../") || file.startsWith("/") || /^[a-z]:/i.test(file)) throw httpError(400, "File paths must be relative to the repository");
  return file;
}

/** Makes names case-insensitive so "Ana" and "ana" are the same agent. */
function cleanName(name) {
  return (name ?? "").trim().toLowerCase() || UNKNOWN_AGENT;
}

/** Turns a project name into a safe, case-insensitive key, falling back to the default project. */
function cleanProject(name) {
  return (name ?? "").trim().toLowerCase().replace(PROJECT_NAME_PATTERN, "-") || DEFAULT_PROJECT;
}

/** Keeps branch names as Git writes them, minus surrounding spaces; no branch means "". */
function cleanBranch(name) {
  return (name ?? "").trim();
}

/** Wraps text in the response shape MCP tools return. */
function reply(text) {
  return { content: [{ type: "text", text }] };
}

/** Reads a JSON request body, treating an empty body as an empty object. */
async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/** Sends a JSON response. */
function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Sends a plain-text response. */
function sendText(res, text) {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

/** Sends an HTML file from disk. */
function sendFile(res, file) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(file));
}

/**
 * Opens the SQLite database in the data folder and loads every project and
 * key from it, so a restart keeps tasks, locks, chat and sign-ins. The
 * database uses write-ahead logging, so a crash can't leave it half-written.
 * The first start with an empty database imports the old state.json (or its
 * backup) once, then renames it so it is never read again.
 */
function loadStore() {
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS};
    CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS keys (hash TEXT PRIMARY KEY, login TEXT NOT NULL, project TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  const stored = { projects: Object.create(null), keys: Object.create(null) };
  for (const row of db.prepare("SELECT name, data FROM projects").all()) stored.projects[row.name] = JSON.parse(row.data);
  for (const row of db.prepare("SELECT hash, login, project, created_at FROM keys").all()) {
    stored.keys[row.hash] = { login: row.login, project: row.project, createdAt: row.created_at };
  }
  const isEmpty = !Object.keys(stored.projects).length && !Object.keys(stored.keys).length;
  const legacy = isEmpty ? readLegacyState() : undefined;
  const loaded = normalizeStore(legacy ?? stored);
  if (legacy) {
    writeStore(loaded);
    for (const file of [LEGACY_STATE_FILE, LEGACY_BACKUP_FILE]) if (fs.existsSync(file)) fs.renameSync(file, `${file}${IMPORTED_SUFFIX}`);
    console.log("agentsTalk imported the old state.json into the database");
  } else {
    for (const [name, space] of Object.entries(loaded.projects)) savedProjects.set(name, JSON.stringify(space));
    for (const [hash, record] of Object.entries(loaded.keys)) savedKeys.set(hash, JSON.stringify(record));
  }
  return loaded;
}

/**
 * Reads the old JSON state file, falling back to its backup. Returns nothing
 * when neither exists; fails loudly when one exists but can't be read, so
 * data is never silently dropped.
 */
function readLegacyState() {
  const present = [LEGACY_STATE_FILE, LEGACY_BACKUP_FILE].filter((file) => fs.existsSync(file));
  for (const file of present) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* try the next file */ }
  }
  if (present.length) throw new Error(`Cannot read ${present.join(" or ")}; fix or move it before starting`);
  return undefined;
}

/**
 * Turns saved data into the in-memory shape: older files are upgraded (one
 * from before projects existed becomes the default project, and locks from
 * before branches existed move to the unnamed branch), and lookup tables
 * have no prototype so names like "__proto__" are plain keys.
 */
function normalizeStore(saved) {
  const keys = Object.assign(Object.create(null), saved.keys ?? {});
  const projects = Object.assign(Object.create(null), saved.projects ?? { [DEFAULT_PROJECT]: saved });
  for (const [name, space] of Object.entries(projects)) {
    projects[name] = { ...emptySpace(), ...space, locks: Object.assign(Object.create(null), space.locks ?? {}), notices: Object.assign(Object.create(null), space.notices ?? {}), members: Object.assign(Object.create(null), space.members ?? {}), presence: Object.assign(Object.create(null), space.presence ?? {}) };
    for (const [file, lock] of Object.entries(projects[name].locks)) {
      projects[name].locks[file] = Object.assign(Object.create(null), "owner" in lock ? { "": lock } : lock);
    }
  }
  return { projects, keys };
}

/** Saves whatever changed since the last save; called after every change. */
function saveStore() {
  writeStore(store);
}

/**
 * Writes the projects and keys that changed since the last write, all in one
 * transaction, so a crash leaves either the old or the new state, never a
 * mix. Unchanged projects aren't rewritten, and revoked keys are deleted.
 */
function writeStore(data) {
  const projects = Object.entries(data.projects).map(([name, space]) => [name, JSON.stringify(space)]).filter(([name, json]) => savedProjects.get(name) !== json);
  const keys = Object.entries(data.keys).map(([hash, record]) => [hash, record, JSON.stringify(record)]).filter(([hash, , json]) => savedKeys.get(hash) !== json);
  const revoked = [...savedKeys.keys()].filter((hash) => !(hash in data.keys));
  if (!projects.length && !keys.length && !revoked.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const saveProject = db.prepare("INSERT INTO projects (name, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at");
    for (const [name, json] of projects) saveProject.run(name, json, Date.now());
    const saveKey = db.prepare("INSERT INTO keys (hash, login, project, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET login = excluded.login, project = excluded.project, created_at = excluded.created_at");
    for (const [hash, record] of keys) saveKey.run(hash, record.login, record.project, record.createdAt);
    const deleteKey = db.prepare("DELETE FROM keys WHERE hash = ?");
    for (const hash of revoked) deleteKey.run(hash);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  for (const [name, json] of projects) savedProjects.set(name, json);
  for (const [hash, , json] of keys) savedKeys.set(hash, json);
  for (const hash of revoked) savedKeys.delete(hash);
}

/**
 * Keeps a few recent copies of the database in the snapshots folder, taken
 * with VACUUM INTO (a consistent copy even while the hub is running). Takes
 * one when the newest is older than the interval, and prunes the oldest.
 */
function ensureSnapshot() {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
    const existing = fs.readdirSync(SNAPSHOT_DIR).filter((file) => file.endsWith(".db")).sort();
    const newest = existing.at(-1);
    if (!newest || Date.now() - fs.statSync(path.join(SNAPSHOT_DIR, newest)).mtimeMs >= SNAPSHOT_INTERVAL_MS) {
      const file = path.join(SNAPSHOT_DIR, `agentstalk-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
      db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
      existing.push(path.basename(file));
    }
    for (const old of existing.slice(0, -SNAPSHOTS_KEPT)) fs.rmSync(path.join(SNAPSHOT_DIR, old), { force: true });
  } catch (error) {
    console.error(`agentsTalk could not take a database snapshot: ${error.message}`);
  }
}
