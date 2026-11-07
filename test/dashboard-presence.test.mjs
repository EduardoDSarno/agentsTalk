import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\s+start\(\);\s*$/, '');
function form() {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {value: '', hidden: true, textContent: '', listeners: {}, addEventListener(name, callback) {this.listeners[name] = callback;}});
    return nodes.get(id);
  };
  const requests = [];
  let respond = async () => ({ok: true, json: async () => ({status: 'working', doing: 'Reviewing'})});
  const context = vm.createContext({document: {getElementById: element}, location: {search: ''}, URLSearchParams, localStorage: {getItem: () => null}, fetch: async (url, options) => {requests.push({url, ...options}); return respond();}});
  vm.runInContext(script, context);
  vm.runInContext('currentName="alice"; project="team/project"; keys={"team/project":"test-key"}; refresh=()=>{}; setUpPresence(); syncPersonalPresence([]);', context);
  return {element, requests, run: code => vm.runInContext(code, context), respond: fn => {respond = fn;}};
}

test('Presence form follows human presence until edited; identity changes reset it', () => {
  const f = form();
  f.run('syncPersonalPresence([{name:"alice", person:{status:"working", doing:"Reviewing"}}])');
  assert.equal(f.element('presence-status').value, 'working');
  assert.equal(f.element('presence-doing').value, 'Reviewing');
  f.element('presence-doing').value = 'Unsaved work';
  f.element('presence-doing').listeners.input();
  f.run('syncPersonalPresence([{name:"alice", person:{status:"away", doing:"Old value"}}])');
  assert.equal(f.element('presence-doing').value, 'Unsaved work');
  assert.equal(f.element('presence-status').value, 'working');
  f.run('project="other/project"; syncPersonalPresence([])');
  assert.equal(f.element('presence-doing').value, '');
  assert.equal(f.element('presence-status').value, 'available');
});

test('Saving presence posts as the human and reports success', async () => {
  const f = form();
  f.element('presence-status').value = 'working';
  f.element('presence-doing').value = ' Reviewing ';
  await f.run('savePersonalPresence()');
  assert.equal(f.requests[0].url, '/api/presence?as=human');
  assert.deepEqual(JSON.parse(f.requests[0].body), {status: 'working', doing: 'Reviewing'});
  assert.equal(f.element('presence-feedback').textContent, 'Status saved.');
});

test('API errors preserve edits and keep the dashboard connected', async () => {
  const f = form();
  f.element('presence-doing').value = 'My draft';
  f.element('presence-doing').listeners.input();
  f.respond(async () => ({ok: false, status: 400, json: async () => ({error: 'Please try again'})}));
  await f.run('savePersonalPresence()');
  assert.equal(f.element('presence-feedback').textContent, 'Please try again');
  assert.equal(f.element('presence-doing').value, 'My draft');
  assert.equal(f.run('presenceDirty'), true);
  assert.equal(f.run('offline'), false);
});

test('Offline and pending states disable presence writes', async () => {
  const f = form();
  f.run('offline=true; setPresenceAvailability()');
  await f.run('savePersonalPresence()');
  assert.equal(f.requests.length, 0);
  assert.equal(f.element('presence-save').disabled, true);
  f.run('offline=false');
  let release;
  f.respond(() => new Promise(resolve => {release = resolve;}));
  const pending = f.run('savePersonalPresence()');
  await f.run('savePersonalPresence()');
  assert.equal(f.requests.length, 1);
  release({ok: true, json: async () => ({})});
  await pending;
  assert.equal(f.element('presence-save').disabled, false);
});
