import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const DEFAULT_PORT = 4000;
const PORT = Number(process.env.AGENT_HUB_PORT ?? DEFAULT_PORT);
const TEAM_TOKEN = process.env.AGENT_HUB_TOKEN ?? "";
const LOCK_TTL_MINUTES = 20;
const LOCK_TTL_MS = LOCK_TTL_MINUTES * 60_000;
const MAX_EVENTS = 200;
const MAX_MESSAGES = 200;
const RECENT_EVENTS_IN_STATUS = 10;
const TASK_STATUSES = ["todo", "doing", "done"];
const EVERYONE = "all";
const UNKNOWN_AGENT = "unknown";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(DIR, "state.json");
const DASHBOARD_FILE = path.join(DIR, "dashboard.html");

const state = loadState();

http.createServer(handleRequest).listen(PORT, () => {
  console.log(`Agent hub running: dashboard at http://localhost:${PORT}/  MCP at http://localhost:${PORT}/mcp?agent=<name>`);
});

/**
 * Routes every HTTP request: the dashboard page, the JSON API used by hooks
 * and the dashboard, and the MCP endpoint that any agent can connect to.
 * The agent's name always comes from the `agent` query parameter.
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const agent = cleanName(url.searchParams.get("agent"));
  try {
    if (url.pathname === "/") return sendFile(res, DASHBOARD_FILE);
    if (!isAuthorized(req, url)) return sendJson(res, 401, { error: "Wrong or missing team token" });
    if (url.pathname === "/mcp") return await handleMcp(req, res, agent);
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, snapshot());
    if (req.method === "GET" && url.pathname === "/api/status") return sendText(res, statusText(agent));
    if (req.method === "POST" && url.pathname === "/api/lock") {
      const body = await readJson(req);
      return sendJson(res, 200, lockFiles(agent, body.paths ?? [], body.reason));
    }
    if (req.method === "POST" && url.pathname === "/api/unlock") {
      const body = await readJson(req);
      return sendJson(res, 200, unlockFiles(agent, body.paths));
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error?.message ?? String(error) });
  }
}

/**
 * Answers one MCP request. The server is stateless, so each request gets a
 * fresh MCP server bound to the calling agent's name.
 */
async function handleMcp(req, res, agent) {
  const server = buildMcpServer(agent);
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
 * unlock files, manage tasks, message teammates and announce what they do.
 */
function buildMcpServer(agent) {
  const server = new McpServer({ name: "agent-hub", version: "1.0.0" });

  server.registerTool("status", {
    description: "Call this first and before each new piece of work. Shows file locks, tasks, your unread messages and recent team activity.",
  }, async () => reply(statusText(agent)));

  server.registerTool("lock_files", {
    description: "Lock files BEFORE editing them so teammates' agents don't edit them at the same time. Use paths relative to the repo root (e.g. src/api.ts). Do not edit files that come back as blocked.",
    inputSchema: { paths: z.array(z.string()).min(1), reason: z.string().describe("What you are changing") },
  }, async ({ paths, reason }) => reply(formatLockResult(lockFiles(agent, paths, reason))));

  server.registerTool("unlock_files", {
    description: "Release your locks after you have committed and pushed. Leave paths empty to release all your locks.",
    inputSchema: { paths: z.array(z.string()).optional() },
  }, async ({ paths }) => reply(formatUnlockResult(unlockFiles(agent, paths))));

  server.registerTool("add_task", {
    description: "Add a task to the shared team board.",
    inputSchema: { title: z.string() },
  }, async ({ title }) => reply(`Added task #${addTask(agent, title).id}`));

  server.registerTool("update_task", {
    description: "Move a task. Setting it to 'doing' makes you its owner.",
    inputSchema: { id: z.number().int(), status: z.enum(TASK_STATUSES), note: z.string().optional() },
  }, async ({ id, status, note }) => reply(`Task #${updateTask(agent, id, status, note).id} is now ${status}`));

  server.registerTool("send_message", {
    description: `Send a message to a teammate's agent by name, or to "${EVERYONE}". They see it the next time they check status.`,
    inputSchema: { to: z.string(), text: z.string() },
  }, async ({ to, text }) => reply(`Sent to ${sendMessage(agent, to, text).to}`));

  server.registerTool("log", {
    description: "Tell the team what you are doing right now. Shows on the live dashboard.",
    inputSchema: { text: z.string() },
  }, async ({ text }) => {
    logEvent(agent, text);
    saveState();
    return reply("Logged");
  });

  return server;
}

/**
 * Gives the agent each requested file unless another agent holds a live lock
 * on it. Re-locking your own file extends its expiry, which keeps a lock
 * alive while you keep editing.
 */
function lockFiles(agent, paths, reason = "") {
  pruneExpiredLocks();
  const granted = [];
  const blocked = [];
  for (const raw of paths) {
    const file = normalizePath(raw);
    const lock = state.locks[file];
    if (lock && lock.owner !== agent) {
      blocked.push({ path: file, owner: lock.owner, reason: lock.reason });
      continue;
    }
    if (!lock) logEvent(agent, `locked ${file}${reason ? ` (${reason})` : ""}`);
    state.locks[file] = { owner: agent, reason: reason || lock?.reason || "", expiresAt: Date.now() + LOCK_TTL_MS };
    granted.push(file);
  }
  saveState();
  return { granted, blocked };
}

/**
 * Releases the agent's own locks: the listed files, or all of them when no
 * list is given. Locks held by others are reported, never removed.
 */
function unlockFiles(agent, paths) {
  const targets = paths?.length
    ? paths.map(normalizePath)
    : Object.keys(state.locks).filter((file) => state.locks[file].owner === agent);
  const released = [];
  const notYours = [];
  for (const file of targets) {
    const lock = state.locks[file];
    if (!lock) continue;
    if (lock.owner !== agent) {
      notYours.push(file);
      continue;
    }
    delete state.locks[file];
    released.push(file);
  }
  if (released.length) logEvent(agent, `unlocked ${released.join(", ")}`);
  saveState();
  return { released, notYours };
}

/** Adds a new task to the shared board in the first status column. */
function addTask(agent, title) {
  const task = { id: state.nextTaskId++, title, status: TASK_STATUSES[0], owner: "", note: "" };
  state.tasks.push(task);
  logEvent(agent, `added task #${task.id}: ${title}`);
  saveState();
  return task;
}

/** Moves a task to a new status; starting work on it claims ownership. */
function updateTask(agent, id, status, note) {
  const task = state.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`Task #${id} does not exist`);
  task.status = status;
  if (status === "doing") task.owner = agent;
  if (note !== undefined) task.note = note;
  logEvent(agent, `moved task #${id} to ${status}${note ? ` (${note})` : ""}`);
  saveState();
  return task;
}

/** Stores a message for one teammate or everyone and shows it in the feed. */
function sendMessage(from, to, text) {
  const message = { id: Date.now(), at: Date.now(), from, to: cleanName(to), text, readBy: [] };
  state.messages.push(message);
  state.messages = state.messages.slice(-MAX_MESSAGES);
  logEvent(from, `→ ${message.to}: ${text}`);
  saveState();
  return message;
}

/**
 * Builds the plain-text briefing agents read: rules, locks, tasks, unread
 * messages and recent activity. Reading it marks the messages as read.
 */
function statusText(agent) {
  const { locks, tasks, events } = snapshot();
  const unread = takeUnread(agent);
  const lines = [
    `TEAM AGENT HUB — you are "${agent}".`,
    "Rules: call lock_files before editing a file; never edit a file locked by someone else; unlock_files after you push.",
    "",
    "File locks:",
    ...(locks.length ? locks.map((l) => `- ${l.path} — ${l.owner}${l.reason ? ` (${l.reason})` : ""}, ${l.minutesLeft} min left`) : ["- none"]),
    "",
    "Tasks:",
    ...(tasks.length ? tasks.map((t) => `- #${t.id} [${t.status}] ${t.title}${t.owner ? ` — ${t.owner}` : ""}${t.note ? ` (${t.note})` : ""}`) : ["- none"]),
    "",
    "Unread messages for you:",
    ...(unread.length ? unread.map((m) => `- from ${m.from}${m.to === EVERYONE ? " (to all)" : ""}: ${m.text}`) : ["- none"]),
    "",
    "Recent activity:",
    ...events.slice(0, RECENT_EVENTS_IN_STATUS).map((e) => `- ${e.agent}: ${e.text}`),
  ];
  return lines.join("\n");
}

/** Returns the whole team state for the dashboard, without expired locks. */
function snapshot() {
  pruneExpiredLocks();
  const now = Date.now();
  return {
    locks: Object.entries(state.locks).map(([file, lock]) => ({
      path: file,
      owner: lock.owner,
      reason: lock.reason,
      minutesLeft: Math.ceil((lock.expiresAt - now) / 60_000),
    })),
    tasks: state.tasks,
    events: [...state.events].reverse(),
    messages: [...state.messages].reverse().map(({ readBy, ...message }) => message),
  };
}

/** Returns the messages this agent hasn't seen yet and marks them as seen. */
function takeUnread(agent) {
  const unread = state.messages.filter((m) =>
    (m.to === agent || (m.to === EVERYONE && m.from !== agent)) && !m.readBy.includes(agent));
  for (const message of unread) message.readBy.push(agent);
  if (unread.length) saveState();
  return unread;
}

/** Turns a lock result into a sentence an agent can act on. */
function formatLockResult({ granted, blocked }) {
  const parts = [];
  if (granted.length) parts.push(`Locked for you: ${granted.join(", ")}`);
  for (const b of blocked) parts.push(`BLOCKED: ${b.path} is locked by ${b.owner}${b.reason ? ` (${b.reason})` : ""}. Do not edit it; work on something else or send_message to ${b.owner}.`);
  return parts.join("\n");
}

/** Turns an unlock result into a short sentence for the agent. */
function formatUnlockResult({ released, notYours }) {
  const parts = [released.length ? `Released: ${released.join(", ")}` : "You had no matching locks"];
  if (notYours.length) parts.push(`Not yours, left alone: ${notYours.join(", ")}`);
  return parts.join("\n");
}

/** Appends a line to the live activity feed, keeping only the newest events. */
function logEvent(agent, text) {
  state.events.push({ at: Date.now(), agent, text });
  state.events = state.events.slice(-MAX_EVENTS);
}

/** Drops locks whose time ran out, so a crashed session can't block a file forever. */
function pruneExpiredLocks() {
  const now = Date.now();
  for (const [file, lock] of Object.entries(state.locks)) {
    if (lock.expiresAt <= now) {
      delete state.locks[file];
      logEvent(lock.owner, `lock on ${file} expired`);
    }
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

/** Loads saved state so a server restart keeps tasks and locks. */
function loadState() {
  const empty = { locks: {}, tasks: [], events: [], messages: [], nextTaskId: 1 };
  if (!fs.existsSync(STATE_FILE)) return empty;
  return { ...empty, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
}

/** Writes the current state to disk after every change. */
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
