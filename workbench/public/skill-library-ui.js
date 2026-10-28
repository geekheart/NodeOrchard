import { safeText } from '../shared/diagnostics.mjs';
import { skillDisplayName, skillVersionLabel } from './workflow-runtime-ui.js';
import { createWorkflowIcon } from './workflow-toolbar-controls.js';

export const SKILL_SOURCE_GROUPS = Object.freeze([
  { kind: 'hermes-builtin', label: 'Hermes 自带' },
  { kind: 'workbench-builtin', label: '工作台内置' },
  { kind: 'generated', label: '后续创建' },
  { kind: 'unknown', label: '其他来源' },
]);
const element = (tag, className = '', text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = safeText(text); return node; };
const button = (label, action, className = 'button quiet small') => { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', action); return node; };

export function skillSource(skill) {
  const group = SKILL_SOURCE_GROUPS.find(row => row.kind === skill?.origin?.kind) || SKILL_SOURCE_GROUPS.at(-1);
  return { ...group, canDelete: group.kind === 'generated' && skill?.origin?.canDelete === true
    && /^sha256:[a-f0-9]{64}$/.test(skill.revision || ''), reason: typeof skill?.origin?.reason === 'string' ? skill.origin.reason.slice(0, 600) : '' };
}

export function workflowReferencesSkill(document, name, seen = new Set(), depth = 0) {
  if (!document || !Array.isArray(document.nodes)) return false;
  if (depth > 8 || seen.has(document)) return true;
  seen.add(document);
  const found = document.nodes.some(node => node.type === 'skill' && node.config?.skillRef === name
    || node.config?.document && workflowReferencesSkill(node.config.document, name, seen, depth + 1));
  seen.delete(document); return found;
}

export function propertyDraftReferencesSkill(drafts, name) {
  return [...(drafts || [])].some(value => {
    const patch = Array.isArray(value) ? value[1] : value;
    return patch?.config?.skillRef === name || workflowReferencesSkill(patch?.config?.document, name);
  });
}

export class SkillLibraryUI {
  constructor({ list, detail, api, onDeleted = async () => {}, draftReferenceReason = () => '', readOnly = false }) {
    Object.assign(this, { list, detail, api, onDeleted, draftReferenceReason, readOnly });
    this.operations = new Map(); this.session = null; this.selected = null;
  }
  render({ skills, selectedName, selected, loading = false }) {
    this.loading = loading;
    this.selected = selected?.name === selectedName ? selected : null;
    if (this.session && !this.session.busy && (this.session.skill.name !== selectedName || this.session.skill.revision !== selected?.revision || this.session.skill.creationId !== selected?.creationId)) this.dismiss();
    const groups = [];
    for (const group of SKILL_SOURCE_GROUPS) {
      const rows = skills.filter(skill => skillSource(skill).kind === group.kind);
      if (!rows.length && group.kind === 'unknown') continue;
      const section = element('section', 'skill-source-group'); section.setAttribute('aria-label', group.label);
      const heading = element('h2', 'skill-source-heading', group.label); heading.append(element('span', 'subtle-label', String(rows.length))); section.append(heading);
      for (const skill of rows) {
        const source = skillSource(skill), item = element('a', `skill-item${skill.name === selectedName ? ' selected' : ''}`);
        item.href = `#/skills/${encodeURIComponent(skill.name)}`;
        const title = element('h3', '', skillDisplayName(skill));
        if (skill.usage === 'assistant') title.append(element('span', 'skill-badge', '应用助手'));
        if (skill.installed === false && skill.usage !== 'assistant') title.append(element('span', 'skill-badge', '未安装'));
        const meta = [skill.enabled === false ? '未启用' : '', source.label, skillVersionLabel(skill)].filter(Boolean).join(' · ');
        item.append(title, element('p', '', skill.description || '未提供说明'), element('span', 'skill-source', meta)); section.append(item);
      }
      groups.push(section);
    }
    if (!skills.length) groups.push(element('p', 'helper skill-empty', '没有匹配的技能'));
    this.list.replaceChildren(...groups);
    if (!this.selected) { this.detail.replaceChildren(element('p', 'helper', selectedName ? selected?.error || '正在读取技能内容…' : '选择一项技能')); return; }
    const skill = this.selected, source = skillSource(skill), header = element('div', 'skill-detail-heading');
    header.append(element('h2', '', skillDisplayName(skill)));
    if (source.canDelete && !this.readOnly) {
      const remove = button('', () => this.requestDelete(skill), 'button quiet small skill-delete-button');
      remove.setAttribute('aria-label', '删除 Skill'); remove.title = '删除 Skill'; remove.append(createWorkflowIcon('trash'));
      remove.disabled = loading || !!this.session?.busy; header.append(remove);
    } else {
      const badge = element('span', 'skill-badge', source.kind.endsWith('-builtin') ? '内置' : '只读'); badge.title = source.reason; header.append(badge);
    }
    const metadata = [source.label, skill.usage === 'assistant' ? '应用助手' : '', skillVersionLabel(skill),
      skillDisplayName(skill) !== skill.name ? skill.name : ''].filter(Boolean).join(' · ');
    this.detail.replaceChildren(header, element('span', 'skill-source mono', metadata), element('p', '', skill.description || ''),
      element('pre', 'skill-content', skill.content || '这项技能未提供正文。'));
  }
  dismiss() {
    if (!this.session) return;
    const session = this.session; this.session = null; session.dialog.close(); session.dialog.remove();
  }
  deactivate() { this.dismiss(); this.selected = null; }
  requestDelete(skill) {
    if (this.readOnly || this.loading || !skillSource(skill).canDelete || this.session?.busy) return;
    this.dismiss();
    const dialog = element('dialog', 'app-dialog skill-delete-dialog'); dialog.setAttribute('aria-label', '删除 Skill');
    const heading = element('h2', '', `删除“${skillDisplayName(skill)}”？`), status = element('p', 'helper'); status.setAttribute('role', 'status');
    const actions = element('div', 'dialog-actions'), cancel = button('取消', () => this.dismiss()), confirm = button('删除', () => void this.remove(session), 'button danger');
    actions.append(cancel, confirm); dialog.append(heading, element('p', 'helper', '历史记录和冻结副本保留。'), status, actions); document.body.append(dialog);
    const session = { skill: structuredClone(skill), dialog, status, confirm, busy: false, confirmed: false };
    this.session = session; dialog.addEventListener('close', () => { if (this.session === session) this.session = null; dialog.remove(); });
    dialog.showModal(); cancel.focus();
  }
  async remove(session) {
    if (this.session !== session || session.busy || session.confirmed || this.loading) return;
    if (this.readOnly || this.selected?.name !== session.skill.name || this.selected.revision !== session.skill.revision || this.selected.creationId !== session.skill.creationId || !skillSource(this.selected).canDelete) { this.dismiss(); return; }
    const reason = this.draftReferenceReason(session.skill.name);
    if (reason) { session.status.textContent = safeText(reason); session.status.className = 'error-text'; return; }
    const payload = { expectedRevision: session.skill.revision, expectedCreationId: session.skill.creationId || null }, key = JSON.stringify([session.skill.name, payload]);
    if (!this.operations.has(key)) {
      if (this.operations.size >= 100) { session.status.textContent = '未确认操作过多，请先刷新并核对结果。'; return; }
      this.operations.set(key, crypto.randomUUID());
    }
    payload.operationId = this.operations.get(key); session.busy = true; session.confirm.disabled = true; session.status.textContent = '正在删除…';
    try {
      const result = await this.api(`/api/skills/${encodeURIComponent(session.skill.name)}/delete`, { method: 'POST', body: payload });
      if (result?.deleted !== true || result.name !== session.skill.name || result.operationId !== payload.operationId) throw Error('删除结果尚未确认，请刷新列表核对。');
      session.confirmed = true; session.status.textContent = '已删除';
      this.operations.delete(key);
      try { await this.onDeleted(result); }
      catch { session.status.textContent = '已删除，列表刷新失败，请手动刷新。'; return; }
      if (this.session === session) this.dismiss();
    } catch (error) { if (this.session === session) { session.status.textContent = safeText(error.message); session.status.className = 'error-text'; } }
    finally { session.busy = false; if (!session.confirmed) session.confirm.disabled = false; }
  }
}
