import test from 'node:test';
import assert from 'node:assert/strict';
import { SHORTCUT_ACTIONS, DEFAULT_SHORTCUTS, normalizeShortcuts, shortcutFromEvent, matchesShortcut, formatShortcut, shortcutLabel } from '../shared/keyboard-shortcuts.mjs';

const event = (key, modifiers = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });

test('default bindings describe real scopes and preserve Ctrl/Meta sending with exact modifier matching', () => {
  assert.equal(SHORTCUT_ACTIONS.length, 15);
  assert.deepEqual(DEFAULT_SHORTCUTS['chat.send'], ['Ctrl+Enter', 'Meta+Enter']);
  assert.equal(matchesShortcut(event('Enter', { ctrlKey: true }), 'chat.send'), true);
  assert.equal(matchesShortcut(event('Enter', { metaKey: true }), 'chat.send'), true);
  for (const extra of [{}, { ctrlKey: true, shiftKey: true }, { metaKey: true, altKey: true }, { ctrlKey: true, repeat: true },
    { ctrlKey: true, isComposing: true }, { ctrlKey: true, keyCode: 229 }, { ctrlKey: true, defaultPrevented: true }]) {
    assert.equal(matchesShortcut(event('Enter', extra), 'chat.send'), false);
  }
  assert(Object.isFrozen(DEFAULT_SHORTCUTS)); assert(Object.isFrozen(DEFAULT_SHORTCUTS['chat.send']));
});

test('remapping and disabling replace only the chosen action without changing built-in defaults', () => {
  const bindings = normalizeShortcuts({ 'chat.send': ['Shift+Ctrl+Enter'], 'canvas.fit': [] });
  assert.deepEqual(bindings['chat.send'], ['Ctrl+Shift+Enter']); assert.deepEqual(bindings['canvas.fit'], []);
  assert.equal(matchesShortcut(event('Enter', { ctrlKey: true }), 'chat.send', bindings), false);
  assert.equal(matchesShortcut(event('Enter', { ctrlKey: true, shiftKey: true }), 'chat.send', bindings), true);
  assert.equal(matchesShortcut(event('f'), 'canvas.fit', bindings), false);
  assert.deepEqual(DEFAULT_SHORTCUTS['chat.send'], ['Ctrl+Enter', 'Meta+Enter']);
  assert.deepEqual(bindings['workflow.save'], ['Ctrl+S', 'Meta+S']);
});

test('conflicting active scopes fail while a chat-only binding may reuse a canvas-only key', () => {
  assert.throws(() => normalizeShortcuts({ 'chat.focus': ['Ctrl+Enter'] }), /冲突.*发送消息|发送消息.*冲突/);
  assert.throws(() => normalizeShortcuts({ 'canvas.fit': ['Ctrl+S'] }), /冲突/);
  assert.throws(() => normalizeShortcuts({ 'canvas.fit': ['L'] }), /冲突/);
  const bindings = normalizeShortcuts({ 'chat.send': ['Ctrl+D'] });
  assert.equal(matchesShortcut(event('d', { ctrlKey: true }), 'chat.send', bindings), true);
  assert.equal(matchesShortcut(event('d', { ctrlKey: true }), 'canvas.duplicate', bindings), true);
});

test('invalid configuration cannot admit unknown actions, native reserved keys or accidental text typing outside canvas', () => {
  for (const value of [null, [], 'Ctrl+Enter', { unknown: ['Ctrl+Enter'] }, { 'chat.send': null }, { 'chat.send': ['Control'] },
    { 'chat.send': ['Escape'] }, { 'chat.send': ['Ctrl+Tab'] }, { 'chat.send': ['Alt+F4'] }, { 'chat.send': ['F5'] },
    { 'chat.send': ['Ctrl+R'] }, { 'chat.send': ['Meta+W'] }, { 'chat.send': ['Ctrl+Shift+I'] },
    { 'chat.send': ['A'] }, { 'chat.focus': ['Shift+A'] }, { 'chat.send': ['Super+Enter'] },
    { 'chat.focus': ['Enter'] }, { 'chat.toggle': ['Space'] }, { 'chat.focus': ['Delete'] }, { 'chat.toggle': ['ArrowLeft'] },
    { 'chat.send': ['Ctrl+Enter', 'Ctrl+Enter'] }, { 'chat.send': ['Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5'] },
    Object.assign(Object.create({ inherited: [] }), { 'chat.send': [] }),
    Object.defineProperty({}, 'chat.send', { get() { assert.fail('Do not invoke config getters'); } }),
  ]) assert.throws(() => normalizeShortcuts(value), /快捷键|组合|冲突/);
});

test('recording normalizes shifted punctuation and ignores input methods and modifier-only keystrokes', () => {
  assert.equal(shortcutFromEvent(event('?', { shiftKey: true, code: 'Slash' })), 'Shift+/');
  assert.equal(shortcutFromEvent(event('+', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+=');
  assert.equal(shortcutFromEvent(event('s', { metaKey: true })), 'Meta+S');
  assert.equal(shortcutFromEvent(event('Â', { altKey: true, shiftKey: true, code: 'KeyM' })), 'Alt+Shift+M');
  assert.equal(matchesShortcut(event('Ç', { altKey: true, shiftKey: true, code: 'KeyC' }), 'chat.toggle'), true);
  assert.equal(shortcutFromEvent(event('Â', { altKey: true, shiftKey: true, code: 'KeyM', isComposing: true })), '');
  for (const e of [event('Shift', { shiftKey: true }), event('Process'), event('a', { isComposing: true }), event('Enter', { keyCode: 229 })]) assert.equal(shortcutFromEvent(e), '');
  assert.equal(formatShortcut('Meta+Shift+Enter'), '⌘ + Shift + Enter');
  assert.equal(shortcutLabel('chat.send'), 'Ctrl + Enter / ⌘ + Enter');
  assert.equal(shortcutLabel('canvas.fit', normalizeShortcuts({ 'canvas.fit': [] })), '未设置');
});

test('fixed canvas movement and activation keys cannot be rebound while explicit chat Enter remains configurable', () => {
  for (const key of ['Space', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    for (const prefix of ['', 'Shift+']) assert.throws(() => normalizeShortcuts({ 'canvas.fit': [prefix + key] }), /画布.*固定|固定.*画布/);
  }
  assert.deepEqual(normalizeShortcuts({ 'chat.send': ['Enter'] })['chat.send'], ['Enter']);
  assert.deepEqual(normalizeShortcuts({ 'chat.send': ['Shift+Enter'] })['chat.send'], ['Shift+Enter']);
  assert.deepEqual(normalizeShortcuts()['canvas.delete'], ['Delete', 'Backspace']);
  assert.deepEqual(normalizeShortcuts({ 'canvas.fit': ['Ctrl+ArrowLeft'] })['canvas.fit'], ['Ctrl+ArrowLeft']);
});
