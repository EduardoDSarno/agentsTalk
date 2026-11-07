#!/usr/bin/env node
// One-time setup for a teammate: run `node .agent-hub/join.mjs` inside your clone of the team repo.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const KIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(fs.readFileSync(path.join(KIT_DIR, "config.json"), "utf8"));
const HUB_URL = CONFIG.hubUrl.replace(/\/$/, "");
const CHANNEL_FILE = path.join(KIT_DIR, "channel.mjs");
const PRE_COMMIT_MARKER = "agent-hub";
const PRE_COMMIT_SCRIPT = `#!/bin/sh\n# ${PRE_COMMIT_MARKER}: refuse commits of files a teammate has locked\nexec node "$(git rev-parse --show-toplevel)/.agent-hub/pre-commit.mjs"\n`;

await main();

/**
 * Connects this clone and this person's Claude Code to the team hub: asks who
 * you are, saves the hub settings in this clone's Git config (read by the
 * hook and the pre-commit check), installs the pre-commit check, and adds the
 * hub tools and the wake-up channel to Claude Code for this project.
 */
async function main() {
  const repo = git(["rev-parse", "--show-toplevel"]).trim();
  const human = await askWho();
  const agent = `${human}${CONFIG.agentSuffix}`;

  for (const [key, value] of Object.entries({ url: HUB_URL, token: CONFIG.token, name: agent })) {
    git(["config", `agenthub.${key}`, value], repo);
  }
  console.log(`✓ This clone now talks to the hub as "${agent}"`);

  installPreCommit(repo);
  const claudeReady = connectClaudeCode(repo, agent);
  printNextSteps(human, agent, claudeReady);
}

/** Shows the team list and returns the chosen person, asking again on a bad answer. */
async function askWho() {
  const lines = createInterface({ input: process.stdin });
  console.log("\nWho are you?");
  CONFIG.team.forEach((name, i) => console.log(`  ${i + 1}) ${name}`));
  process.stdout.write("Type a number: ");
  for await (const line of lines) {
    const answer = line.trim();
    const human = CONFIG.team[Number(answer) - 1] ?? CONFIG.team.find((name) => name === answer.toLowerCase());
    if (human) {
      lines.close();
      return human;
    }
    process.stdout.write("That's not on the list, try again: ");
  }
  throw new Error("No answer given");
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
 * Old entries are removed first so running join again just refreshes them.
 * Returns false when Claude Code isn't installed.
 */
function connectClaudeCode(repo, agent) {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
  } catch {
    console.log("! Claude Code not found; skipped. Install it, then run this script again.");
    return false;
  }
  for (const name of ["agent-hub", "agent-hub-chat"]) claude(["mcp", "remove", name, "-s", "local"], repo, true);
  claude(["mcp", "add", "--transport", "http", "-s", "local", "agent-hub", mcpUrl(agent)], repo);
  claude(["mcp", "add", "agent-hub-chat", "-s", "local",
    "-e", `AGENT_HUB_URL=${HUB_URL}`, "-e", `AGENT_HUB_NAME=${agent}`, "-e", `AGENT_HUB_TOKEN=${CONFIG.token}`,
    "--", "node", CHANNEL_FILE], repo);
  console.log("✓ Claude Code connected: team tools, automatic file locks and wake-up channel");
  return true;
}

/** Prints how to start working, open the dashboard and connect other tools. */
function printNextSteps(human, agent, claudeReady) {
  const dashboard = `${HUB_URL}/?token=${encodeURIComponent(CONFIG.token)}`;
  console.log(`\nAll set, ${human}! Your agent is @${agent}.\n`);
  console.log(`Team dashboard (open in your browser):\n  ${dashboard}\n`);
  if (claudeReady) {
    console.log("Start Claude Code here so teammates can wake it with @mentions:");
    console.log("  claude --dangerously-load-development-channels server:agent-hub-chat");
    console.log("(First time: pick \"I am using this for local development\".)\n");
  }
  console.log("Using Cursor, Codex or another tool? Give it this MCP server URL:");
  console.log(`  ${mcpUrl(agent)}\n`);
}

/** Builds this agent's MCP address on the hub. */
function mcpUrl(agent) {
  return `${HUB_URL}/mcp?agent=${encodeURIComponent(agent)}&token=${encodeURIComponent(CONFIG.token)}`;
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
