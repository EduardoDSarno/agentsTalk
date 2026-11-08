import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const hash = (key) => createHash('sha256').update(key).digest('hex');
const PROJECT = 'boss/project';

test('only the repo owner can remove a person; their key stops working and their locks are released', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-remove-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const keys = { boss: 'boss-remove-key', bob: 'bob-remove-key', carol: 'carol-remove-key' };
  const members = Object.fromEntries(Object.keys(keys).map((login) => [login, { agent: `${login}-agent`, joinedAt: 1 }]));
  const records = Object.fromEntries(Object.entries(keys).map(([login, key]) => [hash(key), { login, project: PROJECT, createdAt: Date.now() }]));
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ projects: { [PROJECT]: { members } }, keys: records }));

  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(source, 'server.mjs')], { env: { ...process.env, PORT: String(port), AGENT_HUB_DATA_DIR: dir, AGENT_HUB_TOKEN: 'admin-remove-key' }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const call = async (route, key, body) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };

  await call('/api/lock', keys.bob, { paths: ['src/a.ts'], reason: 'editing' });

  // A teammate cannot remove anyone, and nobody can remove the owner.
  assert.equal((await call('/api/members/remove', keys.carol, { login: 'bob' })).status, 403);
  assert.equal((await call('/api/members/remove', keys.boss, { login: 'boss' })).status, 400);
  assert.equal((await call('/api/members/remove', keys.boss, { login: 'nobody' })).status, 404);

  const removed = await call('/api/members/remove', keys.boss, { login: 'bob' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.agents, ['bob/agent']);

  const state = (await call('/api/state', keys.boss)).body;
  assert.deepEqual(state.members.map((member) => member.name).sort(), ['boss', 'carol']);
  assert.equal(state.locks.length, 0, 'their locks are released');
  assert.match(state.events[0].text, /removed bob and bob\/agent/);
  assert.equal((await call('/api/state', keys.bob)).status, 401, 'their key no longer works');
});
