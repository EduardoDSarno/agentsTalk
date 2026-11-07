import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\s+start\(\);\s*$/, '');

function composer() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', hidden: true, innerHTML: '', attributes: {}, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      focus() {},
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element },
    location: { search: '' }, URLSearchParams,
    localStorage: { getItem: () => null },
  });
  vm.runInContext(script, context);
  vm.runInContext('currentName = "alice"; mentionable = ["alice", "bob", "bob-agent", "all"]; setUpComposer();', context);
  const draft = element('draft');
  const type = value => { draft.value = value; draft.listeners.input(); };
  const key = (key, options = {}) => {
    const event = { key, shiftKey: false, preventDefault() { this.prevented = true; }, ...options };
    draft.listeners.keydown(event);
    return event;
  };
  return { draft, element, type, key, refresh: () => vm.runInContext('updateComposer()', context) };
}

for (const accept of ['Enter', 'Tab']) {
  test(`Down selects the next mention and ${accept} inserts it`, () => {
    const c = composer();
    c.type('@');
    assert.equal(c.key('ArrowDown').prevented, true);
    assert.equal(c.draft.attributes['aria-activedescendant'], 'suggestion-1');
    assert.match(c.element('suggest').innerHTML, /aria-selected="true" class="sug sel" data-name="bob"/);
    assert.equal(c.key(accept).prevented, true);
    assert.equal(c.draft.value, '@bob ');
    assert.equal(c.element('suggest').hidden, true);
  });
}

test('Up and Down wrap around, and typing a filter resets selection', () => {
  const c = composer();
  c.type('@');
  c.key('ArrowUp');
  assert.equal(c.draft.attributes['aria-activedescendant'], 'suggestion-3');
  c.key('ArrowDown');
  assert.equal(c.draft.attributes['aria-activedescendant'], 'suggestion-0');
  c.key('ArrowDown');
  c.type('@b');
  c.key('Enter');
  assert.equal(c.draft.value, '@bob ');
});

test('Escape closes suggestions through refreshes until input changes', () => {
  const c = composer();
  c.type('@');
  assert.equal(c.key('Escape').prevented, true);
  c.refresh();
  assert.equal(c.element('suggest').hidden, true);
  assert.equal(c.draft.attributes['aria-expanded'], 'false');
  assert.equal(c.draft.attributes['aria-activedescendant'], undefined);
  assert.equal(c.key('ArrowDown').prevented, undefined);
  c.type('@b');
  assert.equal(c.element('suggest').hidden, false);
});

test('Shift+Enter, Shift+Tab and IME composition keep native input behavior', () => {
  const c = composer();
  c.type('@');
  for (const [key, options] of [['Enter', {shiftKey: true}], ['Tab', {shiftKey: true}], ['Enter', {isComposing: true}], ['ArrowDown', {isComposing: true}]]) {
    assert.equal(c.key(key, options).prevented, undefined);
    assert.equal(c.draft.value, '@');
  }
});

test('Mouse selection still inserts the clicked mention', () => {
  const c = composer();
  c.type('Hi @b');
  let prevented = false;
  c.element('suggest').listeners.mousedown({
    target: { closest: () => ({ dataset: {name: 'bob-agent'} }) },
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(c.draft.value, 'Hi @bob-agent ');
});
