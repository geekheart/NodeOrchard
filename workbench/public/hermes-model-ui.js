// Hermes owns provider authentication and its global model configuration.
// This controller only presents that configuration and submits explicit changes.
export function hermesModelLabel(current) {
  return [current?.provider, current?.model].filter(Boolean).join(' / ') || 'Hermes 模型';
}

export class HermesModelUI {
  constructor({ api, context, connect, changed = () => {} }) {
    Object.assign(this, { api, context, connect, changed });
    this.data = null; this.loading = false; this.saving = false; this.error = ''; this.message = '';
    this.selection = { provider: '', model: '' };
    this.nodes = Object.fromEntries(['dialog', 'button', 'label', 'current', 'provider', 'model', 'models', 'authentication', 'status', 'refresh', 'connect', 'apply', 'close', 'cancel', 'form'].map(name => [name, document.getElementById(`hermes-model-${name}`)]));
    this.nodes.button.addEventListener('click', () => this.open());
    for (const id of ['setting-hermes-model', 'new-task-model-settings']) document.getElementById(id)?.addEventListener('click', () => this.open());
    for (const name of ['close', 'cancel']) this.nodes[name].addEventListener('click', () => { if (!this.saving) this.nodes.dialog.close(); });
    this.nodes.dialog.addEventListener('cancel', event => { if (this.saving) event.preventDefault(); });
    this.nodes.dialog.addEventListener('close', () => this.render());
    this.nodes.refresh.addEventListener('click', () => this.refresh({ preserveSelection: true }));
    this.nodes.connect.addEventListener('click', async () => {
      try {
        const connected = await this.connect();
        if (connected === false) throw new Error('请检查 Hermes 连接设置后重试。');
        await this.refresh({ preserveSelection: true });
      } catch (error) { this.error = `连接失败：${error.message}`; this.render(); }
    });
    this.nodes.provider.addEventListener('change', () => {
      this.selection.provider = this.nodes.provider.value;
      const provider = this.selectedProvider();
      this.selection.model = provider?.id === this.data?.current?.provider ? this.data.current.model || '' : this.models(provider)[0] || '';
      this.error = ''; this.message = ''; this.render();
    });
    this.nodes.model.addEventListener('input', () => { this.selection.model = this.nodes.model.value; this.error = ''; this.message = ''; this.renderStatus(); });
    this.nodes.form.addEventListener('submit', event => { event.preventDefault(); void this.apply(); });
    this.render();
  }

  models(provider = this.selectedProvider()) {
    return [...new Set((provider?.models || []).map(model => typeof model === 'string' ? model : model?.id).filter(value => typeof value === 'string' && value))];
  }
  selectedProvider() { return this.data?.providers?.find(provider => provider.id === this.selection.provider); }
  current() { return this.data?.current || { provider: this.context().backend?.provider, model: this.context().backend?.model }; }
  label() { return hermesModelLabel(this.current()); }
  async open() {
    if (!this.nodes.dialog.open) this.nodes.dialog.showModal();
    this.error = ''; this.message = '';
    this.render();
    await this.refresh();
  }
  async refresh({ preserveSelection = false } = {}) {
    if (this.loading || this.saving) return;
    this.loading = true; this.error = ''; this.render();
    try {
      const data = await this.api('/api/models');
      this.data = { ...data, providers: Array.isArray(data.providers) ? data.providers : [] };
      if (!preserveSelection || !this.selection.provider) this.selection = { provider: data.current?.provider || '', model: data.current?.model || '' };
      this.changed(this.data);
    } catch (error) { this.error = `模型读取失败：${error.message}`; }
    finally { this.loading = false; this.render(); }
  }
  canApply() {
    const { csrfToken } = this.context(), provider = this.selectedProvider(), model = this.selection.model.trim(), current = this.data?.current;
    return Boolean(csrfToken && this.data?.connected && provider?.authenticated === true && model && !this.loading && !this.saving && (provider.id !== current?.provider || model !== current?.model));
  }
  async apply() {
    if (!this.canApply()) return;
    const selection = { provider: this.selection.provider, model: this.selection.model.trim() };
    this.saving = true; this.error = ''; this.message = ''; this.render();
    try {
      const data = await this.api('/api/models', { method: 'POST', body: selection });
      this.data = { ...data, providers: Array.isArray(data.providers) ? data.providers : [] };
      this.selection = { provider: data.current?.provider || selection.provider, model: data.current?.model || selection.model };
      this.message = 'Hermes 默认模型已更新';
      this.changed(this.data, { applied: true });
    } catch (error) { this.error = `切换失败：${error.message}`; }
    finally { this.saving = false; this.render(); }
  }
  render() {
    const { backend = {}, connecting = false, csrfToken = '' } = this.context(), nodes = this.nodes;
    const label = this.label(); nodes.label.textContent = label;
    nodes.button.title = `切换 Hermes 模型 · ${label}`;
    nodes.button.setAttribute('aria-label', `切换 Hermes 模型，当前 ${label}`);
    nodes.button.setAttribute('aria-expanded', String(nodes.dialog.open));
    nodes.current.textContent = label;
    const providers = [...(this.data?.providers || [])];
    if (this.selection.provider && !providers.some(provider => provider.id === this.selection.provider)) providers.push({ id: this.selection.provider, label: `${this.selection.provider}（当前不可选）`, unavailable: true });
    nodes.provider.replaceChildren();
    if (!providers.length) { const option = document.createElement('option'); option.value = ''; option.textContent = this.loading ? '正在读取…' : '暂无可用服务商'; nodes.provider.append(option); }
    for (const provider of providers) { const option = document.createElement('option'); option.value = provider.id; option.textContent = `${provider.label || provider.id}${provider.authenticated === false ? ' · 未认证' : ''}`; nodes.provider.append(option); }
    nodes.provider.value = this.selection.provider;
    nodes.models.replaceChildren();
    for (const model of this.models()) { const option = document.createElement('option'); option.value = model; nodes.models.append(option); }
    nodes.model.value = this.selection.model;
    const provider = this.selectedProvider();
    nodes.authentication.textContent = provider?.authenticated === false ? '未认证，请在 Hermes 认证后刷新。' : provider?.authenticated === true ? '已认证' : '认证状态未知';
    const blocked = this.loading || this.saving;
    nodes.provider.disabled = blocked || !this.data?.providers?.length;
    nodes.model.disabled = blocked || provider?.authenticated !== true;
    nodes.refresh.disabled = blocked; nodes.refresh.textContent = this.loading ? '读取中…' : '刷新配置';
    nodes.connect.hidden = this.data?.connected === true || backend.state === 'ready';
    nodes.connect.disabled = blocked || connecting || !csrfToken;
    nodes.connect.textContent = connecting ? '连接中…' : '连接 Hermes';
    nodes.close.disabled = this.saving; nodes.cancel.disabled = this.saving;
    nodes.apply.textContent = this.saving ? '应用中…' : '应用到 Hermes';
    this.renderStatus();
  }
  renderStatus() {
    const nodes = this.nodes;
    nodes.apply.disabled = !this.canApply();
    const message = this.error || (this.loading ? '正在读取 Hermes 的实时配置…' : this.message || (!this.data?.connected ? '连接 Hermes 后即可切换模型。' : '服务商与凭据沿用 Hermes，不在工作台单独配置。'));
    nodes.status.textContent = message; nodes.status.className = this.error ? 'error-text' : 'helper';
    nodes.status.setAttribute('role', this.error ? 'alert' : 'status');
  }
}
