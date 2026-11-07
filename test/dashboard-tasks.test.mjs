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
  const context = vm.createContext({
    document: { getElementById: element }, location: {search: ''}, URLSearchParams,
    localStorage: { getItem: () => null }, tasks,
    fetch: async (url, options) => { requests.push({url, ...options}); return respond(url, options); },
  });
  vm.runInContext(script, context);
  vm.runInContext('currentName = "alice"; project = "team/project"; keys = {"team/project":"test-key"}; refresh = () => {}; setUpTasks(); renderTasks(tasks);', context);
  return { element, requests, run: code => vm.runInContext(code, context), respond: fn => {respond = fn;} };
}
const task = (id, status, owner = '') => ({id, title: `Task ${id}`, status, owner, note: ''});

test('Board groups blocked work and offers ownership-aware actions', () => {
  const b = board([task(1, 'todo'), task(2, 'doing', 'bob-agent'), task(3, 'blocked', 'alice'), task(4, 'done', 'bob-agent')]);
  const view = b.element('tasks').innerHTML;
  for (const text of ['Blocked', 'Claim task #1', 'Resume task #3', 'Done task #3', 'Release task #3', 'Reopen task #4']) assert.ok(view.includes(text), text);
  assert.ok(!view.includes('data-task-id="2"'));
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
