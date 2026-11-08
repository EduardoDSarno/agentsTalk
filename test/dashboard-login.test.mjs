import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\s+start\(\);\s*$/, '');

/** Loads the page script signed out, with the given address query, fake elements and a fake browser. */
function page(search = '') {
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', hidden: true, disabled: false, innerHTML: '', textContent: '', listeners: {}, attributes: {}, style: {},
      classList: { contains: () => false, toggle() {} },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name] ?? null; },
    });
    return nodes.get(id);
  };
  const assigned = [];
  const replaced = [];
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [] },
    location: { search, pathname: '/', assign: (url) => assigned.push(url), replace: () => {} },
    history: { replaceState: (state, title, url) => replaced.push(url) },
    URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: () => 0, clearTimeout: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  vm.runInContext(script, context);
  return { element, assigned, replaced, run: (code) => vm.runInContext(code, context) };
}

test('opening the app signed out shows the login page for the project in the link', async () => {
  const p = page('?project=team/project');
  await p.run('loadIdentity()');
  assert.equal(p.element('login').hidden, false);
  assert.equal(p.element('login-project').textContent, 'team/project');
  assert.equal(p.element('login-project-pill').hidden, false);
  assert.equal(p.element('login-repo-wrap').hidden, true);
  assert.equal(p.element('login-alert').hidden, true);
});

test('a failed GitHub sign-in says why once, then the reason leaves the address', async () => {
  const p = page('?project=team/project&login_error=no_access&login=eve');
  await p.run('loadIdentity()');
  assert.equal(p.element('login-alert').hidden, false);
  assert.equal(p.element('login-alert-title').textContent, "@eve can't write to team/project on GitHub");
  assert.deepEqual(p.replaced, ['/?project=team%2Fproject']);
});

test('Continue with GitHub goes to GitHub for the repo, and a missing repo is asked for first', async () => {
  const p = page('?project=team/project');
  await p.run('loadIdentity(); webSignIn = true; continueWithGitHub()');
  assert.deepEqual(p.assigned, ['/auth/github/start?repo=team%2Fproject']);
  assert.equal(p.element('login-go').disabled, true);
  assert.match(p.element('login-go').innerHTML, /Redirecting to GitHub/);

  const q = page('');
  await q.run('loadIdentity(); webSignIn = true');
  assert.equal(q.element('login-repo-wrap').hidden, false, 'without a project the repo is asked for');
  q.element('login-repo').value = 'not a repo';
  q.run('continueWithGitHub()');
  assert.equal(q.element('login-alert-title').textContent, 'Enter the repo as owner/name');
  assert.equal(q.assigned.length, 0);
  q.element('login-repo').value = 'Team/Other';
  q.run('continueWithGitHub()');
  assert.deepEqual(q.assigned, ['/auth/github/start?repo=team%2Fother']);
});
