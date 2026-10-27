import { createNode, updateNode, validateDocument } from '../shared/workflow/workflow-model.mjs';
import { workflowInputFields, workflowInputValue } from '../shared/workflow/workflow-inputs.mjs';
import { documentFingerprint } from '../shared/workflow/workflow-conversation-commands.mjs';

const raster = item => /^image\/(?:png|jpeg|webp|gif)$/.test(item.mimeType || '');
export function attachmentInputChoices(document, attachment) {
  if (document.id !== attachment.workflowId) throw Error('素材不属于当前工作流。');
  return document.nodes.filter(node => node.type === 'input').flatMap(node => workflowInputFields(node)
    .filter(field => (field.kind === 'file' || field.kind === 'image' && raster(attachment))
      && (!field.extensions?.length || field.extensions.some(extension => attachment.path.toLowerCase().endsWith(extension))))
    .map(field => ({ value: node.id + ':' + field.key, label: node.title + ' · ' + field.label })));
}
export function bindAttachmentInput(document, attachment, target = 'new') {
  if (document.id !== attachment.workflowId || typeof attachment.path !== 'string' || !/^(?:\/|[A-Za-z]:[\\/])/.test(attachment.path)) throw Error('素材不属于当前工作流或缺少有效路径。');
  let next;
  if (target === 'new') {
    const node = createNode('input', { x: 80, y: 80 + document.nodes.filter(node => node.type === 'input').length * 200 }, {
      title: attachment.name.slice(0, 100), config: { outputType: 'object', fieldName: 'material_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12),
        fields: [{ key: 'file', label: attachment.name.slice(0, 100), kind: raster(attachment) ? 'image' : 'file', required: true }], defaultValue: { file: attachment.path } },
    });
    next = { ...document, nodes: [...document.nodes, node] };
  } else {
    if (!attachmentInputChoices(document, attachment).some(choice => choice.value === target)) throw Error('输入字段已变化或不接受此素材。');
    const [id, key] = target.split(':'), node = document.nodes.find(node => node.id === id), current = workflowInputValue(document, undefined, node);
    const fields = workflowInputFields(node), defaults = current && typeof current === 'object' && !Array.isArray(current) ? structuredClone(current)
      : fields.length === 1 && current !== undefined ? { [key]: current } : {};
    defaults[key] = attachment.path;
    next = updateNode(document, id, { config: { ...node.config, defaultValue: defaults,
      ...(!node.config.fields?.length && node.config.sourceKind ? { path: attachment.path } : {}) } });
  }
  return validateDocument(next);
}
export function openAttachmentInput(editor, attachment) {
  if (editor.libraryReadOnly || editor.documentLoaded === false || editor.nodeLibrary?.nested) throw Error('请先打开可编辑的主工作流。');
  const fingerprint = documentFingerprint(editor.doc), choices = attachmentInputChoices(editor.doc, attachment);
  const dialog = editor.openDialog('用作输入', ''), select = document.createElement('select'); select.setAttribute('aria-label', '素材输入位置');
  for (const choice of [...choices, { value: 'new', label: '新增输入节点' }]) { const option = document.createElement('option'); option.value = choice.value; option.textContent = choice.label; select.append(option); }
  const selected = choices.find(choice => editor.selection?.has(choice.value.split(':')[0])); select.value = selected?.value || 'new';
  const name = document.createElement('p'); name.textContent = attachment.name;
  const actions = document.createElement('div'); actions.className = 'wf-dialog-actions';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'wf-button'; cancel.textContent = '取消'; cancel.addEventListener('click', () => dialog.close());
  const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'wf-button primary'; apply.textContent = '设为输入';
  apply.addEventListener('click', () => {
    try {
      if (editor.doc.id !== attachment.workflowId || documentFingerprint(editor.doc) !== fingerprint || editor.libraryReadOnly || editor.nodeLibrary?.nested) throw Error('工作流已变化，请重新选择素材输入。');
      const document = editor.prepareRun({ operation: '设置素材输入' });
      const next = bindAttachmentInput(document, attachment, select.value);
      if (editor.commit(next, '设置素材输入') === false) throw Error('素材输入未保存。');
      dialog.close(); editor.toast('已设为工作流输入。');
    } catch (error) { editor.toast(error.message, true); }
  });
  actions.append(cancel, apply); dialog.append(name, select, actions); return dialog;
}
