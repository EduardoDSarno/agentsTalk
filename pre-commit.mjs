#!/usr/bin/env node
// Git pre-commit hook for the agent hub. No dependencies: copy it into your project.
import { execFileSync } from "node:child_process";

const DEFAULT_HUB_URL = "http://localhost:4000";
const HUB_TIMEOUT_MS = 3000;
const REFUSE_EXIT_CODE = 1;

await main();

/**
 * Refuses a commit that includes files a teammate has locked on the hub.
 * It runs for every commit in this clone, whichever agent or human makes it,
 * so it also covers tools that don't get the Claude Code hook. If the hub is
 * unreachable or this clone isn't set up, the commit goes through with a warning.
 */
async function main() {
  const staged = git("diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean);
  if (!staged.length) return;
  const key = setting("AGENT_HUB_KEY", "key");
  if (!key) {
    console.error("agentsTalk: this clone isn't set up (run: node agentstalk); committing without the lock check");
    return;
  }
  try {
    const blocked = await findBlocked(key, staged);
    if (!blocked.length) return;
    console.error("Commit refused: these files are locked by a teammate on agentsTalk:");
    for (const b of blocked) console.error(`  ${b.path} (${b.owner}${b.reason ? `: ${b.reason}` : ""})`);
    console.error("Unstage them (git restore --staged <file>) and undo your changes, or ask the owner in the team chat.");
    process.exit(REFUSE_EXIT_CODE);
  } catch (error) {
    console.error(`agent-hub unreachable (${error.message}); committing without the lock check`);
  }
}

/** Asks the hub which of these files someone else has locked; the personal key tells it who and which repo. */
async function findBlocked(key, paths) {
  const hubUrl = setting("AGENT_HUB_URL", "url") || DEFAULT_HUB_URL;
  // Only locks on the branch being committed to count; other branches meet at merge time.
  const branch = git("branch", "--show-current").trim();
  const response = await fetch(`${hubUrl.replace(/\/$/, "")}/api/check?branch=${encodeURIComponent(branch)}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ paths }),
    signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`hub answered ${response.status}`);
  return (await response.json()).blocked;
}

/** Reads a setting from the environment, falling back to `git config agenthub.<key>`. */
function setting(envName, gitKey) {
  if (process.env[envName]) return process.env[envName];
  try {
    return git("config", "--get", `agenthub.${gitKey}`).trim();
  } catch {
    return ""; // not configured
  }
}

/** Runs a Git command in the repo and returns its output. */
function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
