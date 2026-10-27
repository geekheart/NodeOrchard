import test from 'node:test';
import assert from 'node:assert/strict';
import { ShortcutSettingsUI } from '../public/shortcut-settings-ui.js';
import { DEFAULT_SHORTCUTS } from '../shared/keyboard-shortcuts.mjs';

class Element {
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.listeners = new Map(); this.attributes = {}; this.dataset = {}; this.children = []; this.disabled = false; this.isConnected = true; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parentNode = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  closest(selector) { return selector === '[hidden]' && this.hidden ? this : this.parentNode?.closest(selector) || null; }
  focus() { this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) this.listeners.get('click')?.({ preventDefault() {} }); }
}
const settings = shortcuts => ({ preferences: { theme: 'dark', density: 'comfortable', defaultWorkspace: '.', shortcuts: structuredClone(shortcuts || DEFAULT_SHORTCUTS) } });
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
function fixture(t, { api = async (_path, options) => settings(options.body.preferences.shortcuts), onSaved, readOnly = false } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document'), listeners = new Map();
  const document = { activeElement: null, createElement: tag => new Element(tag, document),
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
    emit(name, event) { for (const handler of listeners.get(name) || []) { handler(event); if (event.immediateStopped) break; } },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  const host = document.createElement('div'), ui = new ShortcutSettingsUI({ api, onSaved, readOnly }); ui.mount(host);
  t.after(() => { ui.destroy(); descriptor ? Object.defineProperty(globalThis, 'document', descriptor) : delete globalThis.document; });
  const press = (key, modifiers = {}) => {
    const event = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: document.activeElement,
      ...modifiers, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.immediateStopped = true; } };
    document.emit('keydown', event); return event;
  };
  return { ui, host, document, press };
}

test('the editable operation table displays default shortcuts only after settings are read', t => {
  const { ui } = fixture(t);
  assert.equal(ui.saveButton.disabled, true); assert([...ui.rows.values()].every(row => row.edit.disabled));
  ui.accept(settings());
  assert.equal(ui.rows.get('chat.send').keys.children.length, 2);
  assert(ui.rows.get('chat.send').keys.children.some(key => key.textContent.includes('Ctrl')));
  assert(ui.rows.get('chat.send').keys.children.some(key => key.textContent.includes('⌘')));
  assert.equal(ui.rows.get('chat.send').edit.attributes['aria-label'].includes('修改快捷键'), true);
  assert.equal(ui.dirty(), false); assert.equal(ui.rows.get('workflow.save').edit.disabled, false);
});

test('recording a chord consumes the event without triggering global handlers and remains a local draft', t => {
  let globalHits = 0, writes = 0;
  const { ui, press, document } = fixture(t, { api: async () => { writes++; } }); ui.accept(settings());
  document.addEventListener('keydown', () => { globalHits++; }, true);
  ui.rows.get('chat.send').edit.click(); assert.equal(ui.isRecording(), true);
  const event = press('Enter', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(ui.draft['chat.send'], ['Ctrl+Shift+Enter']); assert.deepEqual(ui.saved['chat.send'], DEFAULT_SHORTCUTS['chat.send']);
  assert(event.defaultPrevented && event.stopped && event.immediateStopped);
  assert.equal(globalHits, 0); assert.equal(writes, 0); assert.equal(ui.isRecording(), false); assert.equal(ui.dirty(), true);
});

test('conflicting, reserved and IME chords preserve the previous binding while Escape cancels recording', t => {
  const { ui, press } = fixture(t); ui.accept(settings()); const before = structuredClone(ui.draft);
  ui.startRecording('chat.send'); press('M', { altKey: true, shiftKey: true });
  assert.deepEqual(ui.draft, before); assert.equal(ui.isRecording(), true); assert(ui.error);
  assert(ui.rows.get('chat.send').keys.children.some(node => node.attributes?.role === 'alert'));
  press('r', { ctrlKey: true }); assert.deepEqual(ui.draft, before); assert(ui.error);
  press('Enter', { ctrlKey: true, isComposing: true, keyCode: 229 }); assert.deepEqual(ui.draft, before); assert.match(ui.error, /输入法/);
  press('Enter', { ctrlKey: true, repeat: true }); assert.deepEqual(ui.draft, before);
  press('Escape'); assert.equal(ui.isRecording(), false); assert.deepEqual(ui.draft, before); assert.equal(ui.dirty(), false);
});

test('external settings reads cannot overwrite unsaved or currently recorded shortcuts', t => {
  const { ui } = fixture(t); ui.accept(settings()); ui.setBindings('chat.send', ['Ctrl+Shift+Enter']);
  const external = structuredClone(DEFAULT_SHORTCUTS); external['workflow.save'] = ['Ctrl+Shift+S']; ui.accept(settings(external));
  assert.deepEqual(ui.draft['chat.send'], ['Ctrl+Shift+Enter']); assert.deepEqual(ui.draft['workflow.save'], DEFAULT_SHORTCUTS['workflow.save']);
  assert.deepEqual(ui.saved['workflow.save'], ['Ctrl+Shift+S']);
  ui.resetAll(); ui.saved = structuredClone(DEFAULT_SHORTCUTS); ui.startRecording('chat.send'); ui.accept(settings(external));
  assert.equal(ui.recording, 'chat.send'); assert.deepEqual(ui.draft['workflow.save'], DEFAULT_SHORTCUTS['workflow.save']);
});

test('disabling and restoring individual or all shortcuts affects only the draft until explicitly saved', t => {
  const { ui } = fixture(t); ui.accept(settings());
  ui.rows.get('chat.send').disable.click(); assert.deepEqual(ui.draft['chat.send'], []); assert.equal(ui.rows.get('chat.send').keys.children[0].textContent, '未设置');
  ui.rows.get('chat.send').reset.click(); assert.deepEqual(ui.draft['chat.send'], DEFAULT_SHORTCUTS['chat.send']); assert.equal(ui.dirty(), false);
  ui.setBindings('chat.send', ['Ctrl+Shift+Enter']); ui.resetAllButton.click(); assert.deepEqual(ui.draft, DEFAULT_SHORTCUTS); assert.equal(ui.saveButton.disabled, true);
});

test('saving sends only shortcut preferences, blocks duplicate writes, and reports the confirmed setting', async t => {
  const gate = deferred(), writes = [], accepted = [];
  const { ui } = fixture(t, { api: async (path, options) => { writes.push({ path, options }); return gate.promise; }, onSaved: value => accepted.push(value) });
  ui.accept(settings()); ui.setBindings('chat.send', ['Ctrl+Shift+Enter']); const pending = ui.save(); await ui.save();
  assert.equal(writes.length, 1); assert.equal(ui.saveButton.disabled, true); assert.equal(ui.rows.get('chat.send').edit.disabled, true);
  assert.deepEqual(Object.keys(writes[0].options.body.preferences), ['shortcuts']); assert.equal(writes[0].path, '/api/settings');
  assert.deepEqual(writes[0].options.body.preferences.shortcuts['chat.send'], ['Ctrl+Shift+Enter']);
  ui.setBindings('chat.send', []); assert.deepEqual(ui.draft['chat.send'], ['Ctrl+Shift+Enter']);
  const response = settings(ui.draft); gate.resolve(response); assert.equal(await pending, true);
  assert.deepEqual(accepted, [response]); assert.equal(ui.dirty(), false); assert.match(ui.status.textContent, /已保存/);
});

test('a failed or unconfirmed save retains the user draft instead of claiming that the binding is live', async t => {
  let reject = true;
  const { ui } = fixture(t, { api: async () => { if (reject) throw Error('服务暂不可用'); return settings(); } });
  ui.accept(settings()); ui.setBindings('chat.send', ['Ctrl+Shift+Enter']); assert.equal(await ui.save(), false);
  assert.deepEqual(ui.draft['chat.send'], ['Ctrl+Shift+Enter']); assert.match(ui.status.textContent, /服务暂不可用/);
  reject = false; assert.equal(await ui.save(), false);
  assert.deepEqual(ui.draft['chat.send'], ['Ctrl+Shift+Enter']); assert.deepEqual(ui.saved['chat.send'], DEFAULT_SHORTCUTS['chat.send']);
  assert.match(ui.status.textContent, /未确认|不一致/);
});

test('the app save callback can reread settings and refresh twice without losing the confirmed binding or receipt', async t => {
  let ui, live;
  ({ ui } = fixture(t, { onSaved: value => {
    live = value.preferences.shortcuts;
    // app.js applies preferences and renders settings in the same callback.
    ui.accept(value); ui.accept(value);
  } }));
  ui.accept(settings()); ui.setBindings('chat.send', ['Ctrl+Shift+Enter']);
  assert.equal(await ui.save(), true);
  assert.deepEqual(live['chat.send'], ['Ctrl+Shift+Enter']);
  assert.deepEqual(ui.saved['chat.send'], live['chat.send']); assert.deepEqual(ui.draft['chat.send'], live['chat.send']);
  assert.match(ui.status.textContent, /已保存/); assert.equal(ui.saveButton.disabled, true);
});

test('diagnostic read-only settings cannot record, disable or persist any shortcut', async t => {
  const calls = [], { ui, press } = fixture(t, { readOnly: true, api: async (...args) => calls.push(args) }); ui.accept(settings());
  ui.startRecording('chat.send'); press('k', { ctrlKey: true }); ui.setBindings('chat.send', []); ui.resetAll(); await ui.save();
  assert.equal(ui.isRecording(), false); assert.deepEqual(ui.draft, DEFAULT_SHORTCUTS); assert.deepEqual(calls, []);
  assert([...ui.rows.values()].every(row => row.edit.disabled));
});

test('leaving the settings surface releases recording without stealing the new focused control', t => {
  const { ui, host, document, press } = fixture(t); ui.accept(settings()); ui.startRecording('chat.send');
  const outside = document.createElement('button'); outside.focus(); document.emit('focusin', { target: outside });
  assert.equal(ui.recording, null); assert.equal(document.activeElement, outside);
  ui.startRecording('chat.send'); host.hidden = true;
  assert.equal(ui.isRecording(), false); const event = press('k', { ctrlKey: true }); assert.equal(event.defaultPrevented, undefined);
  assert.deepEqual(ui.draft, DEFAULT_SHORTCUTS);
});
