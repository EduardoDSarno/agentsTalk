import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { githubRepoFromRemote } from '../kit/github-repo.mjs';
const source = fileURLToPath(new URL('../', import.meta.url));
const cli = process.env.TEST_CLI_ENTRY ?? path.join(source, 'cli.mjs');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function run(root, args, env = {}, input = '') {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(input);
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => output += chunk);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, output };
}
test('GitHub identities accept real remotes and reject lookalikes', () => {
  for (const remote of ['https://github.com/team/repo.git', 'git@github.com:team/repo.git', 'ssh://git@github.com/team/repo.git']) assert.equal(githubRepoFromRemote(remote), 'team/repo');
  for (const remote of ['https://evilgithub.com/team/repo', 'https://github.com.evil.test/team/repo', 'https://gitlab.com/team/repo', 'file:///team/repo', 'https://github.com/team/repo/extra']) assert.equal(githubRepoFromRemote(remote), undefined);
});
test('CLI initializes and joins clones, preserves settings, and reuses GitHub login', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'agentstalk-cli-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const mock = path.join(temp, 'github-mock.mjs');
  await fs.writeFile(mock, `const original = globalThis.fetch; globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if(u.hostname === 'api.github.com') return Response.json({}, {status: Number(process.env.TEST_GITHUB_STATUS || 200)});
    if(u.hostname === 'github.com') {
      if(u.pathname.endsWith('/device/code')) return Response.json({device_code:'test-device',user_code:'test-code',verification_uri:'https://github.com/login/device',interval:0,expires_in:30});
      return Response.json({access_token:'test-github-token',scope:''});
    }
    return original(url, init);
  };`);
  // Avoid opening a real browser during device-flow simulation.
  const bin = path.join(temp, 'bin');await fs.mkdir(bin);
  for (const command of ['xdg-open','open','explorer']) {const file=path.join(bin,command);await fs.writeFile(file,'#!/bin/sh\nexit 0\n',{mode:0o755});}
  const calls = [];
  const hub = http.createServer(async (req, res) => {
    res.setHeader('content-type','application/json');
    if(req.url === '/api/config') return res.end(JSON.stringify({githubClientId:'test-client'}));
    if(req.url.startsWith('/api/check')) return res.end(JSON.stringify({blocked:[]}));
    if(req.url === '/api/auth/github') {
      let raw='';for await (const chunk of req) raw += chunk;
      const body=JSON.parse(raw);calls.push(body);
      if(body.repo === 'team/read-only') {res.writeHead(403);return res.end(JSON.stringify({error:'You need write access to join this repository'}));}
      return res.end(JSON.stringify({key:'test-personal-key',login:'friend',agent:'friend-agent',project:body.repo.toLowerCase()}));
    }
    res.writeHead(404);res.end('{}');
  });
  await new Promise(resolve => hub.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => hub.close(resolve)));
  const url=`http://127.0.0.1:${hub.address().port}`;
  const env={AGENTSTALK_HOME:path.join(temp,'login'),NODE_OPTIONS:`--import=${mock}`,PATH:bin+path.delimiter+process.env.PATH};
  async function repo(name) {
    const root=path.join(temp,name);await fs.mkdir(root);git(root,'init','-q');git(root,'remote','add','origin','git@github.com:team/hackathon.git');
    return root;
  }
  const owner=await repo('owner');
  git(owner,'config','user.name','Setup Test');git(owner,'config','user.email','setup@example.invalid');git(owner,'config','commit.gpgsign','false');
  await fs.writeFile(path.join(owner,'AGENTS.md'),'Keep existing instructions.\n');
  await fs.mkdir(path.join(owner,'.codex'));await fs.writeFile(path.join(owner,'.codex/config.toml'),'model = "existing-model"\n');
  git(owner,'add','.');git(owner,'commit','-qm','Existing project');
  const initial=git(owner,'rev-parse','HEAD');
  const remote=path.join(temp,'remote.git');git(temp,'init','--bare','-q',remote);git(owner,'config','remote.origin.pushurl',remote);
  let result=await run(owner,['init','--hub',url,'--agent','codex'],env,'n\n');
  assert.equal(result.code,0,result.output);assert.match(result.output,/Warning:/);assert.match(result.output,/Cancelled/);
  assert.equal(git(owner,'rev-parse','HEAD'),initial);assert.equal(calls.length,0);
  await assert.rejects(fs.access(path.join(owner,'agentstalk')));
  await fs.appendFile(path.join(owner,'AGENTS.md'),'Uncommitted instructions\n');
  result=await run(owner,['init','--yes','--hub',url,'--agent','codex'],env);
  assert.equal(result.code,1);assert.match(result.output,/existing changes/);assert.equal(calls.length,0);
  git(owner,'restore','AGENTS.md');
  await fs.writeFile(path.join(owner,'unrelated.txt'),'Staged user work\n');git(owner,'add','unrelated.txt');
  await fs.writeFile(path.join(owner,'untracked.txt'),'Untracked user work\n');
  result=await run(owner,['init','--hub',url,'--agent','codex'],env,'yes\n');
  assert.equal(result.code,0,result.output.replace(/test-personal-key/g,'[redacted]'));
  assert.match(result.output,/Committed agentsTalk/);assert.match(result.output,/Pushed/);
  const initialized=git(owner,'rev-parse','HEAD'),branch=git(owner,'branch','--show-current');
  assert.equal(git(remote,'rev-parse',`refs/heads/${branch}`),initialized);
  assert.equal(git(owner,'diff','--cached','--name-only'),'unrelated.txt');
  const committed=git(owner,'show','--pretty=','--name-only','HEAD');
  assert.ok(!committed.includes('unrelated.txt'));assert.ok(!committed.includes('untracked.txt'));
  assert.ok(!git(owner,'show','HEAD:agentstalk/config.json').includes('test-personal-key'));
  result=await run(owner,['init','--yes','--hub',url,'--agent','codex'],env);
  assert.equal(result.code,0,result.output);assert.match(result.output,/already committed/);assert.equal(git(owner,'rev-parse','HEAD'),initialized);
  assert.equal(git(owner,'config','--get','agenthub.project'),'team/hackathon');
  assert.equal(git(owner,'config','--get','agenthub.key'),'test-personal-key');
  const config=await fs.readFile(path.join(owner,'.codex/config.toml'),'utf8');
  assert.match(config,/existing-model/);assert.match(config,/mcp-proxy.mjs/);assert.match(config,/hooks.PreToolUse/);assert.ok(!config.includes('test-personal-key'));
  assert.match(await fs.readFile(path.join(owner,'AGENTS.md'),'utf8'),/^Keep existing instructions/);
  const login=JSON.parse(await fs.readFile(path.join(env.AGENTSTALK_HOME,'github.json'),'utf8'));assert.equal(login.token,'test-github-token');
  assert.equal((await fs.stat(path.join(env.AGENTSTALK_HOME,'github.json'))).mode & 0o777,0o600);
  result=await run(owner,['--agent','codex'],env);assert.equal(result.code,0);assert.equal(await fs.readFile(path.join(owner,'.codex/config.toml'),'utf8'),config);
  assert.equal((await fs.readFile(path.join(owner,'AGENTS.md'),'utf8')).split('## Team coordination').length,2);
  const friend=await repo('friend');result=await run(friend,['join','--hub',url,'--agent','none'],env);assert.equal(result.code,0);assert.ok(!result.output.includes('enter the code'));
  assert.deepEqual(calls.map(c=>c.repo),['team/hackathon','team/hackathon','team/hackathon','team/hackathon']);
  assert.equal((await fs.readFile(path.join(owner,'agentstalk/config.json'),'utf8')).includes('test-personal-key'),false);
  const denied=await repo('denied');git(denied,'remote','set-url','origin','https://github.com/team/read-only');
  result=await run(denied,['join','--hub',url,'--agent','none'],env);assert.equal(result.code,1);assert.match(result.output,/write access/);
  assert.throws(()=>git(denied,'config','--get','agenthub.key'));
  // GitHub outages must not trigger a request for broader private-repository scope.
  result=await run(friend,['--agent','none'],{...env,TEST_GITHUB_STATUS:'403'});assert.equal(result.code,1);assert.ok(!result.output.includes('enter the code'));
});
test('CLI rejects invalid commands, non-GitHub repos and insecure hubs before setup', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agentstalk-invalid-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  assert.equal((await run(root,['--help'])).code,0);
  assert.equal((await run(root,['unknown'])).code,1);
  assert.equal((await run(root,[])).code,1);
  git(root,'init','-q');git(root,'remote','add','origin','https://evilgithub.com/team/repo');
  assert.equal((await run(root,['init'])).code,1);
  git(root,'remote','set-url','origin','https://github.com/team/repo');
  for(const hub of ['http://example.com','https://user:pass@example.com','https://example.com/path']) assert.equal((await run(root,['init','--hub',hub])).code,1);
  await assert.rejects(fs.access(path.join(root,'agentstalk')));
});
