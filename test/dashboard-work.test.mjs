import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function dashboard() {
  const html=fs.readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');
  const code=html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\n\s*start\(\);\s*$/, '\n');
  const elements=new Map();
  const document={getElementById(id){if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:''});return elements.get(id);}};
  const context=vm.createContext({document,URLSearchParams,location:{search:''},localStorage:{getItem(){return null;}},console});
  vm.runInContext(code+'\nglobalThis.testDashboard={renderTasks,renderAgents,personAvatar,setData:(members,tasks,locks,view)=>{lastMembers=members;lastTasks=tasks;lastLocks=locks;agentView=view;}};',context);
  return {ui:context.testDashboard,elements};
}

test('tasks show readable titles, owner identity and escaped user text',()=>{
 const {ui,elements}=dashboard();
 ui.renderTasks([{id:1,status:'doing',title:'A long task <script>alert(1)</script>',note:'Work & review',owner:'alice-agent'},{id:2,status:'todo',title:'Next',owner:''}]);
 const html=elements.get('tasks').innerHTML;
 assert.match(html,/A long task &#60;script&#62;/);
 assert.ok(!html.includes('<script>'));assert.match(html,/Work &#38; review/);
 assert.match(html,/#1/);assert.match(html,/alice-agent/);assert.match(html,/Unassigned/);
});

test('working agents come from in-progress tasks and active locks, and all shows remaining members',()=>{
 const {ui,elements}=dashboard();
 const members=[{name:'alice',agent:'alice-agent'},{name:'bob',agent:'bob-agent'},{name:'cat',agent:'cat-agent'}];
 const tasks=[{id:1,status:'doing',title:'Build dashboard',owner:'alice-agent'},{id:2,status:'done',title:'Old task',owner:'cat-agent'}];
 const locks=[{path:'src/app.js',owner:'bob-agent'}];
 ui.setData(members,tasks,locks,'working');ui.renderAgents();
 assert.equal(elements.get('agent-count').textContent,'2 working');
 let html=elements.get('agents').innerHTML;
 assert.match(html,/alice-agent/);assert.match(html,/Build dashboard/);assert.match(html,/bob-agent/);assert.match(html,/1 file locked/);assert.ok(!html.includes('cat-agent'));
 ui.setData(members,tasks,locks,'all');ui.renderAgents();html=elements.get('agents').innerHTML;
 assert.match(html,/cat-agent/);assert.match(html,/No work reported/);assert.ok(!html.includes('Old task'));
});

test('avatars use consistent colors for a person and their agent',()=>{
 const {ui}=dashboard();
 const alice=ui.personAvatar('alice',false,24),agent=ui.personAvatar('alice-agent',true,24),bob=ui.personAvatar('bob-agent',true,24);
 const color=s=>s.match(/--avatar-bg:([^;]+)/)[1];
 assert.equal(color(alice),color(agent));assert.notEqual(color(agent),color(bob));
 assert.match(alice,/>A<\/span>/);assert.match(agent,/<svg/);
});
