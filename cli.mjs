#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { installKit } from './install-kit.mjs';
import { githubRepoFromRemote } from './kit/github-repo.mjs';

const DEFAULT_HUB = 'https://agentstalk-production.up.railway.app';
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    hub: { type: 'string' }, agent: { type: 'string', default: 'auto' },
    'switch-user': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: agentstalk [init|join] [--agent auto|claude|codex|none] [--hub URL] [--switch-user]\n\nRun init once in a GitHub repository, then commit the public kit.\nFriends run agentstalk in their clones to sign in and join the same project.\nUses the hosted agentsTalk hub by default.');
  } else {
    const command = positionals[0] ?? 'join';
    if (positionals.length > 1 || !['init', 'join', 'setup'].includes(command)) throw new Error('Expected init or join. Run agentstalk --help.');
    if (!['auto', 'claude', 'codex', 'none'].includes(values.agent)) throw new Error('--agent must be auto, claude, codex or none');
    let root, remote;
    try {
      root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { throw new Error('Run agentstalk inside a Git repository with a GitHub origin remote.'); }
    const repo = githubRepoFromRemote(remote);
    if (!repo) throw new Error('The origin remote must point to a GitHub repository (HTTPS or SSH).');
    const configPath = path.join(root, 'agentstalk/config.json');
    const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : undefined;
    const hub = new URL(values.hub ?? existing?.hubUrl ?? DEFAULT_HUB);
    if (hub.username || hub.password || hub.search || hub.hash || hub.pathname !== '/' ||
        (hub.protocol !== 'https:' && !(hub.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hub.hostname)))) {
      throw new Error('--hub must be an HTTPS origin (HTTP is allowed only for localhost development).');
    }
    console.log(`Connecting ${repo} to ${hub.origin}`);
    // Refresh the kit for new CLI features, while retaining its selected hub.
    await installKit(root, hub.origin);
    execFileSync(process.execPath, [path.join(root, 'agentstalk/join.mjs'), '--agent', values.agent, '--no-command', ...(values['switch-user'] ? ['--switch-user'] : [])], { cwd: root, stdio: 'inherit' });
    if (command === 'init') console.log('Next: commit the public agentstalk kit, AGENTS.md and agent settings. Friends can then run npx agentstalk.');
  }
} catch (error) {
  console.error(`agentsTalk: ${error.status ? 'setup failed' : error.message}`);
  process.exitCode = 1;
}
