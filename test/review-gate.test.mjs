import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const hash = (key) => createHash('sha256').update(key).digest('hex');
const PROJECT = 'team/project';

test('changes to main need another agent or a human to approve; the hook enforces it and agents are told', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-review-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const keys = { alice: 'alice-review-key', bob: 'bob-review-key' };
  const members = Object.fromEntries(Object.keys(keys).map((login) => [login, { agent: `${login}-agent`, joinedAt: 1 }]));
  const records = Object.fromEntries(Object.entries(keys).map(([login, key]) => [hash(key), { login, project: PROJECT, createdAt: Date.now() }]));
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ projects: { [PROJECT]: { members } }, keys: records }));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(source, 'server.mjs')], { env: { ...process.env, PORT: String(port), AGENT_HUB_DATA_DIR: dir, AGENT_HUB_TOKEN: 'admin-review-key' }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const call = async (route, key, body) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
  };

  // Alice's agent takes a task and links its PR: bob's agent is told once that a review is waiting.
  const task = (await call('/api/tasks', keys.alice, { title: 'Ship it' })).body.id;
  await call(`/api/tasks/${task}`, keys.alice, { status: 'doing', pr: 7 });
  const inbox = (await call('/api/inbox', keys.bob)).body;
  assert.match(inbox, /PR #7 .* needs a review/);
  assert.equal((await call('/api/inbox', keys.bob)).body.includes('needs a review'), false, 'told once, not on every call');
  assert.match((await call('/api/status', keys.bob)).body, /Waiting for your review[\s\S]*PR #7/);
  assert.equal((await call('/api/status', keys.alice)).body.includes('Waiting for your review'), false, 'not shown to the author');

  // Not allowed to merge yet, and the author cannot approve their own work.
  assert.match((await call('/api/merge-check?pr=7', keys.alice)).body.reason, /needs approval from someone other than alice\/agent/);
  assert.equal((await call('/api/reviews', keys.alice, { pr: 7, verdict: 'approved' })).status, 403);
  assert.equal((await call('/api/merge-check?pr=99', keys.alice)).body.allowed, false, 'an unknown PR is not allowed');

  // The hook refuses `gh pr merge 7` until approved, and a push straight from main.
  const clone = path.join(dir, 'clone');
  execFileSync('git', ['init', '-q', '-b', 'main', clone]);
  for (const [name, value] of Object.entries({ url: base, key: keys.alice, project: PROJECT })) execFileSync('git', ['-C', clone, 'config', `agenthub.${name}`, value]);
  execFileSync('git', ['-C', clone, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'base']);
  const { AGENT_HUB_KEY, AGENT_HUB_URL, ...env } = process.env;
  const hook = (command) => spawnSync(process.execPath, [path.join(source, 'hook.mjs')], {
    cwd: clone, encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: clone },
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: clone, tool_input: { command } }),
  });
  assert.equal(hook('gh pr merge 7 --squash').status, 2);
  assert.match(hook('gh pr merge 7').stderr, /needs approval/);
  assert.equal(hook('gh pr merge --squash').status, 2, 'a merge without a PR number cannot be checked');
  assert.equal(hook('git push origin main').status, 2, 'no pushing straight to main');
  assert.equal(hook('git status').status, 0);

  // Bob's agent asks for changes: still blocked, and alice's agent is told. A later approval from bob replaces it.
  await call('/api/reviews', keys.bob, { pr: 7, verdict: 'changes' });
  assert.match((await call('/api/merge-check?pr=7', keys.alice)).body.reason, /bob\/agent requested changes/);
  assert.match((await call('/api/inbox', keys.alice)).body, /bob\/agent requested changes on PR #7/);
  await call('/api/reviews', keys.bob, { pr: 7, verdict: 'approved', commit: 'abc1234' });
  assert.equal((await call('/api/merge-check?pr=7', keys.alice)).body.allowed, true);
  assert.equal(hook('gh pr merge 7 --squash').status, 0);

  // A human can approve too (the dashboard acts as the person), and changing the linked PR starts the reviews over.
  await call(`/api/tasks/${task}`, keys.alice, { status: 'doing', pr: 8 });
  assert.equal((await call('/api/merge-check?pr=8', keys.alice)).body.allowed, false);
  assert.equal((await call('/api/reviews?as=human', keys.bob, { pr: 8, verdict: 'approved' })).status, 200);
  assert.equal((await call('/api/merge-check?pr=8', keys.alice)).body.allowed, true);
});
