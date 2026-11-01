import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionRequestView } from '../public/connection-management-ui.js';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, value) { this.listeners[key] = value; }
  focus() { this.focused = true; }
  reportValidity() { this.reported = true; }
}
function fixture(t, targets) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: tag => new Element(tag) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
  const calls = [], view = connectionRequestView({ params: { targets } }, { submit: value => calls.push(value) });
  return { ...view, calls };
}
const walk = node => [node, ...node.children.flatMap(walk)];

test('credentials require an explicit human click and secret defaults are blank', t => {
  const f = fixture(t, [{ name: 'fixture', kind: 'mcp', state: 'pending', required_env: [{ name: 'FIXTURE_KEY', prompt: 'API key', required: true, secret: true, default: 'hidden-default' }] }]);
  const input = f.controls.find(node => node.tagName === 'input'), approve = f.controls.find(node => node.textContent === '确认连接');
  assert.equal(input.type, 'password'); assert.equal(input.value, ''); assert.deepEqual(f.calls, []);
  approve.listeners.click(); assert.equal(f.calls.length, 0); assert.equal(input.focused, true);
  input.value = 'manual-secret'; approve.listeners.click();
  assert.deepEqual(f.calls, [{ targets: [{ name: 'fixture', status: 'approved', env: { FIXTURE_KEY: 'manual-secret' } }] }]);
});

test('auth links are human-opened and unsafe schemes are refused', t => {
  const f = fixture(t, [{ name: 'hosted', kind: 'connector', state: 'initiated', connect_url: 'https://auth.invalid/?opaque=one' },
    { name: 'unsafe', kind: 'connector', state: 'pending', connect_url: 'javascript:alert(1)' }]);
  const links = walk(f.card).filter(node => node.tagName === 'a'); assert.equal(links.length, 1);
  assert.equal(links[0].attributes.href, 'https://auth.invalid/?opaque=one'); assert.equal(links[0].attributes.rel, 'noopener noreferrer'); assert.equal(f.calls.length, 0);
});

test('cancel skips unresolved targets without claiming backend connection success', t => {
  const f = fixture(t, [{ name: 'one', kind: 'mcp', state: 'pending' }, { name: 'done', kind: 'mcp', state: 'connected' }]);
  f.controls.find(node => node.textContent === '取消').listeners.click();
  assert.deepEqual(f.calls, [{ targets: [{ name: 'one', status: 'skipped' }], settled_by: 'continue' }]);
});

test('disabled controls do not submit and status checking carries no credentials', t => {
  const f = fixture(t, [{ name: '<img onerror=alert(1)>', kind: 'connector', state: 'initiated' }]);
  const check = f.controls.find(node => node.textContent === '检查连接'); check.disabled = true; check.listeners.click(); assert.equal(f.calls.length, 0);
  check.disabled = false; check.listeners.click(); assert.deepEqual(f.calls, [{ targets: [] }]);
  assert(walk(f.card).some(node => node.textContent.includes('<img onerror='))); assert.equal(walk(f.card).filter(node => node.tagName === 'img').length, 0);
});
