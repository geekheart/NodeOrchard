import { SHORTCUT_ACTIONS, DEFAULT_SHORTCUTS, normalizeShortcuts, shortcutFromEvent, formatShortcut } from '../shared/keyboard-shortcuts.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const SCOPE_LABELS = { global: '工作台', chat: '对话输入框', editor: '工作流编辑器', canvas: '节点画布' };
const element = (tag, className = '', text) => {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text; return node;
};
const button = (label, action, className = 'button quiet small') => {
  const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node;
};

// Settings edits remain local until the user explicitly saves this table.
export class ShortcutSettingsUI {
  constructor({ api, onSaved, readOnly = false } = {}) {
    Object.assign(this, { api, onSaved, readOnly });
    this.saved = null; this.draft = null; this.saving = false; this.recording = null; this.error = ''; this.message = ''; this.rows = new Map();
    this.captureKey = event => this.onKeyDown(event);
    this.captureFocus = event => { if (this.recording && !this.host?.contains(event.target)) this.cancelRecording({ restoreFocus: false }); };
  }
  mount(host) {
    if (this.host === host) return this;
    this.destroy(); this.host = host;
    this.form = element('form', 'shortcut-settings-form');
    this.form.addEventListener('submit', event => { event.preventDefault(); void this.save(); });
    const toolbar = element('div', 'shortcut-settings-toolbar');
    this.resetAllButton = button('恢复全部默认', () => this.resetAll()); toolbar.append(this.resetAllButton);
    const wrapper = element('div', 'shortcut-table-wrap'), table = element('table', 'shortcut-table'); table.setAttribute('aria-label', '快捷键操作表');
    const head = element('thead'), heading = element('tr');
    for (const label of ['操作', '生效范围', '快捷键', '修改']) { const cell = element('th', '', label); cell.scope = 'col'; heading.append(cell); }
    head.append(heading); this.body = element('tbody'); table.append(head, this.body); wrapper.append(table);
    this.status = element('p', 'helper'); this.status.setAttribute('aria-live', 'polite');
    this.saveButton = element('button', 'button primary', '保存快捷键'); this.saveButton.type = 'submit';
    const footer = element('div', 'settings-save shortcut-settings-save'); footer.append(this.status, this.saveButton);
    this.form.append(toolbar, wrapper, footer); host.replaceChildren(this.form);
    document.addEventListener('keydown', this.captureKey, true); document.addEventListener('focusin', this.captureFocus, true);
    this.render(); return this;
  }
  destroy() {
    if (this.host) { document.removeEventListener('keydown', this.captureKey, true); document.removeEventListener('focusin', this.captureFocus, true); }
    this.recording = null;
  }
  isRecording() { return Boolean(this.recording && this.host?.isConnected !== false && !this.host?.closest?.('[hidden]')); }
  dirty() { return Boolean(this.saved && this.draft && JSON.stringify(this.saved) !== JSON.stringify(this.draft)); }
  editable() { return Boolean(this.saved && !this.readOnly && !this.saving); }
  accept(settings) {
    try {
      const value = normalizeShortcuts(settings?.preferences?.shortcuts || {}), preserve = this.dirty() || this.recording || this.saving;
      this.saved = value;
      if (!preserve) { this.draft = clone(value); this.error = ''; this.message = ''; }
      this.render(); return true;
    } catch (error) { this.error = `快捷键读取失败：${error.message}`; this.render(); return false; }
  }
  startRecording(id) {
    if (!this.editable() || !this.rows.has(id)) return;
    this.recording = id; this.error = ''; this.message = ''; this.render(); this.rows.get(id)?.edit.focus();
  }
  cancelRecording({ restoreFocus = true } = {}) {
    const id = this.recording; this.recording = null; this.error = ''; this.message = ''; this.render(); if (restoreFocus) this.rows.get(id)?.edit.focus();
  }
  setBindings(id, bindings) {
    if (!this.editable() || !Object.hasOwn(DEFAULT_SHORTCUTS, id)) return false;
    try {
      const next = normalizeShortcuts({ ...this.draft, [id]: clone(bindings) });
      this.draft = next; this.recording = null; this.error = ''; this.message = ''; this.render(); return true;
    } catch (error) { this.error = error.message; this.message = ''; this.render(); return false; }
  }
  resetAll() {
    if (!this.editable()) return;
    this.draft = clone(DEFAULT_SHORTCUTS); this.recording = null; this.error = ''; this.message = ''; this.render();
  }
  onKeyDown(event) {
    if (!this.isRecording()) return;
    const binding = shortcutFromEvent(event);
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.();
    if (event.key === 'Escape') { this.cancelRecording(); return; }
    if (event.repeat) return;
    if (event.isComposing || event.keyCode === 229) { this.error = '输入法组合期间无法录制快捷键。'; this.render(); return; }
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
    const id = this.recording;
    if (!binding) { this.error = '该按键不能用作快捷键，请换一个组合。'; this.render(); return; }
    if (this.setBindings(id, [binding])) this.rows.get(id)?.edit.focus();
  }
  async save() {
    if (!this.editable() || this.recording || !this.dirty()) return false;
    let shortcuts;
    try { shortcuts = normalizeShortcuts(this.draft); }
    catch (error) { this.error = error.message; this.render(); return false; }
    this.saving = true; this.error = ''; this.message = ''; this.render();
    try {
      const settings = await this.api('/api/settings', { method: 'POST', body: { preferences: { shortcuts: clone(shortcuts) } } });
      const saved = normalizeShortcuts(settings?.preferences?.shortcuts || {});
      if (JSON.stringify(saved) !== JSON.stringify(shortcuts)) throw new Error('服务端返回的快捷键与提交内容不一致，尚未确认保存。');
      this.saved = saved; this.draft = clone(saved); this.message = '快捷键已保存';
      this.onSaved?.(settings); return true;
    } catch (error) { this.error = `保存失败：${error.message}`; return false; }
    finally { this.saving = false; this.render(); }
  }
  render() {
    if (!this.host) return;
    this.host.setAttribute('data-shortcut-recording', String(this.isRecording()));
    const values = this.draft || DEFAULT_SHORTCUTS, disabled = !this.editable();
    this.body.replaceChildren(); this.rows.clear();
    for (const action of SHORTCUT_ACTIONS) {
      const active = this.recording === action.id, row = element('tr', active ? 'shortcut-recording-row' : '');
      row.dataset.shortcutAction = action.id;
      const label = element('th', '', action.label); label.scope = 'row';
      const scope = element('td', 'shortcut-scope', SCOPE_LABELS[action.scope] || action.scope), keys = element('td', 'shortcut-bindings');
      if (active) keys.append(element('span', 'shortcut-recording-prompt', '请按快捷键 · Esc 取消'));
      else if (!values[action.id]?.length) keys.append(element('span', 'helper', '未设置'));
      else for (const binding of values[action.id]) keys.append(element('kbd', '', formatShortcut(binding)));
      if (active && this.error) { const error = element('span', 'shortcut-row-error', this.error); error.setAttribute('role', 'alert'); keys.append(error); }
      const actions = element('td', 'shortcut-row-actions'), edit = button(active ? '取消' : '修改', () => active ? this.cancelRecording() : this.startRecording(action.id));
      const disable = button('禁用', () => this.setBindings(action.id, [])), reset = button('默认', () => this.setBindings(action.id, DEFAULT_SHORTCUTS[action.id]));
      for (const [control, operation] of [[edit, active ? '取消录制' : '修改快捷键'], [disable, '禁用快捷键'], [reset, '恢复默认快捷键']]) {
        control.disabled = disabled; control.setAttribute('aria-label', `${action.label}：${operation}`); control.title = `${action.label}：${operation}`;
      }
      disable.disabled ||= !values[action.id]?.length; reset.disabled ||= JSON.stringify(values[action.id]) === JSON.stringify(DEFAULT_SHORTCUTS[action.id]);
      actions.append(edit, disable, reset); row.append(label, scope, keys, actions); this.body.append(row);
      this.rows.set(action.id, { row, keys, edit, disable, reset });
    }
    this.resetAllButton.disabled = disabled || !this.draft || JSON.stringify(this.draft) === JSON.stringify(DEFAULT_SHORTCUTS);
    this.saveButton.disabled = disabled || Boolean(this.recording) || !this.dirty(); this.saveButton.textContent = this.saving ? '保存中…' : '保存快捷键';
    this.status.textContent = this.error || (this.readOnly ? '只读' : this.saving ? '正在保存…' : this.recording ? '正在录制快捷键，按 Esc 取消' : this.message || (this.dirty() ? '有未保存的快捷键更改' : this.saved ? '' : '正在读取快捷键…'));
    this.status.className = this.error ? 'error-text' : 'helper'; this.status.setAttribute('role', this.error ? 'alert' : 'status');
  }
}
