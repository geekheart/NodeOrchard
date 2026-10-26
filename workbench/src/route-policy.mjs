const SUBSCRIPTION_PROVIDER = 'openai-codex';
// Local Hermes: hermes_cli/approval_mode.py and tools/approval_context.py.
const ALLOWED_APPROVAL_MODES = new Set(['manual', 'smart']);

function policyError(code, message) {
  // Never attach an upstream error, config object, or untrusted config value.
  return Object.assign(new Error(message), { code });
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fallbackCountFrom(result, provider) {
  if (!record(result) || !record(result.config)) {
    throw policyError('POLICY_CONFIG_INVALID', '无法核验 Hermes 的 fallback 配置，已停止提交。');
  }

  // config.get(full) may contain secrets. Inspect only the two fallback roots,
  // synchronously, and return a count; retain no config/entry objects afterwards.
  const seen = new Set();
  for (const key of ['fallback_providers', 'fallback_model']) {
    const raw = result.config[key];
    if (raw === undefined || raw === null) continue;
    const entries = Array.isArray(raw) ? raw : record(raw) ? [raw] : null;
    if (entries === null) {
      throw policyError('FALLBACK_CONFIG_INVALID', 'Hermes fallback 配置格式无法确认；请移除或修正后再试。');
    }
    for (const entry of entries) {
      if (!record(entry)
          || typeof entry.provider !== 'string' || !entry.provider.trim()
          || typeof entry.model !== 'string' || !entry.model.trim()) {
        throw policyError('FALLBACK_ROUTE_UNKNOWN', 'Hermes fallback 含有未知路由或缺少 provider / model，已停止提交。');
      }
      if (entry.provider.trim().toLowerCase() !== provider) {
        throw policyError('FALLBACK_PROVIDER_NOT_ALLOWED', 'Hermes 配置了非 ChatGPT 订阅路由的 fallback；请停用该 fallback 后再试。');
      }
      // Match fallback_config.py's merge order and provider/model/base_url identity.
      // The identity remains local and is never returned, logged, or put in errors.
      const baseURL = typeof entry.base_url === 'string' ? entry.base_url.trim().replace(/\/+$/, '') : '';
      seen.add(JSON.stringify([provider, entry.model.trim().toLowerCase(), baseURL.toLowerCase()]));
    }
  }
  return seen.size;
}

async function readFallbackCount(adapter, provider) {
  let result;
  try {
    result = await adapter.request('config.get', { key: 'full' });
  } catch {
    throw policyError('POLICY_CONFIG_UNAVAILABLE', '无法读取 Hermes fallback 策略，已停止提交；请检查后端连接。');
  }
  try {
    return fallbackCountFrom(result, provider);
  } finally {
    // Release the only local reference before the next asynchronous operation.
    result = undefined;
  }
}

/**
 * Read-only, fail-closed guard for the workbench's ChatGPT subscription route.
 *
 * Checks both current and legacy fallback roots (dict or list); unlike Hermes's
 * permissive normalizer, malformed entries are rejected rather than ignored.
 * Only manual/smart approval modes are accepted. No config or credentials leave
 * this module, including through errors. The caller must rerun before each turn
 * if changes to live Hermes configuration need to be caught.
 *
 * @returns {Promise<{provider: string, approvalMode: 'manual'|'smart', fallbackCount: number}>}
 * A frozen, non-secret summary. fallbackCount is the deduplicated effective chain
 * length across fallback_providers followed by legacy fallback_model.
 */
export async function assertSubscriptionPolicy(adapter, provider = SUBSCRIPTION_PROVIDER) {
  if (typeof provider !== 'string' || provider.trim().toLowerCase() !== SUBSCRIPTION_PROVIDER) {
    throw policyError('SUBSCRIPTION_PROVIDER_REQUIRED', '此工作台仅允许已确认的 ChatGPT 订阅提供商。');
  }
  if (!adapter || typeof adapter.request !== 'function') {
    throw policyError('POLICY_ADAPTER_UNAVAILABLE', '无法核验订阅路由策略：Hermes 后端不可用。');
  }
  const fallbackCount = await readFallbackCount(adapter, SUBSCRIPTION_PROVIDER);
  let approval;
  try {
    approval = await adapter.request('config.get', { key: 'approvals.mode' });
  } catch {
    throw policyError('POLICY_APPROVAL_UNAVAILABLE', '无法读取 Hermes 审批策略，已停止提交；请检查后端连接。');
  }
  const approvalMode = typeof approval?.value === 'string' ? approval.value.trim().toLowerCase() : '';
  if (!ALLOWED_APPROVAL_MODES.has(approvalMode)) {
    throw policyError('POLICY_APPROVAL_REQUIRED', 'Hermes 审批模式必须为 manual 或 smart；关闭或未知模式不能提交任务。');
  }
  return Object.freeze({ provider: SUBSCRIPTION_PROVIDER, approvalMode, fallbackCount });
}
