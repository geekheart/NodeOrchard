const COMMON = [
  ['workflowRead', '读取工作流与运行日志', '节点、运行与会话'],
  ['workflowEdit', '修改工作流与节点', '业务修改候选'],
  ['customNodes', '派生自定义节点', '业务代码候选'],
  ['workspaceRead', '读取工作文件夹资料', '当前工作文件夹'],
  ['capture', '截图与短录制', '隔离页面'],
];
const GROUPS = [
  ['workflow', '独立工作流助手', '范围：当前工作流与工作文件夹', COMMON],
  ['supervisor', '总控助手', '范围：跨工作流', [...COMMON,
    ['crossWorkflowRead', '跨工作流读取', '任意工作流的状态与日志'],
    ['manageWorkflows', '管理工作流', '复制、测试草稿、回收站、只读诊断委派'],
    ['appLogs', '读取软件日志', '脱敏诊断日志'],
    ['sourceRead', '读取诊断源码', '工作台仓库与固定Hermes模块，只读'],
    ['sourceRepair', '源码自修复（实验性）', '修改工作台源码并运行隔离相关测试，保留修复记录和回滚入口；不修改或运行用户工作流'],
    ['modelExperiment', '模型诊断实验（实验性）', '真实模型调用，每轮一次，输出长度为软约束'],
  ]],
];
const clone = value => JSON.parse(JSON.stringify(value));

function configuration(data) {
  if (!data || !Number.isInteger(data.revision) || data.revision < 0) throw new Error('权限版本无效，请刷新后重试。');
  const result = { revision: data.revision };
  if (typeof data.workspaceRoot === 'string' && data.workspaceRoot.length <= 4000) result.workspaceRoot = data.workspaceRoot;
  for (const [role, , , flags] of GROUPS) {
    result[role] = {};
    for (const [flag] of flags) {
      if (typeof data[role]?.[flag] !== 'boolean') throw new Error('权限配置不完整，请刷新后重试。');
      result[role][flag] = data[role][flag];
    }
  }
  const limits = data.modelExperimentLimits;
  if (!limits || !Number.isSafeInteger(limits.maxInputCharacters) || limits.maxInputCharacters < 1000 || limits.maxInputCharacters > 100000) throw new Error('模型实验额度无效，请刷新后重试。');
  result.modelExperimentLimits = { maxInputCharacters: limits.maxInputCharacters };
  return result;
}

// Only the settings form calls this controller. It is not an assistant tool.
export class AssistantPermissionsUI {
  constructor({ api, context, readOnly = false }) {
    Object.assign(this, { api, context, readOnly });
    this.data = null; this.draft = null; this.loading = false; this.saving = false; this.error = ''; this.message = '';
    this.nodes = Object.fromEntries(['form', 'groups', 'status', 'save', 'refresh', 'folder'].map(name => [name, document.getElementById(`assistant-permissions-${name}`)]));
    this.inputs = new Map();
    for (const [role, title, description, flags] of GROUPS) {
      const group = document.createElement('fieldset'), legend = document.createElement('legend'), help = document.createElement('p');
      group.className = 'assistant-permission-group'; legend.textContent = title; help.className = 'helper'; help.textContent = description; group.append(legend, help);
      for (const [flag, label, description] of flags) {
        const row = document.createElement('label'), text = document.createElement('span'), hint = document.createElement('span'), input = document.createElement('input');
        row.className = 'setting-row assistant-permission-row'; text.textContent = label; hint.textContent = description; text.append(hint);
        input.type = 'checkbox'; input.setAttribute('aria-label', `${title}：${label}`);
        input.addEventListener('change', () => {
          if (!this.draft || this.loading || this.saving || this.readOnly) return;
          this.draft[role][flag] = input.checked; this.error = ''; this.message = ''; this.render();
        });
        this.inputs.set(`${role}.${flag}`, input); row.append(text, input); group.append(row);
      }
      if (role === 'supervisor') {
        const row = document.createElement('label'), text = document.createElement('span'), input = document.createElement('input');
        row.className = 'setting-row assistant-permission-row'; text.textContent = '模型实验输入上限（字符）';
        input.type = 'number'; input.min = '1000'; input.max = '100000'; input.step = '1'; input.setAttribute('aria-label', '模型实验输入上限（字符）');
        input.addEventListener('input', () => {
          if (!this.draft || this.loading || this.saving || this.readOnly || !this.draft.supervisor.modelExperiment) return;
          this.draft.modelExperimentLimits.maxInputCharacters = input.value.trim() ? Number(input.value) : NaN; this.error = ''; this.message = ''; this.render();
        });
        this.experimentInput = input; row.append(text, input); group.append(row);
      }
      this.nodes.groups.append(group);
    }
    this.nodes.form.addEventListener('submit', event => { event.preventDefault(); void this.save(); });
    this.nodes.refresh.addEventListener('click', () => this.refresh({ discardDraft: true }));
    this.render();
  }
  dirty() { return Boolean(this.data && this.draft && (GROUPS.some(([role]) => JSON.stringify(this.data[role]) !== JSON.stringify(this.draft[role]))
    || JSON.stringify(this.data.modelExperimentLimits) !== JSON.stringify(this.draft.modelExperimentLimits))); }
  async refresh({ discardDraft = false } = {}) {
    if (this.loading || this.saving || (this.dirty() && !discardDraft)) return;
    this.loading = true; this.error = ''; this.message = ''; this.render();
    try { const data = configuration(await this.api('/api/assistant-permissions')); this.data = data; this.draft = clone(data); }
    catch (error) { this.error = `权限读取失败：${error.message}`; }
    finally { this.loading = false; this.render(); }
  }
  async save() {
    if (this.readOnly || this.loading || this.saving || !this.context().csrfToken || !this.dirty()) return;
    let limit = this.draft.modelExperimentLimits.maxInputCharacters;
    if (!Number.isSafeInteger(limit) || limit < 1000 || limit > 100000) {
      if (this.draft.supervisor.modelExperiment) { this.error = '模型实验输入上限必须为 1000–100000 字符的整数。'; this.render(); return; }
      limit = this.data.modelExperimentLimits.maxInputCharacters;
    }
    const body = { expectedRevision: this.data.revision, ...Object.fromEntries(GROUPS.map(([role]) => [role, clone(this.draft[role])])),
      modelExperimentLimits: { maxInputCharacters: limit } };
    this.saving = true; this.error = ''; this.message = ''; this.render();
    try { const data = configuration(await this.api('/api/assistant-permissions', { method: 'PUT', body })); this.data = data; this.draft = clone(data); this.message = '权限已保存'; }
    catch (error) { this.error = `保存失败：${error.message}`; }
    finally { this.saving = false; this.render(); }
  }
  render() {
    this.nodes.folder.textContent = this.data?.workspaceRoot || '尚未读取';
    const disabled = this.readOnly || !this.draft || this.loading || this.saving || !this.context().csrfToken;
    for (const [key, input] of this.inputs) { const [role, flag] = key.split('.'); input.checked = this.draft?.[role]?.[flag] === true; input.disabled = disabled; }
    const limit = this.draft?.modelExperimentLimits?.maxInputCharacters;
    this.experimentInput.value = Number.isFinite(limit) ? String(limit) : '';
    this.experimentInput.disabled = disabled || !this.draft?.supervisor.modelExperiment;
    this.nodes.save.disabled = disabled || !this.dirty(); this.nodes.save.textContent = this.saving ? '保存中…' : '保存助手权限';
    this.nodes.refresh.disabled = this.loading || this.saving; this.nodes.refresh.textContent = this.loading ? '读取中…' : '重新读取';
    this.nodes.status.textContent = this.error || this.message || (this.readOnly ? '只读' : this.loading ? '正在读取权限…' : this.dirty() ? '有未保存的权限更改' : this.data ? `权限版本 ${this.data.revision}` : '权限尚未读取。');
    this.nodes.status.className = this.error ? 'error-text' : 'helper'; this.nodes.status.setAttribute('role', this.error ? 'alert' : 'status');
  }
}
