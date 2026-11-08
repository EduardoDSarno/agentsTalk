import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));

/** A stand-in for GitHub: the device sign-in endpoints and the two API calls the hub makes. */
async function fakeGitHub(t) {
  const seen = { deviceScopes: [], polls: 0 };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    if (req.url === '/login/device/code') {
      seen.deviceScopes.push(form.get('scope'));
      return send(200, { device_code: form.get('client_id') === 'test-client' ? 'device-1' : '', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900 });
    }
    if (req.url === '/login/oauth/access_token') {
      if (form.get('device_code') === 'denied') return send(200, { error: 'access_denied' });
      seen.polls++;
      return send(200, seen.polls === 1 ? { error: 'authorization_pending' } : seen.polls === 2 ? { error: 'slow_down', interval: 10 } : { access_token: 'gh-token' });
    }
    if (req.url === '/user' && token === 'gh-token') return send(200, { login: 'Ana' });
    // Without a token GitHub only shows public repos; this one is private.
    if (req.url === '/repos/ana/secret') return token === 'gh-token' ? send(200, { full_name: 'ana/secret', permissions: { push: true } }) : send(404, {});
    if (req.url === '/repos/ana/open') return send(200, { full_name: 'ana/open', permissions: { push: token === 'gh-token' } });
    send(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

test('the dashboard signs in with GitHub through the hub and gets a personal key', async (t) => {
  const github = await fakeGitHub(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-signin-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), AGENT_HUB_DATA_DIR: dir, GITHUB_OAUTH_CLIENT_ID: 'test-client', AGENTSTALK_GITHUB_API: github.url, AGENTSTALK_GITHUB_WEB: github.url };
  const child = spawn(process.execPath, [path.join(source, 'server.mjs')], { env, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const post = async (route, body, key) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await post('/api/auth/device/start', { repo: 'not a repo' })).status, 400);
  const started = await post('/api/auth/device/start', { repo: 'ana/secret' });
  assert.equal(started.status, 200);
  assert.deepEqual([started.body.userCode, started.body.verificationUri, started.body.deviceCode], ['ABCD-1234', 'https://github.com/login/device', 'device-1']);
  await post('/api/auth/device/start', { repo: 'ana/open' });
  assert.deepEqual(github.seen.deviceScopes, ['repo', ''], 'only private repos ask for the repo scope');

  // Waiting, then GitHub asks to slow down, then the person approved.
  assert.deepEqual((await post('/api/auth/device/poll', { deviceCode: 'device-1', repo: 'ana/secret' })).body, { done: false });
  assert.deepEqual((await post('/api/auth/device/poll', { deviceCode: 'device-1', repo: 'ana/secret' })).body, { done: false, interval: 10 });
  const done = await post('/api/auth/device/poll', { deviceCode: 'device-1', repo: 'ana/secret' });
  assert.equal(done.status, 200);
  assert.equal(done.body.done, true);
  assert.equal(done.body.login, 'ana');
  assert.equal(done.body.project, 'ana/secret');
  assert.ok(done.body.key, 'a personal key comes back');
  assert.ok(!JSON.stringify(done.body).includes('gh-token'), 'the GitHub token never leaves the hub');

  // The key works, and signing in on the dashboard adds the person without inventing an agent.
  const state = await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${done.body.key}` } })).json();
  assert.deepEqual(state.members.map((m) => [m.name, m.agents.length]), [['ana', 0]]);

  // Cancelling on GitHub and missing codes are refused clearly.
  assert.equal((await post('/api/auth/device/poll', { deviceCode: 'denied', repo: 'ana/secret' })).status, 403);
  assert.equal((await post('/api/auth/device/poll', { repo: 'ana/secret' })).status, 400);
});
