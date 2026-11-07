#!/usr/bin/env node
// Claude Code hook for the agent hub. No dependencies: copy it into your project.
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_HUB_URL = "http://localhost:4000";
// Settings come from the environment, or from this clone's `git config agenthub.*` written by join.mjs.
const GIT_SETTINGS = readGitSettings(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const HUB_URL = (process.env.AGENT_HUB_URL ?? GIT_SETTINGS.url ?? DEFAULT_HUB_URL).replace(/\/$/, "");
const AGENT = process.env.AGENT_HUB_NAME ?? GIT_SETTINGS.name ?? os.userInfo().username;
const TOKEN = process.env.AGENT_HUB_TOKEN ?? GIT_SETTINGS.token ?? "";
const PROJECT = process.env.AGENT_HUB_PROJECT ?? GIT_SETTINGS.project ?? "";
const HUB_TIMEOUT_MS = 3000;
const BLOCK_EXIT_CODE = 2;
const LOCK_REASON = "editing with Claude Code";
const SHELL_LOCK_REASON = "changed by a shell command";
const RENAME_OR_COPY = /[RC]/;

await main();

/**
 * Runs on Claude Code hook events. Before an edit it locks the file on the
 * hub and blocks the edit if a teammate holds it. At session start Claude
 * gets the full team status once; after that, on each prompt and tool call,
 * it only gets new chat messages that mention it, and nothing at all when
 * there are none, so the hub costs no tokens while it's quiet. After shell
 * commands it also checks which files actually changed, since a shell
 * command can edit files without going through the edit tools.
 * If the hub is unreachable it lets work continue instead of blocking it.
 */
async function main() {
  const input = JSON.parse(await readStdin());
  const event = input.hook_event_name;
  try {
    if (event === "PreToolUse") return await guardEdit(input);
    if (event === "PostToolUse" && input.tool_name === "Bash") await checkShellChanges(input);
    if (event === "SessionStart") return addContext(event, await hub("GET", "/api/status"));
    if (event === "UserPromptSubmit" || event === "PostToolUse") return addContext(event, await hub("GET", "/api/inbox"));
  } catch (error) {
    console.error(`agent-hub unreachable (${error.message}); continuing without locks`);
  }
}

/** Hands text to Claude as extra context for this event; does nothing for empty text. */
function addContext(hookEventName, text) {
  if (!text.trim()) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }));
}

/** Locks the file Claude is about to edit, or blocks the edit if someone else holds it. */
async function guardEdit(input) {
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!file) return;
  const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
  const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
  if (relative.startsWith("..")) return; // outside the shared project
  const result = JSON.parse(await hub("POST", "/api/lock", { paths: [relative], reason: LOCK_REASON }));
  const blocked = result.blocked?.[0];
  if (!blocked) return;
  console.error(`${blocked.path} is locked by ${blocked.owner}${blocked.reason ? ` (${blocked.reason})` : ""}. ` +
    `Do not edit it. Work on something else, or ask @${blocked.owner} with the agent-hub say tool.`);
  process.exit(BLOCK_EXIT_CODE);
}

/**
 * Runs after a shell command. Every file Git reports as changed gets locked
 * for this agent; if a teammate already holds one, Claude is told to undo
 * what its command did to that file. Nothing is reverted automatically, so
 * no work is thrown away without Claude looking first.
 */
async function checkShellChanges(input) {
  const changed = changedFiles(process.env.CLAUDE_PROJECT_DIR ?? input.cwd);
  if (!changed.length) return;
  const result = JSON.parse(await hub("POST", "/api/lock", { paths: changed, reason: SHELL_LOCK_REASON }));
  if (!result.blocked?.length) return;
  const list = result.blocked.map((b) => `${b.path} (locked by ${b.owner}${b.reason ? `: ${b.reason}` : ""})`).join(", ");
  console.error(`Your last command changed files a teammate has locked: ${list}. ` +
    "Undo the changes your command made to them (or delete them if you created them), then work on something else " +
    "or ask the owner with the agent-hub say tool.");
  process.exit(BLOCK_EXIT_CODE);
}

/** Lists files Git sees as modified, added, deleted or untracked, relative to the repo root. */
function changedFiles(root) {
  let output;
  try {
    output = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  } catch {
    return []; // not a Git repo
  }
  const entries = output.split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    files.push(entries[i].slice(3));
    if (RENAME_OR_COPY.test(entries[i].slice(0, 2))) files.push(entries[++i]); // a rename also changes the old name
  }
  return files;
}

/** Calls the hub API as this agent and returns the response body as text. */
async function hub(method, route, body) {
  const url = `${HUB_URL}${route}?project=${encodeURIComponent(PROJECT)}&agent=${encodeURIComponent(AGENT)}&token=${encodeURIComponent(TOKEN)}`;
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`hub answered ${response.status}`);
  return response.text();
}

/** Reads the JSON event Claude Code sends on standard input. */
async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw || "{}";
}

/** Reads every `agenthub.<key>` value from this clone's Git config, or nothing outside a Git repo. */
function readGitSettings(cwd) {
  try {
    const output = execFileSync("git", ["config", "--get-regexp", "^agenthub\\."], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Object.fromEntries(output.trim().split("\n").filter(Boolean).map((line) => {
      const [key, ...value] = line.split(" ");
      return [key.slice("agenthub.".length), value.join(" ")];
    }));
  } catch {
    return {}; // not a Git repo, or nothing configured
  }
}
