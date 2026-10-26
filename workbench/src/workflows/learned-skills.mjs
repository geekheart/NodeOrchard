import { createHash, randomUUID } from 'node:crypto';
import { readSkill } from '../catalog.mjs';

const REF = /^wb-learn-[a-f0-9-]{36}$/;
const fail = (message, httpStatus = 400) => Object.assign(new Error(message), { httpStatus });
export const skillRevision = content => 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
export function skillFrontmatter(content) {
  const normalized = content.replace(/\r\n?/g, '\n');
  const bom = normalized.startsWith('\uFEFF') ? '\uFEFF' : '';
  const probe = bom ? normalized.slice(1) : normalized;
  const end = probe.startsWith('---') ? /\n---[ \t]*\n/.exec(probe.slice(3)) : null;
  return end ? bom + probe.slice(0, 3 + end.index + end[0].length) : '';
}

// Only the SKILL.md instruction is versioned here. The original Hermes bundle
// remains the resource source and is independently audited by the gateway.
export class LearnedSkills {
  constructor(app) {
    this.app = app;
    this.db = app.store.db;
    this.db.exec('CREATE TABLE IF NOT EXISTS learned_skills (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.write = this.db.prepare('INSERT INTO learned_skills(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value');
  }
  has(name) { return typeof name === 'string' && name.startsWith('wb-learn-'); }
  get(name) {
    if (!REF.test(name || '')) throw fail('学习 Skill 引用无效。', 404);
    const row = this.db.prepare('SELECT value FROM learned_skills WHERE id=?').get(name);
    if (!row) throw fail('学习 Skill 版本不存在。', 404);
    const skill = JSON.parse(row.value);
    if (skill.name !== name || skill.ref !== name || skillRevision(skill.content) !== skill.revision) throw fail('学习 Skill 版本完整性检查失败。', 409);
    return skill;
  }
  async resolve(name) {
    const skill = this.get(name);
    const base = await readSkill(this.app.adapter, skill.baseName);
    if (base.revision !== skill.baseRevision) throw fail('原 Skill 已变化；请用当前版本重新学习。', 409);
    return skill;
  }
  create(base, { content, learningId, nodeId, parentRef } = {}) {
    if (typeof content !== 'string' || !content.trim() || content.includes('\0') || Buffer.byteLength(content, 'utf8') > 64 * 1024) {
      throw fail('候选 Skill 正文必须是非空文本，且不能超过 64 KiB。');
    }
    content = content.replace(/\r\n?/g, '\n');
    if (!base || typeof base.content !== 'string' || skillRevision(base.content) !== base.revision) throw fail('候选 Skill 缺少有效原版本。');
    if (skillFrontmatter(content) !== skillFrontmatter(base.content)) throw fail('学习只能修改 Skill 指令正文，不能修改 frontmatter 元配置。');
    if (content.trim() === skillFrontmatter(content).trim()) throw fail('候选 Skill 缺少指令正文。');
    const name = 'wb-learn-' + randomUUID();
    const result = { name, ref: name, content, revision: skillRevision(content), source: 'learned',
      baseName: base.baseName || base.name, baseRevision: base.baseRevision || base.revision,
      parentRef: parentRef || base.name, description: '学习版本 · ' + (base.baseName || base.name), category: '学习版本',
      learningId, nodeId, createdAt: new Date().toISOString(), published: false, enabled: true };
    this.write.run(name, JSON.stringify(result));
    return structuredClone(result);
  }
  list() {
    return this.db.prepare("SELECT value FROM learned_skills WHERE json_extract(value,'$.published')=1 ORDER BY rowid DESC LIMIT 200").all()
      .map(row => { const { content, ...metadata } = JSON.parse(row.value); return metadata; });
  }
  async publish(document, { beforePublish } = {}) {
    const selected = [];
    for (const node of document.nodes.filter(node => node.type === 'skill' && this.has(node.config.skillRef))) {
      const skill = await this.resolve(node.config.skillRef);
      if (node.config.version !== skill.revision) throw fail('待应用学习版本的指纹不一致。', 409);
      selected.push(skill);
    }
    // Feedback may be revised while base resources resolve asynchronously.
    // Re-admit synchronously before any candidate becomes discoverable.
    if (beforePublish) beforePublish();
    for (const skill of selected) { skill.published = true; this.write.run(skill.name, JSON.stringify(skill)); }
    return document;
  }
}
