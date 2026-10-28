import { safeText } from '../shared/diagnostics.mjs';

const element = (tag, className = '', text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = safeText(text); return node; };
const button = (label, action, className = 'button quiet small') => { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node; };
const unique = values => [...new Set(Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.length <= 128) : [])].sort().slice(0, 16);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x20\x7f]/.test(value);
const operation = (map, payload) => { const key = JSON.stringify(payload); if (!map.has(key)) { if (map.size >= 20) map.delete(map.keys().next().value); map.set(key, crypto.randomUUID()); } return map.get(key); };

export const IMAGE_SKILL_TEMPLATE = '根据输入要求，调用已配置且可用的图片生成工具生成图片。缺少工具、服务或认证时明确报告缺失，不用代码绘图或文字描述冒充生成成功。\n将真实图片保存到本次运行提供的会话目录，核对文件存在后仅返回 JSON 文件引用，例如 {"path":"实际图片绝对路径"}。不得编造路径、审核或交付成功。';

export function skillIntegrations(value) {
  if (!value || typeof value.connected !== 'boolean' || !Array.isArray(value.toolsets) || !Array.isArray(value.imageProviders)
    || value.toolsets.length > 100 || value.imageProviders.length > 100 || typeof value.selectedImageProvider !== 'string') throw Error('工具配置目录响应无效。');
  const rows = (items, tools = false) => {
    const ids = new Set();
    return items.map(row => {
      if (!row || !identity(row.id) || ids.has(row.id) || typeof row.label !== 'string' || typeof row.available !== 'boolean'
        || tools && (typeof row.enabled !== 'boolean' || !Array.isArray(row.tools) || row.tools.some(name => typeof name !== 'string'))) throw Error('工具配置目录响应无效。');
      ids.add(row.id); return { id: row.id, label: row.label.slice(0, 200), available: row.available,
        reason: typeof row.reason === 'string' ? row.reason.slice(0, 2000) : '', ...(tools ? { enabled: row.enabled, tools: row.tools.slice(0, 200) } : {}) };
    });
  };
  return { connected: value.connected, toolsets: rows(value.toolsets, true), imageProviders: rows(value.imageProviders), selectedImageProvider: value.selectedImageProvider };
}

export class SkillToolsetsUI {
  constructor(host, { api, selected = [], onChange = () => {}, readOnly = false } = {}) {
    Object.assign(this, { host, api, onChange, readOnly }); this.selected = unique(selected); this.revision = 0; this.data = null; this.loading = false; this.error = ''; this.listeners = new Set(); this.render();
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setSelected(values, { notify = true } = {}) {
    this.selected = unique(values); this.revision++; this.render(); if (notify) this.onChange([...this.selected]);
  }
  async load() {
    if (this.pending) return this.pending;
    this.loading = true; this.error = ''; this.render();
    this.pending = (async () => {
      try { this.data = skillIntegrations(await this.api('/api/skill-integrations')); return this.data; }
      catch (error) { this.error = error.message; return null; }
      finally { this.loading = false; this.pending = null; this.render(); for (const listener of this.listeners) listener(this.data); }
    })(); return this.pending;
  }
  render() {
    this.host.replaceChildren(); this.host.append(element('div', 'skill-toolsets-heading', '所需工具'));
    const status = element('p', 'helper skill-toolsets-status', this.selectionError || this.error || (this.loading ? '正在读取工具…' : this.data?.connected === false ? 'Hermes 未连接' : ''));
    status.setAttribute('role', 'status'); this.host.append(status); status.hidden = !status.textContent;
    const rows = this.data?.toolsets || [], ids = new Set(rows.map(row => row.id));
    for (const row of rows) {
      const label = element('label', 'skill-toolset-choice'), input = element('input'); input.type = 'checkbox'; input.value = row.id; input.checked = this.selected.includes(row.id); input.disabled = this.readOnly;
      input.setAttribute('aria-label', row.label); input.addEventListener('change', () => {
        if (this.readOnly) return;
        if (input.checked && !this.selected.includes(row.id) && this.selected.length >= 16) { this.selectionError = '最多选择 16 个工具集。'; this.render(); return; }
        this.selectionError = '';
        this.setSelected(input.checked ? [...this.selected, row.id] : this.selected.filter(id => id !== row.id));
      });
      const description = element('span'), title = element('span', 'skill-toolset-title', `${row.label} · ${row.available && row.enabled ? '可用' : row.available ? '未启用' : '未配置'}`);
      description.append(title); if (row.reason) description.append(element('span', 'helper skill-toolset-reason', row.reason));
      if (row.tools.length) title.title = row.tools.join('\n'); label.append(input, description); this.host.append(label);
    }
    for (const id of this.selected.filter(id => !ids.has(id))) this.host.append(element('p', 'helper skill-toolset-missing', `${id} · 目录未确认，保留原选择`));
    if (this.data && !rows.some(row => /figma/i.test(row.id + ' ' + row.label))) this.host.append(element('p', 'helper skill-integration-unavailable', `Figma · ${this.data.connected ? '未配置 MCP' : '连接后确认'}`));
    if (this.data && !ids.has('computer_use')) this.host.append(element('p', 'helper skill-integration-unavailable', 'Computer Use · 目录未提供'));
  }
}

export class SkillAuthoringUI {
  constructor({ api, readOnly = false } = {}) { this.api = api; this.readOnly = readOnly; this.operations = new Map(); this.providerOperations = new Map(); this.session = null; }
  current(session) { return Boolean(session && this.session === session && session.dialog.open); }
  async open({ onCreated = () => {} } = {}) {
    if (this.readOnly) return false;
    if (this.session?.dialog.open) { this.session.name.focus(); return false; }
    const dialog = element('dialog', 'new-task-dialog skill-authoring-dialog'), heading = element('div', 'dialog-heading');
    const close = button('×', () => dialog.close(), 'icon-button'); close.setAttribute('aria-label', '关闭新建 Skill');
    heading.append(element('h2', '', '新建 Skill'), close); const form = element('form', 'skill-authoring-form');
    const field = (label, name, multiline = false) => {
      const wrapper = element('label', 'skill-authoring-field'), control = element(multiline ? 'textarea' : 'input'); control.name = name; control.setAttribute('aria-label', label); control.required = true;
      wrapper.append(element('span', '', label), control); form.append(wrapper); return control;
    };
    const name = field('名称', 'name'); name.maxLength = 64; name.pattern = '[a-z0-9][a-z0-9-]{0,63}'; name.placeholder = 'my-image-skill'; name.autocomplete = 'off';
    const description = field('说明', 'description'); description.maxLength = 1024;
    const template = button('图片生成模板', () => {
      instructions.value = IMAGE_SKILL_TEMPLATE; if (!description.value.trim()) description.value = '按输入生成图片';
      if (integrations.data?.toolsets.some(row => row.id === 'image_gen')) integrations.setSelected([...integrations.selected, 'image_gen']);
    }); form.append(template);
    const instructions = field('指令正文', 'instructions', true); instructions.maxLength = 48000;
    const host = element('section', 'skill-toolsets'), integrations = new SkillToolsetsUI(host, { api: this.api }); form.append(host);
    const providerSection = element('section', 'skill-image-provider'), providerLabel = element('label', '', '图像服务'), provider = element('select'); provider.setAttribute('aria-label', '图像服务');
    const providerReason = element('p', 'helper'), providerApply = button('应用图像服务', () => this.applyProvider(session));
    providerSection.append(providerLabel, provider, providerApply, providerReason, element('p', 'helper', '服务认证在 Hermes 中配置')); form.append(providerSection);
    const status = element('p', 'helper skill-authoring-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const actions = element('div', 'dialog-actions'), cancel = button('取消', () => dialog.close()), submit = element('button', 'button primary', '创建 Skill'); submit.type = 'submit';
    actions.append(cancel, submit); form.append(status, actions); dialog.append(heading, form); document.body.append(dialog);
    const session = { dialog, form, name, description, instructions, integrations, provider, providerReason, providerApply, submit, template, status, onCreated, busy: false, providerBusy: false, created: null };
    this.session = session;
    dialog.addEventListener('close', () => { if (!session.busy && !session.providerBusy) dialog.remove?.(); });
    form.addEventListener('submit', event => { event.preventDefault(); void this.create(session); });
    provider.addEventListener('change', () => this.renderProvider(session, false)); integrations.subscribe(() => { this.renderProvider(session); this.controls(session); });
    this.controls(session); dialog.showModal(); name.focus(); await integrations.load(); return true;
  }
  controls(session) {
    const busy = session.busy || session.providerBusy;
    session.submit.disabled = busy || !session.integrations.data?.connected;
    session.template.disabled = busy;
    session.provider.disabled = busy || !session.integrations.data?.imageProviders.length;
    const selected = session.integrations.data?.imageProviders.find(row => row.id === session.provider.value);
    session.providerApply.disabled = busy || !selected?.available || session.provider.value === session.integrations.data?.selectedImageProvider;
    for (const control of [session.name, session.description, session.instructions]) control.disabled = session.busy;
  }
  renderProvider(session, replace = true) {
    const data = session.integrations.data;
    if (replace) {
      session.provider.replaceChildren(); const empty = element('option', '', '选择图像服务'); empty.value = ''; session.provider.append(empty);
      for (const row of data?.imageProviders || []) { const option = element('option', '', row.label + (row.available ? '' : ' · 未配置')); option.value = row.id; option.disabled = !row.available; session.provider.append(option); }
      session.provider.value = data?.selectedImageProvider || '';
    }
    const selected = data?.imageProviders.find(row => row.id === session.provider.value);
    session.providerReason.textContent = safeText(selected?.reason || (!data?.imageProviders.length ? '未发现已配置的图像服务' : ''));
    session.providerReason.hidden = !session.providerReason.textContent;
    this.controls(session);
  }
  async applyProvider(session = this.session) {
    if (!this.current(session) || this.readOnly || session.busy || session.providerBusy) return false;
    const data = session.integrations.data, provider = session.provider.value;
    if (!data?.imageProviders.some(row => row.id === provider && row.available) || provider === data.selectedImageProvider) return false;
    const payload = { provider, expectedProvider: data.selectedImageProvider }; payload.operationId = operation(this.providerOperations, payload);
    session.providerBusy = true; session.status.textContent = '正在保存图像服务…'; this.controls(session);
    try {
      await this.api('/api/skill-integrations/image-provider', { method: 'POST', body: payload });
      const confirmed = await session.integrations.load();
      if (confirmed?.selectedImageProvider !== provider) throw Error('Hermes 尚未确认图像服务选择，请刷新后核对。');
      if (this.current(session)) session.status.textContent = '图像服务已保存。'; return true;
    } catch (error) { if (this.current(session)) session.status.textContent = safeText(error.message); return false; }
    finally { session.providerBusy = false; if (this.current(session)) this.controls(session); }
  }
  async create(session = this.session) {
    if (!this.current(session) || this.readOnly || session.busy || session.providerBusy) return false;
    if (!session.integrations.data?.connected) { session.status.textContent = '请先连接 Hermes 并读取工具配置。'; return false; }
    const payload = { name: session.name.value.trim(), description: session.description.value.trim(), instructions: session.instructions.value.trim(), requiredToolsets: [...session.integrations.selected] };
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(payload.name) || !payload.description || !payload.instructions) { session.status.textContent = '请填写名称、说明与指令正文；名称最多 64 位，使用小写字母、数字和连字符。'; return false; }
    if (payload.description.length > 1024 || new TextEncoder().encode(payload.description).byteLength > 2000 || new TextEncoder().encode(payload.instructions).byteLength > 48000) { session.status.textContent = '说明最多 1024 字符且不超过 2000 字节，指令正文最多 48000 字节。'; return false; }
    const signature = JSON.stringify(payload), operationId = operation(this.operations, payload);
    session.busy = true; session.integrations.readOnly = true; session.integrations.render(); session.status.textContent = '正在创建 Skill…'; this.controls(session);
    try {
      if (session.created?.signature !== signature) {
        const result = await this.api('/api/skills', { method: 'POST', body: { ...payload, operationId } });
        if (result.skill?.name !== payload.name || !/^sha256:[a-f0-9]{64}$/i.test(result.skill?.revision || '')) throw Error('Skill 创建结果尚未确认，请按原请求重试。');
        session.created = { signature, skill: result.skill };
      }
      const skill = await this.api('/api/skills/' + encodeURIComponent(payload.name));
      if (skill?.name !== payload.name || skill.revision !== session.created.skill.revision || typeof skill.content !== 'string') throw Error('Skill 读回版本不一致，请刷新后核对。');
      if (!this.current(session)) return false;
      await session.onCreated(skill, { isCurrent: () => this.current(session) }); if (this.current(session)) session.dialog.close(); return true;
    } catch (error) { if (this.current(session)) session.status.textContent = safeText((session.created?.signature === signature ? 'Skill 已创建，读回或选择未完成：' : '') + error.message); return false; }
    finally { session.busy = false; session.integrations.readOnly = false; if (this.current(session)) { session.integrations.render(); this.controls(session); } else session.dialog.remove?.(); }
  }
}
