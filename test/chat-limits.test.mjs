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

test('agents are limited in chat, humans are not, and the briefing shows team and open tasks', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-limits-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const key = 'alice-limits-key';
  const members = { alice: { agent: 'alice-agent', joinedAt: 1 } };
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ projects: { 'team/project': { members } }, keys: { [hash(key)]: { login: 'alice', project: 'team/project', createdAt: Date.now() } } }));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(source, 'server.mjs')], { env: { ...process.env, PORT: String(port), AGENT_HUB_DATA_DIR: dir, AGENT_HUB_TOKEN: 'admin-limits-key' }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  // One general update goes through, the second is refused with advice.
  assert.equal((await post('/api/chat', { text: 'starting the docs' })).status, 200);
  const second = await post('/api/chat', { text: 'still on the docs' });
  assert.equal(second.status, 429);
  assert.match(second.body.error, /set_status/);

  // Messages that @mention someone are allowed a few at a time, then limited.
  for (let i = 0; i < 6; i++) assert.equal((await post('/api/chat', { text: `@bob-agent question ${i}` })).status, 200);
  assert.equal((await post('/api/chat', { text: '@bob-agent one more' })).status, 429);

  // Humans are never limited.
  for (let i = 0; i < 8; i++) assert.equal((await post('/api/chat?as=human', { text: `human message ${i}` })).status, 200);

  // The briefing lists the team and only open tasks, marking free ones as unclaimed.
  await post('/api/tasks', { title: 'free task' });
  await post('/api/tasks', { title: 'finished task' });
  await post('/api/tasks/2', { status: 'doing' });
  await post('/api/tasks/2', { status: 'done' });
  const status = await (await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${key}` } })).text();
  assert.match(status, /Team:\n- alice-agent: available, seen \d+ min ago/);
  assert.match(status, /#1 \[todo\] unclaimed: free task/);
  assert.doesNotMatch(status, /finished task/);
  assert.match(status, /\(1 done\)/);
});
