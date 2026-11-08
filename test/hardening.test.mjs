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

test('the public hub caps request size, rate-limits sign-in, and sends security headers', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-harden-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(source, 'server.mjs')], { env: { ...process.env, PORT: String(port), AGENT_HUB_DATA_DIR: dir, GITHUB_OAUTH_CLIENT_ID: '' }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const post = (route, body, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

  // Oversized and malformed bodies are refused before anything else happens.
  assert.equal((await post('/api/auth/github', JSON.stringify({ pad: 'x'.repeat(70 * 1024) }))).status, 413);
  assert.equal((await post('/api/auth/github', '{not json')).status, 400);

  // Starting sign-in is limited per address; another address is not affected.
  const from = (address) => ({ 'x-real-ip': address, 'x-forwarded-for': '203.0.113.9' });
  for (let i = 0; i < 20; i++) assert.notEqual((await post('/api/auth/device/start', '{}', from('198.51.100.1'))).status, 429);
  const limited = await post('/api/auth/device/start', '{}', from('198.51.100.1'));
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /Too many sign-in attempts/);
  assert.notEqual((await post('/api/auth/device/start', '{}', from('198.51.100.2'))).status, 429);

  // The page may only run its own script, can't be framed, and every answer carries the basic headers.
  const page = await fetch(`${base}/`);
  const html = await page.text();
  const csp = page.headers.get('content-security-policy');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(csp.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`), 'the inline script is allowed by its hash');
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'no other inline script may run');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(html, / on[a-z]+="/, 'no inline event handlers, which the policy would block');
  for (const response of [page, await fetch(`${base}/api/health`)]) {
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
});
