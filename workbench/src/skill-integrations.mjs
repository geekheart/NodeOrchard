import { createHash } from 'node:crypto';
import { validateSkillToolsets } from '../shared/workflow/workflow-integrations.mjs';
import { redact } from './hermes-adapter.mjs';

const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const providerId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value);
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
    this.app = app; this.active = new Map(); this.cache = null; this.pending = null; this.generation = 0;
    this.db = app.store.db;
    this.db.exec('CREATE TABLE IF NOT EXISTS skill_integration_operations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, value TEXT, updated_at TEXT NOT NULL)');
    this.db.prepare("UPDATE skill_integration_operations SET status='unknown' WHERE status='pending'").run();
  }
  invalidate() { this.cache = null; this.pending = null; this.generation++; }
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
    if (human !== true) fail('此入口只能由用户在界面操作，助手不能创建 Skill 或修改图片提供商。', 403);
    this.app.checkReady();
    const id = input.operationId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) fail('Skill 操作身份无效。');
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = this.db.prepare('SELECT * FROM skill_integration_operations WHERE id=?').get(id);
    if (existing) {
      if (existing.kind !== kind || existing.fingerprint !== fingerprint) fail('操作身份已用于其它内容，请重新提交。', 409);
      if (existing.status === 'complete') return JSON.parse(existing.value);
      if (this.active.has(id)) return this.active.get(id);
      fail('上次操作结果尚未确认，请先刷新技能或图片服务状态，不要重复创建或覆盖。', 409);
    }
    const now = () => new Date().toISOString();
    this.db.prepare('INSERT INTO skill_integration_operations(id,kind,fingerprint,status,updated_at) VALUES(?,?,?,?,?)').run(id, kind, fingerprint, 'pending', now());
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
        this.db.prepare("UPDATE skill_integration_operations SET status='unknown',updated_at=? WHERE id=?").run(now(), id);
        this.app.logEvents?.write('warn', `skill.integration.${kind}.unconfirmed`, { component: 'skills', operationId: id, durationMs: Math.round(performance.now() - started), errorName: error.name, errorCode: error.code });
        throw error;
      } finally { this.active.delete(id); }
    })();
    this.active.set(id, pending); return pending;
  }
  async create(input, identity) {
    args(input, ['name', 'description', 'instructions', 'requiredToolsets', 'operationId']);
    const name = bounded(input.name, 'Skill 名称', 64);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) fail('Skill 名称须使用最多64个小写字母、数字和连字符。');
    const description = bounded(input.description, 'Skill 描述', 2000), instructions = bounded(input.instructions, 'Skill 正文', 48000).replace(/\r\n?/g, '\n');
    if (description.length > 1024) fail('Skill 描述不能超过1024个字符。');
    const requiredToolsets = validateSkillToolsets(input.requiredToolsets);
    const request = { name, description, instructions, requiredToolsets, operationId: input.operationId };
    return this.mutate('create', request, async () => {
      const result = await this.app.adapter.request('workbench.skill.create', { name, description, instructions, required_toolsets: requiredToolsets });
      const confirmed = result?.skill || result;
      if (confirmed?.name !== name) fail('Hermes 未确认新建 Skill 的身份，请先刷新目录核对。', 502);
      const skill = await this.app.skill(name);
      if (!skill.content?.includes(instructions) || JSON.stringify(skill.requiredToolsets || []) !== JSON.stringify(requiredToolsets)
        || confirmed.revision && confirmed.revision !== skill.revision) fail('新建 Skill 读回内容未确认，请先刷新目录核对。', 502);
      return { skill, operationId: request.operationId, created: true };
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
