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
const PROJECT = 'team/project';

test('presence follows activity, honours set_status, and shows who can be woken', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-presence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const keys = { alice: 'alice-presence-key', bob: 'bob-presence-key' };
  const members = { alice: { agent: 'alice-agent', joinedAt: 1 }, bob: { agent: 'bob-agent', joinedAt: 1 } };
  const records = Object.fromEntries(Object.entries(keys).map(([login, key]) => [hash(key), { login, project: PROJECT, createdAt: Date.now() }]));
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ projects: { [PROJECT]: { members } }, keys: records }));

  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(source, 'server.mjs')], { env: { ...process.env, PORT: String(port), AGENT_HUB_DATA_DIR: dir, AGENT_HUB_TOKEN: 'admin-presence-key' }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const call = async (route, key, body) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const team = async () => Object.fromEntries((await call('/api/state', keys.bob)).body.members.map((member) => [member.name, member]));

  // Nobody has used their agent yet: both agents are away, and only bob (who just polled) is present as a person.
  let state = await team();
  assert.equal(state.alice.status, 'away');
  assert.equal(state.alice.lastSeen, null);
  assert.equal(state.bob.person.status, 'available');
  assert.equal(state.alice.wakeable, false);

  // The dashboard's lightweight polls (/api/me, /api/projects) also count as the person being present.
  await call('/api/me', keys.alice);
  assert.equal((await team()).alice.person.status, 'available');
  await call('/api/projects', keys.alice);
  assert.ok((await team()).alice.person.lastSeen > 0);

  // Taking a lock makes alice's agent present and visibly working.
  await call('/api/lock?branch=main', keys.alice, { paths: ['src/app.ts'], reason: 'test' });
  state = await team();
  assert.equal(state.alice.status, 'working');
  assert.equal(state.alice.locks, 1);
  assert.ok(state.alice.lastSeen > 0);

  // An explicit status and a doing line override what is worked out.
  assert.equal((await call('/api/presence', keys.alice, { status: 'available', doing: 'reviewing the dashboard PR' })).status, 200);
  state = await team();
  assert.equal(state.alice.status, 'available');
  assert.equal(state.alice.doing, 'reviewing the dashboard PR');
  assert.equal((await call('/api/presence', keys.alice, { status: 'busy' })).status, 400);

  // The dashboard acting as the person sets the person's status, not the agent's.
  await call('/api/presence?as=human', keys.alice, { status: 'away', doing: 'lunch' });
  state = await team();
  assert.equal(state.alice.person.status, 'away');
  assert.equal(state.alice.status, 'available');

  // The set_status tool works for agents over MCP.
  const tool = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${keys.bob}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_status', arguments: { status: 'working', doing: 'wiring the team panel' } } }),
  });
  assert.match((await tool.json()).result.content[0].text, /working/);
  state = await team();
  assert.equal(state.bob.doing, 'wiring the team panel');

  // A connected wake-up stream marks the agent as wakeable, and disconnecting clears it.
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/wake`, { headers: { authorization: `Bearer ${keys.bob}` }, signal: controller.signal });
  await stream.body.getReader().read();
  assert.equal((await team()).bob.wakeable, true);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await team()).bob.wakeable, false);
});
