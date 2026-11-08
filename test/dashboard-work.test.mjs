import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/** Loads the dashboard script against a fake page and exposes what the tests need. */
function dashboard() {
  const html = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\n\s*start\(\);\s*$/, '\n');
  const elements = new Map();
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', hidden: true }); return elements.get(id); } };
  const context = vm.createContext({ document, URLSearchParams, location: { search: '' }, localStorage: { getItem() { return null; } }, console });
  vm.runInContext(code + '\nglobalThis.testDashboard = { renderTasks, renderLocks, renderEvents, personAvatar, open: (id) => { openTaskId = id; taskRenderKey = ""; } };', context);
  return { ui: context.testDashboard, elements, context };
}

test('tasks show readable titles, owner identity and escaped user text', () => {
  const { ui, elements } = dashboard();
  ui.renderTasks([{ id: 1, status: 'doing', title: 'A long task <script>alert(1)</script>', note: 'Work & review', owner: 'alice-agent' }, { id: 2, status: 'todo', title: 'Next', owner: '' }]);
  const html = elements.get('tasks').innerHTML;
  assert.match(html, /A long task &#60;script&#62;/);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /Work &#38; review/);
  assert.match(html, /#1/);
  assert.match(html, /alice-agent/);
  assert.match(html, /Unassigned/);
  assert.equal(elements.get('task-count').textContent, 2);
});

test('a task with a pull request links to it on GitHub', () => {
  const { ui, elements, context } = dashboard();
  vm.runInContext('project = "team/app"', context);
  ui.renderTasks([{ id: 1, status: 'doing', title: 'Linked', owner: 'alice', pr: 17 }, { id: 2, status: 'todo', title: 'Plain', owner: '' }]);
  const html = elements.get('tasks').innerHTML;
  assert.match(html, /href="https:\/\/github\.com\/team\/app\/pull\/17"[^>]*>PR #17</);
  assert.equal((html.match(/pull\//g) || []).length, 1);
});

test('only the opened task shows its note field and actions; done tasks stay out of the count', () => {
  const { ui, elements } = dashboard();
  const tasks = [{ id: 1, status: 'todo', title: 'First', owner: '' }, { id: 2, status: 'todo', title: 'Second', owner: '' }, { id: 3, status: 'done', title: 'Old', owner: 'alice' }];
  ui.renderTasks(tasks);
  assert.ok(!elements.get('tasks').innerHTML.includes('Claim task'));
  assert.equal(elements.get('task-count').textContent, 2);
  ui.open(2);
  ui.renderTasks(tasks);
  const html = elements.get('tasks').innerHTML;
  assert.ok(html.includes('Claim task #2'));
  assert.ok(!html.includes('Claim task #1'));
  assert.match(html, /aria-expanded="true"/);
});

test('stale tasks are labelled and offer Take over, fresh tasks held by someone else offer nothing', () => {
  const { ui, elements } = dashboard();
  const tasks = [{ id: 1, status: 'doing', title: 'Abandoned', owner: 'bob-agent', stale: true }, { id: 2, status: 'doing', title: 'Busy', owner: 'bob-agent', stale: false }];
  ui.open(1);
  ui.renderTasks(tasks);
  let html = elements.get('tasks').innerHTML;
  const [abandoned, busy] = html.split('Busy');
  assert.match(abandoned, /Stale/);
  assert.match(abandoned, /Take over task #1/);
  assert.ok(!busy.includes('Stale'));
  ui.open(2);
  ui.renderTasks(tasks);
  html = elements.get('tasks').innerHTML;
  assert.match(html, /Held by bob-agent\. Only they can move it\./);
  assert.ok(!html.includes('Take over task #2'));
});

test('locks show path, owner, branch and reason, and flag locks about to expire', () => {
  const { ui, elements } = dashboard();
  ui.renderLocks([{ path: 'src/a.ts', owner: 'alice-agent', branch: 'main', reason: 'adding <search>', minutesLeft: 3 }, { path: 'src/b.ts', owner: 'bob-agent', branch: '', reason: '', minutesLeft: 20 }]);
  const html = elements.get('locks').innerHTML;
  assert.equal(elements.get('lock-count').textContent, 2);
  for (const text of ['src/a.ts', 'alice-agent', 'main', 'adding &#60;search&#62;', '3m', '20m']) assert.ok(html.includes(text), text);
  assert.match(html, /warn" style="line-height:20px" aria-label="3 minutes left"/);
  ui.renderLocks([]);
  assert.match(elements.get('locks').innerHTML, /No files locked/);
});

test('the activity tab lists newest first with paths in monospace and the branch', () => {
  const { ui, elements } = dashboard();
  ui.renderEvents([{ at: Date.now(), agent: 'alice-agent', text: 'locked src/api.ts (adding search)', branch: 'feat/search' }]);
  const html = elements.get('events').innerHTML;
  assert.equal(elements.get('event-count').textContent, 1);
  assert.match(html, /alice-agent/);
  assert.match(html, /<span class="mono">src\/api\.ts<\/span>/);
  assert.match(html, /on feat\/search/);
});

test('avatars use consistent colors for a person and their agents, in both themes', () => {
  const { ui } = dashboard();
  const alice = ui.personAvatar('alice', false, 24), agent = ui.personAvatar('alice/claude', true, 24), bob = ui.personAvatar('bob/codex', true, 24);
  const dark = (s) => s.match(/--avatar-bg:([^;]+)/)[1];
  const light = (s) => s.match(/--avatar-lbg:([^;]+)/)[1];
  assert.equal(dark(alice), dark(agent));
  assert.notEqual(dark(agent), dark(bob));
  assert.equal(light(alice), alice.match(/--avatar-fg:([^;]+)/)[1], 'light mode swaps the pair');
  assert.match(alice, />A<\/span>/);
  assert.match(agent, /<svg/);
  assert.match(agent, /av-a/);
  assert.match(alice, /av-h/);
});
