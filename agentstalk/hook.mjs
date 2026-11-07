#!/usr/bin/env node
// agentsTalk hook for Claude Code and Codex. No dependencies: copy it into your project.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_HUB_URL = "http://localhost:4000";
// Settings come from the environment, or from this clone's `git config agenthub.*` written by join.mjs.
const GIT_SETTINGS = readGitSettings(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const HUB_URL = (process.env.AGENT_HUB_URL ?? GIT_SETTINGS.url ?? DEFAULT_HUB_URL).replace(/\/$/, "");
// The personal key from the setup; the hub knows the person and project from it.
const KEY = process.env.AGENT_HUB_KEY ?? GIT_SETTINGS.key ?? "";
// Read on every run, so switching branches is picked up right away.
const BRANCH = currentBranch(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const HUB_TIMEOUT_MS = 3000;
const BLOCK_EXIT_CODE = 2;
// Codex hooks set AGENTSTALK_TOOL=codex in their command (see the kit's .codex/config.toml).
const IS_CODEX = process.env.AGENTSTALK_TOOL === "codex";
const LOCK_REASON = `editing with ${IS_CODEX ? "Codex" : "Claude Code"}`;
const SHELL_LOCK_REASON = "changed by a shell command";
const RENAME_OR_COPY = /[RC]/;
// A shell command that mentions pushing; the hook then checks whether files really got pushed.
const PUSH_COMMAND = /\bgit\s+(?:-\S+\s+)*push\b/;
// Where the hook remembers, inside .git, which files a push is about to send.
const PUSH_STATE_FILE = "agentstalk-push.json";
// Lines of a Codex apply_patch that name the files it changes.
const PATCH_FILE_LINE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
// Set up means the setup script saved a personal key for this clone.
const JOINED = Boolean(KEY);
const NOT_JOINED_NOTICE = "agentsTalk (the team's shared chat, file locks and tasks) isn't set up in this clone yet. " +
  "At a good moment, tell the user once: run `node agentstalk` in a terminal in this repo; it signs them in with GitHub. " +
  "Afterwards they start their agent with the `agentstalk` command (or `agentstalk codex`) so teammates can reach this session.";

await main();

/**
 * Runs on Claude Code and Codex hook events. Before an edit it locks the file
 * on the hub and blocks the edit if a teammate holds it. At session start the
 * agent gets the full team status once; after that, on each prompt and tool
 * call, it only gets new chat messages that mention it, and nothing at all
 * when there are none, so the hub costs no tokens while it's quiet (Codex
 * can't add context after a tool call, so it gets them before the next one).
 * After shell commands it also checks which files actually changed, since a
 * shell command can edit files without going through the edit tools. If the
 * hub is unreachable it lets work continue instead of blocking it. With
 * `--headers` it only prints the auth header, for Codex's MCP connection.
 */
async function main() {
  // Codex doesn't let its header helper set Authorization, so the key goes in a header of our own.
  if (process.argv.includes("--headers")) return process.stdout.write(JSON.stringify({ "X-Agentstalk-Key": KEY }));
  const input = JSON.parse(await readStdin());
  const event = input.hook_event_name;
  if (!JOINED) {
    // Not set up yet: stay out of the hub rather than act under a guessed name, and point to the setup.
    if (event === "SessionStart") addContext(event, NOT_JOINED_NOTICE);
    return;
  }
  try {
    if (event === "PreToolUse") {
      await guardEdit(input);
      if (input.tool_name === "Bash" && PUSH_COMMAND.test(String(input.tool_input?.command ?? ""))) rememberUnpushedFiles(input);
      return IS_CODEX ? addContext(event, await hub("GET", "/api/inbox")) : undefined;
    }
    if (event === "PostToolUse" && input.tool_name === "Bash") {
      await checkShellChanges(input);
      if (PUSH_COMMAND.test(String(input.tool_input?.command ?? ""))) await releasePushedLocks(input);
    }
    if (event === "SessionStart") return addContext(event, await hub("GET", "/api/status"));
    if (event === "UserPromptSubmit" || (event === "PostToolUse" && !IS_CODEX)) return addContext(event, await hub("GET", "/api/inbox"));
  } catch (error) {
    console.error(`agent-hub unreachable (${error.message}); continuing without locks`);
  }
}

/** Hands text to the agent as extra context for this event; does nothing for empty text. */
function addContext(hookEventName, text) {
  if (!text.trim()) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }));
}

/** Locks the files the agent is about to edit, or blocks the edit if someone else holds one of them. */
async function guardEdit(input) {
  const files = editedFiles(input);
  if (!files.length) return;
  const root = repoRoot(input);
  const relatives = files
    .map((file) => path.relative(root, path.resolve(input.cwd ?? root, file)).split(path.sep).join("/"))
    .filter((relative) => !relative.startsWith("..")); // outside the shared project
  if (!relatives.length) return;
  const result = JSON.parse(await hub("POST", "/api/lock", { paths: relatives, reason: LOCK_REASON }));
  if (!result.blocked?.length) return;
  const list = result.blocked.map((b) => `${b.path} is locked by ${b.owner} on this branch${b.reason ? ` (${b.reason})` : ""}`).join("; ");
  console.error(`${list}. Do not edit ${result.blocked.length > 1 ? "them" : "it"}. ` +
    `Work on something else, or ask @${result.blocked[0].owner} with the agent-hub say tool.`);
  process.exit(BLOCK_EXIT_CODE);
}

/**
 * Lists the files an edit tool call is about to change: the file path Claude
 * Code's edit tools carry, or the files named in a Codex apply_patch.
 */
function editedFiles(input) {
  const args = input.tool_input ?? {};
  if (input.tool_name === "apply_patch") return [...String(args.command ?? "").matchAll(PATCH_FILE_LINE)].map((match) => match[1].trim());
  return [args.file_path ?? args.notebook_path].filter(Boolean);
}

/** The repo's top folder: Claude Code gives it directly, Codex only gives the session folder. */
function repoRoot(input) {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const cwd = input.cwd ?? process.cwd();
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return cwd;
  }
}

/**
 * Runs after a shell command. Every file Git reports as changed gets locked
 * for this agent; if a teammate already holds one, Claude is told to undo
 * what its command did to that file. Nothing is reverted automatically, so
 * no work is thrown away without Claude looking first.
 */
async function checkShellChanges(input) {
  const changed = changedFiles(repoRoot(input));
  if (!changed.length) return;
  const result = JSON.parse(await hub("POST", "/api/lock", { paths: changed, reason: SHELL_LOCK_REASON }));
  if (!result.blocked?.length) return;
  const list = result.blocked.map((b) => `${b.path} (locked by ${b.owner}${b.reason ? `: ${b.reason}` : ""})`).join(", ");
  console.error(`Your last command changed files a teammate has locked: ${list}. ` +
    "Undo the changes your command made to them (or delete them if you created them), then work on something else " +
    "or ask the owner with the agent-hub say tool.");
  process.exit(BLOCK_EXIT_CODE);
}

/**
 * Runs before a command that mentions `git push`: remembers which files are
 * in commits no remote branch has yet, i.e. what the push would send.
 */
function rememberUnpushedFiles(input) {
  const root = repoRoot(input);
  const files = unpushedFiles(root);
  if (files) fs.writeFileSync(pushStatePath(root), JSON.stringify({ files }));
}

/**
 * Runs after that command: frees this agent's locks only on files that were
 * waiting to be pushed and now are on a remote branch with no local
 * changes. A failed push, a command that only mentions pushing (like an
 * echo), and files that are locked but not edited yet all keep their locks.
 */
async function releasePushedLocks(input) {
  const root = repoRoot(input);
  const stateFile = pushStatePath(root);
  if (!fs.existsSync(stateFile)) return;
  const { files: before } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  fs.rmSync(stateFile, { force: true });
  const stillUnpushed = new Set(unpushedFiles(root) ?? before);
  const dirty = new Set(changedFiles(root));
  const pushed = before.filter((file) => !stillUnpushed.has(file) && !dirty.has(file));
  if (pushed.length) await hub("POST", "/api/unlock", { paths: pushed });
}

/**
 * Files touched by local commits that no remote branch has yet. Counting
 * against every remote branch, not only the upstream, means the first push of
 * a new branch (`git push -u`, which has no upstream before it) is tracked too.
 * Returns nothing outside a Git repo.
 */
function unpushedFiles(root) {
  try {
    const output = execFileSync("git", ["log", "--name-only", "-z", "--format=", "HEAD", "--not", "--remotes"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return [...new Set(output.split("\0").filter(Boolean))];
  } catch {
    return undefined;
  }
}

/** Where the push state lives: inside this clone's .git folder, so it is never committed. */
function pushStatePath(root) {
  return path.resolve(root, execFileSync("git", ["rev-parse", "--git-path", PUSH_STATE_FILE], { cwd: root, encoding: "utf8" }).trim());
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

/** Calls the hub API as this agent, with the personal key in a header, and returns the response body as text. */
async function hub(method, route, body) {
  const response = await fetch(`${HUB_URL}${route}?branch=${encodeURIComponent(BRANCH)}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`hub answered ${response.status}`);
  return response.text();
}

/** Reads the JSON event the agent sends on standard input. */
async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw || "{}";
}

/** Returns the checked-out Git branch, or "" when detached or outside a Git repo. */
function currentBranch(cwd) {
  try {
    const name = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return name === "HEAD" ? "" : name;
  } catch {
    return "";
  }
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
