import { resolve } from 'node:path';

export const ASSISTANT_PERMISSION_KEYS = Object.freeze({
  workflow: Object.freeze(['workflowRead', 'workflowEdit', 'customNodes', 'workspaceRead', 'capture']),
  supervisor: Object.freeze(['workflowRead', 'workflowEdit', 'customNodes', 'workspaceRead', 'capture', 'crossWorkflowRead', 'manageWorkflows', 'appLogs', 'sourceRepair']),
});
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
const defaults = () => Object.fromEntries(Object.entries(ASSISTANT_PERMISSION_KEYS).map(([role, keys]) => [role, Object.fromEntries(keys.map(key => [key, key !== 'sourceRepair']))]));

// This store is deliberately absent from the assistant tool dispatcher. Only
// the authenticated settings form's HTTP handler can call save().
export class AssistantPermissionSettings {
  constructor(app) {
    this.app = app; this.db = app.store.db;
    this.db.exec('CREATE TABLE IF NOT EXISTS assistant_permission_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, value TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO assistant_permission_settings(id,revision,value) VALUES(1,1,?)').run(JSON.stringify(defaults()));
  }
  get() {
    const row = this.db.prepare('SELECT revision,value FROM assistant_permission_settings WHERE id=1').get();
    const value = JSON.parse(row.value);
    // Older human settings stay byte-for-byte intact until an explicit save.
    // A missing experimental permission is a read-only disabled projection.
    if (value.supervisor && typeof value.supervisor === 'object' && !Array.isArray(value.supervisor) && !Object.hasOwn(value.supervisor, 'sourceRepair')) {
      value.supervisor = { ...value.supervisor, sourceRepair: false };
    }
    return { revision: row.revision, ...value, protection: 'human-only',
      workspaceRoot: resolve(this.app.config.workspaceRoot, this.app.preferences?.defaultWorkspace || '.'),
      immutable: { unrestrictedSourceWrite: false, shell: false, permissionWrite: false, workflowCrossScope: false } };
  }
  save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['expectedRevision', 'workflow', 'supervisor'].includes(key))) fail('权限配置包含未知字段。');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail('权限配置版本无效。');
    const value = {};
    for (const [role, keys] of Object.entries(ASSISTANT_PERMISSION_KEYS)) {
      const row = input[role];
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== keys.length
        || Object.keys(row).some(key => !keys.includes(key)) || keys.some(key => typeof row[key] !== 'boolean')) fail('请提交完整的助手权限配置。');
      value[role] = Object.fromEntries(keys.map(key => [key, row[key]]));
    }
    const result = this.db.prepare('UPDATE assistant_permission_settings SET revision=revision+1,value=? WHERE id=1 AND revision=?')
      .run(JSON.stringify(value), input.expectedRevision);
    if (!result.changes) fail('权限配置已被其他页面修改，请重新读取后保存。', 409);
    const saved = this.get(); this.app.publish('assistant.permissions.updated', null, { revision: saved.revision });
    return saved;
  }
}
