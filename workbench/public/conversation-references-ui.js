const LIMIT = 4;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const clean = (value, limit = 240) => String(value || '').replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已隐藏密钥]')
  .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [已隐藏]').replace(/((?:api[_ -]?key|token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}\]]+/gi, '$1[已隐藏]').slice(0, limit);
const element = (tag, className = '', value) => { const node = document.createElement(tag); node.className = className; if (value !== undefined) node.textContent = clean(value); return node; };
const button = (label, action, className = 'wf-conversation-link') => { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node; };
const key = value => `${value.workflowId}:${value.turnId}`;
const signature = value => JSON.stringify([value.workflowId, value.turnId, value.updatedAt, value.sourceDigest]);
const wire = value => ({ workflowId: value.workflowId, turnId: value.turnId, ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}), ...(value.sourceDigest ? { sourceDigest: value.sourceDigest } : {}) });
const project = value => {
  if (!value || !identifier(value.workflowId) || !identifier(value.turnId)
    || value.updatedAt !== undefined && (typeof value.updatedAt !== 'string' || value.updatedAt.length > 40 || !Number.isFinite(Date.parse(value.updatedAt)))
    || value.sourceDigest !== undefined && (typeof value.sourceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.sourceDigest))) return null;
  return { ...wire(value), workflowTitle: clean(value.workflowTitle || value.title || '工作流聊天'), preview: clean(value.preview, 150),
    sourceStatus: clean(value.sourceStatus, 40), status: ['stale', 'unavailable'].includes(value.status) ? value.status : 'current' };
};
const STATUS = { error: '失败消息', failed: '失败消息', complete: '已完成消息', completed: '已完成消息', proposed: '修改建议', thinking: '正在回复', interrupted: '已中断消息' };
const label = value => `${value.workflowTitle} · ${value.status === 'stale' ? '来源已变化' : value.status === 'unavailable' ? '来源不可用' : STATUS[value.sourceStatus] || '聊天消息'}`;

// Selection is a draft owned by the captured supervisor topic. This component
// only makes authenticated GETs and never submits a message or changes a source.
export class ConversationReferencesUI {
  constructor(owner) {
    this.owner = owner; this.requests = new WeakMap();
    this.element = element('section', 'wf-conversation-attachments'); this.element.setAttribute('aria-label', '引用工作流聊天');
  }
  mount(host) { host?.append(this.element); this.render(); return this.element; }
  entries(state = this.owner.state()) { return state.conversationReferences ||= []; }
  picker(state = this.owner.state()) { return state.conversationReferencePicker ||= { open: false, loading: false, request: 0, workflows: [], turns: [], workflowId: null, hasMore: false, nextBeforeTurnId: null, error: '' }; }
  readOnly(state = this.owner.state()) { return this.owner.editor?.libraryReadOnly === true || state.conversation?.archived === true || state.conversation?.lifecycle === 'archived' || state.conversation?.readOnly === true; }
  capture() { if (this.owner.destroyed || !identifier(this.owner.workflowId)) return null; const state = this.owner.state(); return this.readOnly(state) ? null : { id: this.owner.workflowId, state }; }
  changed(state) { if (!this.owner.destroyed && identifier(this.owner.workflowId) && state === this.owner.state()) { this.render(); this.owner.updateSendButton?.(); } }
  references(state = this.owner.state()) {
    const entries = this.entries(state).filter(value => project(value)).slice(0, LIMIT), values = entries.map(wire);
    this.requests.set(values, new Set(entries)); return values;
  }
  trackRequest(state, request) {
    const values = request?.conversationReferences;
    if (!Array.isArray(values) || this.requests.has(values)) return;
    const selected = new Set(values.map(signature)); this.requests.set(values, new Set(this.entries(state).filter(value => selected.has(signature(value)))));
  }
  consume(state, request) {
    const values = request?.conversationReferences, selected = Array.isArray(values) && this.requests.get(values);
    if (!selected) return;
    const sent = new Set(values.map(signature));
    state.conversationReferences = this.entries(state).filter(value => !selected.has(value) || !sent.has(signature(value)));
    this.requests.delete(values); this.changed(state);
  }
  restore(turn, state = this.owner.state()) {
    if (this.readOnly(state)) return false;
    const raw = Array.isArray(turn) ? turn : turn?.user?.conversationReferences || [];
    const values = (Array.isArray(raw) ? raw : []).map(project).filter(Boolean).slice(0, LIMIT);
    state.conversationReferences = [...new Map(values.map(value => [key(value), value])).values()]; this.changed(state); return true;
  }
  add(value, captured = this.capture()) {
    if (!captured || this.owner.workflowId !== captured.id || this.owner.state() !== captured.state || this.readOnly(captured.state)) return false;
    const reference = project(value); if (!reference) return false;
    const entries = this.entries(captured.state), previous = entries.findIndex(item => key(item) === key(reference));
    if (previous < 0 && entries.length >= LIMIT) { this.picker(captured.state).error = '最多引用4条消息。'; this.changed(captured.state); return false; }
    if (previous < 0) entries.push(reference); else entries.splice(previous, 1, reference);
    this.picker(captured.state).error = ''; this.owner.clearRetryTarget?.(captured.state); this.changed(captured.state); return true;
  }
  remove(value, captured = this.capture()) {
    if (!captured || this.owner.workflowId !== captured.id || this.owner.state() !== captured.state || this.readOnly(captured.state)) return false;
    const before = this.entries(captured.state); captured.state.conversationReferences = before.filter(item => item !== value);
    this.owner.clearRetryTarget?.(captured.state); this.changed(captured.state); return before.length !== captured.state.conversationReferences.length;
  }
  async open() {
    const captured = this.capture(); if (!captured) return false;
    const picker = this.picker(captured.state); picker.open = !picker.open; this.changed(captured.state);
    if (!picker.open || picker.workflows.length) return true;
    return this.load(captured, {});
  }
  async load(captured, { workflowId, beforeTurnId } = {}) {
    if (!captured || this.readOnly(captured.state)) return false;
    const picker = this.picker(captured.state), request = ++picker.request;
    picker.loading = true; picker.error = ''; if (workflowId && !beforeTurnId) { picker.workflowId = workflowId; picker.turns = []; }
    this.changed(captured.state);
    const suffix = workflowId ? '?workflowId=' + encodeURIComponent(workflowId) + (beforeTurnId ? '&beforeTurnId=' + encodeURIComponent(beforeTurnId) : '') : '';
    try {
      const result = await this.owner.api('/api/app-assistant/references' + suffix);
      if (request !== picker.request || this.owner.destroyed || this.readOnly(captured.state)) return false;
      if (workflowId) {
        if (result.workflow?.workflowId !== workflowId) throw Error('聊天记录与所选工作流不匹配。');
        const values = (result.turns || []).map(project).filter(value => value?.workflowId === workflowId);
        picker.turns = beforeTurnId ? [...new Map([...values, ...picker.turns].map(value => [key(value), value])).values()] : values;
        picker.hasMore = result.hasMore === true; picker.nextBeforeTurnId = identifier(result.nextBeforeTurnId) ? result.nextBeforeTurnId : null;
      } else picker.workflows = (result.workflows || []).filter(value => identifier(value.workflowId)).slice(0, 100).map(value => ({ workflowId: value.workflowId, title: clean(value.title) }));
      return true;
    } catch (error) { if (request === picker.request) picker.error = clean(error.message); return false; }
    finally { if (request === picker.request) { picker.loading = false; this.changed(captured.state); } }
  }
  render() {
    if (!this.owner.workflowId) { this.element.hidden = true; return; }
    const captured = { id: this.owner.workflowId, state: this.owner.state() }, state = captured.state, picker = this.picker(state), locked = this.readOnly(state);
    this.element.hidden = false; this.element.replaceChildren();
    const trigger = button('引用聊天', () => void this.open()); trigger.disabled = locked; trigger.setAttribute('aria-expanded', String(picker.open)); this.element.append(trigger);
    const chips = element('div', 'wf-conversation-context'); chips.setAttribute('aria-label', '已选聊天引用');
    for (const reference of this.entries(state)) {
      const value = project(reference); if (!value) continue;
      const chip = element('span', 'wf-conversation-chip'); chip.append(element('span', '', label(value)));
      const remove = button('×', () => this.remove(reference, captured)); remove.setAttribute('aria-label', '移除引用：' + value.workflowTitle); remove.disabled = locked; chip.append(remove); chips.append(chip);
    }
    if (chips.children.length) this.element.append(chips);
    if (!picker.open || locked) return;
    const box = element('div', 'wf-conversation-attachment');
    const select = element('select'); select.setAttribute('aria-label', '选择引用来源工作流'); select.disabled = picker.loading;
    const empty = element('option', '', '选择工作流…'); empty.value = ''; select.append(empty);
    for (const workflow of picker.workflows) { const option = element('option', '', workflow.title); option.value = workflow.workflowId; select.append(option); }
    select.value = picker.workflowId || ''; select.addEventListener('change', () => { if (select.value) void this.load(captured, { workflowId: select.value }); }); box.append(select);
    if (picker.error) box.append(element('p', 'wf-conversation-error', picker.error));
    if (picker.loading) box.append(element('p', 'wf-conversation-message-scope', '正在读取…'));
    else if (!picker.workflows.length) box.append(element('p', 'wf-conversation-message-scope', '暂无可引用的聊天。'));
    else if (picker.workflowId && !picker.turns.length) box.append(element('p', 'wf-conversation-message-scope', '暂无可引用的消息。'));
    else if (picker.workflowId && !picker.turns.length) box.append(element('p', 'wf-conversation-message-scope', '这页没有可引用消息。'));
    const choices = element('div', 'wf-conversation-attachment-actions');
    for (const value of picker.turns) {
      const choose = button(value.preview || label(value), () => this.add(value, captured));
      choose.setAttribute('aria-label', '引用消息：' + (value.preview || value.workflowTitle)); choose.title = value.preview || label(value);
      choose.disabled = locked || this.entries(state).length >= LIMIT && !this.entries(state).some(item => key(item) === key(value)); choices.append(choose);
    }
    box.append(choices);
    if (picker.hasMore && picker.nextBeforeTurnId) { const more = button('更早消息', () => void this.load(captured, { workflowId: picker.workflowId, beforeTurnId: picker.nextBeforeTurnId })); more.disabled = picker.loading; box.append(more); }
    this.element.append(box);
  }
  messageView(stored = []) {
    const box = element('div', 'wf-conversation-attachments is-message'); box.setAttribute('aria-label', '已引用的工作流聊天');
    for (const value of (Array.isArray(stored) ? stored : []).map(project).filter(Boolean).slice(0, LIMIT)) {
      const link = element('a', 'wf-conversation-attachment-name', '引用：' + label(value));
      link.href = '#/workflows/' + encodeURIComponent(value.workflowId); box.append(link);
    }
    return box;
  }
}
