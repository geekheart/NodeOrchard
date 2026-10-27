import { randomUUID } from 'node:crypto';
import { builtinNodePresets, validatePresetDefinition } from '../../shared/workflow/workflow-presets.mjs';
import { validateNodeParent } from '../../shared/workflow/workflow-model.mjs';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };

function id(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) fail('派生节点 ID 无效。');
  return value;
}

function request(input, creating = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('派生节点保存请求必须是对象。');
  if (Reflect.ownKeys(input).some(key => !['definition', 'expectedRevision'].includes(key))) fail('派生节点保存请求包含未知字段。');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(input))) if (!Object.hasOwn(descriptor, 'value')) fail('派生节点保存请求不能包含访问器。');
  if ((creating && input.expectedRevision !== undefined && input.expectedRevision !== 0)
    || (!creating && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1))) fail(creating ? '新派生的 expectedRevision 必须为 0。' : 'expectedRevision 必须是正整数。');
  let definition;
  try { definition = validatePresetDefinition(input.definition); }
  catch (error) { fail(error.message, /不能超过 2MB/.test(error.message) ? 413 : 400); }
  if (creating && (!Object.hasOwn(input.definition, 'parent') || definition.parent.kind === 'unknown')) fail('新派生节点必须记录明确的父级来源。');
  return { definition, expectedRevision: input.expectedRevision };
}

function summary(record) {
  const { definition, ...result } = record;
  return result;
}

export class WorkflowNodePresets {
  constructor(app) {
    this.app = app;
    this.db = app.store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_node_presets (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_node_preset_versions (
      preset_id TEXT NOT NULL REFERENCES workflow_node_presets(id), version INTEGER NOT NULL,
      created_at TEXT NOT NULL, definition TEXT NOT NULL, PRIMARY KEY(preset_id,version)
    );`);
    this.readHead = this.db.prepare('SELECT * FROM workflow_node_presets WHERE id=?');
    this.readVersion = this.db.prepare('SELECT * FROM workflow_node_preset_versions WHERE preset_id=? AND version=?');
  }

  get(presetId, options = {}) {
    const key = id(presetId);
    if (!options || typeof options !== 'object' || Array.isArray(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
      || Reflect.ownKeys(options).some(key => key !== 'version')
      || Object.values(Object.getOwnPropertyDescriptors(options)).some(descriptor => !Object.hasOwn(descriptor, 'value'))) fail('派生读取选项无效。');
    const version = options.version;
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) fail('派生节点版本必须是正整数。');
    const builtin = builtinNodePresets().find(record => record.id === key);
    if (builtin) {
      if (version !== undefined && version !== builtin.version) fail('派生节点版本不存在。', 404);
      return builtin;
    }
    const head = this.readHead.get(key);
    if (!head) fail('派生节点不存在。', 404);
    const row = this.readVersion.get(key, version ?? head.revision);
    if (!row) fail('派生节点版本不存在。', 404);
    const stored = JSON.parse(row.definition);
    const parent = Object.hasOwn(stored, 'parent') ? validateNodeParent(stored.parent, stored.node.type) : { kind: 'unknown', baseType: stored.node.type };
    const definition = { ...stored, parent };
    return { id: key, title: definition.title, description: definition.description, kind: definition.kind,
      baseType: definition.node.type, parent, source: 'user', version: row.version, revision: head.revision,
      createdAt: head.created_at, updatedAt: row.created_at, definition };
  }

  list() {
    const users = this.db.prepare('SELECT id FROM workflow_node_presets ORDER BY updated_at DESC,rowid DESC').all().map(row => summary(this.get(row.id)));
    return [...builtinNodePresets().map(summary), ...users];
  }

  assertParent(definition, key, previous) {
    const parent = definition.parent;
    if (previous && JSON.stringify(parent) !== JSON.stringify(previous.parent)) fail('发布新版本不能更换派生父级，请另存为新的派生节点。', 409);
    if (parent.kind === 'foundation' || parent.kind === 'unknown' && previous?.parent.kind === 'unknown') return;
    if (parent.kind === 'unknown') fail('新派生节点必须记录明确的父级来源。');
    if (parent.id === key) fail('派生节点不能以自身作为父级。', 409);
    let record;
    try { record = this.get(parent.id, { version: parent.version }); }
    catch (error) { if (error.httpStatus === 404) fail('派生父级或固定版本不存在，请核对来源。', 409); throw error; }
    if (record.kind !== parent.kind || record.baseType !== parent.baseType || record.title !== parent.title) fail('派生父级名称、种类或基础类型与固定版本不一致。', 409);
  }

  create(input) {
    const { definition } = request(input, true);
    const key = 'preset-' + randomUUID();
    this.assertParent(definition, key);
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO workflow_node_presets(id,revision,created_at,updated_at) VALUES(?,1,?,?)').run(key, now, now);
      this.db.prepare('INSERT INTO workflow_node_preset_versions(preset_id,version,created_at,definition) VALUES(?,1,?,?)').run(key, now, JSON.stringify(definition));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const record = this.get(key);
    this.app.publish?.('workflow.node-preset', null, { preset: summary(record) });
    return record;
  }

  update(presetId, input) {
    const key = id(presetId);
    if (key.startsWith('builtin-')) fail('内置派生不能覆盖，请另存为我的派生。', 409);
    const { definition, expectedRevision } = request(input);
    const serialized = JSON.stringify(definition);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.readHead.get(key);
      if (!previous) fail('派生节点不存在。', 404);
      if (previous.revision !== expectedRevision) fail('派生节点已有新版本，请刷新后再保存。', 409);
      this.assertParent(definition, key, this.get(key));
      const current = this.readVersion.get(key, previous.revision);
      if (current.definition === serialized) { this.db.exec('COMMIT'); return this.get(key); }
      const now = new Date().toISOString();
      const version = previous.revision + 1;
      this.db.prepare('INSERT INTO workflow_node_preset_versions(preset_id,version,created_at,definition) VALUES(?,?,?,?)').run(key, version, now, serialized);
      const result = this.db.prepare('UPDATE workflow_node_presets SET revision=?,updated_at=? WHERE id=? AND revision=?').run(version, now, key, expectedRevision);
      if (!result.changes) fail('派生节点已有新版本，请刷新后再保存。', 409);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const record = this.get(key);
    this.app.publish?.('workflow.node-preset', null, { preset: summary(record) });
    return record;
  }
}
