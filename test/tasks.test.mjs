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

test('tasks can be added and moved over HTTP, and a task being worked on cannot be taken over', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-tasks-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const keys = { alice: 'alice-tasks-key', bob: 'bob-tasks-key' };
  const records = Object.fromEntries(Object.entries(keys).map(([login, key]) => [hash(key), { login, project: 'team/project', createdAt: Date.now() }]));
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ projects: {}, keys: records }));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(source, 'server.mjs')], { env: { ...process.env, PORT: String(port), AGENT_HUB_DATA_DIR: dir, AGENT_HUB_TOKEN: 'admin-tasks-key' }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const call = async (route, key, body) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await call('/api/tasks', keys.alice, { title: '  ' })).status, 400, 'a task needs a title');
  // The admin token cannot invent an agent: it may only act as one linked to a signed-in GitHub person.
  assert.equal((await call('/api/tasks?project=team/project&agent=ghost/agent', 'admin-tasks-key', { title: 'x' })).status, 403);  const added = await call('/api/tasks?as=human', keys.alice, { title: 'Write the docs' });
  assert.equal(added.status, 200);
  const id = added.body.id;
  assert.equal(added.body.status, 'todo');

  // Alice's agent claims it; bob's agent is refused while it is in progress (people may step in; see agents-under-people).
  assert.equal((await call(`/api/tasks/${id}`, keys.alice, { status: 'doing', note: 'drafting' })).body.owner, 'alice/agent');
  assert.equal((await call(`/api/tasks/${id}`, keys.bob, { status: 'doing' })).status, 409);
  // The PR number is stored on the task, must be a positive whole number, and survives later updates.
  assert.equal((await call(`/api/tasks/${id}`, keys.alice, { status: 'doing', pr: 'abc' })).status, 400);
  assert.equal((await call(`/api/tasks/${id}`, keys.alice, { status: 'doing', pr: 17 })).body.pr, 17);
  assert.equal((await call(`/api/tasks/${id}`, keys.alice, { status: 'doing' })).body.pr, 17);

  // The owner can block it with a reason, which still keeps others out, then release it.
  const blocked = await call(`/api/tasks/${id}`, keys.alice, { status: 'blocked', note: 'waiting for review' });
  assert.equal(blocked.body.status, 'blocked');
  assert.equal((await call(`/api/tasks/${id}`, keys.bob, { status: 'doing' })).status, 409);
  const released = await call(`/api/tasks/${id}`, keys.alice, { status: 'todo' });
  assert.equal(released.body.owner, '');

  // Once free, bob's agent can take it and finish it; finished tasks keep their owner.
  assert.equal((await call(`/api/tasks/${id}`, keys.bob, { status: 'doing' })).body.owner, 'bob/agent');
  assert.equal((await call(`/api/tasks/${id}`, keys.bob, { status: 'done' })).body.owner, 'bob/agent');

  assert.equal((await call(`/api/tasks/${id}`, keys.bob, { status: 'sleeping' })).status, 400);
  assert.equal((await call('/api/tasks/999', keys.bob, { status: 'doing' })).status, 404);
  assert.equal((await call('/api/state', keys.alice)).body.tasks.length, 1);
});
