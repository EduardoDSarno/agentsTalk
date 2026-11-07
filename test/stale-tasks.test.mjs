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
const HOUR = 60 * 60_000;

test('a task whose owner went quiet for a long time is stale and can be taken over', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-stale-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const key = 'alice-stale-key';
  const now = Date.now();
  const task = (id, status, owner, updatedAt) => ({ id, title: `task ${id}`, status, owner, note: '', updatedAt });
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({
    projects: { 'team/project': { nextTaskId: 5, tasks: [
      task(1, 'doing', 'bob-agent', now - 3 * HOUR),
      task(2, 'doing', 'bob-agent', now),
      task(3, 'blocked', 'bob-agent', now - 3 * HOUR),
      task(4, 'todo', '', now - 3 * HOUR),
    ] } },
    keys: { [hash(key)]: { login: 'alice', project: 'team/project', createdAt: now } },
  }));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(source, 'server.mjs')], { env: { ...process.env, PORT: String(port), AGENT_HUB_DATA_DIR: dir, AGENT_HUB_TOKEN: 'admin-stale-key' }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const call = async (route, body) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: response.headers.get('content-type').includes('json') ? await response.json() : await response.text() };
  };

  // Only owned tasks that have been quiet for long are stale; a free task never is.
  const tasks = (await call('/api/state')).body.tasks;
  assert.deepEqual(tasks.map((entry) => entry.stale), [true, false, true, false]);
  assert.match((await call('/api/status')).body, /#1 \[doing\] bob-agent \(stale, you may take it over\): task 1/);
  assert.doesNotMatch((await call('/api/status')).body, /#2 \[doing\] bob-agent \(stale/);

  // A fresh task is still protected, a stale one can be taken over, and the takeover is logged.
  assert.equal((await call('/api/tasks/2', { status: 'doing' })).status, 409);
  const taken = await call('/api/tasks/1', { status: 'doing', note: 'continuing' });
  assert.equal(taken.status, 200);
  assert.equal(taken.body.owner, 'alice-agent');
  assert.equal((await call('/api/tasks/3', { status: 'doing' })).body.owner, 'alice-agent', 'blocked stale tasks can be taken over too');
  const state = (await call('/api/state')).body;
  assert.equal(state.tasks[0].stale, false, 'after the takeover it is fresh again');
  assert.ok(state.events.some((event) => event.text === 'took over stale task #1 from bob-agent'));
});
