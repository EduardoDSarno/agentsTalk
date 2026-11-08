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

/** A stand-in for GitHub's web sign-in: each code belongs to one person; eve can't write to the repo. */
async function fakeGitHub(t) {
  const exchanges = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    if (req.url === '/login/oauth/access_token') {
      exchanges.push(Object.fromEntries(form));
      const person = form.get('client_secret') === 'test-secret' ? form.get('code')?.replace('-code', '') : '';
      return send(200, person ? { access_token: `tok-${person}` } : { error: 'bad_verification_code' });
    }
    if (req.url === '/user' && token.startsWith('tok-')) return send(200, { login: token.slice(4) });
    if (req.url === '/repos/ana/open') return send(200, { full_name: 'ana/open', permissions: { push: ['tok-ana', 'tok-bo'].includes(token) } });
    send(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, exchanges };
}

async function startHub(t, github, env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-login-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(source, 'server.mjs')], {
    env: { ...process.env, PORT: String(port), AGENT_HUB_DATA_DIR: dir, AGENT_HUB_TOKEN: '', GITHUB_OAUTH_CLIENT_ID: 'test-client', GITHUB_OAUTH_CLIENT_SECRET: 'test-secret', AGENTSTALK_GITHUB_API: github.url, AGENTSTALK_GITHUB_WEB: github.url, ...env },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return base;
}

test('the login page signs in by redirecting to GitHub and back, and only for the browser that started it', async (t) => {
  const github = await fakeGitHub(t);
  const base = await startHub(t, github);
  const get = (route, cookie) => fetch(base + route, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  assert.equal((await (await fetch(`${base}/api/config`)).json()).webSignIn, true);

  /** Starts a sign-in and returns GitHub's state and this browser's cookie. */
  const start = async (query = 'repo=ana/open') => {
    const response = await get(`/auth/github/start?${query}`);
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location'));
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return { location, cookie, state: location.searchParams.get('state') };
  };

  const first = await start('repo=ana/open&switch=1');
  assert.equal(first.location.origin + first.location.pathname, `${github.url}/login/oauth/authorize`);
  assert.equal(first.location.searchParams.get('client_id'), 'test-client');
  assert.equal(first.location.searchParams.get('redirect_uri'), `${base}/auth/github/callback`);
  assert.equal(first.location.searchParams.get('scope'), '', 'a public repo asks for no extra access');
  assert.equal(first.location.searchParams.get('prompt'), 'select_account', 'switching accounts lets the person pick one');
  assert.match(first.cookie, /^agentstalk_oauth=/);

  // A callback without this browser's cookie (a link someone else made) is refused.
  const forged = await get(`/auth/github/callback?code=ana-code&state=${first.state}`);
  assert.match(forged.headers.get('location'), /login_error=expired/);

  // The real round trip hands back a personal key after "#", never in the query.
  const ok = await start();
  const back = await get(`/auth/github/callback?code=ana-code&state=${ok.state}`, ok.cookie);
  const landing = back.headers.get('location');
  assert.match(landing, /^\/\?project=ana%2Fopen#key=/);
  assert.equal(github.exchanges.at(-1).redirect_uri, `${base}/auth/github/callback`);
  const key = decodeURIComponent(landing.split('#key=')[1]);
  const me = await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${key}` } })).json();
  assert.deepEqual([me.login, me.project], ['ana', 'ana/open']);
  assert.match(back.headers.get('set-cookie'), /Max-Age=0/, 'the state cookie is cleared');

  // A state works once.
  assert.match((await get(`/auth/github/callback?code=ana-code&state=${ok.state}`, ok.cookie)).headers.get('location'), /login_error=expired/);

  // Cancelling on GitHub, and someone who can't write to the repo, come back with a reason.
  const cancelled = await start();
  assert.match((await get(`/auth/github/callback?error=access_denied&state=${cancelled.state}`, cancelled.cookie)).headers.get('location'), /project=ana%2Fopen&login_error=cancelled/);
  const eve = await start();
  assert.match((await get(`/auth/github/callback?code=eve-code&state=${eve.state}`, eve.cookie)).headers.get('location'), /login_error=no_access&login=eve/);
  assert.match((await get('/auth/github/start?repo=nope')).headers.get('location'), /login_error=bad_repo/);

  // The repo's owner renames agents in their project; a teammate can't.
  const bob = await start();
  const bobKey = decodeURIComponent((await get(`/auth/github/callback?code=bo-code&state=${bob.state}`, bob.cookie)).headers.get('location').split('#key=')[1]);
  await fetch(`${base}/api/inbox`, { headers: { authorization: `Bearer ${bobKey}`, 'x-agentstalk-tool': 'agent' } });
  const rename = (who, body) => fetch(`${base}/api/agents/rename`, { method: 'POST', headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await rename(bobKey, { from: 'bo/agent', to: 'bo/codex' })).status, 403);
  assert.equal((await rename(key, { from: 'bo/agent', to: 'bo/codex' })).status, 200);
});

test('without the OAuth secret the login page falls back to a code', async (t) => {
  const github = await fakeGitHub(t);
  const base = await startHub(t, github, { GITHUB_OAUTH_CLIENT_SECRET: '' });
  assert.equal((await (await fetch(`${base}/api/config`)).json()).webSignIn, false);
  assert.match((await fetch(`${base}/auth/github/start?repo=ana/open`, { redirect: 'manual' })).headers.get('location'), /login_error=unavailable/);
});
