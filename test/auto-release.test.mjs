import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const hash = (key) => createHash('sha256').update(key).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('locks are released after git push, except for files still changed or not pushed', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-release-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const key = 'alice-release-key';
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ projects: {}, keys: { [hash(key)]: { login: 'alice', project: 'team/project', createdAt: Date.now() } } }));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(source, 'server.mjs')], { env: { ...process.env, PORT: String(port), AGENT_HUB_DATA_DIR: dir, AGENT_HUB_TOKEN: 'admin-release-key' }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const call = async (route, body) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return response.json();
  };
  const lockedPaths = async () => (await call('/api/state')).locks.map((lock) => lock.path).sort();

  // Server side: only files not in the dirty list are released, and only on the given branch.
  await call('/api/lock?branch=main', { paths: ['a.txt', 'b.txt', 'c.txt'] });
  await call('/api/lock?branch=other', { paths: ['d.txt'] });
  assert.deepEqual((await call('/api/release?branch=main', { dirty: ['b.txt', './c.txt'] })).released, ['a.txt']);
  assert.deepEqual(await lockedPaths(), ['b.txt', 'c.txt', 'd.txt']);
  assert.deepEqual((await call('/api/release', { dirty: [] })).released, [], 'without a branch nothing is released');
  await call('/api/unlock', {});

  // Hook side, in a real clone with an upstream: lock three files, push one of them.
  const remote = path.join(dir, 'remote.git');
  const clone = path.join(dir, 'clone');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, clone], { stdio: 'ignore' });
  git(clone, 'config', 'user.email', 't@example.com');
  git(clone, 'config', 'user.name', 'T');
  for (const [name, value] of Object.entries({ url: base, key, project: 'team/project' })) git(clone, 'config', `agenthub.${name}`, value);
  for (const file of ['pushed.txt', 'unpushed.txt', 'dirty.txt']) await fs.writeFile(path.join(clone, file), 'one\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'base');
  git(clone, 'push', '-q', '-u', 'origin', 'main');
  await call('/api/lock?branch=main', { paths: ['pushed.txt', 'unpushed.txt', 'dirty.txt'] });
  await fs.writeFile(path.join(clone, 'pushed.txt'), 'two\n');
  git(clone, 'commit', '-qam', 'change pushed');
  git(clone, 'push', '-q');
  await fs.writeFile(path.join(clone, 'unpushed.txt'), 'two\n');
  git(clone, 'commit', '-qam', 'change unpushed, not pushed');
  await fs.writeFile(path.join(clone, 'dirty.txt'), 'two\n');

  // The hook reads the hub address and key from the clone's Git config, as after a real setup.
  const { AGENT_HUB_KEY, AGENT_HUB_URL, ...env } = process.env;
  const runHook = (command) => execFileSync(process.execPath, [path.join(source, 'hook.mjs')], {
    cwd: clone,
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: clone, tool_input: { command } }),
    encoding: 'utf8',
    env: { ...env, CLAUDE_PROJECT_DIR: clone },
  });
  runHook('ls');
  assert.deepEqual(await lockedPaths(), ['dirty.txt', 'pushed.txt', 'unpushed.txt'], 'a command that is not a push releases nothing');
  runHook('git push origin main');
  assert.deepEqual(await lockedPaths(), ['dirty.txt', 'unpushed.txt'], 'only the fully pushed file is released');
});
