import { DEFAULT_SHORTCUTS, matchesShortcut, shortcutLabel } from '../shared/keyboard-shortcuts.mjs';

// Every conversation uses the same input boundary. Sending remains subject to
// the existing composer admission; a keyboard event never starts a second path.
export function bindChatSendShortcut(input, { getShortcuts = () => undefined, canSend = () => true, send } = {}) {
  let composing = false;
  const start = () => { composing = true; }, end = () => { composing = false; };
  const keydown = event => {
    event.stopPropagation();
    if (composing || !matchesShortcut(event, 'chat.send', getShortcuts())) return;
    event.preventDefault();
    if (canSend()) send();
  };
  input.addEventListener('compositionstart', start); input.addEventListener('compositionend', end); input.addEventListener('keydown', keydown);
  return () => { input.removeEventListener('compositionstart', start); input.removeEventListener('compositionend', end); input.removeEventListener('keydown', keydown); };
}

export function updateChatShortcutHints(input, button, shortcuts = DEFAULT_SHORTCUTS) {
  const bindings = shortcuts?.['chat.send'] ?? DEFAULT_SHORTCUTS['chat.send'];
  const label = bindings.length ? `发送消息 · ${shortcutLabel('chat.send', shortcuts)}` : '发送消息';
  for (const target of [input, button]) {
    if (!target) continue;
    target.title = label;
    if (bindings.length) target.setAttribute('aria-keyshortcuts', bindings.map(value => value.replace(/^Ctrl\+/, 'Control+')).join(' '));
    else target.removeAttribute?.('aria-keyshortcuts');
  }
}

export function handleGlobalChatShortcut(event, { getShortcuts = () => undefined, getChat, isBlocked = () => false } = {}) {
  if (isBlocked()) return false;
  const shortcuts = getShortcuts();
  const action = matchesShortcut(event, 'chat.focus', shortcuts) ? 'focus' : matchesShortcut(event, 'chat.toggle', shortcuts) ? 'toggle' : null;
  if (!action) return false;
  const chat = getChat?.();
  if (typeof chat?.[action] !== 'function') return false;
  event.preventDefault(); event.stopPropagation(); chat[action](); return true;
}
