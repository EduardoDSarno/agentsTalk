import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/** Loads the dashboard script against a fake page with chat, tabs and the activity switch. */
function page() {
  const html = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\n\s*start\(\);\s*$/, '\n');
  const nodes = new Map();
  const classes = (set) => ({ toggle: (name, on) => (on ? set.add(name) : set.delete(name)), has: (name) => set.has(name) });
  const element = (id) => {
    if (!nodes.has(id)) {
      const set = new Set();
      nodes.set(id, { innerHTML: '', textContent: '', hidden: true, listeners: {}, attributes: {}, classList: classes(set), set,
        addEventListener(name, callback) { this.listeners[name] = callback; }, setAttribute(name, value) { this.attributes[name] = value; },
        querySelector: () => element(id + '-inner') });
    }
    return nodes.get(id);
  };
  const stored = {};
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [] }, location: { search: '' }, URLSearchParams,
    localStorage: { getItem: (key) => stored[key] ?? null, setItem: (key, value) => { stored[key] = value; } },
  });
  vm.runInContext(code, context);
  const run = (source) => vm.runInContext(source, context);
  run('currentName = "alice"; mentionable = ["alice", "bob", "bob-agent", "all"];');
  return { element, run, stored };
}

const at = (minutes) => Date.UTC(2026, 10, 7, 12, minutes);
const message = (id, from, text, minutes, extra = {}) => ({ id, from, text, at: at(minutes), mentions: [...text.matchAll(/@([\w-]+)/g)].map((m) => m[1]), fromHuman: !from.endsWith('-agent'), ...extra });

test('the chat interleaves activity lines with messages in time order, and the switch hides them', () => {
  const p = page();
  p.run(`lastMessages = ${JSON.stringify([message(1, 'bob', 'start the search', 0), message(2, 'bob-agent', 'locking the api', 5)])};
         lastEvents = ${JSON.stringify([{ at: at(3), agent: 'bob-agent', text: 'locked src/api.ts (adding search)', branch: 'feat/search' }, { at: at(7), agent: 'bob-agent', text: 'moved task #2 to doing', branch: '' }])};
         renderChat()`);
  const html = p.element('chat').innerHTML;
  const order = ['start the search', 'locked', 'locking the api', 'moved task'].map((text) => html.indexOf(text));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'messages and activity lines are in time order');
  assert.match(html, /<span class="mono strong">src\/api\.ts<\/span>/);
  assert.match(html, /on feat\/search/);
  assert.equal(p.element('chat-empty').hidden, true);

  p.run('showActivity = false; renderChat()');
  assert.ok(!p.element('chat').innerHTML.includes('src/api.ts'));
  assert.ok(p.element('chat').innerHTML.includes('locking the api'));
});

test('the chosen branch filters the activity lines in the chat', () => {
  const p = page();
  p.run(`lastMessages = [];
         lastEvents = ${JSON.stringify([{ at: at(1), agent: 'a-agent', text: 'locked one.ts', branch: 'main' }, { at: at(2), agent: 'b-agent', text: 'locked two.ts', branch: 'dev' }])};
         branchFilter = "dev"; renderChat()`);
  const html = p.element('chat').innerHTML;
  assert.ok(html.includes('two.ts'));
  assert.ok(!html.includes('one.ts'));
});

test('people are boxed, agents are plain, consecutive messages group, and mentions of you stand out', () => {
  const p = page();
  p.run(`lastMessages = ${JSON.stringify([message(1, 'bob', '@alice can you look?', 0), message(2, 'bob', 'thanks', 1), message(3, 'bob-agent', 'hi @all <b>', 2), message(4, 'alice', '@bob-agent go', 3)])};
         lastEvents = []; renderChat()`);
  const html = p.element('chat').innerHTML;
  assert.equal((html.match(/class="mrow head"/g) || []).length, 3, 'the second bob message continues the first');
  assert.equal((html.match(/class="mrow cont"/g) || []).length, 1);
  assert.match(html, /class="hbox me"/, 'a human message that mentions you is outlined');
  assert.match(html, /class="abody me"/, 'an agent message to @all is tinted for you');
  assert.match(html, /<span class="m m-me">@alice<\/span>/);
  assert.ok(html.includes('hi <span class="m">@all</span> &#60;b&#62;'), 'text is escaped');
  assert.match(html, /class="hbox"><div class="mh"><span style="font-weight:500">alice<\/span>/, 'your own message is not outlined');
});

test('an empty timeline shows the empty state', () => {
  const p = page();
  p.run('lastMessages = []; lastEvents = []; renderChat()');
  assert.equal(p.element('chat-empty').hidden, false);
  assert.equal(p.element('chat-scroll').hidden, true);
});

test('unchanged polls do not redraw the chat', () => {
  const p = page();
  p.run(`lastMessages = ${JSON.stringify([message(1, 'bob', 'hello', 0)])}; lastEvents = []; renderChat()`);
  p.element('chat').innerHTML = 'kept as is';
  p.run('renderChat()');
  assert.equal(p.element('chat').innerHTML, 'kept as is');
});

test('tabs show one list at a time and mark the selected tab', () => {
  const p = page();
  p.run('setTab("locks")');
  assert.equal(p.element('panel-locks').hidden, false);
  assert.equal(p.element('panel-tasks').hidden, true);
  assert.equal(p.element('panel-activity').hidden, true);
  assert.equal(p.element('tab-locks').attributes['aria-selected'], 'true');
  assert.equal(p.element('tab-tasks').attributes['aria-selected'], 'false');
  assert.equal(p.element('tab-locks').set.has('on'), true);
  p.run('setTab("tasks")');
  assert.equal(p.element('panel-tasks').hidden, false);
});

test('the activity switch is remembered and starts on unless turned off', () => {
  const p = page();
  assert.equal(p.run('showActivity'), true);
  p.run('setActivityToggle()');
  p.element('activity-toggle').listeners.click();
  assert.equal(p.run('showActivity'), false);
  assert.equal(p.stored['agent-hub-activity'], 'off');
  assert.equal(p.element('activity-toggle').attributes['aria-pressed'], 'false');
});
