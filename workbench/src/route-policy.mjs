// Hermes owns provider authentication, endpoint resolution and fallback routing.
// Retain interactive tool approvals independently of the selected model provider.
const ALLOWED_APPROVAL_MODES = new Set(['manual', 'smart']);
const policyError = (code, message) => Object.assign(new Error(message), { code });

export async function assertHermesPolicy(adapter) {
  if (!adapter || typeof adapter.request !== 'function') {
    throw policyError('POLICY_ADAPTER_UNAVAILABLE', '无法核验审批策略：Hermes 后端不可用。');
  }
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
  return Object.freeze({ approvalMode });
}
