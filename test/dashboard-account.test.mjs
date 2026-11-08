import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\s+start\(\);\s*$/, '');

/** Loads the page script with fake elements, storage, timers and network, signed in as alice. */
function page(stored = {}) {
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', hidden: true, innerHTML: '', textContent: '', listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; } });
    return nodes.get(id);
  };
  const replaced = [];
  const timers = [];
  let respond = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [] },
    location: { search: '', pathname: '/', replace: (url) => replaced.push(url) },
    URLSearchParams,
    localStorage: { getItem: (key) => stored[key] ?? null, setItem: (key, value) => { stored[key] = value; } },
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
    fetch: async (url, options) => { requests.push({ url, ...options }); return respond(url, options); },
  });
  vm.runInContext(script, context);
  vm.runInContext('setUpAccount();', context);
  const click = (match) => element('account-body').listeners.click({ target: { closest: (selector) => match(selector) } });
  return { element, stored, replaced, timers, requests, click, run: (code) => vm.runInContext(code, context), respond: (fn) => { respond = fn; } };
}

const signedInAsAlice = () => ({
  'agentstalk-keys': JSON.stringify({ 'team/project': 'alice-key' }),
  'agentstalk-accounts': JSON.stringify({ 'team/project': { alice: 'alice-key', bob: 'bob-key' } }),
  'agent-hub-name': 'alice',
});

test('the account dialog lists the other remembered accounts and switches to one in a click', () => {
  const p = page(signedInAsAlice());
  p.run('project = "team/project"; openAccount()');
  assert.equal(p.element('account').hidden, false);
  assert.equal(p.element('account-title').textContent, 'Signed in as alice');
  const body = p.element('account-body').innerHTML;
  assert.match(body, /Switch to bob/);
  assert.ok(!body.includes('Switch to alice'), 'the current account is not offered');
  assert.match(body, /Sign in with another GitHub account/);
  assert.match(body, /Sign out/);

  p.click((selector) => (selector === '[data-account]' ? { dataset: { account: 'bob' } } : null));
  assert.equal(JSON.parse(p.stored['agentstalk-keys'])['team/project'], 'bob-key');
  assert.equal(p.stored['agent-hub-name'], 'bob');
  assert.deepEqual(p.replaced, ['/?project=team%2Fproject'], 'the page reopens fresh as bob');
});

test('signing out forgets only the current account', () => {
  const p = page(signedInAsAlice());
  p.run('project = "team/project"; openAccount()');
  p.click((selector) => (selector === '[data-account-signout]' ? {} : null));
  assert.equal(JSON.parse(p.stored['agentstalk-keys'])['team/project'], undefined);
  assert.deepEqual(JSON.parse(p.stored['agentstalk-accounts'])['team/project'], { bob: 'bob-key' });
  assert.equal(p.stored['agent-hub-name'], '');
  assert.equal(p.replaced.length, 1);
});

test('GitHub sign-in shows the code, waits for approval, then remembers the new account', async () => {
  const p = page({});
  p.run('project = ""; openAccount()');
  assert.equal(p.element('account-title').textContent, 'Sign in with GitHub');
  assert.match(p.element('account-body').innerHTML, /id="account-repo"/);

  const answers = [
    { deviceCode: 'device-1', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5 },
    { done: false },
    { done: true, key: 'new-key', login: 'carol', project: 'team/project' },
  ];
  p.respond(async () => ({ ok: true, status: 200, json: async () => answers.shift() }));
  p.element('account-repo').value = 'Team/Project';
  await p.run('startSignIn()');
  assert.deepEqual(JSON.parse(p.requests[0].body), { repo: 'team/project' });
  assert.equal(p.element('account-title').textContent, 'Enter this code on GitHub');
  assert.match(p.element('account-body').innerHTML, /ABCD-1234/);

  await p.timers.shift()();
  assert.equal(p.replaced.length, 0, 'still waiting');
  await p.timers.shift()();
  assert.deepEqual(JSON.parse(p.requests[2].body), { deviceCode: 'device-1', repo: 'team/project' });
  assert.equal(JSON.parse(p.stored['agentstalk-keys'])['team/project'], 'new-key');
  assert.deepEqual(JSON.parse(p.stored['agentstalk-accounts'])['team/project'], { carol: 'new-key' });
  assert.equal(p.stored['agent-hub-name'], 'carol');
  assert.deepEqual(p.replaced, ['/?project=team%2Fproject']);
});

test('a refused sign-in shows why, and a bad repo name is caught before asking GitHub', async () => {
  const p = page({});
  p.run('project = ""; openAccount()');
  p.element('account-repo').value = 'nope';
  await p.run('startSignIn()');
  assert.equal(p.element('account-error').textContent, 'Enter the repo as owner/name');
  assert.equal(p.requests.length, 0);

  p.element('account-repo').value = 'team/project';
  p.respond(async () => ({ ok: false, status: 403, json: async () => ({ error: "carol can't write to team/project on GitHub" }) }));
  await p.run('startSignIn()');
  assert.equal(p.element('account-error').textContent, "carol can't write to team/project on GitHub");
});

test('the team list shows every agent under its person, and none for someone who only signed in', () => {
  const p = page(signedInAsAlice());
  p.run(`renderTeam(${JSON.stringify([
    { name: 'alice', person: { status: 'available' }, agents: [{ name: 'alice/claude', status: 'working', doing: 'tests', lastSeen: null, locks: 1 }, { name: 'alice/codex', status: 'away', doing: '', lastSeen: null, locks: 0 }] },
    { name: 'bob', person: { status: 'available' }, agents: [] },
  ])})`);
  const html = p.element('members').innerHTML;
  assert.match(html, /alice\/claude/);
  assert.match(html, /alice\/codex/);
  assert.match(html, /tests · 1 file locked/);
  assert.equal((html.match(/class="mem sub"/g) ?? []).length, 2, 'bob has no agent row');
});
