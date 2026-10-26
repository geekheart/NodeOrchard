import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowFeedback } from '../src/workflows/workflow-feedback.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

const hash = index => `sha256:${String(index).repeat(64)}`;
const copy = value => JSON.parse(JSON.stringify(value));

function execution({ hdk = false, id = 'run-one', status = 'complete' } = {}) {
  let document = createDocument({ title: '个人资料流程' });
  document.id = hdk ? 'workflow-hdk-engineering-delivery' : 'personal-flow';
  const ids = hdk ? ['hdk-plan-skill', 'hdk-process-skill', 'hdk-firmware-skill', 'hdk-sop-skill'] : ['extract', 'write'];
  document.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'text' } }),
    ...ids.map((id, index) => createNode('skill', { x: 300 * (index + 1), y: 0 }, { id, title: `实际主链 ${index + 1}`, config: {
      skillRef: `skill-${index + 1}`, version: hash(index + 1), inputType: 'text', outputType: 'text',
    } })), createNode('output', { x: 1800, y: 0 }, { id: 'output' })];
  for (let index = 1; index < document.nodes.length; index++) document = connectNodes(document, {
    sourceNode: document.nodes[index - 1].id, sourcePort: 'out', targetNode: document.nodes[index].id, targetPort: 'in',
  });
  const nodeOrder = document.nodes.map(node => node.id);
  const skills = document.nodes.filter(node => node.type === 'skill').map(node => ({ nodeId: node.id, name: node.config.skillRef,
    revision: node.config.version, source: 'learned', bundleHash: `bundle-${node.id}` }));
  document.nodes.reverse();
  return { id, workflowId: document.id, document, status, nodeOrder, skills, input: 'source', output: 'result',
    nodes: Object.fromEntries(nodeOrder.map(id => [id, { status: 'complete', input: `input-${id}`, output: `output-${id}` }])) };
}

async function fixture(t, run = execution()) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-feedback-'));
  const path = join(directory, 'feedback.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE workflow_runs (id TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const put = value => db.prepare('INSERT OR REPLACE INTO workflow_runs(id,value) VALUES(?,?)').run(value.id, JSON.stringify(value));
  put(run);
  const events = [];
  const app = { store: { db }, workflows: { get(id) {
    const row = db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(id);
    if (!row) throw Object.assign(new Error('工作流运行不存在。'), { httpStatus: 404 });
    return JSON.parse(row.value);
  } }, publish: (...args) => events.push(args) };
  const manager = new WorkflowFeedback(app);
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  return { db, path, app, manager, events, run, put };
}

const comment = '命名中保留硬件版本，并校验生成文件内容；测试说明应明确接线要求。';
const submit = (text = comment, expectedRevision = 0) => ({ expectedRevision, comment: text });
const throws = (fn, code, match) => assert.throws(fn, error => error.httpStatus === code && (!match || match.test(error.message)));

test('one comprehensive review binds the four immutable HDK Skill versions without Hermes', async t => {
  const f = await fixture(t, execution({ hdk: true }));
  const before = f.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(f.run.id).value;
  const view = f.manager.get(f.run.id);
  assert.equal(view.feedback, null);
  assert.equal(view.canReview, true);
  assert.deepEqual(view.targets.map(target => target.title), ['导出与命名', '工艺要求', '测试固件', '测试说明']);
  const saved = f.manager.save(f.run.id, submit());
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.runId, f.run.id);
  assert.equal(saved.workflowId, f.run.workflowId);
  assert.equal(saved.revision, 1);
  assert.equal(saved.comment, comment);
  assert.deepEqual(saved.targets.map(target => target.nodeId), f.run.skills.map(skill => skill.nodeId));
  assert.deepEqual(saved.targets.map(target => target.version), f.run.skills.map(skill => skill.revision));
  assert(saved.targets.every(target => target.status === 'complete'));
  assert(!Object.hasOwn(saved, 'items'));
  assert(!Object.hasOwn(saved, 'score'));
  assert.equal(f.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(f.run.id).value, before);
  assert.equal(f.events[0][0], 'workflow.feedback');
  saved.comment = 'client mutation'; saved.targets[0].skillRef = 'forged';
  assert.equal(f.manager.get(f.run.id).feedback.comment, comment);
  assert.equal(f.manager.get(f.run.id).feedback.targets[0].skillRef, 'skill-1');
});

test('generic workflows keep real Skill titles and empty feedback clears text without rating fields', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.manager.get(f.run.id).targets.map(target => target.title), ['实际主链 1', '实际主链 2']);
  f.manager.save(f.run.id, submit());
  const cleared = f.manager.save(f.run.id, submit('', 1));
  assert.equal(cleared.comment, '');
  assert.equal(cleared.targets.length, 2);
  assert(!Object.hasOwn(cleared, 'items'));
  assert(!JSON.stringify(cleared).includes('selectedForLearning'));
  throws(() => f.manager.learningRequest(f.run.id, { feedbackRevision: 2 }), 400, /具体问题和期望/);
});

test('append-only comprehensive feedback survives SQLite reopening and CAS preserves history', async t => {
  const f = await fixture(t);
  const first = f.manager.save(f.run.id, submit());
  throws(() => f.manager.save(f.run.id, submit('stale text')), 409);
  const second = f.manager.save(f.run.id, submit('补充：测试说明缺少外设型号。', 1));
  assert.equal(second.revision, 2);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM workflow_feedback').get().count, 2);
  assert.deepEqual(f.manager.getRevision(f.run.id, 1), first);
  const reopened = new DatabaseSync(f.path);
  try {
    const manager = new WorkflowFeedback({ ...f.app, store: { db: reopened } });
    assert.deepEqual(manager.get(f.run.id).feedback, second);
    throws(() => manager.save(f.run.id, submit('stale', 1)), 409);
    assert.equal(manager.save(f.run.id, submit('', 2)).revision, 3);
    assert.deepEqual(manager.getRevision(f.run.id, 1), first);
  } finally { reopened.close(); }
});

test('an error result binds only completed earlier Skills, excluding failed and skipped nodes', async t => {
  const run = execution({ status: 'error' });
  run.nodes.write.status = 'error';
  const f = await fixture(t, run);
  assert.equal(f.manager.get(run.id).canReview, true);
  assert.deepEqual(f.manager.get(run.id).targets.map(target => target.status), ['complete', 'error']);
  assert.deepEqual(f.manager.save(run.id, submit()).targets.map(target => target.nodeId), ['extract']);
  run.nodes.extract.status = 'skipped'; f.put(run);
  assert.equal(f.manager.get(run.id).canReview, false);
  throws(() => f.manager.save(run.id, submit('new', 1)), 409, /没有已完成/);
});

test('active runs and isolated learning samples remain ineligible for feedback', async t => {
  const f = await fixture(t);
  for (const status of ['preparing', 'running', 'waiting']) {
    const run = { ...f.run, status }; f.put(run);
    assert.equal(f.manager.get(run.id).canReview, false);
    throws(() => f.manager.save(run.id, submit()), 409, /结束/);
  }
  for (const extra of [{ learningId: 'training-batch' }, { memoryScopeId: 'training-batch' }]) {
    const run = { ...f.run, ...extra }; f.put(run);
    assert.equal(f.manager.get(run.id).canReview, false);
    throws(() => f.manager.save(run.id, submit()), 409, /学习样例/);
  }
  for (const status of ['interrupted', 'unknown']) {
    f.put({ ...f.run, status }); assert.equal(f.manager.get(f.run.id).canReview, true);
  }
});

test('missing, changed or duplicate actual Skill versions are never bound into comprehensive feedback', async t => {
  const f = await fixture(t);
  for (const mutate of [
    run => { run.skills[0].revision = hash(8); }, run => { run.skills[0].name = 'other-skill'; },
    run => { run.skills[0].revision = 'latest'; }, run => { run.skills.push(copy(run.skills[0])); },
  ]) {
    const run = copy(f.run); mutate(run); f.put(run);
    assert.equal(f.manager.get(run.id).targets.some(target => target.nodeId === 'extract'), false);
    assert.deepEqual(f.manager.save(run.id, submit('valid remaining skill', f.manager.current(run.id)?.revision || 0)).targets.map(target => target.nodeId), ['write']);
  }
  const run = copy(f.run); run.skills = []; f.put(run);
  throws(() => f.manager.save(run.id, submit()), 409, /没有已完成/);
  run.workflowId = 'other-workflow'; f.put(run);
  throws(() => f.manager.get(run.id), 409, /快照/);
});

test('saving rejects old rating payloads, client targets, non-text feedback and invalid revisions', async t => {
  const f = await fixture(t);
  for (const request of [
    {}, { expectedRevision: 0, items: [] }, { ...submit(), items: [] }, { ...submit(), score: 100 },
    { ...submit(), targets: [] }, { ...submit(), nodeId: 'extract' }, { ...submit(), skillRef: 'spoof' },
    { ...submit(), workflowId: 'spoof' }, submit('a'.repeat(8001)), submit(null), submit({ text: 'bad' }),
    submit(comment, -1), submit(comment, 0.5), submit(comment, '0'), submit(comment, Number.MAX_SAFE_INTEGER),
  ]) throws(() => f.manager.save(f.run.id, request), 400);
  const getter = { expectedRevision: 0, get comment() { throw new Error('must not run getter'); } };
  throws(() => f.manager.save(f.run.id, getter), 400, /访问器/);
  throws(() => f.manager.save(f.run.id, { ...submit(), [Symbol('spoof')]: 1 }), 400);
  assert.equal(f.manager.get(f.run.id).feedback, null);
  assert.equal(f.manager.save(f.run.id, submit('字'.repeat(8000))).comment.length, 8000);
});

test('learning requires current nonempty text and verifies every bound target against the same run', async t => {
  const f = await fixture(t);
  const first = f.manager.save(f.run.id, submit());
  assert.deepEqual(f.manager.learningRequest(f.run.id, { feedbackRevision: 1 }), first);
  for (const input of [{}, { feedbackRevision: 0 }, { feedbackRevision: '1' }, { feedbackRevision: 1, nodeId: 'write' }]) {
    throws(() => f.manager.learningRequest(f.run.id, input), 400);
  }
  const other = execution({ id: 'run-two' }); f.put(other);
  throws(() => f.manager.getRevision(other.id, 1), 404);
  throws(() => f.manager.learningRequest(other.id, { feedbackRevision: 1 }), 409);
  const changed = copy(f.run); changed.skills[0].revision = hash(8); f.put(changed);
  throws(() => f.manager.learningRequest(f.run.id, { feedbackRevision: 1 }), 409, /版本不一致/);
  f.put(f.run);
  const cleared = f.manager.save(f.run.id, submit(' \n ', 1));
  assert.equal(cleared.revision, 2);
  throws(() => f.manager.learningRequest(f.run.id, { feedbackRevision: 1 }), 409);
  throws(() => f.manager.learningRequest(f.run.id, { feedbackRevision: 2 }), 400, /具体问题和期望/);
  throws(() => f.manager.get('missing-run'), 404);
  throws(() => f.manager.get({ id: f.run.id }), 400);
});

test('legacy per-Skill feedback remains readable and learnable without rewriting historical records', async t => {
  const f = await fixture(t);
  const legacy = { runId: f.run.id, workflowId: f.run.workflowId, revision: 1,
    createdAt: '2026-10-24T01:00:00.000Z', updatedAt: '2026-10-24T01:00:00.000Z',
    items: f.manager.get(f.run.id).targets.map((target, index) => ({ ...target, score: index ? null : 0,
      comment: index ? '' : '旧反馈仍需保留，命名需要带硬件版本。', selectedForLearning: index === 0 })) };
  const original = JSON.stringify(legacy);
  f.db.prepare('INSERT INTO workflow_feedback(run_id,revision,workflow_id,value) VALUES(?,?,?,?)').run(f.run.id, 1, f.run.workflowId, original);
  assert.deepEqual(f.manager.get(f.run.id).feedback, legacy);
  assert.deepEqual(f.manager.getRevision(f.run.id, 1), legacy);
  assert.deepEqual(f.manager.learningRequest(f.run.id, { feedbackRevision: 1 }), legacy);
  assert.equal(f.db.prepare('SELECT value FROM workflow_feedback WHERE run_id=? AND revision=1').get(f.run.id).value, original);
  const saved = f.manager.save(f.run.id, submit('后续只保存综合反馈。', 1));
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.createdAt, legacy.createdAt);
  assert.deepEqual(f.manager.getRevision(f.run.id, 1), legacy);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM workflow_feedback').get().count, 2);
});

function executionWithLearning() {
  const run = execution(); let document = run.document;
  document.nodes.push(createNode('evaluation', { x: 0, y: 300 }, { id: 'compare', config: { comparison: 'exact' } }),
    createNode('improvement', { x: 300, y: 300 }, { id: 'improve', config: { targetSkillNodeIds: ['extract', 'write'] } }));
  document = connectNodes(document, { sourceNode: 'output', sourcePort: 'learning', targetNode: 'compare', targetPort: 'in' });
  document = connectNodes(document, { sourceNode: 'compare', sourcePort: 'out', targetNode: 'improve', targetPort: 'in' });
  run.document = document; run.nodes.compare = { status: 'skipped' }; run.nodes.improve = { status: 'skipped' }; return run;
}

test('scoped feedback appends only selected declared completed Skill versions while public comprehensive save remains strict', async t => {
  const f = await fixture(t, executionWithLearning()), original = copy(f.run);
  const first = f.manager.saveScoped(f.run.id, { expectedRevision: 0, comment: '只优化写作方法', targetNodeIds: ['write'] });
  assert.equal(first.schemaVersion, 3); assert.equal(first.scope, 'selected'); assert.deepEqual(first.targets.map(target => target.nodeId), ['write']);
  assert.equal(first.targets[0].version, f.run.skills.find(skill => skill.nodeId === 'write').revision);
  assert.deepEqual(f.manager.learningRequest(f.run.id, { feedbackRevision: 1 }), first);
  assert.deepEqual(f.manager.run(f.run.id), original);
  assert.throws(() => f.manager.save(f.run.id, { expectedRevision: 1, comment: '不能伪造范围', targetNodeIds: ['write'] }), /字段/);
  assert.throws(() => f.manager.saveScoped(f.run.id, { expectedRevision: 0, comment: '过期', targetNodeIds: ['extract'] }), /其它窗口/);
  const second = f.manager.save(f.run.id, { expectedRevision: 1, comment: '综合反馈仍覆盖全部已完成 Skill' });
  assert.equal(second.schemaVersion, 2); assert.equal(second.targets.length, 2); assert.deepEqual(f.manager.getRevision(f.run.id, 1), first);
});

test('scoped feedback rejects forbidden, stale, duplicate, unfinished and undeclared targets before persistence', async t => {
  const f = await fixture(t, executionWithLearning());
  const submit = targetNodeIds => ({ expectedRevision: 0, comment: '改善执行方法', targetNodeIds });
  for (const ids of [[], ['write', 'write'], ['missing'], ['input'], ['__proto__'], [null]]) assert.throws(() => f.manager.saveScoped(f.run.id, submit(ids)));
  assert.throws(() => f.manager.saveScoped(f.run.id, { ...submit(['write']), unexpected: true }), /字段/);
  const run = copy(f.run); run.nodes.write.status = 'error'; f.put(run);
  assert.throws(() => f.manager.saveScoped(run.id, submit(['write'])), /尚未完成/);
  run.nodes.write.status = 'complete'; run.document.nodes.find(node => node.id === 'improve').config.targetSkillNodeIds = ['extract']; f.put(run);
  assert.throws(() => f.manager.saveScoped(run.id, submit(['write'])), /允许改进/);
  f.put(f.run); const saved = f.manager.saveScoped(f.run.id, submit(['write']));
  const changed = copy(f.run); changed.skills.find(skill => skill.nodeId === 'write').revision = hash(9); f.put(changed);
  assert.throws(() => f.manager.learningRequest(f.run.id, { feedbackRevision: saved.revision }), /版本或允许改进/);
  f.put(f.run); const tampered = { ...saved, targets: [saved.targets[0], saved.targets[0]] };
  f.db.prepare('UPDATE workflow_feedback SET value=? WHERE run_id=? AND revision=1').run(JSON.stringify(tampered), f.run.id);
  assert.throws(() => f.manager.learningRequest(f.run.id, { feedbackRevision: 1 }), /有效的 Skill 范围/);
});
