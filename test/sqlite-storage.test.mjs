import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const hash = (key) => createHash('sha256').update(key).digest('hex');
const KEY = 'alice-storage-key';

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

/** Starts the hub on a data folder; returns helpers and a stop function (signal chooses how it dies). */
async function startHub(dir) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(source, 'server.mjs')], { env: { ...process.env, PORT: String(port), AGENT_HUB_DATA_DIR: dir, AGENT_HUB_TOKEN: 'admin-storage-key' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`hub exited: ${errors}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const call = async (route, body, key = KEY) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const stop = async (signal = 'SIGTERM') => {
    if (child.exitCode !== null) return;
    const finished = once(child, 'exit');
    child.kill(signal);
    await finished;
  };
  return { base, call, stop, child };
}

const seed = (dir, extra = {}) => fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({
  projects: { 'team/project': { tasks: [{ id: 1, title: 'old task', status: 'todo', owner: '', note: '' }], nextTaskId: 2, ...extra } },
  keys: { [hash(KEY)]: { login: 'alice', project: 'team/project', createdAt: Date.now() } },
}));

test('the old state.json is imported once and never read again', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-import-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await seed(dir);
  let hub = await startHub(dir);
  t.after(() => hub.stop());
  assert.equal((await hub.call('/api/state')).body.tasks[0].title, 'old task');
  assert.deepEqual((await fs.readdir(dir)).filter((file) => file.startsWith('state.json')), ['state.json.imported']);

  // A stale state.json showing up later is ignored: the database is the source of truth.
  await hub.stop();
  await seed(dir, { tasks: [{ id: 1, title: 'stale file', status: 'todo', owner: '', note: '' }] });
  hub = await startHub(dir);
  assert.equal((await hub.call('/api/state')).body.tasks[0].title, 'old task');
});

test('an unreadable old state file stops the hub instead of dropping data', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-unreadable-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'state.json'), '{broken');
  await assert.rejects(startHub(dir), /Cannot read/);
});

test('a write survives the hub being killed right after it, and revoked keys stay revoked', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-crash-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await seed(dir);
  let hub = await startHub(dir);
  t.after(() => hub.stop());
  assert.equal((await hub.call('/api/tasks', { title: 'written just before the crash' })).status, 200);
  assert.equal((await hub.call('/api/admin/revoke', { project: 'team/project', login: 'alice' }, 'admin-storage-key')).body.revoked, 1);
  await hub.stop('SIGKILL');

  hub = await startHub(dir);
  const state = await hub.call('/api/state?project=team/project', undefined, 'admin-storage-key');
  assert.deepEqual(state.body.tasks.map((task) => task.title), ['old task', 'written just before the crash']);
  assert.equal((await hub.call('/api/me')).status, 401, 'the revoked key is still revoked after a crash');
});

test('health answers without a key and a snapshot of the database is kept', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-health-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const hub = await startHub(dir);
  t.after(() => hub.stop());
  const response = await fetch(`${hub.base}/api/health`);
  assert.deepEqual(await response.json(), { ok: true });
  const snapshots = (await fs.readdir(path.join(dir, 'snapshots'))).filter((file) => file.endsWith('.db'));
  assert.equal(snapshots.length, 1);
  assert.ok((await fs.stat(path.join(dir, 'snapshots', snapshots[0]))).size > 0);
});
