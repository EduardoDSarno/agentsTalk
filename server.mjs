import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const DEFAULT_PORT = 4000;
// Cloud hosts such as Railway assign the port through PORT.
const PORT = Number(process.env.PORT ?? process.env.AGENT_HUB_PORT ?? DEFAULT_PORT);
const TEAM_TOKEN = process.env.AGENT_HUB_TOKEN ?? "";
const LOCK_TTL_MINUTES = 20;
const LOCK_TTL_MS = LOCK_TTL_MINUTES * 60_000;
const MAX_EVENTS = 200;
const MAX_MESSAGES = 500;
const MAX_MESSAGE_CHARS = 1000;
const CHAT_READ_DEFAULT = 20;
const CHAT_READ_MAX = 100;
const RECENT_EVENTS_IN_STATUS = 10;
const HEARTBEAT_MS = 25_000;
const TASK_STATUSES = ["todo", "doing", "done"];
const EVERYONE = "all";
const UNKNOWN_AGENT = "unknown";
// Requests without a project (older kits) land here, so they keep working.
const DEFAULT_PROJECT = "default";
const PROJECT_NAME_PATTERN = /[^a-z0-9._-]/g;
const MENTION_PATTERN = /@([a-z0-9_-]+)/gi;
const DIR = path.dirname(fileURLToPath(import.meta.url));
// On a cloud host, point AGENT_HUB_DATA_DIR at a mounted disk so data survives redeploys.
const STATE_FILE = path.join(process.env.AGENT_HUB_DATA_DIR ?? DIR, "state.json");
const DASHBOARD_FILE = path.join(DIR, "dashboard.html");

/** Every project's chat, locks, tasks and activity, keyed by project name. */
const store = loadStore();
/** Open wake-up streams per project, then per agent name, used by the Claude Code channel. */
const wakeStreams = new Map();

http.createServer(handleRequest).listen(PORT, () => {
  console.log(`Agent hub running: dashboard at http://localhost:${PORT}/  MCP at http://localhost:${PORT}/mcp?project=<repo>&agent=<name>`);
});
setInterval(sendHeartbeats, HEARTBEAT_MS);

/**
 * Routes every HTTP request: the dashboard page, the JSON API used by hooks,
 * channels and the dashboard, and the MCP endpoint any agent can connect to.
 * The `project` query parameter picks which repo's space to use, so one hub
 * can serve several repos without their locks or chat mixing; `agent` is the
 * caller's name.
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const agent = cleanName(url.searchParams.get("agent"));
  const project = cleanProject(url.searchParams.get("project"));
  try {
    if (url.pathname === "/") return sendFile(res, DASHBOARD_FILE);
    if (!isAuthorized(req, url)) return sendJson(res, 401, { error: "Wrong or missing team token" });
    if (req.method === "GET" && url.pathname === "/api/projects") return sendJson(res, 200, listProjects());
    const space = spaceFor(project);
    if (url.pathname === "/mcp") return await handleMcp(req, res, space, project, agent);
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, snapshot(space));
    if (req.method === "GET" && url.pathname === "/api/status") return sendText(res, statusText(space, project, agent));
    if (req.method === "GET" && url.pathname === "/api/inbox") return sendText(res, formatMentions(takeMentions(space, agent)));
    if (req.method === "GET" && url.pathname === "/api/wake") return openWakeStream(req, res, project, agent);
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJson(req);
      return sendJson(res, 200, publicMessage(postChat(project, agent, body.text, body.human === true)));
    }
    if (req.method === "POST" && url.pathname === "/api/lock") {
      const body = await readJson(req);
      return sendJson(res, 200, lockFiles(space, agent, body.paths ?? [], body.reason));
    }
    if (req.method === "POST" && url.pathname === "/api/check") {
      const body = await readJson(req);
      return sendJson(res, 200, { blocked: findBlocked(space, agent, body.paths ?? []) });
    }
    if (req.method === "POST" && url.pathname === "/api/unlock") {
      const body = await readJson(req);
      return sendJson(res, 200, unlockFiles(space, agent, body.paths));
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error?.message ?? String(error) });
  }
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

  server.registerTool("lock_files", {
    description: "Lock files BEFORE editing them so teammates' agents don't edit them at the same time. Use paths relative to the repo root (e.g. src/api.ts). Do not edit files that come back as blocked.",
    inputSchema: { paths: z.array(z.string()).min(1), reason: z.string().describe("What you are changing") },
  }, async ({ paths, reason }) => reply(formatLockResult(lockFiles(space, agent, paths, reason))));

  server.registerTool("unlock_files", {
    description: "Release your locks after you have committed and pushed. Leave paths empty to release all your locks.",
    inputSchema: { paths: z.array(z.string()).optional() },
  }, async ({ paths }) => reply(formatUnlockResult(unlockFiles(space, agent, paths))));

  server.registerTool("add_task", {
    description: "Add a task to the shared team board.",
    inputSchema: { title: z.string() },
  }, async ({ title }) => reply(`Added task #${addTask(space, agent, title).id}`));

  server.registerTool("update_task", {
    description: "Move a task. Setting it to 'doing' makes you its owner.",
    inputSchema: { id: z.number().int(), status: z.enum(TASK_STATUSES), note: z.string().optional() },
  }, async ({ id, status, note }) => reply(`Task #${updateTask(space, agent, id, status, note).id} is now ${status}`));

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
function openWakeStream(req, res, project, agent) {
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
    if (!streams.size) continue;
    const mentions = takeMentions(space, agent, true);
    if (!mentions.length) continue;
    const data = `data: ${JSON.stringify(mentions.map(publicMessage))}\n\n`;
    for (const res of streams) res.write(data);
  }
}

/**
 * Gives the agent each requested file unless another agent holds a live lock
 * on it. Re-locking your own file extends its expiry, which keeps a lock
 * alive while you keep editing.
 */
function lockFiles(space, agent, paths, reason = "") {
  pruneExpiredLocks(space);
  const granted = [];
  const blocked = [];
  for (const raw of paths) {
    const file = normalizePath(raw);
    const lock = space.locks[file];
    if (lock && lock.owner !== agent) {
      blocked.push({ path: file, owner: lock.owner, reason: lock.reason });
      continue;
    }
    if (!lock) logEvent(space, agent, `locked ${file}${reason ? ` (${reason})` : ""}`);
    space.locks[file] = { owner: agent, reason: reason || lock?.reason || "", expiresAt: Date.now() + LOCK_TTL_MS };
    granted.push(file);
  }
  saveStore();
  return { granted, blocked };
}

/**
 * Lists which of these files someone else has locked, without locking
 * anything. The Git pre-commit check uses it to refuse such commits.
 */
function findBlocked(space, agent, paths) {
  pruneExpiredLocks(space);
  return paths.map(normalizePath)
    .filter((file) => space.locks[file] && space.locks[file].owner !== agent)
    .map((file) => ({ path: file, owner: space.locks[file].owner, reason: space.locks[file].reason }));
}

/**
 * Releases the agent's own locks: the listed files, or all of them when no
 * list is given. Locks held by others are reported, never removed.
 */
function unlockFiles(space, agent, paths) {
  const targets = paths?.length
    ? paths.map(normalizePath)
    : Object.keys(space.locks).filter((file) => space.locks[file].owner === agent);
  const released = [];
  const notYours = [];
  for (const file of targets) {
    const lock = space.locks[file];
    if (!lock) continue;
    if (lock.owner !== agent) {
      notYours.push(file);
      continue;
    }
    delete space.locks[file];
    released.push(file);
  }
  if (released.length) logEvent(space, agent, `unlocked ${released.join(", ")}`);
  saveStore();
  return { released, notYours };
}

/** Adds a new task to the project's board in the first status column. */
function addTask(space, agent, title) {
  const task = { id: space.nextTaskId++, title, status: TASK_STATUSES[0], owner: "", note: "" };
  space.tasks.push(task);
  logEvent(space, agent, `added task #${task.id}: ${title}`);
  saveStore();
  return task;
}

/** Moves a task to a new status; starting work on it claims ownership. */
function updateTask(space, agent, id, status, note) {
  const task = space.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Task #${id} does not exist`);
  task.status = status;
  if (status === "doing") task.owner = agent;
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
  const { locks, tasks, events } = snapshot(space);
  const lines = [
    `TEAM AGENT HUB — project "${project}", you are "${agent}".`,
    "Rules: lock files before editing; never edit a file locked by someone else; unlock after you push. Post one short line with `say` when you start something; @name addresses someone.",
    "",
    "File locks:",
    ...(locks.length ? locks.map((l) => `- ${l.path} — ${l.owner}${l.reason ? ` (${l.reason})` : ""}, ${l.minutesLeft} min left`) : ["- none"]),
    "",
    "Tasks:",
    ...(tasks.length ? tasks.map((t) => `- #${t.id} [${t.status}] ${t.title}${t.owner ? ` — ${t.owner}` : ""}${t.note ? ` (${t.note})` : ""}`) : ["- none"]),
    "",
    formatMentions(takeMentions(space, agent)) || "No new chat messages for you.",
    "",
    "Recent activity:",
    ...events.slice(0, RECENT_EVENTS_IN_STATUS).map((e) => `- ${e.agent}: ${e.text}`),
  ];
  return lines.join("\n");
}

/** Returns one project's whole state for the dashboard, without expired locks. */
function snapshot(space) {
  pruneExpiredLocks(space);
  const now = Date.now();
  return {
    locks: Object.entries(space.locks).map(([file, lock]) => ({
      path: file,
      owner: lock.owner,
      reason: lock.reason,
      minutesLeft: Math.ceil((lock.expiresAt - now) / 60_000),
    })),
    tasks: space.tasks,
    events: [...space.events].reverse(),
    messages: space.messages.map(publicMessage),
  };
}

/** Lists the projects that have any activity, most recently active first, for the dashboard's switcher. */
function listProjects() {
  return Object.entries(store.projects)
    .map(([name, space]) => ({
      name,
      lastActivity: Math.max(0, space.events.at(-1)?.at ?? 0, space.messages.at(-1)?.at ?? 0),
      locks: Object.keys(space.locks).length,
    }))
    .filter((project) => project.lastActivity > 0)
    .sort((a, b) => b.lastActivity - a.lastActivity);
}

/** Returns a project's space, creating an empty one the first time the project is used. */
function spaceFor(project) {
  store.projects[project] ??= emptySpace();
  return store.projects[project];
}

/** A new project's starting state. */
function emptySpace() {
  return { locks: {}, tasks: [], events: [], messages: [], nextTaskId: 1, nextMessageId: 1 };
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
function formatLockResult({ granted, blocked }) {
  const parts = [];
  if (granted.length) parts.push(`Locked for you: ${granted.join(", ")}`);
  for (const b of blocked) parts.push(`BLOCKED: ${b.path} is locked by ${b.owner}${b.reason ? ` (${b.reason})` : ""}. Do not edit it; work on something else or ask @${b.owner} with say.`);
  return parts.join("\n");
}

/** Turns an unlock result into a short sentence for the agent. */
function formatUnlockResult({ released, notYours }) {
  const parts = [released.length ? `Released: ${released.join(", ")}` : "You had no matching locks"];
  if (notYours.length) parts.push(`Not yours, left alone: ${notYours.join(", ")}`);
  return parts.join("\n");
}

/** Appends a line to the project's live activity feed, keeping only the newest events. */
function logEvent(space, agent, text) {
  space.events.push({ at: Date.now(), agent, text });
  space.events = space.events.slice(-MAX_EVENTS);
}

/** Drops locks whose time ran out, so a crashed session can't block a file forever. */
function pruneExpiredLocks(space) {
  const now = Date.now();
  for (const [file, lock] of Object.entries(space.locks)) {
    if (lock.expiresAt <= now) {
      delete space.locks[file];
      logEvent(space, lock.owner, `lock on ${file} expired`);
    }
  }
}

/** Keeps idle wake-up streams from being closed by proxies or the OS. */
function sendHeartbeats() {
  for (const agents of wakeStreams.values()) {
    for (const streams of agents.values()) for (const res of streams) res.write(": ping\n\n");
  }
}

/** Makes paths from different machines and agents comparable. */
function normalizePath(raw) {
  return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Makes names case-insensitive so "Ana" and "ana" are the same agent. */
function cleanName(name) {
  return (name ?? "").trim().toLowerCase() || UNKNOWN_AGENT;
}

/** Turns a project name into a safe, case-insensitive key, falling back to the default project. */
function cleanProject(name) {
  return (name ?? "").trim().toLowerCase().replace(PROJECT_NAME_PATTERN, "-") || DEFAULT_PROJECT;
}

/** Checks the optional team token so strangers on the same network can't join. */
function isAuthorized(req, url) {
  return !TEAM_TOKEN || url.searchParams.get("token") === TEAM_TOKEN || req.headers["x-team-token"] === TEAM_TOKEN;
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
 * Loads saved state so a server restart keeps every project's tasks, locks
 * and chat. A file from before projects existed becomes the default project.
 */
function loadStore() {
  if (!fs.existsSync(STATE_FILE)) return { projects: {} };
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (saved.projects) return saved;
  return { projects: { [DEFAULT_PROJECT]: { ...emptySpace(), ...saved } } };
}

/** Writes every project's state to disk after each change. */
function saveStore() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(store, null, 2));
}
