import test from 'node:test';
import assert from 'node:assert/strict';
import { bindChatSendShortcut, updateChatShortcutHints, handleGlobalChatShortcut } from '../public/keyboard-shortcuts.js';

class Input {
  constructor() { this.listeners = new Map(); this.attributes = {}; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name) { this.listeners.delete(name); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  emit(name, values = {}) { const event = { key: 'Enter', ctrlKey: true, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...values };
    this.listeners.get(name)?.(event); return event; }
}

test('Ctrl+Enter and Cmd+Enter send once while ordinary Enter stays a newline and composing or held keys do not send', () => {
  const input = new Input(); let sent = 0;
  const remove = bindChatSendShortcut(input, { send: () => sent++ });
  assert.equal(input.emit('keydown').defaultPrevented, true);
  input.emit('keydown', { ctrlKey: false, metaKey: true }); assert.equal(sent, 2);
  assert.equal(input.emit('keydown', { ctrlKey: false }).defaultPrevented, false);
  for (const event of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { shiftKey: true }, { altKey: true }]) input.emit('keydown', event);
  input.emit('compositionstart'); input.emit('keydown'); input.emit('compositionend');
  assert.equal(sent, 2); remove(); input.emit('keydown'); assert.equal(sent, 2);
});

test('rebinding or disabling send takes effect immediately and disabled composers never submit', () => {
  const input = new Input(); let sent = 0, enabled = true, shortcuts;
  bindChatSendShortcut(input, { getShortcuts: () => shortcuts, canSend: () => enabled, send: () => sent++ });
  input.emit('keydown'); shortcuts = { 'chat.send': ['Alt+Enter'] }; input.emit('keydown');
  input.emit('keydown', { ctrlKey: false, altKey: true }); assert.equal(sent, 2);
  enabled = false; assert.equal(input.emit('keydown', { ctrlKey: false, altKey: true }).defaultPrevented, true); assert.equal(sent, 2);
  shortcuts = { 'chat.send': [] }; enabled = true; input.emit('keydown', { ctrlKey: false, altKey: true }); assert.equal(sent, 2);
});

test('composer tooltip and accessibility hint follow the active shortcut rather than a hardcoded label', () => {
  const input = new Input(), button = new Input();
  updateChatShortcutHints(input, button); assert.match(button.title, /Ctrl.*Enter/); assert.match(button.attributes['aria-keyshortcuts'], /Control\+Enter/);
  updateChatShortcutHints(input, button, { 'chat.send': ['Alt+Enter'] }); assert.match(button.title, /Alt.*Enter/); assert.doesNotMatch(button.title, /Ctrl/);
  updateChatShortcutHints(input, button, { 'chat.send': [] }); assert.equal(button.attributes['aria-keyshortcuts'], undefined);
});

test('global chat focus and toggle act only on the available chat and pause during settings capture or dialogs', () => {
  let focused = 0, toggled = 0, blocked = false, available = true;
  const options = { isBlocked: () => blocked, getChat: () => available ? { focus: () => focused++, toggle: () => toggled++ } : null };
  const key = value => ({ key: value, altKey: true, shiftKey: true, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} });
  assert.equal(handleGlobalChatShortcut(key('M'), options), true); assert.equal(focused, 1);
  assert.equal(handleGlobalChatShortcut(key('C'), options), true); assert.equal(toggled, 1);
  blocked = true; handleGlobalChatShortcut(key('M'), options); assert.equal(focused, 1);
  blocked = false; available = false; assert.equal(handleGlobalChatShortcut(key('C'), options), false); assert.equal(toggled, 1);
});
