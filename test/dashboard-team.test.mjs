import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\s+start\(\);\s*$/, '');

/** Loads the dashboard script against a fake page and draws the team from the given members, tasks and locks. */
function sidebar(members, { tasks = [], locks = [] } = {}) {
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '', value: '', hidden: true, disabled: false });
    return nodes.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element }, location: { search: '' }, URLSearchParams,
    localStorage: { getItem: () => null }, members,
  });
  vm.runInContext(script, context);
  vm.runInContext(`lastTasks = ${JSON.stringify(tasks)}; lastLocks = ${JSON.stringify(locks)}; renderTeam(members)`, context);
  return { html: element('members').innerHTML, count: element('member-count').textContent, element, context };
}

test('Team shows each person with their agent: status, work, locks and last seen', () => {
  const now = Date.now();
  const result = sidebar([
    { name: 'zoe', agent: 'zoe-agent', status: 'away', doing: '', lastSeen: null, locks: 0, person: { status: 'away', lastSeen: null } },
    { name: 'alice', agent: 'alice-agent', status: 'working', doing: 'Reviewing the PR', lastSeen: now, locks: 2, person: { status: 'working', doing: 'Planning', lastSeen: now } },
    { name: 'bob', agent: 'bob-agent', status: 'available', doing: '', lastSeen: now - 120_000, locks: 1, person: { status: 'available', lastSeen: now - 5 * 60_000 } },
  ], { tasks: [{ id: 1, title: 'Build the task board', status: 'doing', owner: 'alice-agent' }] });
  assert.equal(result.count, 3);
  for (const text of ['Working', 'Available', 'Away', 'Planning', 'Reviewing the PR', 'Build the task board', '2 files locked', '1 file locked', 'just now', '2 min ago', '5 min ago', 'No work reported']) {
    assert.ok(result.html.includes(text), text);
  }
  assert.ok(result.html.indexOf('>alice<') < result.html.indexOf('>zoe<'), 'people are listed alphabetically');
  assert.match(result.html, /class="st st-working" aria-hidden="true"/);
  assert.match(result.html, /class="mem sub"/);
});

test('The agent line does not repeat work that its task already says', () => {
  const result = sidebar([{ name: 'alice', agent: 'alice-agent', status: 'working', doing: '#1 Build the board', locks: 0 }], { tasks: [{ id: 1, title: 'Build the board', status: 'doing', owner: 'alice-agent' }] });
  assert.equal((result.html.match(/Build the board/g) || []).length, 2, 'once visible and once in the hover title');
});

test('Team escapes server-supplied names and work, and handles legacy members', () => {
  const result = sidebar([{ name: '<img src=x onerror=alert(1)>', agent: 'bad"agent', doing: '<script>alert(1)</script>' }, { name: 'legacy', agent: 'legacy-agent' }]);
  assert.ok(!result.html.includes('<script>'));
  assert.ok(!result.html.includes('<img'));
  assert.ok(result.html.includes('&#60;script&#62;'));
  assert.ok(result.html.includes('bad&#34;agent'));
  assert.ok(result.html.includes('Away'));
  assert.ok(result.html.includes('No work reported'));
});

test('Team has an empty state and readable older timestamps', () => {
  const result = sidebar([]);
  assert.equal(result.count, 0);
  assert.match(result.html, /No teammates yet/);
  assert.equal(vm.runInContext('lastSeenLabel(Date.now() - 3 * 60 * 60_000)', result.context), '3 hrs ago');
  assert.equal(vm.runInContext('lastSeenLabel(Date.now() - 2 * 24 * 60 * 60_000)', result.context), '2 days ago');
});

test('Setting the team updates the people and agents line and the mention list', () => {
  const result = sidebar([]);
  vm.runInContext('currentName = "alice"; setTeam([{ name: "alice", agent: "alice-agent" }, { name: "bob", agent: "bob-agent" }])', result.context);
  assert.equal(result.element('team-size').textContent, '2 people · 2 agents');
  assert.deepEqual([...vm.runInContext('mentionable', result.context)], ['alice', 'bob', 'alice-agent', 'bob-agent', 'all']);
  vm.runInContext('setTeam([{ name: "alice", agent: "alice-agent" }])', result.context);
  assert.equal(result.element('team-size').textContent, '1 person · 1 agent');
});

test('Your own status shows under your name in the sidebar', () => {
  const result = sidebar([]);
  vm.runInContext('currentName = "alice"; syncPersonalPresence([{ name: "alice", person: { status: "working", doing: "Reviewing designs" } }])', result.context);
  assert.equal(result.element('user-status').textContent, 'Working · Reviewing designs');
  vm.runInContext('syncPersonalPresence([])', result.context);
  assert.equal(result.element('user-status').textContent, 'Away');
});

test('Only the repo owner sees Remove, never on their own row, and confirming sends the request', async () => {
  const result = sidebar([]);
  const draw = (who) => {
    vm.runInContext(`currentName = "${who}"; project = "boss/app"; renderTeam([{ name: "boss", agent: "boss-agent" }, { name: "bob", agent: "bob-agent" }])`, result.context);
    return result.element('members').innerHTML;
  };
  const owner = draw('boss');
  assert.equal((owner.match(/data-remove-member/g) || []).length, 1);
  assert.match(owner, /data-remove-member="bob"/);
  assert.ok(!draw('bob').includes('data-remove-member'), 'a teammate cannot remove people');

  const requests = [];
  Object.assign(result.context, { confirm: () => true, alert() {}, fetch: async (url, options) => { requests.push({ url, ...options }); return { ok: true, json: async () => ({}) }; } });
  vm.runInContext('keys = { "boss/app": "owner-key" }; refresh = () => {}; currentName = "boss"', result.context);
  await vm.runInContext('removeTeamMember("bob")', result.context);
  assert.equal(requests[0].url, '/api/members/remove');
  assert.deepEqual(JSON.parse(requests[0].body), { login: 'bob' });
  assert.equal(requests[0].headers.authorization, 'Bearer owner-key');
  await vm.runInContext('removeTeamMember("boss")', result.context);
  assert.equal(requests.length, 1, 'the owner cannot remove themselves');
});
