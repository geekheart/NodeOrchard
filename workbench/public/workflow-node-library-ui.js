import { NODE_GROUPS, NODE_TYPES, createNode, getPorts, validateDocument, updateNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { builtinNodePresets, instantiatePreset, presetDefinitionFromNode, presetParentFromNode } from '../shared/workflow/workflow-presets.mjs';
import { vacantNodePosition, portCompatible } from '../shared/workflow/workflow-studio-utils.mjs';
import * as components from '../shared/workflow/workflow-components.mjs';
import { validationRules } from '../shared/workflow/workflow-validation.mjs';
import { documentFingerprint } from '../shared/workflow/workflow-conversation-commands.mjs';

const el = (tag, className = '', text) => { const item = document.createElement(tag); item.className = className; if (text !== undefined) item.textContent = String(text); return item; };
const button = (title, handler, className = 'wf-button') => { const item = el('button', className, title); item.type = 'button'; item.addEventListener('click', handler); return item; };
const copy = value => structuredClone(value);
const labels = { skill: 'AI / Skill', human: '人工审核 / 补充', output: '产物输出', validation: '校验' };
const labelFor = type => labels[type] || NODE_TYPES.find(item => item.type === type)?.label || type;
const typeFor = type => NODE_TYPES.find(item => item.type === type);
const groupFor = type => NODE_GROUPS.find(group => group.id === typeFor(type)?.category);
const stageLabels = [['foundation', '基础节点'], ['preset', '节点派生'], ['component', '组合节点']];
const parentDescription = parent => parent?.kind === 'foundation' ? `${parent.title || labelFor(parent.baseType)}（基础节点）`
  : ['preset', 'component'].includes(parent?.kind) ? `${parent.title} · v${parent.version}` : '未记录';
const recordParent = record => record.parent || record.definition?.parent || { kind: 'unknown', baseType: record.baseType || record.definition?.node?.type };
const glyphs = { input: 'M14 3H5v18h14V8zM14 3v5h5M9 12h7m-3-3 3 3-3 3', output: 'M14 3H5v18h14V8zM14 3v5h5M9 13h7m-4-3-3 3 3 3', skill: 'M12 5c-3-2-7-2-10-1v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1zM12 5v15', tool: 'm8 5-6 7 6 7m8-14 6 7-6 7M14 3l-4 18', subflow: 'm12 2 10 5-10 5L2 7zM2 12l10 5 10-5M2 17l10 5 10-5', transform: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6', condition: 'm12 2 10 10-10 10L2 12z', foreach: 'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01', loop: 'M20 7H7a4 4 0 0 0-4 4m17-4-4-4m4 4-4 4M4 17h13a4 4 0 0 0 4-4M4 17l4 4m-4-4 4-4', human: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2z', merge: 'M4 4v4l8 5 8-5V4M12 13v7', validation: 'm7 12 3 3 7-7M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', evaluation: 'M5 4v16M19 4v16M5 8h14M5 16h14', improvement: 'M4 17l6-6 4 3 6-9M14 5h6v6' };
function nodeIcon(type) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value); const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', glyphs[type] || glyphs.subflow); svg.append(path); return svg; }

export function validationRuleFromFields(fields) {
  const rule = { valuePath: fields.valuePath.trim(), check: fields.check }; if (fields.message?.trim()) rule.message = fields.message.trim();
  if (rule.check === 'type') rule.expectedType = fields.expectedType;
  if (rule.check === 'equals') {
    const raw = fields.expected;
    if (fields.valueType === 'text') rule.expected = raw;
    else if (fields.valueType === 'number') { if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error('相等比较的期望数字无效。'); rule.expected = Number(raw); }
    else if (fields.valueType === 'boolean') { if (!['true', 'false'].includes(raw.trim())) throw new Error('布尔期望值请填写 true 或 false。'); rule.expected = raw.trim() === 'true'; }
    else if (fields.valueType === 'null') rule.expected = null;
    else { try { rule.expected = JSON.parse(raw); } catch { throw new Error('对象或数组的期望值需要有效 JSON。'); } }
  }
  return validationRules([rule])[0];
}
const validationFields = rule => ({ valuePath: rule.valuePath || '', check: rule.check, expectedType: rule.expectedType || 'text', message: rule.message || '', valueType: rule.expected === null ? 'null' : typeof rule.expected === 'string' || rule.expected === undefined ? 'text' : typeof rule.expected === 'number' ? 'number' : typeof rule.expected === 'boolean' ? 'boolean' : 'json', expected: rule.expected === undefined ? '' : typeof rule.expected === 'string' ? rule.expected : JSON.stringify(rule.expected) });

export function componentBoundaryDescription(document, mapping, direction) {
  const endpoints = direction === 'inputs' ? mapping.targets || [] : [{ nodeId: mapping.sourceNode, portId: mapping.sourcePort }];
  const names = endpoints.map(endpoint => { const node = document.nodes.find(node => node.id === endpoint.nodeId); if (!node) return '待连接节点'; const ports = getPorts(node)[direction === 'inputs' ? 'inputs' : 'outputs']; return [node.title, ports.find(port => port.id === endpoint.portId)?.label || (direction === 'inputs' ? '输入' : '输出')].join(' · '); });
  return `${mapping.type || 'any'} · ${direction === 'inputs' ? '传入' : '来自'}：${names.join('；') || '待连接节点'}`;
}

// This is a reusable node library, not a second execution engine. Every entry
// instantiates the same validated primitive document that the canvas runs.
export class WorkflowNodeLibraryUI {
  constructor(editor) {
    this.editor = editor; this.tab = 'foundation'; this.records = new Map(builtinNodePresets().map(record => [record.id, record])); this.nestedStack = [];
    this.tabs = el('div', 'wf-node-library-tabs'); this.tabs.setAttribute('role', 'group'); this.tabs.setAttribute('aria-label', '节点来源');
    for (const [id, title] of stageLabels) { const item = button(title, () => { this.tab = id; this.render(); }); item.dataset.nodeLibraryTab = id; this.tabs.append(item); }
    editor.root.querySelector('.wf-library-head').append(this.tabs);
    this.breadcrumb = el('div', 'wf-component-breadcrumb'); this.breadcrumb.hidden = true; editor.root.querySelector('.wf-center').prepend(this.breadcrumb);
  }
  get nested() { return this.nestedStack.at(-1); }
  get rootDocument() { return this.nestedStack[0]?.parent || this.editor.doc; }
  cancelNestedForExternalChange() { this.cancelNested(true); }
  resetValidationDrafts(ids) { for (const id of ids) { this.validationBuilderErrors?.delete(id); this.validationBuilderDrafts?.delete(this.editor.doc.id + ':' + id); } }
  isBoundaryNode(id) { const snapshot = this.nested?.parent.nodes.find(node => node.id === this.nested.nodeId)?.config.document; return Boolean(snapshot?.nodes.some(node => node.id === id && ['input', 'output'].includes(node.type))); }
  protectBoundaryInspector(node) {
    if (!this.isBoundaryNode(node.id)) return;
    const parent = this.editor.properties;
    for (const control of parent.querySelectorAll('[name="fieldName"], [name="required"], [name="inputType"], [name="outputType"], [name="stage"], .wf-studio-port-schema input, .wf-studio-port-schema select, .wf-studio-port-schema button, [data-action="delete"], [data-action="duplicate"]')) control.disabled = true;
    const fields = parent.querySelector('.wf-studio-field-schema'); if (fields) fields.hidden = true;
    const note = el('p', 'wf-field-help', '组合接口固定'); parent.insertBefore(note, parent.querySelector('.wf-property-form'));
  }
  api(path, options) { return this.editor.studio.api(path, options); }
  async refresh() {
    if (this.loading) return; this.loading = true;
    try {
      const result = await this.api('/api/workflow-node-presets'), summaries = result.presets || [];
      const fetched = await Promise.all(summaries.filter(item => item.source !== 'builtin').map(async item => { const result = await this.api(`/api/workflow-node-presets/${encodeURIComponent(item.id)}`); return result.preset || result; }));
      const next = new Map(builtinNodePresets().map(record => [record.id, record])); for (const record of fetched) next.set(record.id, record);
      this.records = next; this.loadError = ''; this.render();
    } catch (error) { this.loadError = `个人派生节点读取失败：${error.message}`; this.render(); }
    finally { this.loading = false; }
  }
  entries({ query = '', all = false } = {}) {
    query = query.trim().toLowerCase();
    const entries = [];
    if (all || this.tab === 'foundation') for (const type of NODE_TYPES) entries.push({ key: `type:${type.type}`, type: type.type, title: labelFor(type.type), description: type.description, group: type.category, foundation: true });
    for (const record of this.records.values()) if (all || this.tab === record.kind) entries.push({ key: record.id, type: record.baseType || record.definition?.node?.type, title: record.title, description: record.description || record.definition?.description || '', group: record.source === 'builtin' ? 'builtin' : 'user', record });
    return entries.filter(entry => `${entry.title} ${entry.description} ${entry.type} ${entry.key} ${entry.record ? parentDescription(recordParent(entry.record)) : ''} ${entry.record?.definition?.node?.config?.toolName || ''}`.toLowerCase().includes(query));
  }
  createEntry(entry, position) {
    if (entry.record) return instantiatePreset(entry.record, position);
    return createNode(entry.type, position, { title: entry.title, ...(this.editor.doc.schemaVersion === 2 && ['input', 'skill'].includes(entry.type) ? { config: { outputType: 'object', ...(entry.type === 'skill' ? { inputType: 'object' } : {}) } } : {}), ...(entry.type === 'output' && this.editor.doc.schemaVersion === 2 ? { config: { stage: 'final' } } : {}) });
  }
  render() {
    const editor = this.editor, parent = editor.root.querySelector('.wf-library-items'), query = editor.root.querySelector('.wf-search').value;
    for (const item of this.tabs.children) item.setAttribute('aria-pressed', String(item.dataset.nodeLibraryTab === this.tab));
    parent.replaceChildren();
    const entries = this.entries({ query });
    const groups = this.tab === 'foundation' ? NODE_GROUPS.map(group => [group.id, group.label]) : this.tab === 'component' ? [['user', '我的组合节点'], ['builtin', '内置组合节点']] : [['user', '我的派生节点'], ['builtin', '内置派生节点']];
    for (const [groupId, title] of groups) {
      const matches = entries.filter(entry => entry.group === groupId); if (!matches.length) continue;
      const section = el('section', 'wf-library-group'); section.append(el('h3', '', title));
      for (const entry of matches) {
        const group = groupFor(entry.type), item = el('button', 'wf-library-item'); item.type = 'button'; item.dataset.type = entry.type; item.dataset.category = group?.id || 'capability'; if (entry.record) item.dataset.presetId = entry.record.id;
        item.disabled = editor.libraryReadOnly || !editor.studio.executable(entry.type) || Boolean(entry.record && editor.doc.schemaVersion !== 2) || Boolean(this.nested && ['input', 'output'].includes(entry.type)); item.style.setProperty('--node-color', group?.color || '#a78bfa'); item.setAttribute('aria-label', `添加${entry.title}${entry.foundation ? '节点' : ''}`); if (this.nested && ['input', 'output'].includes(entry.type)) item.title = '组合边界保持固定，请重新封装调整接口。';
        const tile = el('span', 'wf-type-icon'); tile.append(nodeIcon(entry.type));
        const content = el('span'); content.append(el('strong', '', entry.title), el('small', 'wf-library-item-description', entry.description));
        if (entry.record) content.append(el('small', 'wf-preset-meta', `${labelFor(entry.type)} · ${entry.record.source === 'builtin' ? '内置' : '个人'} · v${entry.record.version}`), el('small', 'wf-preset-parent', `派生自：${parentDescription(recordParent(entry.record))}`));
        item.append(tile, content, el('span', 'wf-drag-grip', '⠿')); section.append(item);
      }
      parent.append(section);
    }
    if (!entries.length) { parent.append(el('p', 'wf-library-no-results', '此分类没有匹配项。')); }
    if (this.loadError) { const notice = el('div', 'wf-node-library-notice'); notice.append(el('p', 'wf-field-help', this.loadError), button('重试读取', () => void this.refresh())); parent.append(notice); }
  }
  addPreset(id, position) {
    const editor = this.editor; if (editor.libraryReadOnly || !editor.flushTitleDraft()) return;
    try {
      const record = this.records.get(id); if (!record) throw new Error('派生节点尚未读取，请刷新后重试。'); if (editor.doc.schemaVersion !== 2) throw new Error('请先升级为并行工作流。'); if (this.nested && ['input', 'output'].includes(record.baseType)) throw new Error('组合边界保持固定，请重新封装调整接口。');
      const r = editor.canvas.getBoundingClientRect(), point = position || editor.worldPoint(r.left + r.width / 2, r.top + r.height / 2);
      const sizes = new Map([...editor.nodeElements].map(([id, card]) => [id, { width: card.offsetWidth || 270, height: card.offsetHeight || 180 }]));
      const node = instantiatePreset(record, editor.snapPosition(vacantNodePosition(editor.doc.nodes, { x: point.x - 112, y: point.y - 50 }, sizes)));
      editor.commit({ ...editor.doc, nodes: [...editor.doc.nodes, node] }, record.kind === 'component' ? '添加组合节点' : '添加派生节点'); editor.selectNode(node.id); editor.toast(`已添加 ${record.title} · v${record.version}`); return node;
    } catch (error) { editor.toast(error.message, true); }
  }
  renderInspector(selected) {
    const editor = this.editor, section = el('section', 'wf-property-section wf-node-origin');
    if (selected.length > 1) { const action = button('封装为子流程', () => this.openExtract(), 'wf-button primary'); action.disabled = editor.libraryReadOnly || editor.doc.schemaVersion !== 2; section.append(el('h3', '', '组合与复用'), action); editor.properties.append(section); return; }
    const node = selected[0]; if (!node) return;
    section.append(el('h3', '', '基础与来源')); const list = el('dl', 'wf-node-origin-list');
    const metadata = [['基础节点', labelFor(node.type)], ['来源', node.origin ? `${node.origin.title} · v${node.origin.version}` : node.type === 'tool' && node.config.executionMode === 'tool' ? '内置工具配置' : '基础节点配置']];
    if (node.origin) metadata.push(['派生自', parentDescription(node.origin.parent)]);
    for (const [key, value] of metadata) list.append(el('dt', '', key), el('dd', '', value)); section.append(list);
    const actions = el('div', 'wf-property-actions');
    if (node.config.document && ['subflow', 'foreach', 'loop'].includes(node.type)) {
      actions.append(button('进入子流程', () => this.openNested(node.id))); if (node.type === 'subflow') actions.append(button('展开为节点', () => this.unpack(node.id)));
      section.append(el('p', 'wf-field-help', `${node.config.document.nodes.length} 个内部节点`));
    }
    const save = button(node.type === 'subflow' && node.config.document ? '保存为组合节点' : '派生为特色节点', () => this.openSavePreset(node.id)); save.disabled = editor.libraryReadOnly || editor.doc.schemaVersion !== 2; actions.append(save);
    if (node.origin && this.records.get(node.origin.id)?.source === 'user') { const update = button('发布新版本', () => this.openSavePreset(node.id, true)); update.disabled = save.disabled; actions.append(update); }
    for (const action of actions.children) if (editor.libraryReadOnly) action.disabled = true;
    section.append(actions); const form = editor.properties.querySelector('.wf-property-form'); if (form) editor.properties.insertBefore(section, form); else editor.properties.append(section);
  }
  renderValidationFields(form, node, config) {
    const editor = this.editor, key = editor.doc.id + ':' + node.id; this.validationBuilderErrors ||= new Map(); this.validationBuilderDrafts ||= new Map();
    const section = el('section', 'wf-validation-builder'); section.append(el('h3', '', '校验规则'), el('p', 'wf-field-help', '全部规则通过后传递原始输入。字段路径留空表示检查整个输入；可用 source.name 选择字段。'));
    const rows = el('div', 'wf-validation-rows'), advanced = el('details', 'wf-validation-advanced'); advanced.append(el('summary', '', '高级 · JSON 规则'));
    const raw = editor.validationDraftErrors?.get(node.id)?.raw ?? JSON.stringify(config.rules || [], null, 2), textarea = editor.field(advanced, '规则 JSON', 'validationRules', raw, { multiline: true, code: true, maxLength: 20000 });
    let initial; try { const value = JSON.parse(raw); initial = Array.isArray(value) ? value.map(validationFields) : null; } catch { /* Keep invalid JSON visible in Advanced and use the last accepted builder values. */ }
    let drafts = this.validationBuilderDrafts.get(key) || initial || (config.rules || []).map(validationFields), controls = [], syncing = false;
    if (!initial && editor.validationDraftErrors?.has(node.id)) advanced.open = true;
    const collect = () => controls.map(row => Object.fromEntries(Object.entries(row).map(([name, input]) => [name, input.value])));
    const emit = () => { drafts = collect(); this.validationBuilderDrafts.set(key, copy(drafts)); try { const rules = drafts.map(validationRuleFromFields); if (!rules.length) throw new Error('请至少添加一条校验规则。'); textarea.value = JSON.stringify(rules, null, 2); this.validationBuilderErrors.delete(node.id); } catch (error) { this.validationBuilderErrors.set(node.id, error.message); } syncing = true; textarea.dispatchEvent(new Event('input', { bubbles: true })); syncing = false; };
    const render = () => {
      rows.replaceChildren(); controls = [];
      drafts.forEach((draft, index) => {
        const card = el('section', 'wf-validation-rule'), heading = el('div', 'wf-validation-rule-heading'); heading.append(el('strong', '', `规则 ${index + 1}`)); const remove = button('移除', () => { drafts = collect().filter((_, item) => item !== index); render(); emit(); }, 'wf-button wf-studio-small'); remove.disabled = drafts.length === 1; heading.append(remove); card.append(heading);
        const row = {}, make = (name, title, options) => { const field = el('label', 'wf-validation-field'); field.append(el('span', '', title)); const input = el(options ? 'select' : 'input'); input.setAttribute('aria-label', `规则 ${index + 1} ${title}`); if (options) for (const [value, label] of options) { const option = el('option', '', label); option.value = value; input.append(option); } input.value = draft[name] || ''; if (!options) input.maxLength = name === 'valuePath' ? 4000 : name === 'message' ? 1000 : 4096; field.append(input); card.append(field); row[name] = input; return field; };
        make('valuePath', '字段路径').querySelector('input').placeholder = '留空 = 完整输入';
        make('check', '检查方式', [['required', '必填 · 值必须存在'], ['nonempty', '非空 · 文本或列表不能为空'], ['type', '类型符合要求'], ['equals', '等于指定值']]);
        const typeField = make('expectedType', '要求类型', [['text', '文本'], ['number', '数字'], ['boolean', '布尔值'], ['object', '对象'], ['array', '数组']]);
        const valueType = make('valueType', '期望值类型', [['text', '文本'], ['number', '数字'], ['boolean', '布尔值'], ['null', '空值 null'], ['json', '对象 / 数组 JSON']]), expected = make('expected', '期望值'); make('message', '失败提示（可选）');
        const visibility = () => { typeField.hidden = row.check.value !== 'type'; valueType.hidden = row.check.value !== 'equals'; expected.hidden = row.check.value !== 'equals' || row.valueType.value === 'null'; row.expected.placeholder = row.valueType.value === 'boolean' ? 'true 或 false' : row.valueType.value === 'json' ? '例如 {"ready":true}' : ''; };
        for (const input of Object.values(row)) { input.addEventListener('input', () => { visibility(); emit(); }); input.addEventListener('change', () => { visibility(); emit(); }); } visibility(); controls.push(row); rows.append(card);
      });
    };
    textarea.addEventListener('input', () => { if (!syncing) { this.validationBuilderErrors.delete(node.id); this.validationBuilderDrafts.delete(key); } });
    textarea.addEventListener('change', () => { if (syncing) return; try { const rules = validationRules(JSON.parse(textarea.value)); drafts = rules.map(validationFields); this.validationBuilderDrafts.delete(key); render(); } catch { /* The shared property draft feedback explains invalid advanced rules. */ } });
    section.append(rows, button('添加校验规则', () => { if (drafts.length >= 32) { editor.toast('最多支持 32 条校验规则。', true); return; } drafts = [...collect(), validationFields({ valuePath: '', check: 'required' })]; render(); emit(); }), advanced); form.append(section); render();
  }
  handleClick(item) { return false; }
  flushNodeDrafts() {
    const editor = this.editor; if (!editor.flushTitleDraft()) throw new Error('请填写流程名称。'); if (editor.runtime?.isSkillSelectionPending?.()) throw new Error('请等待 Skill 固定版本读取完成。');
    if (editor.validationDraftErrors?.size) throw new Error('校验规则有无效的 JSON 或字段配置，请先修正。');
    let doc = editor.doc; for (const [id, patch] of editor.propertyDrafts) doc = updateNode(doc, id, patch);
    if (editor.propertyDrafts.size) { editor.propertyDrafts.clear(); editor.commit(doc, '应用节点配置'); }
    return editor.doc;
  }
  openSavePreset(nodeId, update = false) {
    const editor = this.editor; if (editor.libraryReadOnly) return;
    try { this.flushNodeDrafts(); } catch (error) { editor.toast(error.message, true); return; }
    const node = copy(editor.doc.nodes.find(item => item.id === nodeId)); if (!node) return;
    const contextDocumentId = editor.doc.id, session = this.presetDialogSession = {}, origin = update && this.records.get(node.origin?.id), dialog = editor.dialog;
    if (update && (!origin || origin.source !== 'user')) { editor.toast('当前派生节点来源尚未读取，请刷新后重试。', true); return; }
    const caption = update ? '发布节点新版本' : node.type === 'subflow' && node.config.document ? '保存组合节点' : '派生特色节点', parent = origin ? recordParent(origin) : presetParentFromNode(node);
    dialog.replaceChildren(el('h2', '', caption)); dialog.setAttribute('aria-label', caption);
    const form = el('form', 'wf-preset-form'); const title = editor.field(form, '节点名称', 'presetTitle', origin?.title || node.title, { required: true, maxLength: 120 }); const description = editor.field(form, '用途说明', 'presetDescription', origin?.description || '', { multiline: true, maxLength: 2000 });
    const source = el('dl', 'wf-node-origin-list'); source.append(el('dt', '', '派生自'), el('dd', '', parentDescription(parent)), el('dt', '', '基础节点'), el('dd', '', labelFor(node.type))); form.append(source);
    const error = el('p', 'wf-field-feedback'); error.setAttribute('role', 'status'); const actions = el('div', 'wf-dialog-actions'); const cancel = button('取消', () => dialog.close()), save = el('button', 'wf-button primary', update ? '发布新版本' : node.type === 'subflow' && node.config.document ? '保存组合节点' : '保存派生节点'); save.type = 'submit'; actions.append(cancel, save); form.append(error, actions); dialog.append(form);
    form.addEventListener('submit', async event => { event.preventDefault(); if (save.disabled) return;
      if (editor.libraryReadOnly || editor.doc.id !== contextDocumentId || this.presetDialogSession !== session || !dialog.open || !dialog.contains(form)) { error.textContent = '当前流程已变化或为只读，请重新打开节点派生入口。'; error.classList.add('error'); return; }
      save.disabled = true; error.textContent = '';
      try {
        const definition = presetDefinitionFromNode(node, { title: title.value.trim(), description: description.value.trim(), includePaths: false, ...(origin ? { parent } : {}) });
        const result = await this.api('/api/workflow-node-presets' + (origin ? `/${encodeURIComponent(origin.id)}` : ''), { method: 'POST', body: { definition, ...(origin ? { expectedRevision: origin.revision } : {}) } });
        const record = result.preset || result; this.records.set(record.id, record); this.render();
        const currentContext = editor.doc.id === contextDocumentId && this.presetDialogSession === session && dialog.contains(form);
        if (currentContext) { this.tab = record.kind; this.render(); dialog.close(); }
        // The workflow pins this new version only if its originating node still
        // matches the reviewed snapshot; late HTTP responses never overwrite edits.
        const current = editor.doc.nodes.find(item => item.id === nodeId);
        if (currentContext && !editor.libraryReadOnly && current && JSON.stringify(current) === JSON.stringify(node)) editor.commit({ ...editor.doc, nodes: editor.doc.nodes.map(item => item.id === nodeId ? { ...item, origin: { kind: record.kind, id: record.id, version: record.version, title: record.title, baseType: record.baseType, parent: recordParent(record) } } : item) }, '记录节点派生版本');
        if (currentContext) editor.toast(`已保存 ${record.title} · v${record.version}`);
      } catch (caught) { if (editor.doc.id === contextDocumentId && this.presetDialogSession === session && dialog.contains(form)) { error.textContent = caught.message; error.classList.add('error'); save.disabled = false; } }
    }); if (!dialog.open) dialog.showModal(); title.focus();
  }
  openExtract() {
    const editor = this.editor; if (editor.libraryReadOnly) return;
    try {
      const doc = this.flushNodeDrafts(), ids = [...editor.selection], analysis = components.analyzeSelection(doc, ids), dialog = editor.dialog;
      dialog.replaceChildren(el('h2', '', '封装为子流程')); dialog.setAttribute('aria-label', '封装为子流程');
      const form = el('form', 'wf-component-form'), title = editor.field(form, '组合名称', 'componentTitle', '新的组合节点', { required: true, maxLength: 120 });
      form.append(el('p', 'wf-field-help', `已选中 ${ids.length} 个节点。不支持封装学习目标或跨运行产物回执。`));
      const mappings = {};
      for (const [direction, caption] of [['inputs', '对外输入'], ['outputs', '对外输出']]) {
        const section = el('section', 'wf-component-ports'); section.append(el('h3', '', caption)); mappings[direction] = [];
        for (const [index, mapping] of analysis[direction].entries()) { const row = el('div', 'wf-component-port'); row.append(el('span', '', mapping.label || `${caption} ${index + 1}`)); const input = el('input'); input.value = mapping.label || `${caption} ${index + 1}`; input.required = true; input.maxLength = 120; input.setAttribute('aria-label', `${caption} ${index + 1} 名称`); row.append(input, el('small', 'wf-field-help', componentBoundaryDescription(doc, mapping, direction))); section.append(row); mappings[direction].push({ mapping, input }); }
        if (!analysis[direction].length) section.append(el('p', 'wf-field-help', '没有跨选区连线。')); form.append(section);
      }
      const error = el('p', 'wf-field-feedback'), actions = el('div', 'wf-dialog-actions'), submit = el('button', 'wf-button primary', '封装并保留连线'); submit.type = 'submit'; actions.append(button('取消', () => dialog.close()), submit); form.append(error, actions); dialog.append(form);
      form.addEventListener('submit', event => { event.preventDefault(); try { if (editor.doc !== doc) throw new Error('画布已变化，请重新选择节点封装。'); const result = components.extractSelection(doc, ids, { title: title.value.trim(), inputs: mappings.inputs.map(({ mapping, input }) => ({ ...mapping, label: input.value.trim() })), outputs: mappings.outputs.map(({ mapping, input }) => ({ ...mapping, label: input.value.trim() })) }); editor.commit(result.document, '封装为子流程'); editor.selectNode(result.node.id); dialog.close(); editor.toast('已封装。'); } catch (caught) { error.textContent = caught.message; error.classList.add('error'); } });
      if (!dialog.open) dialog.showModal(); title.focus();
    } catch (error) { editor.toast(error.message, true); }
  }
  unpack(id) { if (this.editor.libraryReadOnly) return; try { this.flushNodeDrafts(); const result = components.unpackSubflow(this.editor.doc, id); this.editor.commit(result.document || result, '展开子流程'); this.editor.toast('已展开为基础节点，外部连线已映射。'); } catch (error) { this.editor.toast(error.message, true); } }
  openNested(id) {
    const editor = this.editor; if (editor.libraryReadOnly) return;
    try {
      const parent = this.flushNodeDrafts(), node = parent.nodes.find(item => item.id === id); if (!node?.config.document) throw new Error('此节点尚未保存子流程快照。');
      if (this.nestedStack.length >= 7) throw new Error('最多进入 7 层内部编辑。');
      if (editor.cancelAutosave) editor.cancelAutosave(); else clearTimeout(editor.saveTimer); editor.cancelGesture(); editor.cancelConnection();
      this.nestedStack.push({ parent, nodeId: id, state: editor.captureDocumentState(), runStates: editor.runStates, validationDraftErrors: editor.validationDraftErrors, unsaved: editor.unsaved, storageKey: editor.storageKey, storageValue: editor.storageValue, studioView: editor.studio.view, pendingFitDocumentId: editor.pendingFitDocumentId });
      editor.doc = validateDocument(copy(node.config.document)); editor.history = []; editor.future = []; editor.selection.clear(); editor.selectedEdge = null; editor.propertyDrafts.clear(); editor.validationDraftErrors = new Map(); editor.runStates = {}; editor.titleDraft = null; editor.unsaved = false; editor.pendingFitDocumentId = null;
      editor.studio.setView('edit'); this.paintNested();
      if (editor.requestDocumentFit) editor.requestDocumentFit();
      else { const child = editor.doc; requestAnimationFrame(() => { if (editor.doc === child) editor.fit(); }); }
    } catch (error) { editor.toast(error.message, true); }
  }
  restoreParent(session) {
    const editor = this.editor; if (editor.cancelAutosave) editor.cancelAutosave(); else clearTimeout(editor.saveTimer); editor.cancelGesture(); editor.cancelConnection(); editor.doc = session.parent; editor.history = copy(session.state.history); editor.future = copy(session.state.future); editor.selection = new Set(session.state.selection); editor.selectedEdge = session.state.selectedEdge; editor.propertyDrafts = new Map(copy(session.state.propertyDrafts)); editor.validationDraftErrors = session.validationDraftErrors; editor.runStates = session.runStates; editor.unsaved = session.unsaved; editor.titleDraft = null; editor.storageKey = session.storageKey; editor.storageValue = session.storageValue; editor.pendingFitDocumentId = session.pendingFitDocumentId;
  }
  async applyNested() {
    const session = this.nested; if (!session) return;
    try {
      const document = this.flushNodeDrafts(), previous = session.parent.nodes.find(node => node.id === session.nodeId)?.config.document;
      if (documentFingerprint(document) === documentFingerprint(previous)) { this.nestedStack.pop(); this.restoreParent(session); this.paintNested(); if (!this.nested && this.editor.unsaved) this.editor.scheduleSave(); return; }
      const child = this.editor.persistenceDocument?.(document) || copy(document), next = await components.updateEmbeddedWorkflow(session.parent, session.nodeId, child);
      if (this.nested !== session) return;
      this.nestedStack.pop(); this.restoreParent(session); this.editor.commit(next, '修改子流程内部节点'); this.paintNested(); this.editor.toast('内部修改已应用到当前流程。');
    }
    catch (error) { this.editor.toast(error.message, true); }
  }
  cancelNested(all = false) { if (!this.nested) return; do { const session = this.nestedStack.pop(); this.restoreParent(session); } while (all && this.nested); this.paintNested(); if (!all && !this.nested && this.editor.unsaved) this.editor.scheduleSave(); }
  paintNested() { const editor = this.editor; this.render(); editor.renderGraph(); editor.renderProperties(); editor.renderHeader(); editor.requestGeometry(); this.syncHeader(); }
  syncHeader() {
    const editor = this.editor; this.breadcrumb.hidden = !this.nested;
    if (this.nested) { this.breadcrumb.replaceChildren(el('span', 'wf-component-path', [this.nestedStack[0].parent.title, ...this.nestedStack.map(session => session.parent.nodes.find(node => node.id === session.nodeId)?.title || '子流程')].join(' / ')), el('span', 'wf-field-help', `${editor.unsaved ? '内部修改未应用' : '固定快照 · 内部编辑'} · 对外输入输出保持固定`), button('取消内部修改', () => this.cancelNested()), button('应用并返回上层', () => void this.applyNested(), 'wf-button primary')); }
    for (const action of ['run', 'schedules', 'new', 'import', 'export', 'board']) { const item = editor.root.querySelector(`[data-action="${action}"]`); if (!item) continue; if (this.nested) { if (!item.dataset.componentDisabled) item.dataset.componentDisabled = item.disabled ? 'yes' : 'no'; item.disabled = true; } else if (item.dataset.componentDisabled) { item.disabled = item.dataset.componentDisabled === 'yes'; delete item.dataset.componentDisabled; } }
    const runView = editor.studio.viewSwitch?.children[1]; if (runView) runView.disabled = Boolean(this.nested);
    if (this.nested) { editor.studio.check.disabled = true; editor.root.querySelector('.wf-save-status').textContent = editor.unsaved ? '内部修改待应用' : '编辑子流程固定快照'; }
  }
  openSearch(clientX, clientY, origin = null, edge = null) {
    const editor = this.editor, menu = editor.contextMenu, bounds = editor.canvas.getBoundingClientRect(), point = editor.worldPoint(clientX, clientY); editor.cancelConnection(); menu.replaceChildren(el('strong', '', edge ? '在线中插入节点' : origin ? '连接兼容节点' : '添加节点'));
    const search = el('input'); search.type = 'search'; search.placeholder = '搜索基础节点、派生节点或组合…'; search.setAttribute('aria-label', '搜索要添加的节点'); const list = el('div', 'wf-context-items'); menu.append(search, list);
    const sourceNode = origin && editor.doc.nodes.find(node => node.id === origin.node), sourcePort = sourceNode && getPorts(sourceNode)[origin.direction === 'output' ? 'outputs' : 'inputs'].find(port => port.id === origin.port);
    const render = () => { list.replaceChildren();
      for (const entry of this.entries({ query: search.value, all: true })) {
        if (!editor.studio.executable(entry.type) || entry.record && editor.doc.schemaVersion !== 2 || this.nested && ['input', 'output'].includes(entry.type)) continue;
        let candidate; try { candidate = this.createEntry(entry, point); candidate = validateDocument({ ...editor.doc, nodes: [...editor.doc.nodes, candidate] }).nodes.at(-1); } catch { continue; }
        const ports = getPorts(candidate), direction = origin?.direction === 'output' ? 'inputs' : 'outputs'; if (origin && !ports[direction].some(port => port.id !== 'learning' && portCompatible(port.type, sourcePort?.type))) continue;
        const source = edge && getPorts(editor.doc.nodes.find(node => node.id === edge.sourceNode)).outputs.find(port => port.id === edge.sourcePort), target = edge && getPorts(editor.doc.nodes.find(node => node.id === edge.targetNode)).inputs.find(port => port.id === edge.targetPort);
        if (edge && (!ports.inputs.some(port => portCompatible(source.type, port.type)) || !ports.outputs.some(port => port.id !== 'learning' && portCompatible(port.type, target.type)))) continue;
        const caption = `${entry.title}${entry.record ? ` · v${entry.record.version}` : ' · 基础'}`, choose = button(caption, () => {
          try { if (editor.libraryReadOnly) return; let next = { ...editor.doc, nodes: [...editor.doc.nodes, candidate] }; if (origin) { const port = ports[direction].find(port => port.id !== 'learning' && portCompatible(port.type, sourcePort.type)); next = connectNodes(next, origin.direction === 'output' ? { sourceNode: origin.node, sourcePort: origin.port, targetNode: candidate.id, targetPort: port.id } : { sourceNode: candidate.id, sourcePort: port.id, targetNode: origin.node, targetPort: origin.port }); } if (edge) { next.edges = next.edges.filter(item => item.id !== edge.id); next = connectNodes(next, { sourceNode: edge.sourceNode, sourcePort: edge.sourcePort, targetNode: candidate.id, targetPort: ports.inputs.find(port => portCompatible(source.type, port.type)).id }); next = connectNodes(next, { sourceNode: candidate.id, sourcePort: ports.outputs.find(port => port.id !== 'learning' && portCompatible(port.type, target.type)).id, targetNode: edge.targetNode, targetPort: edge.targetPort }); } editor.commit(next, '添加并连接节点'); editor.selectNode(candidate.id); menu.hidden = true; } catch (error) { editor.toast(error.message, true); }
        });
        if (entry.record) { const label = el('span'); label.append(el('span', '', caption), el('br'), el('small', 'wf-field-help', `派生自：${parentDescription(recordParent(entry.record))}`)); choose.replaceChildren(label); }
        list.append(choose);
      }
      if (!list.childElementCount) list.append(el('p', 'wf-field-help', '没有兼容节点。可先添加节点再配置端口。'));
    }; search.addEventListener('input', render); render(); menu.hidden = false; menu.style.left = `${Math.max(8, Math.min(clientX - bounds.left, bounds.width - 300))}px`; menu.style.top = `${Math.max(54, Math.min(clientY - bounds.top, bounds.height - 400))}px`; search.focus();
  }
}
