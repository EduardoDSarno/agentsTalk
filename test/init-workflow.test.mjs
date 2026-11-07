import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { prepareInit, commitAndPushSetup, SETUP_FILES } from '../init-workflow.mjs';

const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function fixture(t) {
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'agentstalk-publish-'));
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  git(temp,'init','-q','--initial-branch=main');
  git(temp,'config','user.name','Setup Test');git(temp,'config','user.email','setup@example.invalid');git(temp,'config','commit.gpgsign','false');
  await fs.writeFile(path.join(temp,'README.md'),'Existing project\n');git(temp,'add','.');git(temp,'commit','-qm','Initial project');
  const remote=path.join(temp,'remote.git');git(temp,'init','--bare','-q',remote);git(temp,'remote','add','origin',remote);
  return {temp,remote};
}
async function setupFiles(root) {
  for(const file of SETUP_FILES){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),'Generated setup\n');}
}
test('init requires a branch and refuses an in-progress merge before changing files',async t=>{
  const {temp}=await fixture(t);git(temp,'checkout','--detach','-q');
  assert.throws(()=>prepareInit(temp),/Switch to a branch/);
  git(temp,'checkout','main','-q');
  await fs.writeFile(path.join(temp,'.git','MERGE_HEAD'),git(temp,'rev-parse','HEAD'));
  assert.throws(()=>prepareInit(temp),/Finish the current merge/);
});
test('setup commit honors pre-commit hooks and leaves the remote unchanged on refusal',async t=>{
  const {temp,remote}=await fixture(t);const initial=git(temp,'rev-parse','HEAD');
  await fs.writeFile(path.join(temp,'.git','hooks','pre-commit'),'#!/bin/sh\nexit 1\n',{mode:0o755});
  await setupFiles(temp);
  assert.throws(()=>commitAndPushSetup(temp,'main'),/Git refused/);
  assert.equal(git(temp,'rev-parse','HEAD'),initial);
  assert.equal(git(remote,'for-each-ref','--format=%(refname)','refs/heads'),'');
});
test('rejected push retains the local setup commit and provides a retry command',async t=>{
  const {temp,remote}=await fixture(t);const initial=git(temp,'rev-parse','HEAD');
  await fs.writeFile(path.join(remote,'hooks','pre-receive'),'#!/bin/sh\nexit 1\n',{mode:0o755});
  await setupFiles(temp);
  assert.throws(()=>commitAndPushSetup(temp,'main'),/committed locally.*git push --set-upstream origin HEAD/);
  assert.notEqual(git(temp,'rev-parse','HEAD'),initial);
  assert.equal(git(temp,'status','--porcelain','--',...SETUP_FILES),'');
});
