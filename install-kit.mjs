#!/usr/bin/env node
// Copies the agentsTalk kit into a team repo. Run once, by whoever sets up the team:
//   node install-kit.mjs <path-to-team-repo> --hub <hub-url>
// The kit holds no secrets, so the repo can be public: teammates get personal keys by signing in with GitHub.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const DIR = path.dirname(fileURLToPath(import.meta.url));
// A visible folder with a package.json, so teammates set up with just `node agentstalk`.
const KIT_FOLDER = "agentstalk";
// Where earlier versions put the kit; the installer moves it.
const OLD_KIT_FOLDERS = [".agent-hub", "agenttalk"];
const GITHUB_REMOTE_PATTERN = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
const HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${KIT_FOLDER}/hook.mjs"`;
const HOOK_EVENTS = {
  SessionStart: undefined,
  UserPromptSubmit: undefined,
  PreToolUse: "Edit|Write|MultiEdit|NotebookEdit",
  PostToolUse: undefined,
};
// Codex hooks: tool events run for every tool (the hook decides what matters), shell checks only for Bash.
const CODEX_HOOK_EVENTS = [
  ["SessionStart"],
  ["UserPromptSubmit"],
  ["PreToolUse"],
  ["PostToolUse", "^Bash$"],
];
const CODEX_HOOK_COMMAND = `AGENTSTALK_TOOL=codex node "$(git rev-parse --show-toplevel)/${KIT_FOLDER}/hook.mjs"`;
const CODEX_HEADERS_COMMAND = `node "$(git rev-parse --show-toplevel)/${KIT_FOLDER}/hook.mjs" --headers`;
const CODEX_BLOCK_START = "# agentsTalk begin (written by the agentsTalk installer; edits between these lines are overwritten)";
const CODEX_BLOCK_END = "# agentsTalk end";
const RULES_MARKER = "## Team coordination (agent-hub)";
const RULES = `${RULES_MARKER}
- Call the agent-hub \`status\` tool once when you start.
- Call \`lock_files\` with repo-relative paths BEFORE editing any file.
  If a file comes back BLOCKED, don't edit it: do other work or ask the owner with \`say\`.
- Post one short line with \`say\` when you start or finish something. Use @name to address someone.
- Use \`update_task\` to set your task to \`doing\` when you start and \`done\` when it's merged.
- After you commit and push, call \`unlock_files\`.
- Never use \`git commit --no-verify\`: it skips the team's lock check.
`;

await main();

/**
 * Puts everything teammates need inside the team repo, so their whole setup
 * is cloning it and running the join script: the hook, the pre-commit check,
 * the wake-up channel bundled into one dependency-free file, the join script
 * with the hub address, the shared Claude Code hook settings, and the
 * coordination rules other agents read from AGENTS.md. Nothing secret is
 * written: who may join is decided by GitHub repo access.
 */
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { hub: { type: "string" } } });
  const repo = positionals[0];
  if (!repo || !values.hub) {
    console.error("Usage: node install-kit.mjs <path-to-team-repo> --hub <hub-url>");
    process.exit(1);
  }
  const githubRepo = githubRepoOf(repo);
  const kit = path.join(repo, KIT_FOLDER);
  fs.mkdirSync(kit, { recursive: true });
  for (const old of OLD_KIT_FOLDERS) fs.rmSync(path.join(repo, old), { recursive: true, force: true });
  // Makes `node agentstalk` run the join script.
  writeJson(path.join(kit, "package.json"), { name: "agentstalk-kit", private: true, type: "module", main: "join.mjs" });

  for (const file of ["hook.mjs", "pre-commit.mjs", "kit/join.mjs"]) fs.copyFileSync(path.join(DIR, file), path.join(kit, path.basename(file)));
  await bundleChannel(path.join(kit, "channel.mjs"));
  writeJson(path.join(kit, "config.json"), { hubUrl: values.hub, repo: githubRepo });
  addHookSettings(path.join(repo, ".claude", "settings.json"));
  addCodexConfig(path.join(repo, ".codex", "config.toml"), values.hub);
  addRules(path.join(repo, "AGENTS.md"));

  console.log(`Kit installed in ${path.resolve(repo)} for ${githubRepo ?? "a repo without a GitHub remote yet"}.`);
  console.log("Next: commit and push it. The kit has no secrets, so the repo can be public.");
  console.log(`Teammates with write access then clone the repo and run: node ${KIT_FOLDER}`);
}

/** Reads "owner/name" from the repo's GitHub remote; the hub names the project after it. */
function githubRepoOf(repo) {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return GITHUB_REMOTE_PATTERN.exec(remote)?.[1];
  } catch {
    return undefined; // no origin yet; the join script reads it from each clone
  }
}

/** Bundles the channel and its MCP dependency into one file, so teammates never run npm install. */
async function bundleChannel(outfile) {
  await build({
    entryPoints: [path.join(DIR, "channel.mjs")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "error",
    // Some bundled packages call require(); this gives ESM output a working one.
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
}

/**
 * Adds the agent-hub hook to the repo's shared Claude Code settings for each
 * event it needs, keeping any settings and hooks the repo already has.
 * Running it again doesn't add duplicates.
 */
function addHookSettings(file) {
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  settings.hooks ??= {};
  for (const [event, matcher] of Object.entries(HOOK_EVENTS)) {
    // Drop hook entries pointing at old kit folders, then add ours once.
    const pointsToOldKit = (entry) => OLD_KIT_FOLDERS.some((old) => JSON.stringify(entry).includes(`/${old}/hook.mjs`));
    const entries = (settings.hooks[event] = (settings.hooks[event] ?? []).filter((entry) => !pointsToOldKit(entry)));
    if (JSON.stringify(entries).includes(`${KIT_FOLDER}/hook.mjs`)) continue;
    entries.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: HOOK_COMMAND }] });
  }
  writeJson(file, settings);
}

/**
 * Adds the hub connection and the hooks to the repo's Codex config, between
 * marker lines so running the installer again replaces just this part and
 * keeps whatever else the file holds. No secret goes in: the MCP connection
 * gets its key from a helper that reads this clone's Git config.
 */
function addCodexConfig(file, hubUrl) {
  const hooks = CODEX_HOOK_EVENTS.map(([event, matcher]) => [
    `[[hooks.${event}]]`,
    ...(matcher ? [`matcher = ${JSON.stringify(matcher)}`] : []),
    `[[hooks.${event}.hooks]]`,
    'type = "command"',
    `command = '${CODEX_HOOK_COMMAND}'`,
    "",
  ].join("\n"));
  const block = [
    CODEX_BLOCK_START,
    "[mcp_servers.agent-hub]",
    `url = ${JSON.stringify(`${hubUrl.replace(/\/$/, "")}/mcp`)}`,
    `http_headers_helper = '${CODEX_HEADERS_COMMAND}'`,
    // The hub's tools only coordinate (chat, locks, tasks), so agents don't wait for approval on each call.
    'default_tools_approval_mode = "approve"',
    "",
    ...hooks,
    CODEX_BLOCK_END,
    "",
  ].join("\n");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const start = current.indexOf(CODEX_BLOCK_START);
  const end = current.indexOf(CODEX_BLOCK_END);
  const kept = (start === -1 || end === -1 ? current : `${current.slice(0, start)}${current.slice(end + CODEX_BLOCK_END.length)}`).trim();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${kept}${kept ? "\n\n" : ""}${block}`);
}

/** Appends the coordination rules to AGENTS.md unless they are already there. */
function addRules(file) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current.includes(RULES_MARKER)) return;
  fs.writeFileSync(file, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${current ? "\n" : ""}${RULES}`);
}

/** Writes pretty-printed JSON, creating the folder if needed. */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
