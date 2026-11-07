#!/usr/bin/env node
// One-time setup for a teammate: run `node agentstalk` (or `agentstalk`) inside your clone of the team repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const KIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const KIT_FOLDER = path.basename(KIT_DIR);
const CONFIG = JSON.parse(fs.readFileSync(path.join(KIT_DIR, "config.json"), "utf8"));
const HUB_URL = CONFIG.hubUrl.replace(/\/$/, "");
// Kits made before projects existed have none; the hub then uses its default project.
const PROJECT = CONFIG.project ?? "";
const AGENT_SUFFIX = CONFIG.agentSuffix ?? "-agent";
const CHANNEL_FILE = path.join(KIT_DIR, "channel.mjs");
const PRE_COMMIT_MARKER = "agent-hub";
const PRE_COMMIT_SCRIPT = `#!/bin/sh\n# ${PRE_COMMIT_MARKER}: refuse commits of files a teammate has locked\nexec node "$(git rev-parse --show-toplevel)/${KIT_FOLDER}/pre-commit.mjs"\n`;
// Per-person files shared by every repo this person joins.
const HOME_DIR = path.join(os.homedir(), ".agentstalk");
const IDENTITY_FILE = path.join(HOME_DIR, "identity.json");
const BIN_DIR = path.join(HOME_DIR, "bin");
const COMMAND_NAME = "agentstalk";
const SHELL_RC_MARKER = "# agentsTalk command";
const CHANNEL_FLAG = "--dangerously-load-development-channels server:agent-hub-chat";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
// GitHub asks clients that poll too fast to add this much to their wait.
const SLOW_DOWN_EXTRA_SECONDS = 5;
const HUB_TIMEOUT_MS = 5000;

await main();

/**
 * Connects this clone and this person's Claude Code to the team hub. The
 * person's name comes from their GitHub account (signed in once, then
 * remembered for every repo); the hub settings go into this clone's Git
 * config for the hook and the commit check; the person is registered as a
 * project member; Claude Code gets the hub tools and wake-up channel; and the
 * `agentstalk` command is installed for starting Claude connected.
 */
async function main() {
  const repo = git(["rev-parse", "--show-toplevel"]).trim();
  const human = (await githubLogin(process.argv.includes("--switch-user"))).toLowerCase();
  const agent = `${human}${AGENT_SUFFIX}`;

  for (const [key, value] of Object.entries({ url: HUB_URL, token: CONFIG.token, project: PROJECT, name: agent })) {
    git(["config", `agenthub.${key}`, value], repo);
  }
  console.log(`✓ This clone now talks to the hub as "${agent}" in project "${PROJECT || "default"}"`);

  await registerMember(human, agent);
  installPreCommit(repo);
  const claudeReady = connectClaudeCode(repo, agent);
  const commandReady = installCommand();
  printNextSteps(human, agent, claudeReady, commandReady);
}

/**
 * Returns the person's GitHub username. It signs in with GitHub's device
 * flow through the team's agentsTalk GitHub App the first time, then reuses
 * the remembered name. Without a GitHub App in the kit, it asks for the name.
 */
async function githubLogin(forceNew) {
  const saved = readIdentity();
  if (saved && !forceNew) {
    console.log(`✓ Using your GitHub name "${saved}" (run with --switch-user to change it)`);
    return saved;
  }
  const login = CONFIG.githubClientId ? await signInWithGitHub(CONFIG.githubClientId) : await askGitHubName();
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(IDENTITY_FILE, `${JSON.stringify({ login }, null, 2)}\n`);
  return login;
}

/**
 * Runs GitHub's device sign-in: shows a short code, opens the GitHub page
 * where the person approves it, waits for approval, then reads their
 * username. Only the username is kept; the access token is thrown away.
 */
async function signInWithGitHub(clientId) {
  const device = await postForm(GITHUB_DEVICE_CODE_URL, { client_id: clientId });
  if (!device.device_code) throw new Error(`GitHub sign-in failed: ${device.error_description ?? device.error ?? "no device code"}`);
  console.log(`\nSign in with GitHub: open ${device.verification_uri} and enter the code  ${device.user_code}`);
  openInBrowser(device.verification_uri);

  let waitSeconds = device.interval;
  const deadline = Date.now() + device.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    const result = await postForm(GITHUB_TOKEN_URL, { client_id: clientId, device_code: device.device_code, grant_type: DEVICE_GRANT_TYPE });
    if (result.access_token) {
      const user = await (await fetch(GITHUB_USER_URL, { headers: { authorization: `Bearer ${result.access_token}`, accept: "application/vnd.github+json" } })).json();
      console.log(`✓ Signed in as ${user.login}`);
      return user.login;
    }
    if (result.error === "slow_down") waitSeconds += SLOW_DOWN_EXTRA_SECONDS;
    else if (result.error !== "authorization_pending") throw new Error(`GitHub sign-in failed: ${result.error_description ?? result.error}`);
  }
  throw new Error("GitHub sign-in timed out; run the setup again");
}

/** Tells the hub this person and their agent are part of the project, for the dashboard's team list. */
async function registerMember(human, agent) {
  try {
    const url = `${HUB_URL}/api/join?project=${encodeURIComponent(PROJECT)}&agent=${encodeURIComponent(agent)}&token=${encodeURIComponent(CONFIG.token)}`;
    const response = await fetch(url, { method: "POST", body: JSON.stringify({ human }), signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`hub answered ${response.status}`);
    console.log("✓ Added you to the team on the dashboard");
  } catch (error) {
    console.log(`! Couldn't reach the hub (${error.message}); you'll appear on the dashboard once you start working`);
  }
}

/**
 * Installs the Git pre-commit check so no tool or human can commit files a
 * teammate has locked. An existing pre-commit hook from something else is
 * left alone, with a warning, rather than overwritten.
 */
function installPreCommit(repo) {
  const hookFile = path.resolve(repo, git(["rev-parse", "--git-path", "hooks/pre-commit"], repo).trim());
  if (fs.existsSync(hookFile) && !fs.readFileSync(hookFile, "utf8").includes(PRE_COMMIT_MARKER)) {
    console.log(`! Skipped the commit check: ${hookFile} already exists for something else`);
    return;
  }
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.writeFileSync(hookFile, PRE_COMMIT_SCRIPT, { mode: 0o755 });
  console.log("✓ Commit check installed (commits of files locked by teammates are refused)");
}

/**
 * Adds the hub tools and the wake-up channel to Claude Code for this project.
 * Old entries are removed first so running the setup again just refreshes them.
 * Returns false when Claude Code isn't installed.
 */
function connectClaudeCode(repo, agent) {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
  } catch {
    console.log("! Claude Code not found; skipped. Install it, then run this setup again.");
    return false;
  }
  for (const name of ["agent-hub", "agent-hub-chat"]) claude(["mcp", "remove", name, "-s", "local"], repo, true);
  claude(["mcp", "add", "--transport", "http", "-s", "local", "agent-hub", mcpUrl(agent)], repo);
  claude(["mcp", "add", "agent-hub-chat", "-s", "local",
    "-e", `AGENT_HUB_URL=${HUB_URL}`, "-e", `AGENT_HUB_NAME=${agent}`, "-e", `AGENT_HUB_TOKEN=${CONFIG.token}`,
    "-e", `AGENT_HUB_PROJECT=${PROJECT}`,
    "--", "node", CHANNEL_FILE], repo);
  console.log("✓ Claude Code connected: team tools, automatic file locks and wake-up channel");
  return true;
}

/**
 * Installs the `agentstalk` terminal command in ~/.agentstalk/bin and puts
 * that folder on the PATH in the person's shell startup files. Inside any
 * team repo the command sets the clone up if needed and starts Claude Code
 * with the wake-up channel on. Returns true when the command already works in
 * this terminal, false when a new terminal is needed.
 */
function installCommand() {
  if (process.platform === "win32") return false;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(path.join(BIN_DIR, COMMAND_NAME), commandScript(), { mode: 0o755 });
  for (const rc of [".zshrc", ".bashrc"].map((name) => path.join(os.homedir(), name))) {
    if (rc.endsWith(".bashrc") && !fs.existsSync(rc)) continue;
    const current = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : "";
    if (current.includes(SHELL_RC_MARKER)) continue;
    fs.appendFileSync(rc, `\n${SHELL_RC_MARKER}\nexport PATH="$HOME/.agentstalk/bin:$PATH"\n`);
  }
  console.log(`✓ Installed the "${COMMAND_NAME}" command`);
  return (process.env.PATH ?? "").split(path.delimiter).includes(BIN_DIR);
}

/** The shell script behind the `agentstalk` command. */
function commandScript() {
  return `#!/bin/sh
# agentsTalk: start Claude Code connected to your team, setting this clone up first if needed.
root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "agentstalk: run this inside a team repo"; exit 1; }
[ -f "$root/${KIT_FOLDER}/join.mjs" ] || { echo "agentstalk: this repo has no agentsTalk kit"; exit 1; }
cd "$root" || exit 1
if [ "$1" = "setup" ]; then shift; exec node ${KIT_FOLDER} "$@"; fi
git config --get agenthub.name >/dev/null || node ${KIT_FOLDER} || exit 1
exec claude ${CHANNEL_FLAG} "$@"
`;
}

/** Prints how to start working, open the dashboard and connect other tools. */
function printNextSteps(human, agent, claudeReady, commandReady) {
  const dashboard = `${HUB_URL}/?project=${encodeURIComponent(PROJECT)}&token=${encodeURIComponent(CONFIG.token)}`;
  console.log(`\nAll set, ${human}! Your agent is @${agent}.\n`);
  console.log(`Team dashboard (open in your browser):\n  ${dashboard}\n`);
  if (claudeReady) {
    console.log(`Start working: type  ${COMMAND_NAME}  in this repo${commandReady ? "" : " (open a new terminal first)"}.`);
    console.log("It starts Claude Code so teammates can wake it with @mentions.");
    console.log("(First time: pick \"I am using this for local development\".)\n");
  }
  console.log("Using Cursor, Codex or another tool? Give it this MCP server URL:");
  console.log(`  ${mcpUrl(agent)}\n`);
}

/** Asks for a GitHub username when the kit has no GitHub App to sign in with. */
async function askGitHubName() {
  const lines = createInterface({ input: process.stdin });
  process.stdout.write("Your GitHub username: ");
  for await (const line of lines) {
    const name = line.trim();
    if (/^[a-z0-9-]+$/i.test(name)) {
      lines.close();
      return name;
    }
    process.stdout.write("That doesn't look like a GitHub username, try again: ");
  }
  throw new Error("No answer given");
}

/** Reads the remembered GitHub username, if this person signed in before. */
function readIdentity() {
  try {
    return JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8")).login;
  } catch {
    return undefined;
  }
}

/** Sends a form to GitHub and returns its JSON answer. */
async function postForm(url, fields) {
  const response = await fetch(url, { method: "POST", headers: { accept: "application/json" }, body: new URLSearchParams(fields) });
  return response.json();
}

/** Opens a web page in the default browser when possible; the printed link is the fallback. */
function openInBrowser(url) {
  const opener = { darwin: "open", win32: "explorer" }[process.platform] ?? "xdg-open";
  try {
    execFileSync(opener, [url], { stdio: "ignore" });
  } catch {
    // No browser available: the person uses the printed link.
  }
}

/** Builds this agent's MCP address on the hub. */
function mcpUrl(agent) {
  return `${HUB_URL}/mcp?project=${encodeURIComponent(PROJECT)}&agent=${encodeURIComponent(agent)}&token=${encodeURIComponent(CONFIG.token)}`;
}

/** Runs a Claude Code CLI command in the repo; `quiet` ignores failures such as removing a missing entry. */
function claude(args, cwd, quiet = false) {
  try {
    execFileSync("claude", args, { cwd, stdio: quiet ? "ignore" : ["ignore", "ignore", "inherit"] });
  } catch (error) {
    if (!quiet) throw error;
  }
}

/** Runs a Git command and returns its output. */
function git(args, cwd = KIT_DIR) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
