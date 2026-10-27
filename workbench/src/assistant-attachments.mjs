const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };
export const ATTACHMENT_MESSAGE_TEXT = '请查看这些素材。';
export function attachmentRefs(value = []) {
  if (!Array.isArray(value) || value.length > 8) fail('每条消息最多附加 8 个素材。');
  const seen = new Set();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || ![Object.prototype, null].includes(Object.getPrototypeOf(row))
      || Reflect.ownKeys(row).some(key => !['id', 'workflowId'].includes(key))
      || Object.values(Object.getOwnPropertyDescriptors(row)).some(field => !Object.hasOwn(field, 'value'))
      || !ID.test(row.id || '') || !ID.test(row.workflowId || '') || ['__proto__', 'constructor', 'prototype'].includes(row.workflowId)) fail('素材引用格式无效。');
    const key = row.workflowId + '/' + row.id; if (seen.has(key)) fail('素材引用不能重复。'); seen.add(key);
    return { id: row.id, workflowId: row.workflowId };
  });
}
export const storedAttachmentRefs = value => attachmentRefs((value || []).map(({ id, workflowId }) => ({ id, workflowId })));
export async function resolveAssistantAttachments(app, value, { role, workflowId, document, permissionScope } = {}) {
  const refs = attachmentRefs(value); if (!refs.length) return [];
  if (!app.workflowAttachments) fail('工作流素材功能暂不可用。', 503);
  const target = refs[0].workflowId;
  if (refs.some(row => row.workflowId !== target) || workflowId && workflowId !== target) fail('本条消息的素材必须属于指定的同一工作流。', 403);
  const permissions = app.applicationAssistant.permissions;
  const scope = permissionScope || await permissions.bind({ role, workflowId: workflowId || target, document });
  permissions.workflow(target, scope);
  if (!scope.permissions.workflowRead || !scope.permissions.workspaceRead) fail('当前助手未获准读取工作流素材。', 403);
  const materials = await app.workflowAttachments.resolve(target, refs);
  if (materials.reduce((total, item) => total + item.size, 0) > 64 * 1024 * 1024) fail('每条消息的素材总大小不能超过 64 MB。', 413);
  const images = materials.filter(item => /^image\/(?:png|jpeg|webp|gif)$/.test(item.mimeType));
  if (images.length > 4) fail('每条消息最多分析 4 张图片。');
  if (images.some(item => item.size > 8 * 1024 * 1024) || images.reduce((total, item) => total + item.size, 0) > 16 * 1024 * 1024) fail('AI 图片分析限制为每张 8 MB、合计 16 MB；素材仍可用作工作流输入。', 413);
  for (const item of materials) await permissions.path(item.path, scope, { material: { workflowId: target } });
  await permissions.current(scope);
  return materials;
}
export async function attachmentModelSource(app, materials) {
  let remaining = 6000;
  const source = [];
  for (const item of materials) {
    const { id, workflowId, name, path, relativePath, sha256, size, mimeType } = item;
    const row = { id, workflowId, name, path, relativePath, sha256, size, mimeType };
    if (remaining > 0 && !/^image\//.test(mimeType)) {
      const preview = await app.workflowAttachments.read(workflowId, id, { limit: Math.min(2048, remaining) });
      if (preview.contentAvailable) { row.textPreview = preview.text.slice(0, remaining); remaining -= row.textPreview.length; row.truncated = preview.truncated; }
      else row.contentAvailable = false;
    }
    source.push(row);
  }
  return source;
}
export function attachmentImageOptions(app, materials) {
  const userImages = materials.filter(item => /^image\/(?:png|jpeg|webp|gif)$/.test(item.mimeType)).map(item => item.path);
  if (!userImages.length) return {};
  return { userImages,
    attachmentRoot: app.workflowFolders.directory(materials[0].workflowId) };
}
