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
const PROJECT = 'ana/project';
const ADMIN = 'admin-agents-key';

/** Starts a hub on a free port with the given saved state and returns a caller for it. */
async function startHub(t, saved) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-agents-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(saved));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(source, 'server.mjs')], { env: { ...process.env, PORT: String(port), AGENT_HUB_DATA_DIR: dir, AGENT_HUB_TOKEN: ADMIN }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return async (route, key, body, tool) => {
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(tool ? { 'x-agentstalk-tool': tool } : {}) };
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* plain-text routes */ }
    return { status: response.status, body: parsed };
  };
}

const keyRecord = (login) => ({ login, project: PROJECT, createdAt: Date.now() });

test('one person runs several agents, one per tool, each with its own locks and mentions', async (t) => {
  const call = await startHub(t, { projects: { [PROJECT]: {} }, keys: { [hash('ana-key')]: keyRecord('ana'), [hash('bo-key')]: keyRecord('bo') } });

  // The same key in two tools becomes two agents under the same person.
  assert.equal((await call('/api/lock', 'ana-key', { paths: ['src/a.ts'], reason: 'editing' }, 'claude')).status, 200);
  const blocked = await call('/api/lock', 'ana-key', { paths: ['src/a.ts'], reason: 'also editing' }, 'codex');
  assert.equal(blocked.body.blocked[0].owner, 'ana/claude', 'two agents of one person still block each other');
  const ana = (await call('/api/state', 'ana-key')).body.members.find((m) => m.name === 'ana');
  assert.deepEqual(ana.agents.map((a) => a.name).sort(), ['ana/claude', 'ana/codex']);
  assert.equal(ana.agents.find((a) => a.tool === 'claude').locks, 1);

  // "@ana/codex" reaches only that agent; "@ana" is for the person.
  await call('/api/chat?as=human', 'bo-key', { text: '@ana/codex please review' });
  assert.match((await call('/api/inbox', 'ana-key', undefined, 'codex')).body, /please review/);
  assert.doesNotMatch((await call('/api/inbox', 'ana-key', undefined, 'claude')).body, /please review/);

  // Without a label a tool is "agent"; a bad label is refused.
  assert.equal((await call('/api/tasks', 'bo-key', { title: 'x' })).status, 200);
  assert.ok((await call('/api/state', 'bo-key')).body.members.find((m) => m.name === 'bo').agents.some((a) => a.name === 'bo/agent'));
  assert.equal((await call('/api/tasks', 'bo-key', { title: 'x' }, 'Bad Label!')).status, 400);

  // A person can't start more than a few agents.
  for (let i = 0; i < 7; i++) assert.equal((await call('/api/inbox', 'bo-key', undefined, `tool-${i}`)).status, 200);
  assert.equal((await call('/api/inbox', 'bo-key', undefined, 'one-too-many')).status, 403);
});

test('agents named the old way are upgraded to login/agent, and the admin can rename them', async (t) => {
  const saved = {
    projects: {
      [PROJECT]: {
        members: { ana: { agent: 'ana-agent', joinedAt: 1 }, claude: { agent: 'claude-agent', joinedAt: 1 } },
        tasks: [{ id: 1, title: 'old task', status: 'doing', owner: 'claude-agent', note: '', updatedAt: Date.now(), pr: 5, reviews: [{ by: 'ana-agent', verdict: 'approved' }] }],
        locks: { 'src/a.ts': { '': { owner: 'claude-agent', reason: 'editing', expiresAt: Date.now() + 600_000 } } },
        messages: [{ id: 1, at: 1, from: 'ana', text: '@claude-agent hi', mentions: ['claude-agent'], fromHuman: true, readBy: [] }],
        nextTaskId: 2,
        nextMessageId: 2,
      },
    },
    keys: { [hash('ana-key')]: keyRecord('ana') },
  };
  const call = await startHub(t, saved);

  const state = (await call('/api/state', 'ana-key')).body;
  assert.deepEqual(state.members.map((m) => [m.name, m.agents.map((a) => a.name)]).sort(), [['ana', ['ana/agent']], ['claude', ['claude/agent']]]);
  assert.equal(state.tasks[0].owner, 'claude/agent');
  assert.equal(state.tasks[0].reviews[0].by, 'ana/agent');
  assert.equal(state.locks[0].owner, 'claude/agent');
  assert.deepEqual(state.messages[0].mentions, ['claude/agent']);

  // Only the admin renames, and the new person must already be in the project.
  const rename = (key, from, to) => call('/api/admin/rename-agent', key, { project: PROJECT, from, to });
  assert.equal((await rename('ana-key', 'claude/agent', 'ana/claude')).status, 403);
  assert.equal((await rename(ADMIN, 'claude/agent', 'nobody/claude')).status, 404);
  assert.equal((await rename(ADMIN, 'claude/agent', 'ana/agent')).status, 409);
  assert.equal((await rename(ADMIN, 'claude/agent', 'ana/claude')).status, 200);

  const after = (await call('/api/state', 'ana-key')).body;
  assert.deepEqual(after.members.map((m) => m.name), ['ana'], 'the stand-in person with no key and no agents is gone');
  assert.deepEqual(after.members[0].agents.map((a) => a.name).sort(), ['ana/agent', 'ana/claude']);
  assert.equal(after.tasks[0].owner, 'ana/claude');
  assert.equal(after.locks[0].owner, 'ana/claude');
  assert.match((await call('/api/inbox', 'ana-key', undefined, 'claude')).body, /hi/, 'its unread mentions follow it');
});
