const OPERATION_STORAGE = 'workbench.source-repair-rollback-operations:v1';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const text = (value, limit = 300) => typeof value === 'string' ? value.length > limit ? value.slice(0, limit) + '…' : value : '';
const number = value => Number.isFinite(value) ? value : null;
const element = (tag, className = '', value) => { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
const button = (label, action) => { const node = element('button', 'button quiet small', label); node.type = 'button'; node.addEventListener('click', action); return node; };
const labels = { applied: '已应用', complete: '已完成', incomplete: '不完整', testing: '测试中', running: '运行中', checking: '检查中', verified: '已验证', pass: '通过', passed: '通过', fail: '失败', failed: '失败', error: '失败', timeout: '超时', interrupted: '已中断', unknown: '待核对',
  conflict: '冲突', 'rollback-conflict': '回滚冲突', 'rolled-back': '已回滚', rolled_back: '已回滚', available: '可用', unavailable: '不可用', missing: '缺失', skipped: '未运行', pending: '待处理' };
const label = value => Object.hasOwn(labels, value) ? labels[value] : text(value, 80) || '未提供';
const conflictLabel = repair => repair.error?.code === 'SOURCE_ROLLBACK_CONFLICT' ? '回滚冲突' : repair.error?.code === 'SOURCE_HASH_CONFLICT' ? '版本冲突' : '';
const rolledBack = repair => ['rolled-back', 'rolled_back'].includes(repair?.status);
const paths = value => Array.isArray(value) ? value.slice(0, 32).map(path => text(path, 512)).filter(Boolean) : [];

function records(value) {
  if (!Array.isArray(value?.repairs)) throw new Error('修复记录格式无效。');
  return value.repairs.slice(0, 20).filter(repair => repair && validId(repair.id)).map(repair => ({
    id: repair.id, summary: text(repair.summary, 500), status: text(repair.status, 80), createdAt: text(repair.createdAt, 80), updatedAt: text(repair.updatedAt, 80),
    backupStatus: text(repair.backupStatus || repair.backup?.status || (typeof repair.backupAvailable === 'boolean' ? repair.backupAvailable ? 'available' : 'missing' : ''), 80),
    error: repair.error && typeof repair.error === 'object' ? { code: text(repair.error.code, 100), message: text(repair.error.message, 500) } : null,
    files: Array.isArray(repair.files) ? repair.files.slice(0, 64).filter(file => file && typeof file.path === 'string').map(file => ({ path: text(file.path, 512), beforeHash: text(file.beforeHash, 80), afterHash: text(file.afterHash, 80) })) : [],
    tests: Array.isArray(repair.tests) ? repair.tests.slice(0, 20).filter(test => test && typeof test === 'object').map(test => ({ status: text(test.status, 80), files: paths(test.files), exitCode: number(test.exitCode), durationMs: number(test.durationMs),
      sandbox: { kind: text(test.sandbox?.kind, 80), status: text(test.sandbox?.status, 80), code: text(test.sandbox?.code, 100) } })) : [],
  }));
}

// Human settings controller only. It does not run tests, edit source, or expose
// a method through the assistant tool dispatcher.
export class SourceRepairUI {
  constructor({ api, context, readOnly = false }) {
    Object.assign(this, { api, context, readOnly }); this.repairs = []; this.loaded = false; this.loading = false; this.busy = null; this.error = ''; this.message = '';
    this.root = document.getElementById('source-repair-records'); this.expanded = new Set(); this.operationIds = new Map();
    try {
      const stored = JSON.parse(globalThis.sessionStorage?.getItem(OPERATION_STORAGE) || '[]');
      if (Array.isArray(stored)) for (const row of stored.slice(-20)) if (Array.isArray(row) && validId(row[0]) && /^[a-f\d-]{36}$/i.test(row[1])) this.operationIds.set(row[0], row[1]);
    } catch { /* Keep uncertain operation identities in memory if storage fails. */ }
    this.render();
  }
  operationId(id) {
    if (!this.operationIds.has(id)) {
      this.operationIds.set(id, crypto.randomUUID());
      this.operationIds = new Map([...this.operationIds].slice(-20));
      try { globalThis.sessionStorage?.setItem(OPERATION_STORAGE, JSON.stringify([...this.operationIds])); } catch { /* Memory still preserves identity for retries. */ }
    }
    return this.operationIds.get(id);
  }
  async readRecords() { this.repairs = records(await this.api('/api/source-repairs')); this.loaded = true; }
  async refresh() {
    if (this.loading || this.busy) return;
    this.loading = true; this.error = ''; this.message = ''; this.render();
    try { await this.readRecords(); } catch (error) { this.error = '修复记录读取失败：' + text(error?.message, 500); }
    finally { this.loading = false; this.render(); }
  }
  async rollback(id) {
    if (this.readOnly || this.loading || this.busy || !this.context()?.csrfToken || !validId(id)) return;
    const repair = this.repairs.find(repair => repair.id === id);
    if (!repair || rolledBack(repair) || !repair.files.length) return;
    const operationId = this.operationId(id); this.busy = id; this.error = ''; this.message = ''; this.render();
    try {
      await this.api(`/api/source-repairs/${encodeURIComponent(id)}/rollback`, { method: 'POST', body: { operationId } });
      try {
        await this.readRecords();
        if (rolledBack(this.repairs.find(repair => repair.id === id))) this.message = '已回滚此改动。';
        else this.error = '回滚结果未确认，请核对修复记录；重试将沿用同一请求。';
      } catch (error) { this.error = '回滚请求已提交，记录刷新未确认：' + text(error?.message, 500) + '；重试将沿用同一请求。'; }
    } catch (error) { this.error = '回滚未确认：' + text(error?.message, 500) + '；重试将沿用同一请求。'; }
    finally { this.busy = null; this.render(); }
  }
  render() {
    if (!this.root) return;
    const toolbar = element('div', 'source-repair-toolbar'), status = element('p', this.error ? 'error-text' : 'helper', this.error || this.message || (this.loading ? '正在读取修复记录…' : !this.loaded ? '尚未读取' : this.repairs.length ? `最近 ${this.repairs.length} 条记录` : '暂无源码修复记录'));
    status.setAttribute('role', this.error ? 'alert' : 'status'); status.setAttribute('aria-live', 'polite');
    const refresh = button(this.loading ? '读取中…' : '重新读取', () => this.refresh()); refresh.disabled = this.loading || Boolean(this.busy); toolbar.append(status, refresh);
    const list = element('div', 'source-repair-list');
    for (const repair of this.repairs) {
      const card = element('article', 'source-repair-record'), details = element('details'), conflict = conflictLabel(repair), summary = element('summary', '', `${label(repair.status)}${conflict ? ' · ' + conflict : ''} · ${repair.summary || repair.id}`);
      details.open = this.expanded.has(repair.id); details.addEventListener('toggle', () => details.open ? this.expanded.add(repair.id) : this.expanded.delete(repair.id));
      details.append(summary, element('p', 'helper', `${repair.id} · ${repair.createdAt || '时间未提供'}${repair.updatedAt && repair.updatedAt !== repair.createdAt ? ' · 更新 ' + repair.updatedAt : ''}`), element('p', 'helper', '备份：' + label(repair.backupStatus)));
      if (repair.error?.code || repair.error?.message) details.append(element('p', 'error-text', `${conflict || '错误'}：${repair.error.message || repair.error.code}${repair.error.code && repair.error.message ? ' · ' + repair.error.code : ''}`));
      const files = element('ul', 'source-repair-files');
      for (const file of repair.files) {
        const row = element('li'); row.append(element('code', '', file.path), element('p', 'helper mono', `修改前 ${file.beforeHash || '未提供'} → 修改后 ${file.afterHash || '未提供'}`)); files.append(row);
      }
      details.append(files);
      const tests = element('ul', 'source-repair-tests');
      if (!repair.tests.length) tests.append(element('li', 'helper', '尚无测试记录'));
      for (const test of repair.tests) tests.append(element('li', '', `${label(test.status)} · 退出码 ${test.exitCode ?? '未提供'} · 耗时 ${test.durationMs === null ? '未提供' : test.durationMs + 'ms'}\n沙箱：${test.sandbox.kind || '未提供'} · ${label(test.sandbox.status)}${test.sandbox.code ? ' · ' + test.sandbox.code : ''}${test.files.length ? '\n' + test.files.join('\n') : ''}`));
      details.append(tests); card.append(details);
      const rollback = button(this.busy === repair.id ? '回滚中…' : rolledBack(repair) ? '已回滚' : this.operationIds.has(repair.id) ? '重试确认回滚' : '回滚此改动', () => this.rollback(repair.id));
      rollback.title = '恢复本次改动前的源码；若文件之后被再次编辑，回滚会被拒绝。';
      rollback.disabled = this.readOnly || this.loading || Boolean(this.busy) || !this.context()?.csrfToken || rolledBack(repair) || !repair.files.length;
      card.append(rollback); list.append(card);
    }
    this.root.replaceChildren(toolbar, list);
  }
}
