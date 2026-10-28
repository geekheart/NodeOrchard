import { createHash } from 'node:crypto';
import { validateSkillToolsets } from '../shared/workflow/workflow-integrations.mjs';
import { redact } from './hermes-adapter.mjs';
import { skillOrigin } from './catalog.mjs';
import { skillReferences } from './skill-references.mjs';

const fail = (message, httpStatus = 400, code, stage) => { throw Object.assign(new Error(message), { httpStatus, ...(code ? { code } : {}), ...(stage ? { stage } : {}) }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const providerId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value);
const creationId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const cleanText = (value, limit) => typeof value === 'string' ? redact(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) : '';
function args(value, allowed) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('Skill 参数包含未知字段或访问器。');
}
function bounded(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > max) fail(`${label}不能为空或超过限制。`);
  return value.trim();
}

export function projectSkillIntegrations(raw) {
  if (!plain(raw) || !Array.isArray(raw.toolsets) || raw.toolsets.length > 100) fail('Hermes 未确认工具依赖目录。', 502);
  const seen = new Set();
  const toolsets = raw.toolsets.map(row => {
    if (!plain(row)) fail('Hermes 工具依赖格式无效。', 502);
    try { validateSkillToolsets([row.id]); } catch { fail('Hermes 返回了未支持的工具集标识。', 502); }
    if (seen.has(row.id) || !Array.isArray(row.tools) || row.tools.length > 256
      || row.tools.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name))) fail('Hermes 工具依赖格式无效。', 502);
    seen.add(row.id);
    return { id: row.id, label: cleanText(row.label, 120) || row.id, available: row.available === true,
      enabled: row.enabled === true, tools: [...new Set(row.tools)].sort(), reason: cleanText(row.reason, 400) };
  });
  const providers = Array.isArray(raw.imageProviders) ? raw.imageProviders : [];
  if (providers.length > 50 || providers.some(row => !plain(row) || !providerId(row.id))) fail('Hermes 图片提供商目录无效。', 502);
  const imageProviders = providers.map(row => ({ id: row.id, label: cleanText(row.label, 120) || row.id,
    available: row.available === true, reason: cleanText(row.reason, 400) }));
  return { toolsets, imageProviders, selectedImageProvider: raw.selectedImageProvider === '' || providerId(raw.selectedImageProvider) ? raw.selectedImageProvider : '',
    ...(typeof raw.revision === 'string' && /^sha256:[a-f0-9]{64}$/.test(raw.revision) ? { revision: raw.revision } : {}), collectedAt: new Date().toISOString() };
}

// One interface serves human authoring, node readiness and read-only assistant
// discovery. Credentials, connection creation and native tool execution stay in Hermes.
export class SkillIntegrations {
  constructor(app) {
    this.app = app; this.active = new Map(); this.deleting = new Set(); this.cache = null; this.pending = null; this.generation = 0;
    this.db = app.store.db;
    this.db.exec('CREATE TABLE IF NOT EXISTS skill_integration_operations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, value TEXT, updated_at TEXT NOT NULL)');
    this.db.prepare("UPDATE skill_integration_operations SET status='unknown' WHERE status='pending'").run();
  }
  invalidate() { this.cache = null; this.pending = null; this.generation++; }
  assertBindable(name) { if (this.deleting.has(name)) fail('此 Skill 正在删除，不能创建新的运行绑定。', 409, 'SKILL_DELETE_BUSY', 'preflight'); }
  project(skill) {
    if (skill.source === 'learned') return { ...skill, origin: { kind: 'generated', label: '后续生成', canDelete: true }, usage: 'workflow', assignable: true };
    const origin = skillOrigin(skill.origin);
    const receipts = this.db.prepare("SELECT value FROM skill_integration_operations WHERE kind='create' AND status='complete'").all();
    let owned = false, historical = false;
    for (const row of receipts) {
      try {
        const created = JSON.parse(row.value)?.skill;
        if (created?.name !== skill.name) continue;
        historical = true; if (skill.creationId && created.creationId === skill.creationId) owned = true;
      } catch { /* A malformed receipt never grants removal. */ }
    }
    if (!['hermes-builtin', 'workbench-builtin'].includes(origin.kind)) {
      if (historical && origin.kind === 'unknown') { origin.kind = 'generated'; origin.label = '后续生成'; }
      if (!owned || origin.canDelete !== true) { origin.canDelete = false; origin.reason = historical ? '历史生成归属尚未由原生回执确认，保留保护。' : origin.reason || '缺少工作台创建回执，保留保护。'; }
    }
    return { ...skill, origin, usage: 'workflow', assignable: skill.enabled !== false };
  }
  async inspect({ refresh = false } = {}) {
    if (this.app.closed || this.app.adapter.state !== 'ready') return { connected: false, toolsets: [], imageProviders: [], selectedImageProvider: '' };
    if (!refresh && this.cache && Date.now() - this.cache.at < 15000) return structuredClone(this.cache.value);
    if (this.pending) return this.pending;
    const generation = this.generation;
    const request = Promise.resolve().then(async () => {
      try {
        const value = { connected: true, ...projectSkillIntegrations(await this.app.adapter.request('workbench.tools.catalog', {})) };
        if (this.generation === generation) this.cache = { at: Date.now(), value };
        return structuredClone(value);
      } finally { if (this.generation === generation) this.pending = null; }
    });
    this.pending = request; return request;
  }
  async mutate(kind, input, action, { human = false } = {}) {
    const id = input.operationId;
    const reject = (message, httpStatus, code) => {
      if (kind !== 'delete') return fail(message, httpStatus);
      try { this.app.logEvents?.write('warn', `skill.integration.delete.${code === 'SKILL_DELETE_UNCONFIRMED' ? 'unconfirmed' : 'rejected'}`,
        { component: 'skills', operationId: typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) ? id : undefined, code, httpStatus, stage: 'preflight' }); } catch { /* Logging cannot change rejection semantics. */ }
      return fail(message, httpStatus, code, 'preflight');
    };
    if (human !== true) reject('此入口只能由用户在界面操作，助手不能创建或删除 Skill、修改图片提供商。', 403, 'SKILL_DELETE_PROTECTED');
    try { this.app.checkReady(); } catch (error) { if (kind !== 'delete') throw error; reject(error.message, error.httpStatus || 409, 'SKILL_DELETE_UNCONFIRMED'); }
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) reject('Skill 操作身份无效。', 400, 'SKILL_DELETE_STALE');
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = this.db.prepare('SELECT * FROM skill_integration_operations WHERE id=?').get(id);
    if (existing) {
      if (existing.kind !== kind || existing.fingerprint !== fingerprint) reject('操作身份已用于其它内容，请重新提交。', 409, 'SKILL_DELETE_STALE');
      if (existing.status === 'complete') return JSON.parse(existing.value);
      if (this.active.has(id)) return this.active.get(id);
      if (existing.status !== 'rejected') reject('上次操作结果尚未确认，请先刷新技能或图片服务状态，不要重复创建或覆盖。', 409, 'SKILL_DELETE_UNCONFIRMED');
    }
    const now = () => new Date().toISOString();
    if (existing) this.db.prepare("UPDATE skill_integration_operations SET status='pending',updated_at=? WHERE id=?").run(now(), id);
    else this.db.prepare('INSERT INTO skill_integration_operations(id,kind,fingerprint,status,updated_at) VALUES(?,?,?,?,?)').run(id, kind, fingerprint, 'pending', now());
    const started = performance.now();
    const pending = (async () => {
      try {
        const value = await action();
        this.db.prepare("UPDATE skill_integration_operations SET status='complete',value=?,updated_at=? WHERE id=?").run(JSON.stringify(value), now(), id);
        this.invalidate();
        try { this.app.logEvents?.write('info', `skill.integration.${kind}.completed`, { component: 'skills', operationId: id, durationMs: Math.round(performance.now() - started), success: true }); } catch { /* Observers cannot invalidate a confirmed mutation. */ }
        try { this.app.publish?.('skills.updated', null, { operationId: id }); } catch { /* The persisted receipt remains authoritative. */ }
        return value;
      } catch (error) {
        this.invalidate();
        const status = kind === 'delete' && error.confirmedUnchanged === true ? 'rejected' : 'unknown';
        this.db.prepare('UPDATE skill_integration_operations SET status=?,updated_at=? WHERE id=?').run(status, now(), id);
        try { this.app.logEvents?.write('warn', `skill.integration.${kind}.${status === 'rejected' ? 'rejected' : 'unconfirmed'}`, { component: 'skills', operationId: id,
          durationMs: Math.round(performance.now() - started), errorName: error.name, errorCode: error.code, code: error.code, httpStatus: error.httpStatus,
          ...(kind === 'delete' ? { stage: error.stage || 'preflight' } : {}) }); } catch { /* Observers cannot replace the recorded failure. */ }
        throw error;
      } finally { this.active.delete(id); }
    })();
    this.active.set(id, pending); return pending;
  }
  async create(input, identity) {
    args(input, ['name', 'description', 'instructions', 'requiredToolsets', 'operationId']);
    const name = bounded(input.name, 'Skill 名称', 64);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) fail('Skill 名称须使用最多64个小写字母、数字和连字符。');
    if (name.startsWith('wb-learn-')) fail('wb-learn- 前缀为工作台学习版本保留，请换一个名称。');
    const description = bounded(input.description, 'Skill 描述', 2000), instructions = bounded(input.instructions, 'Skill 正文', 48000).replace(/\r\n?/g, '\n');
    if (description.length > 1024) fail('Skill 描述不能超过1024个字符。');
    const requiredToolsets = validateSkillToolsets(input.requiredToolsets);
    const request = { name, description, instructions, requiredToolsets, operationId: input.operationId };
    return this.mutate('create', request, async () => {
      const result = await this.app.adapter.request('workbench.skill.create', { name, description, instructions, required_toolsets: requiredToolsets, operation_id: request.operationId });
      const confirmed = result?.skill || result;
      if (confirmed?.name !== name) fail('Hermes 未确认新建 Skill 的身份，请先刷新目录核对。', 502);
      const skill = await this.app.skill(name);
      if (!skill.content?.includes(instructions) || JSON.stringify(skill.requiredToolsets || []) !== JSON.stringify(requiredToolsets)
        || confirmed.revision && confirmed.revision !== skill.revision) fail('新建 Skill 读回内容未确认，请先刷新目录核对。', 502);
      const owned = skill.origin?.kind === 'generated' && skill.creationId && confirmed.creationId === skill.creationId;
      return { skill: owned ? { ...skill, origin: skillOrigin(confirmed.origin) } : skill, operationId: request.operationId, created: true };
    }, identity);
  }
  async remove(input, identity) {
    args(input, ['name', 'expectedRevision', 'expectedCreationId', 'operationId']);
    const name = bounded(input.name, 'Skill 名称', 256);
    if (!/^[a-z0-9][a-z0-9-]{0,255}$/.test(name) || !/^sha256:[a-f0-9]{64}$/.test(input.expectedRevision || '')
      || !Object.hasOwn(input, 'expectedCreationId') || input.expectedCreationId !== null && !creationId(input.expectedCreationId)) fail('Skill 删除身份、预期版本或创建代次无效。', 400, 'SKILL_DELETE_STALE', 'preflight');
    const request = { name, expectedRevision: input.expectedRevision, expectedCreationId: input.expectedCreationId, operationId: input.operationId };
    return this.mutate('delete', request, async () => {
      if (this.deleting.has(name)) throw Object.assign(new Error('此 Skill 正在删除。'), { httpStatus: 409, code: 'SKILL_DELETE_BUSY', stage: 'preflight', confirmedUnchanged: true });
      this.deleting.add(name);
      let preflight = true;
      try {
        const learned = this.app.learnedSkills?.has(name);
        const raw = learned ? this.app.learnedSkills.get(name) : await this.app.readSkillForManagement(name);
        const skill = this.project(raw);
        if (skill.origin.kind !== 'generated' || !skill.origin.canDelete) fail(skill.origin.reason || '内置或来源未确认的 Skill 不可删除。', 403, 'SKILL_DELETE_PROTECTED');
        if (learned ? request.expectedCreationId !== null : !creationId(skill.creationId) || request.expectedCreationId !== skill.creationId) fail('Skill 创建代次已变化，请刷新后再删除。', 409, 'SKILL_DELETE_STALE');
        if (skill.revision !== request.expectedRevision) fail('Skill 版本已变化，请刷新后再删除。', 409, 'SKILL_DELETE_STALE');
        const references = skillReferences(this.app, name);
        if (references.length) fail('此 Skill 仍被工作流、定时任务、运行、学习或派生版本引用，请先移除引用。', 409, 'SKILL_DELETE_IN_USE');
        let result;
        if (learned) { preflight = false; result = this.app.learnedSkills.remove(name, request.expectedRevision); }
        else {
          preflight = false;
          result = await this.app.adapter.request('workbench.skill.delete', { name, creation_id: skill.creationId,
            expected_revision: request.expectedRevision, expected_bundle_revision: skill.bundleRevision, operation_id: request.operationId });
          if (result?.deleted !== true || result.name !== name || result.creationId !== skill.creationId || result.operationId !== request.operationId || result.archived !== true) fail('Hermes 未确认删除回执，请先刷新目录核对。', 502, 'SKILL_DELETE_UNCONFIRMED');
        }
        return { deleted: true, name, operationId: request.operationId, archived: result.archived === true };
      } catch (error) {
        if (preflight) error.confirmedUnchanged = true;
        if (!/^SKILL_DELETE_(?:PROTECTED|IN_USE|STALE|BUSY|UNCONFIRMED)$/.test(error.code || '')) error.code = 'SKILL_DELETE_UNCONFIRMED';
        error.stage = preflight ? 'preflight' : 'native'; error.httpStatus ||= 502; throw error;
      }
      finally { this.deleting.delete(name); }
    }, identity);
  }
  async selectImageProvider(input, identity) {
    args(input, ['provider', 'expectedProvider', 'operationId']);
    if (!providerId(input.provider) || !(input.expectedProvider === '' || providerId(input.expectedProvider))) fail('图片提供商或预期版本无效。');
    const request = { provider: input.provider, expectedProvider: input.expectedProvider, operationId: input.operationId };
    return this.mutate('provider', request, async () => {
      this.invalidate();
      await this.app.adapter.request('workbench.image.provider', { provider: request.provider, expected_provider: request.expectedProvider });
      this.invalidate();
      const status = await this.inspect({ refresh: true });
      if (status.selectedImageProvider !== request.provider) fail('Hermes 图片提供商读回未确认，请刷新配置核对。', 502);
      return { ...status, operationId: request.operationId };
    }, identity);
  }
}
