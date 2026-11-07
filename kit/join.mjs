#!/usr/bin/env node
// One-time setup for a teammate: run `node agentstalk` (or `agentstalk`) inside your clone of the team repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { githubRepoFromRemote } from "./github-repo.mjs";

const KIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const KIT_FOLDER = path.basename(KIT_DIR);
const CONFIG = JSON.parse(fs.readFileSync(path.join(KIT_DIR, "config.json"), "utf8"));
const HUB_URL = CONFIG.hubUrl.replace(/\/$/, "");
const CHANNEL_FILE = path.join(KIT_DIR, "channel.mjs");
const PRE_COMMIT_MARKER = "agent-hub";
const PRE_COMMIT_SCRIPT = `#!/bin/sh\n# ${PRE_COMMIT_MARKER}: refuse commits of files a teammate has locked\nexec node "$(git rev-parse --show-toplevel)/${KIT_FOLDER}/pre-commit.mjs"\n`;
// Per-person files shared by every repo this person joins.
const HOME_DIR = process.env.AGENTSTALK_HOME ?? path.join(os.homedir(), ".agentstalk");
const GITHUB_LOGIN_FILE = path.join(HOME_DIR, "github.json");
const BIN_DIR = path.join(HOME_DIR, "bin");
const COMMAND_NAME = "agentstalk";
const SHELL_RC_MARKER = "# agentsTalk command";
const CHANNEL_FLAG = "--dangerously-load-development-channels server:agent-hub-chat";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API = "https://api.github.com";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
// Checking a private repo's access needs GitHub's broad "repo" permission; public repos need none.
const PRIVATE_REPO_SCOPE = "repo";
// GitHub asks clients that poll too fast to add this much to their wait.
const SLOW_DOWN_EXTRA_SECONDS = 5;
const HUB_TIMEOUT_MS = 10_000;

await main().catch((error) => {
  console.error(`agentsTalk: ${error.message}`);
  process.exitCode = 1;
});

/**
 * Connects this clone and this person's Claude Code to the team hub. The
 * person signs in with GitHub; the hub checks with GitHub that they can write
 * to this repo and hands back a personal key. Nothing secret is in the repo:
 * the key lives only in this clone's Git config and Claude Code's settings
 * on this computer. Then the commit check, Claude Code's tools and wake-up
 * channel, and the `agentstalk` command are set up.
 */
async function main() {
  const { values } = parseArgs({ options: { agent: { type: "string", default: "auto" }, "switch-user": { type: "boolean" }, "no-command": { type: "boolean" } } });
  if (!["auto", "claude", "codex", "none"].includes(values.agent)) throw new Error("Unknown agent; choose auto, claude, codex or none");
  const root = git(["rev-parse", "--show-toplevel"]).trim();
  const repo = githubRepoOf(root);
  const { githubClientId } = await hubJson("/api/config");
  if (!githubClientId) throw new Error("GitHub sign-in isn't turned on for this hub yet (GITHUB_OAUTH_CLIENT_ID is missing)");

  const membership = await joinWithGitHub(githubClientId, repo, values["switch-user"]);
  const { key, login, agent, project } = membership;
  for (const [name, value] of Object.entries({ url: HUB_URL, key, project, name: agent })) git(["config", `agenthub.${name}`, value], root);
  git(["config", "--unset", "agenthub.token"], root, true); // from kits that used a shared team token
  console.log(`✓ Joined ${project} as ${login}; your agent is "${agent}"`);

  installPreCommit(root);
  const claudeReady = ["auto", "claude"].includes(values.agent) && connectClaudeCode(root, key);
  const codexReady = ["auto", "codex"].includes(values.agent) && connectCodex(root, values.agent === "codex");
  const commandReady = !values["no-command"] && installCommand();
  printNextSteps(login, agent, key, { claudeReady, codexReady, commandReady });
}

/**
 * Proves to the hub, through GitHub, that this person can write to the repo,
 * and returns the personal key the hub issues. A GitHub sign-in is reused
 * across repos; a new one is requested when there is none, when it was
 * revoked, or when a private repo needs more permission than it has.
 */
async function joinWithGitHub(clientId, repo, forceNew) {
  const scope = (await isPublicRepo(repo)) ? "" : PRIVATE_REPO_SCOPE;
  let login = forceNew ? undefined : readGitHubLogin();
  if (!login || (scope && !login.scope.split(",").includes(scope))) login = await signInWithGitHub(clientId, scope);
  try {
    return await hubJson("/api/auth/github", { githubToken: login.token, repo });
  } catch (error) {
    if (error.status !== 401) throw error;
    // The saved GitHub sign-in no longer works (revoked or expired): sign in again once.
    return hubJson("/api/auth/github", { githubToken: (await signInWithGitHub(clientId, scope)).token, repo });
  }
}

/**
 * Runs GitHub's device sign-in: shows a short code, opens the GitHub page
 * where the person approves it, and waits for approval. The resulting GitHub
 * token is saved in ~/.agentstalk (readable only by this user) so joining
 * other repos doesn't ask again.
 */
async function signInWithGitHub(clientId, scope) {
  const device = await postForm(GITHUB_DEVICE_CODE_URL, { client_id: clientId, scope });
  if (!device.device_code) throw new Error(`GitHub sign-in failed: ${device.error_description ?? device.error ?? "no device code"}`);
  console.log(`\nSign in with GitHub: open ${device.verification_uri} and enter the code  ${device.user_code}`);
  if (scope) console.log("(This repo is private, so GitHub asks for access to your repositories; agentsTalk only uses it to check you're on the team.)");
  openInBrowser(device.verification_uri);

  let waitSeconds = device.interval ?? 5;
  const deadline = Date.now() + device.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    const result = await postForm(GITHUB_TOKEN_URL, { client_id: clientId, device_code: device.device_code, grant_type: DEVICE_GRANT_TYPE });
    if (result.access_token) {
      const login = { token: result.access_token, scope: result.scope ?? "" };
      fs.mkdirSync(HOME_DIR, { recursive: true });
      fs.writeFileSync(GITHUB_LOGIN_FILE, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 });
      console.log("✓ Signed in with GitHub");
      return login;
    }
    if (result.error === "slow_down") waitSeconds += SLOW_DOWN_EXTRA_SECONDS;
    else if (result.error !== "authorization_pending") throw new Error(`GitHub sign-in failed: ${result.error_description ?? result.error}`);
  }
  throw new Error("GitHub sign-in timed out; run the setup again");
}

/**
 * Installs the Git pre-commit check so no tool or human can commit files a
 * teammate has locked. An existing pre-commit hook from something else is
 * left alone, with a warning, rather than overwritten.
 */
function installPreCommit(root) {
  const hookFile = path.resolve(root, git(["rev-parse", "--git-path", "hooks/pre-commit"], root).trim());
  if (fs.existsSync(hookFile) && !fs.readFileSync(hookFile, "utf8").includes(PRE_COMMIT_MARKER)) {
    console.log(`! Skipped the commit check: ${hookFile} already exists for something else`);
    return;
  }
  fs.mkdirSync(path.dirname(hookFile), { recursive: true });
  fs.writeFileSync(hookFile, PRE_COMMIT_SCRIPT, { mode: 0o755 });
  console.log("✓ Commit check installed (commits of files locked by teammates are refused)");
}

/**
 * Adds the hub tools and the wake-up channel to Claude Code for this project,
 * passing the personal key in a header and in the channel's environment,
 * never in a URL. Old entries are removed first so running the setup again
 * just refreshes them. Returns false when Claude Code isn't installed.
 */
function connectClaudeCode(root, key) {
  if (!commandExists("claude")) return false;
  for (const name of ["agent-hub", "agent-hub-chat"]) claude(["mcp", "remove", name, "-s", "local"], root, true);
  claude(["mcp", "add", "--transport", "http", "-s", "local", "agent-hub", `${HUB_URL}/mcp`, "--header", `Authorization: Bearer ${key}`], root);
  claude(["mcp", "add", "agent-hub-chat", "-s", "local", "-e", `AGENT_HUB_URL=${HUB_URL}`, "-e", `AGENT_HUB_KEY=${key}`, "--", "node", CHANNEL_FILE], root);
  console.log("✓ Claude Code connected: team tools, automatic file locks and wake-up channel");
  return true;
}

/** Codex reads this project configuration after the user trusts the repository. */
function connectCodex(root, explicit) {
  if (!explicit) {
    try { execFileSync("codex", ["--version"], { stdio: "ignore" }); }
    catch { return false; }
  }
  const file = path.join(root, ".codex", "config.toml");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (/^\s*\[mcp_servers\.(?:agent-hub|"agent-hub"|'agent-hub')(?:\]|\.)/m.test(current)) {
    console.log("✓ Existing Codex agent-hub configuration preserved");
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}\n[mcp_servers.agent-hub]\ncommand = "node"\nargs = ["${KIT_FOLDER}/mcp-proxy.mjs"]\n`);
  console.log("✓ Codex connected. Start codex from the repo root and trust the project to enable its MCP tools.");
  console.log("  Trust the project hooks with /hooks. Codex receives mentions on its next action; idle wake-up is Claude-only.");
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
# agentsTalk: start Claude Code (or Codex, with "codex") connected to your team, setting this clone up first if needed.
root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "agentstalk: run this inside a team repo"; exit 1; }
[ -f "$root/${KIT_FOLDER}/join.mjs" ] || { echo "agentstalk: this repo has no agentsTalk kit"; exit 1; }
cd "$root" || exit 1
if [ "$1" = "setup" ]; then shift; exec node ${KIT_FOLDER} "$@"; fi
git config --get agenthub.key >/dev/null || node ${KIT_FOLDER} || exit 1
if [ "$1" = "codex" ]; then shift; exec codex "$@"; fi
exec claude ${CHANNEL_FLAG} "$@"
`;
}

/** Prints how to start working, open the dashboard and connect other tools. */
function printNextSteps(login, agent, key, { claudeReady, codexReady, commandReady }) {
  console.log(`\nAll set, ${login}! Your agent is @${agent}.\n`);
  // The key goes after "#", which browsers never send to servers or keep in server logs.
  console.log(`Your dashboard link (personal, don't share it):\n  ${HUB_URL}/#key=${key}\n`);
  if (claudeReady) {
    console.log(commandReady ? `Start working: type ${COMMAND_NAME} in this repo.` : `Start Claude with: claude ${CHANNEL_FLAG}`);
    console.log("It starts Claude Code so teammates can wake it with @mentions.");
    console.log("(First time: pick \"I am using this for local development\".)\n");
  }
  if (codexReady) {
    console.log(commandReady ? `Start Codex: ${COMMAND_NAME} codex` : "Start Codex from this repo root: codex");
    console.log("First time: trust the folder, then run /hooks to trust agentsTalk’s hooks.");
    console.log("Codex can't be woken by @mentions; it sees them on its next action.\n");
  }
  console.log("Using Cursor or another tool? Add an MCP server with:");
  console.log(`  URL:    ${HUB_URL}/mcp`);
  console.log(`  Header: Authorization: Bearer ${key}\n`);
}

/** Reads the repo's "owner/name" from its GitHub remote, falling back to the kit's setting. */
function githubRepoOf(root) {
  const remote = git(["remote", "get-url", "origin"], root, true).trim();
  const repo = remote ? githubRepoFromRemote(remote) : CONFIG.repo;
  if (!repo) throw new Error("Couldn't tell which GitHub repo this is; the clone needs a GitHub 'origin' remote");
  return repo;
}

/** Checks whether the repo is public, which decides how much permission the GitHub sign-in asks for. */
async function isPublicRepo(repo) {
  const response = await fetch(`${GITHUB_API}/repos/${repo}`, { headers: { accept: "application/vnd.github+json", "user-agent": "agentsTalk" }, signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`GitHub repository lookup failed (${response.status}); try again later`);
  return true;
}

/** Calls the hub: GET without a body, POST with one. Fails with the hub's message and status. */
async function hubJson(route, body) {
  const response = await fetch(`${HUB_URL}${route}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error ?? `hub answered ${response.status}`), { status: response.status });
  return data;
}

/** Reads the saved GitHub sign-in, if this person signed in before. */
function readGitHubLogin() {
  try {
    return JSON.parse(fs.readFileSync(GITHUB_LOGIN_FILE, "utf8"));
  } catch {
    return undefined;
  }
}

/** Sends a form to GitHub and returns its JSON answer. */
async function postForm(url, fields) {
  const response = await fetch(url, { method: "POST", headers: { accept: "application/json" }, body: new URLSearchParams(fields), signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
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

/** Whether a command-line tool is installed, checked by asking for its version. */
function commandExists(name) {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Runs a Claude Code CLI command in the repo; `quiet` ignores failures such as removing a missing entry. */
function claude(args, cwd, quiet = false) {
  try {
    execFileSync("claude", args, { cwd, stdio: quiet ? "ignore" : ["ignore", "ignore", "inherit"] });
  } catch (error) {
    if (!quiet) throw error;
  }
}

/** Runs a Git command and returns its output; `quiet` returns "" instead of failing. */
function git(args, cwd = KIT_DIR, quiet = false) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    if (quiet) return "";
    throw error;
  }
}
