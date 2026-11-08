import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\s+start\(\);\s*$/, '');
function board(tasks = []) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', hidden: true, innerHTML: '', textContent: '', listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
    });
    return nodes.get(id);
  };
  const requests = [];
  let respond = async () => ({ok: true, json: async () => ({id: 9, title: 'New task', status: 'todo', owner: '', note: ''})});
  const stored = {};
  const context = vm.createContext({
    document: { getElementById: element }, location: {search: ''}, URLSearchParams,
    localStorage: { getItem: (key) => stored[key] ?? null, setItem: (key, value) => { stored[key] = value; } }, tasks,
    fetch: async (url, options) => { requests.push({url, ...options}); return respond(url, options); },
  });
  vm.runInContext(script, context);
  vm.runInContext('currentName = "alice"; project = "team/project"; keys = {"team/project":"test-key"}; refresh = () => {}; setUpTasks(); renderTasks(tasks);', context);
  return { element, requests, stored, run: code => vm.runInContext(code, context), respond: fn => {respond = fn;} };
}
const task = (id, status, owner = '') => ({id, title: `Task ${id}`, status, owner, note: ''});

test('Board groups blocked work and offers ownership-aware actions', () => {
  const b = board([task(1, 'todo'), task(2, 'doing', 'bob-agent'), task(3, 'blocked', 'alice'), task(4, 'done', 'bob-agent')]);
  assert.ok(b.element('tasks').innerHTML.includes('Blocked'));
  // Actions appear when a task is opened; clicking a task row toggles it.
  const openActions = (id) => {
    b.element('tasks').listeners.click({ target: { closest: (selector) => (selector === '[data-task-toggle]' ? { dataset: { taskToggle: String(id) } } : null) } });
    return b.element('tasks').innerHTML;
  };
  for (const [id, labels] of [[1, ['Claim task #1']], [3, ['Resume task #3', 'Done task #3', 'Release task #3']]]) {
    const view = openActions(id);
    for (const text of labels) assert.ok(view.includes(text), text);
  }
  // Done starts folded, so its tasks appear only once the group is opened.
  assert.ok(!b.element('tasks').innerHTML.includes('Reopen task #4'), 'the Done group starts folded');
  b.run('toggleGroup("done")');
  const doneView = openActions(4);
  for (const text of ['Reopen task #4']) assert.ok(doneView.includes(text), text);
  const held = openActions(2);
  assert.ok(!held.includes('data-task-id="2"'));
  assert.match(held, /Held by bob-agent/);
  assert.equal(b.run('openTaskId'), 2);
  assert.equal(openActions(2).includes('data-task-id="2"'), false);
  assert.equal(b.run('openTaskId'), null, 'clicking the opened task closes it');
  assert.equal(b.element('task-add').disabled, false);
});

test('Add form sends a trimmed title as the human, then clears only on success', async () => {
  const b = board();
  b.element('task-title').value = '  New task  ';
  await b.run('addDashboardTask()');
  assert.equal(b.requests[0].url, '/api/tasks?as=human');
  assert.deepEqual(JSON.parse(b.requests[0].body), {title: 'New task'});
  assert.equal(b.requests[0].headers.authorization, 'Bearer test-key');
  assert.equal(b.element('task-title').value, '');
  assert.match(b.element('tasks').innerHTML, /New task/);
});

test('Move sends status and draft note; blocked requires a reason', async () => {
  const b = board([task(1, 'doing', 'alice')]);
  await b.run('moveDashboardTask(1, "blocked")');
  assert.equal(b.requests.length, 0);
  assert.match(b.element('task-error').textContent, /Add a note/);
  b.element('tasks').listeners.input({target: {dataset: {taskNote: '1'}, value: 'Waiting for review'}});
  b.respond(async () => ({ok: true, json: async () => ({...task(1, 'blocked', 'alice'), note: 'Waiting for review'})}));
  await b.run('moveDashboardTask(1, "blocked")');
  assert.equal(b.requests[0].url, '/api/tasks/1?as=human');
  assert.deepEqual(JSON.parse(b.requests[0].body), {status: 'blocked', note: 'Waiting for review'});
});

test('409 displays the server error without going offline or losing draft notes', async () => {
  const b = board([task(1, 'todo')]);
  b.run('taskNotes.set(1, "keep my draft")');
  b.respond(async () => ({ok: false, status: 409, json: async () => ({error: 'Task #1 is doing with bob-agent'})}));
  await b.run('moveDashboardTask(1, "doing")');
  assert.equal(b.element('task-error').hidden, false);
  assert.equal(b.element('task-error').textContent, 'Task #1 is doing with bob-agent');
  assert.equal(b.run('offline'), false);
  assert.equal(b.run('taskNotes.get(1)'), 'keep my draft');
  assert.equal(b.element('task-add').disabled, false);
});

test('Unchanged polls preserve note DOM and changed polls keep draft values', () => {
  const b = board([task(1, 'todo')]);
  b.run('openTaskId = 1; taskRenderKey = ""; renderTasks(lastTasks)');
  b.element('tasks').innerHTML = 'existing focused DOM';
  b.run('renderTasks(lastTasks)');
  assert.equal(b.element('tasks').innerHTML, 'existing focused DOM');
  b.run('taskNotes.set(1, "unsaved draft"); renderTasks([...lastTasks, {id:2, title:"Other update", status:"todo"}])');
  assert.match(b.element('tasks').innerHTML, /value="unsaved draft"/);
});

test('Pending requests and offline state block duplicate changes', async () => {
  const b = board();
  let release;
  b.respond(() => new Promise(resolve => {release = resolve;}));
  b.element('task-title').value = 'New task';
  const pending = b.run('addDashboardTask()');
  await b.run('addDashboardTask()');
  assert.equal(b.requests.length, 1);
  assert.equal(b.element('task-add').disabled, true);
  release({ok: true, json: async () => ({id: 1, title: 'New task', status: 'todo'})});
  await pending;
  b.run('offline = true; renderTasks(lastTasks)');
  b.element('task-title').value = 'Offline task';
  await b.run('addDashboardTask()');
  assert.equal(b.requests.length, 1);
  assert.equal(b.element('task-add').disabled, true);
});

test('An in-flight response cannot insert a task into a newly selected project', async () => {
  const b = board();
  let release;
  b.respond(() => new Promise(resolve => {release = resolve;}));
  b.element('task-title').value = 'Old project';
  const pending = b.run('addDashboardTask()');
  b.run('project = "other/project"; lastTasks = [];');
  b.element('task-title').value = 'New project draft';
  release({ok: true, json: async () => ({id: 1, title: 'Old project', status: 'todo'})});
  await pending;
  assert.equal(b.run('lastTasks.length'), 0);
  assert.equal(b.element('task-title').value, 'New project draft');
});

test('A task with a pull request shows its review state and lets the human approve or ask for changes', async () => {
  const withPr = (reviews) => ({ ...task(1, 'doing', 'bob-agent'), pr: 7, reviews });
  const b = board([withPr([])]);
  const label = (tasks) => { b.run(`taskRenderKey = ""; renderTasks(${JSON.stringify(tasks)})`); return b.element('tasks').innerHTML; };
  assert.match(label([withPr([])]), /Needs review/);
  assert.match(label([withPr([{ by: 'carol-agent', verdict: 'approved' }])]), /Approved by carol-agent/);
  assert.match(label([withPr([{ by: 'carol-agent', verdict: 'changes' }])]), /Changes requested by carol-agent/);
  assert.ok(!label([task(2, 'doing', 'bob-agent')]).includes('Needs review'), 'no PR, no review state');
  assert.ok(!label([{ ...withPr([]), status: 'done' }]).includes('Needs review'), 'a finished task is not waiting');

  // The buttons appear when the task is opened; clicking one sends the verdict as the human.
  b.run('openTaskId = 1');
  assert.match(label([withPr([])]), /Approve PR #7/);
  b.respond(async () => ({ ok: true, json: async () => ({ ...withPr([{ by: 'alice', verdict: 'approved' }]) }) }));
  b.element('tasks').listeners.click({ target: { closest: (selector) => (selector === '[data-review-pr]' ? { dataset: { reviewPr: '7', verdict: 'approved' }, disabled: false } : null) } });
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(b.requests[0].url, '/api/reviews?as=human');
  assert.deepEqual(JSON.parse(b.requests[0].body), { pr: 7, verdict: 'approved' });
});

test('Pull requests waiting for review come first, with their buttons showing without opening the task', () => {
  const withPr = (id, reviews) => ({ ...task(id, 'doing', 'bob-agent'), pr: 10 + id, reviews });
  const b = board([task(1, 'doing', 'bob-agent'), withPr(2, []), withPr(3, [{ by: 'carol-agent', verdict: 'approved' }]), { ...withPr(4, []), owner: 'alice' }]);
  const html = b.element('tasks').innerHTML;
  const top = html.indexOf('Waiting for review');
  assert.ok(top >= 0 && top < html.indexOf('In progress'), 'the review group is above the status groups');
  assert.match(html, /Approve PR #12/, 'buttons show on a waiting task without opening it');
  assert.ok(!html.includes('Approve PR #13'), 'an approved PR is no longer waiting and stays closed');
  assert.ok(!html.includes('Approve PR #14'), 'the author gets no review buttons on their own task');
  assert.equal(html.split('Task 2<').length - 1, 1, 'a waiting task is not listed twice');
});

test('Task groups fold from their header, Done starts folded, and the choice is remembered', () => {
  const b = board([task(1, 'todo'), task(2, 'done', 'bob-agent')]);
  const view = () => b.element('tasks').innerHTML;
  assert.match(view(), /data-group-toggle="done" aria-expanded="false"/);
  assert.match(view(), /data-group-toggle="todo" aria-expanded="true"/);
  assert.ok(!view().includes('Task 2'), 'a folded group hides its tasks');
  assert.ok(view().includes('Task 1'));

  b.run('toggleGroup("done")');
  assert.match(view(), /data-group-toggle="done" aria-expanded="true"/);
  assert.ok(view().includes('Task 2'));
  assert.equal(b.stored['agent-hub-groups'], '[]', 'opening Done is saved as "nothing folded"');

  b.run('toggleGroup("done")');
  assert.ok(!view().includes('Task 2'));
  assert.equal(b.stored['agent-hub-groups'], '["done"]');
});

test('A saved fold is restored on load, and unknown groups are ignored', () => {
  const b = board([task(1, 'todo'), task(2, 'done')]);
  b.stored['agent-hub-groups'] = '["todo","gone"]';
  assert.deepEqual([...b.run('readCollapsedGroups()')], ['todo']);
  b.stored['agent-hub-groups'] = 'not json';
  assert.deepEqual([...b.run('readCollapsedGroups()')], ['done'], 'bad saved values fall back to Done folded');
});

test("Task cards name the person behind an agent, and people can move their own agents' tasks", () => {
  const b = board([task(1, 'doing', 'bob/codex'), task(2, 'doing', 'alice/opencode')]);
  const open = (id) => { b.run(`openTaskId = ${id}; taskRenderKey = ""; renderTasks(lastTasks)`); return b.element('tasks').innerHTML; };
  const bobs = open(1);
  assert.match(bobs, /title="bob\/codex"/, 'the agent shows on hover');
  assert.match(bobs, /<span class="clip">bob<\/span>/, 'the card names the person');
  assert.match(bobs, /Held by bob\. Only they can move it\./);
  const mine = open(2);
  assert.ok(mine.includes('Done task #2'), "alice can close her own agent's task");
  assert.ok(!mine.includes('Held by'));
});
