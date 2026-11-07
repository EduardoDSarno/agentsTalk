import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\s+start\(\);\s*$/, '');
function panel(members) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', textContent: '' });
    return nodes.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element }, location: { search: '' }, URLSearchParams,
    localStorage: { getItem: () => null }, members,
  });
  vm.runInContext(script, context);
  vm.runInContext('renderTeam(members)', context);
  return { html: element('members').innerHTML, count: element('member-count').textContent, context };
}

test('Team panel renders status, work, last seen, locks and wakeability from members[]', () => {
  const result = panel([
    {name: 'zoe', agent: 'zoe-agent', status: 'away', doing: '', lastSeen: null, locks: 0, wakeable: false},
    {name: 'alice', agent: 'alice-agent', status: 'working', doing: 'Building the task board', lastSeen: Date.now(), locks: 1, wakeable: true},
    {name: 'bob', agent: 'bob-agent', status: 'available', doing: 'Ready for review', lastSeen: Date.now() - 120_000, locks: 2, wakeable: false},
  ]);
  assert.equal(result.count, 3);
  for (const text of ['Working', 'Available', 'Away', 'Building the task board', 'Ready for review', 'Last seen: just now', 'Last seen: 2 min ago', 'Last seen: never', '1 locked file', '2 locked files', 'Wakeable', 'Not wakeable']) assert.ok(result.html.includes(text), text);
  assert.ok(result.html.indexOf('@alice-agent') < result.html.indexOf('@zoe-agent'));
  assert.match(result.html, /class="dot status-working" aria-hidden="true"/);
});

test('Team panel escapes server-supplied names and work, and handles legacy members', () => {
  const result = panel([{name: '<img src=x onerror=alert(1)>', agent: 'bad"agent', doing: '<script>alert(1)</script>'}, {name: 'legacy', agent: 'legacy-agent'}]);
  assert.ok(!result.html.includes('<script>'));
  assert.ok(!result.html.includes('<img'));
  assert.ok(result.html.includes('&#60;script&#62;'));
  assert.ok(result.html.includes('bad&#34;agent'));
  assert.ok(result.html.includes('0 locked files'));
  assert.ok(result.html.includes('Away'));
});

test('Team panel has an empty state and readable older timestamps', () => {
  const result = panel([]);
  assert.equal(result.count, 0);
  assert.match(result.html, /No teammates yet/);
  assert.equal(vm.runInContext('lastSeenLabel(Date.now() - 3 * 60 * 60_000)', result.context), '3 hrs ago');
  assert.equal(vm.runInContext('lastSeenLabel(Date.now() - 2 * 24 * 60 * 60_000)', result.context), '2 days ago');
});

test('Team panel shows independent human status, work and last seen', () => {
  const result = panel([{name: 'alice', agent: 'alice-agent', status: 'away', lastSeen: null, locks: 0, wakeable: false, person: {status: 'working', doing: 'Reviewing <designs>', lastSeen: Date.now()}}]);
  assert.match(result.html, /Human · Working/);
  assert.match(result.html, /Reviewing &#60;designs&#62;/);
  assert.match(result.html, /human-presence/);
  assert.match(result.html, /Last seen: just now/);
  assert.match(result.html, />Away</);
});
