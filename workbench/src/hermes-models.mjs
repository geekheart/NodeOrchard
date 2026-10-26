const empty = () => ({ connected: false, current: { provider: '', model: '' }, providers: [] });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0
  && value.trim().length <= limit && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
const error = (code, message, httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus });

function selection(value) {
  if (!record(value) || Object.keys(value).some(key => !['provider', 'model'].includes(key))) {
    throw error('MODEL_SELECTION_INVALID', '请选择有效的 Hermes 提供商和模型。');
  }
  const provider = text(value.provider, 128), model = text(value.model, 256);
  if (!provider || !model) throw error('MODEL_SELECTION_INVALID', '请选择有效的 Hermes 提供商和模型。');
  return { provider, model };
}

// The browser gets model identities only. Endpoint, pricing, key hints and future
// upstream extensions never pass through this boundary.
function project(payload) {
  if (!record(payload) || !Array.isArray(payload.providers) || payload.providers.length > 512) {
    throw error('MODEL_CATALOG_UNAVAILABLE', '无法读取 Hermes 模型目录，请刷新连接后重试。', 503);
  }
  const providers = [], seen = new Set();
  for (const row of payload.providers) {
    if (!record(row)) continue;
    const id = text(row.slug, 128);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const models = Array.isArray(row.models) ? [...new Set(row.models.map(value => text(value, 256)).filter(Boolean))].slice(0, 10000) : [];
    providers.push({ id, label: text(row.name, 256) || id, models,
      authenticated: typeof row.authenticated === 'boolean' ? row.authenticated : null });
  }
  const provider = text(payload.provider, 128), model = text(payload.model, 256);
  return { connected: true, current: { provider, model }, providers };
}

export class HermesModels {
  constructor(adapter) { this.adapter = adapter; this.pending = Promise.resolve(); }

  enqueue(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  async readCatalog() {
    if (this.adapter.state !== 'ready') return empty();
    let payload;
    try { payload = await this.adapter.request('model.options', { explicit_only: true, include_unconfigured: false }); }
    catch { throw error('MODEL_CATALOG_UNAVAILABLE', '无法读取 Hermes 模型目录，请刷新连接后重试。', 503); }
    if (this.adapter.state !== 'ready') return empty();
    return project(payload);
  }

  read() { return this.enqueue(() => this.readCatalog()); }

  set(value) {
    return this.enqueue(async () => {
      const requested = selection(value), catalog = await this.readCatalog();
      if (!catalog.connected) throw error('MODEL_BACKEND_UNAVAILABLE', '请先连接 Hermes。', 503);
      const provider = catalog.providers.find(row => row.id === requested.provider);
      if (!provider || provider.authenticated !== true) {
        throw error('MODEL_PROVIDER_UNAVAILABLE', '请先在 Hermes 配置并登录此提供商，再刷新模型目录。');
      }
      let result;
      try { result = await this.adapter.request('workbench.model.set', requested); }
      catch (cause) {
        if (cause?.code === 4303) throw error('MODEL_NATIVE_CONFIRMATION_REQUIRED', '该模型需要在 Hermes 原生界面确认选择，请在那里完成后刷新。', 409);
        throw error('MODEL_SELECTION_FAILED', 'Hermes 未确认模型切换，请刷新当前选择后重试。', 503);
      }
      let confirmed;
      try { confirmed = selection(result); }
      catch { throw error('MODEL_SELECTION_UNCONFIRMED', 'Hermes 未确认保存结果，请刷新当前选择后核对。', 503); }
      if (confirmed.provider !== requested.provider || confirmed.model !== requested.model) {
        throw error('MODEL_SELECTION_UNCONFIRMED', 'Hermes 返回的选择与请求不一致，请刷新当前选择后核对。', 503);
      }
      const updated = await this.readCatalog();
      if (!updated.connected || updated.current.provider !== confirmed.provider || updated.current.model !== confirmed.model) {
        throw error('MODEL_SELECTION_UNCONFIRMED', '模型可能已经保存，但读回尚未确认，请刷新当前选择后核对。', 503);
      }
      return updated;
    });
  }
}
