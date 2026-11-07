#!/usr/bin/env node
// Claude Code hook for the agent hub. No dependencies: copy it into your project.
import os from "node:os";
import path from "node:path";

const DEFAULT_HUB_URL = "http://localhost:4000";
const HUB_URL = (process.env.AGENT_HUB_URL ?? DEFAULT_HUB_URL).replace(/\/$/, "");
const AGENT = process.env.AGENT_HUB_NAME ?? os.userInfo().username;
const TOKEN = process.env.AGENT_HUB_TOKEN ?? "";
const HUB_TIMEOUT_MS = 3000;
const BLOCK_EXIT_CODE = 2;
const LOCK_REASON = "editing with Claude Code";

await main();

/**
 * Runs on Claude Code hook events. Before an edit it locks the file on the
 * hub and blocks the edit if a teammate holds it; at session start and on
 * each prompt it gives Claude the team status, including new messages.
 * If the hub is unreachable it lets work continue instead of blocking it.
 */
async function main() {
  const input = JSON.parse(await readStdin());
  try {
    if (input.hook_event_name === "PreToolUse") return await guardEdit(input);
    if (input.hook_event_name === "SessionStart" || input.hook_event_name === "UserPromptSubmit") {
      process.stdout.write(await hub("GET", "/api/status"));
    }
  } catch (error) {
    console.error(`agent-hub unreachable (${error.message}); continuing without locks`);
  }
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
    `Do not edit it. Work on something else, or message ${blocked.owner} through the agent-hub send_message tool.`);
  process.exit(BLOCK_EXIT_CODE);
}

/** Calls the hub API as this agent and returns the response body as text. */
async function hub(method, route, body) {
  const url = `${HUB_URL}${route}?agent=${encodeURIComponent(AGENT)}&token=${encodeURIComponent(TOKEN)}`;
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
