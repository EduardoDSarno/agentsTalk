#!/usr/bin/env node
// Copies the agent-hub kit into a team repo. Run once, by whoever sets up the team:
//   node install-kit.mjs <path-to-team-repo> --hub <hub-url> --token <team-token> [--team eduardo,victor,ratinder]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const KIT_FOLDER = ".agent-hub";
const AGENT_SUFFIX = "-agent";
const DEFAULT_TEAM = "eduardo,victor,ratinder";
const HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${KIT_FOLDER}/hook.mjs"`;
const HOOK_EVENTS = {
  SessionStart: undefined,
  UserPromptSubmit: undefined,
  PreToolUse: "Edit|Write|MultiEdit|NotebookEdit",
  PostToolUse: undefined,
};
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
 * with the hub address and token, the shared Claude Code hook settings, and
 * the coordination rules other agents read from AGENTS.md.
 */
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      hub: { type: "string" },
      token: { type: "string" },
      team: { type: "string", default: DEFAULT_TEAM },
      project: { type: "string" },
    },
  });
  const repo = positionals[0];
  if (!repo || !values.hub || !values.token) {
    console.error("Usage: node install-kit.mjs <path-to-team-repo> --hub <hub-url> --token <team-token> [--team a,b,c] [--project name]");
    process.exit(1);
  }
  const project = (values.project ?? projectNameOf(repo)).toLowerCase();
  const kit = path.join(repo, KIT_FOLDER);
  fs.mkdirSync(kit, { recursive: true });

  for (const file of ["hook.mjs", "pre-commit.mjs", "kit/join.mjs"]) fs.copyFileSync(path.join(DIR, file), path.join(kit, path.basename(file)));
  await bundleChannel(path.join(kit, "channel.mjs"));
  const team = values.team.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  writeJson(path.join(kit, "config.json"), { hubUrl: values.hub, token: values.token, project, team, agentSuffix: AGENT_SUFFIX });
  addHookSettings(path.join(repo, ".claude", "settings.json"));
  addRules(path.join(repo, "AGENTS.md"));

  console.log(`Kit installed in ${path.resolve(repo)} as project "${project}".`);
  console.log("Next: commit and push it (keep the repo private, it holds the team token).");
  console.log(`Teammates then clone the repo and run: node ${KIT_FOLDER}/join.mjs`);
}

/**
 * Picks the project name the hub keeps this repo's chat and locks under: the
 * GitHub repo name when there is an origin remote, so every clone agrees,
 * otherwise the folder name.
 */
function projectNameOf(repo) {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return path.basename(remote).replace(/\.git$/, "");
  } catch {
    return path.basename(path.resolve(repo));
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
    const entries = (settings.hooks[event] ??= []);
    if (JSON.stringify(entries).includes(`${KIT_FOLDER}/hook.mjs`)) continue;
    entries.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: HOOK_COMMAND }] });
  }
  writeJson(file, settings);
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
