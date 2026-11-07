import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const hash = (key) => createHash('sha256').update(key).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('locks are released only for files a successful git push really sent', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-release-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const key = 'alice-release-key';
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ projects: {}, keys: { [hash(key)]: { login: 'alice', project: 'team/project', createdAt: Date.now() } } }));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(source, 'server.mjs')], { env: { ...process.env, PORT: String(port), AGENT_HUB_DATA_DIR: dir, AGENT_HUB_TOKEN: 'admin-release-key' }, stdio: 'ignore' });
  t.after(() => child.kill());
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const call = async (route, body) => {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return response.json();
  };
  const lockedPaths = async () => (await call('/api/state')).locks.map((lock) => lock.path).sort();

  // A real clone with an upstream, and a hook that reads its settings from Git config as after a real setup.
  const remote = path.join(dir, 'remote.git');
  const clone = path.join(dir, 'clone');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, clone], { stdio: 'ignore' });
  git(clone, 'config', 'user.email', 't@example.com');
  git(clone, 'config', 'user.name', 'T');
  for (const [name, value] of Object.entries({ url: base, key, project: 'team/project' })) git(clone, 'config', `agenthub.${name}`, value);
  for (const file of ['pushed.txt', 'unpushed.txt', 'dirty.txt', 'untouched.txt']) await fs.writeFile(path.join(clone, file), 'one\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'base');
  git(clone, 'push', '-q', '-u', 'origin', 'main');

  const { AGENT_HUB_KEY, AGENT_HUB_URL, ...env } = process.env;
  const hook = (event, command) => execFileSync(process.execPath, [path.join(source, 'hook.mjs')], {
    cwd: clone,
    input: JSON.stringify({ hook_event_name: event, tool_name: 'Bash', cwd: clone, tool_input: { command } }),
    encoding: 'utf8',
    env: { ...env, CLAUDE_PROJECT_DIR: clone },
  });
  const push = (command, shouldWork = true) => {
    hook('PreToolUse', command);
    try { execFileSync('sh', ['-c', command], { cwd: clone, stdio: 'ignore' }); } catch (error) { if (shouldWork) throw error; }
    hook('PostToolUse', command);
  };

  // Four files are locked. One is committed and pushed, one committed but not pushed, one edited but not committed,
  // and one only locked (about to be edited).
  await call('/api/lock?branch=main', { paths: ['pushed.txt', 'unpushed.txt', 'dirty.txt', 'untouched.txt'] });
  await fs.writeFile(path.join(clone, 'pushed.txt'), 'two\n');
  git(clone, 'commit', '-qam', 'change pushed');
  const everything = ['dirty.txt', 'pushed.txt', 'unpushed.txt', 'untouched.txt'];

  // A command that only mentions pushing sends nothing, so nothing is released.
  push('echo git push');
  assert.deepEqual(await lockedPaths(), everything);

  // A push that fails (no such remote) sends nothing either.
  push('git push nowhere', false);
  assert.deepEqual(await lockedPaths(), everything);

  // The real push releases only the file it sent; locked-but-untouched files keep their locks.
  await fs.writeFile(path.join(clone, 'dirty.txt'), 'two\n');
  push('git push origin main');
  assert.deepEqual(await lockedPaths(), ['dirty.txt', 'unpushed.txt', 'untouched.txt']);

  // Later, committing and pushing the second file releases it too; the untouched one still stays locked.
  await fs.writeFile(path.join(clone, 'unpushed.txt'), 'two\n');
  git(clone, 'add', 'unpushed.txt');
  git(clone, 'commit', '-qm', 'change unpushed');
  push('git push');
  assert.deepEqual(await lockedPaths(), ['dirty.txt', 'untouched.txt']);

  // The remembered push state is kept inside .git, never in the working tree.
  assert.equal(git(clone, 'status', '--porcelain').includes('agentstalk-push'), false);
});
