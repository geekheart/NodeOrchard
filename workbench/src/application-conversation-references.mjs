import { createHash } from 'node:crypto';
import { sanitizeDiagnosticText } from './app-diagnostics.mjs';

export const CONVERSATION_REFERENCE_LIMITS = Object.freeze({ references: 4, workflows: 100, turns: 20, previewCharacters: 150 });
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA = /^sha256:[a-f0-9]{64}$/;
const identifier = value => typeof value === 'string' && ID.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const text = (value, max = 240) => sanitizeDiagnosticText(String(value || '')).slice(0, max);
const time = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const plain = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !Object.hasOwn(field, 'value'))) fail('聊天引用参数无效。');
};
function references(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > CONVERSATION_REFERENCE_LIMITS.references
    || Object.keys(raw).length !== raw.length || Reflect.ownKeys(raw).length !== raw.length + 1
    || Object.getOwnPropertySymbols(raw).length || Object.values(Object.getOwnPropertyDescriptors(raw)).some(field => !Object.hasOwn(field, 'value'))) fail('最多引用4条明确的工作流聊天消息。');
  const seen = new Set();
  return Array.prototype.map.call(raw, value => {
    plain(value, ['workflowId', 'turnId', 'updatedAt', 'sourceDigest']);
    if (!identifier(value.workflowId) || !identifier(value.turnId) || value.updatedAt !== undefined && !time(value.updatedAt)
      || value.sourceDigest !== undefined && (typeof value.sourceDigest !== 'string' || !SHA.test(value.sourceDigest))) fail('聊天引用的工作流、消息或版本身份无效。');
    const key = value.workflowId + ':' + value.turnId;
    if (seen.has(key)) fail('同一聊天消息不能重复引用。'); seen.add(key);
    return { workflowId: value.workflowId, turnId: value.turnId, ...(value.updatedAt !== undefined ? { updatedAt: value.updatedAt } : {}),
      ...(value.sourceDigest !== undefined ? { sourceDigest: value.sourceDigest } : {}) };
  });
}

// Hash only the same redacted, public fields that exact conversation.inspect
// exposes. No private document, operations, tool checkpoint or attachment is
// read or made portable by a chat reference.
export function conversationReferenceDigest(turn) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify({ id: turn.id, workflowId: turn.workflowId, status: turn.status,
    updatedAt: turn.updatedAt, user: turn.user, assistantText: turn.assistant?.text, restricted: turn.restricted === true })).digest('hex');
}

export class ApplicationConversationReferences {
  constructor(app, owner) { this.app = app; this.owner = owner; }
  async scope(context) {
    const scope = await this.owner.permissions.current(context?.permissionScope);
    if (scope.role !== 'supervisor' || scope.workflowBound || !scope.permissions.workflowRead || !scope.permissions.crossWorkflowRead) fail('引用工作流聊天需要总控的工作流读取与跨工作流读取权限。', 403);
    return scope;
  }
  source(reference, { expected = true } = {}) {
    const record = this.app.workflowLibrary.get(reference.workflowId);
    if (record.lifecycle !== 'active') fail('引用工作流已进入回收站，不能作为当前排错来源。', 409);
    if (record.document?.mode === 'learn') fail('学习材料不能作为总控聊天引用。', 403);
    const result = this.owner.hub.read({ workflowId: reference.workflowId, turnId: reference.turnId,
      ...(expected && reference.updatedAt ? { expectedUpdatedAt: reference.updatedAt } : {}),
      ...(expected && reference.sourceDigest ? { sourceDigest: reference.sourceDigest } : {}) });
    const turn = result.turns[0];
    if (turn?.restricted) fail('学习或反馈内容不能作为总控聊天引用。', 403);
    if (!turn || turn.workflowId !== reference.workflowId || turn.id !== reference.turnId) fail('引用消息归属不一致。', 409);
    return { record, turn, sourceDigest: result.sourceDigest };
  }
  metadata({ record, turn, sourceDigest }) {
    const updatedAt = turn.updatedAt || turn.createdAt;
    return { workflowId: record.id, workflowTitle: text(record.document.title), turnId: turn.id, updatedAt,
      sourceStatus: text(turn.status, 40), sourceDigest, status: 'current',
      read: { tool: 'conversation.inspect', arguments: { workflowId: record.id, turnId: turn.id,
        ...(updatedAt ? { expectedUpdatedAt: updatedAt } : {}), sourceDigest } } };
  }
  async resolve(raw, context) {
    const values = references(raw); if (!values.length) return [];
    const scope = await this.scope(context), resolved = [];
    for (const value of values) {
      this.owner.permissions.workflow(value.workflowId, scope);
      resolved.push(this.metadata(await this.source(value)));
      await this.owner.permissions.current(scope);
    }
    return resolved;
  }
  async project(stored = [], context) {
    if (!Array.isArray(stored) || stored.length > CONVERSATION_REFERENCE_LIMITS.references) fail('保存的聊天引用无效。');
    const values = references(stored.map(value => {
      if (!value || typeof value !== 'object') fail('保存的聊天引用无效。');
      return Object.fromEntries(['workflowId', 'turnId', 'updatedAt', 'sourceDigest'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
    }));
    if (!values.length) return [];
    const scope = await this.scope(context), result = [];
    for (const [index, value] of values.entries()) {
      this.owner.permissions.workflow(value.workflowId, scope);
      try { result.push(this.metadata(await this.source(value))); }
      catch (error) {
        if (![403, 404, 409, 410].includes(error.httpStatus)) throw error;
        let current;
        try { current = this.source(value, { expected: false }); } catch { /* A removed or restricted source remains unavailable. */ }
        result.push({ ...value, workflowTitle: text(stored[index].workflowTitle), status: current ? 'stale' : 'unavailable',
          reason: current ? '引用消息已变化，旧引用不代表当前内容。' : '引用来源已不可用或不允许展开。',
          read: { tool: 'conversation.inspect', arguments: { workflowId: value.workflowId, turnId: value.turnId,
            ...(value.updatedAt ? { expectedUpdatedAt: value.updatedAt } : {}), ...(value.sourceDigest ? { sourceDigest: value.sourceDigest } : {}) } } });
      }
      await this.owner.permissions.current(scope);
    }
    return result;
  }
  async options(raw = {}, context) {
    plain(raw, ['workflowId', 'beforeTurnId']);
    if (raw.workflowId !== undefined && !identifier(raw.workflowId) || raw.beforeTurnId !== undefined && !identifier(raw.beforeTurnId)
      || raw.beforeTurnId !== undefined && !raw.workflowId) fail('聊天引用目录参数无效。');
    const scope = await this.scope(context);
    if (!raw.workflowId) {
      const directory = this.owner.hub.list({ lifecycle: 'active', limit: CONVERSATION_REFERENCE_LIMITS.workflows });
      const workflows = directory.workflows.filter(row => row.lifecycle === 'active' && row.mode !== 'learn' && row.conversation.turnCount > 0)
        .map(row => ({ workflowId: row.workflowId, title: text(row.title), turnCount: row.conversation.turnCount, updatedAt: row.conversation.updatedAt }));
      await this.owner.permissions.current(scope);
      return { workflows, total: workflows.length, truncated: directory.truncated };
    }
    this.owner.permissions.workflow(raw.workflowId, scope);
    const record = this.app.workflowLibrary.get(raw.workflowId);
    if (record.lifecycle !== 'active' || record.document.mode === 'learn') fail('此工作流不提供可引用的普通聊天。', 409);
    const page = this.owner.hub.read({ workflowId: raw.workflowId, limit: CONVERSATION_REFERENCE_LIMITS.turns, ...(raw.beforeTurnId ? { beforeTurnId: raw.beforeTurnId } : {}) });
    const turns = page.turns.filter(turn => !turn.restricted).map(turn => {
      // List pages have a smaller text budget than exact reads. Resolve the
      // selected identity before hashing so a long message remains selectable.
      const exact = this.source({ workflowId: record.id, turnId: turn.id }, { expected: false });
      return { ...this.metadata(exact), preview: text([exact.turn.user?.text, exact.turn.assistant?.text].filter(Boolean).join(' · '), CONVERSATION_REFERENCE_LIMITS.previewCharacters) };
    });
    await this.owner.permissions.current(scope);
    return { workflow: { workflowId: record.id, title: text(record.document.title) }, turns, hasMore: page.hasMore, nextBeforeTurnId: page.nextBeforeTurnId };
  }
}
