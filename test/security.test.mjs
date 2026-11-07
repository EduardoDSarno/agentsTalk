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

const source=fileURLToPath(new URL('../',import.meta.url));
const hash=key=>createHash('sha256').update(key).digest('hex');
test('isolates locks, handles unnamed branches, revokes and expires keys, and recovers state',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agentstalk-security-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const keys={alice:'alice-test-key',bob:'bob-test-key',other:'other-test-key',old:'expired-test-key',soon:'soon-test-key'};
 const now=Date.now();
 const records={};
 for(const [name,key] of Object.entries(keys)) records[hash(key)]={login:name,project:name==='other'?'team/other':'team/project',createdAt:name==='old'?now-31*86400000:name==='soon'?now-30*86400000+2000:now};
 await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({projects:{},keys:records}));
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const base=`http://127.0.0.1:${port}`;let child;
 async function stop(){if(child?.exitCode===null){const finished=once(child,'exit');child.kill();await finished;}}
 t.after(stop);
 async function start(){child=spawn(process.execPath,[path.join(source,'server.mjs')],{env:{...process.env,PORT:String(port),AGENT_HUB_DATA_DIR:dir,AGENT_HUB_TOKEN:'admin-test-key'},stdio:'ignore'});for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('server exited');try{if((await fetch(base+'/api/config')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('server failed to start');}
 async function req(route,key,body){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};}
 await start();
 assert.equal((await req('/api/me',keys.old)).status,401);
 assert.equal((await req('/api/me','bad-key')).status,401);
 assert.equal((await req('/api/admin/revoke',keys.bob,{project:'team/project',login:'alice'})).status,403);
 assert.equal((await req('/api/lock?branch=main',keys.alice,{paths:['__proto__']})).body.granted.length,1);
 assert.equal((await req('/api/lock?branch=main',keys.other,{paths:['unrelated.txt']})).body.granted.length,1);
 assert.equal((await req('/api/lock?branch=main',keys.alice,{paths:['src/../shared.txt']})).body.granted[0],'shared.txt');
 assert.equal((await req('/api/check?branch=main',keys.bob,{paths:['shared.txt']})).body.blocked.length,1);
 assert.equal((await req('/api/lock',keys.alice,{paths:['unknown-branch.txt']})).body.granted.length,1);
 assert.equal((await req('/api/check?branch=main',keys.bob,{paths:['unknown-branch.txt']})).body.blocked.length,1);
 assert.equal((await req('/api/lock',keys.bob,{paths:['shared.txt']})).body.blocked.length,1);
 assert.equal((await req('/api/lock?branch=main',keys.bob,{paths:['../outside']})).status,400);
 const stream=await fetch(base+'/api/wake',{headers:{authorization:`Bearer ${keys.alice}`}});
 const reader=stream.body.getReader();await reader.read();
 const expiring=await fetch(base+'/api/wake',{headers:{authorization:`Bearer ${keys.soon}`}});
 const expiryReader=expiring.body.getReader();await expiryReader.read();
 await new Promise(r=>setTimeout(r,2100));
 await req('/api/chat?as=human',keys.bob,{text:'@soon-agent test'});
 assert.equal((await expiryReader.read()).done,true,'expired notification streams receive no new messages');
 assert.equal((await req('/api/admin/revoke','admin-test-key',{project:'team/project',login:'alice'})).body.revoked,1);
 assert.equal((await reader.read()).done,true,'revocation closes an existing notification stream');
 assert.equal((await req('/api/me',keys.alice)).status,401);
 await stop();await fs.writeFile(path.join(dir,'state.json'),'{broken');await start();
 assert.equal((await req('/api/me',keys.alice)).status,401,'backup must preserve the revocation');
 assert.equal((await req('/api/me',keys.bob)).status,200);
 assert.equal((await req('/api/state',keys.other)).body.locks.some(l=>l.path==='unrelated.txt'),true);
 await req('/api/lock?branch=main',keys.bob,{paths:['after-recovery.txt']});
 await stop();await start();
 assert.equal((await req('/api/state',keys.bob)).body.locks.some(l=>l.path==='after-recovery.txt'),true);
});
