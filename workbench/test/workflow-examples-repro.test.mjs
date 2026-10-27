import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateDocument } from '../shared/workflow/workflow-model.mjs';
import { planWorkflow, learningImprovementTargets } from '../shared/workflow/workflow-plan.mjs';
import { validateWorkflowInput } from '../src/workflows/workflow-runs.mjs';
import { WorkflowExamples } from '../src/workflows/workflow-examples.mjs';

const revision = /^sha256:[a-f0-9]{64}$/;
const directory = new URL('../examples/', import.meta.url);
for (const filename of (await readdir(directory)).filter(name => name.endsWith('.workflow.json'))) {
  test('shipped example can be planned with valid pinned Skill identities: ' + filename, async () => {
    const document = validateDocument(JSON.parse(await readFile(new URL(filename, directory), 'utf8'))), plan = planWorkflow({ ...document, mode: 'execute' });
    assert.equal(document.schemaVersion, 2); assert.doesNotThrow(() => validateWorkflowInput(undefined, plan), 'Every example needs its own usable default input');
    for (const node of plan.skillNodes) assert.match(node.config.version, revision, node.config.skillRef + ' must identify actual immutable Skill content');
    if (document.mode === 'learn' || filename.includes('learning')) {
      assert(plan.learningBranch, 'The learning runtime requires a connected evaluation → improvement branch');
      assert(learningImprovementTargets(plan).ids.length > 0, 'Learning must identify the actual business targets for its scope');
    }
  });
}

test('all source templates use distinct stable IDs', async () => {
  const files = (await readdir(directory)).filter(name => name.endsWith('.workflow.json'));
  const documents = await Promise.all(files.map(async name => JSON.parse(await readFile(new URL(name, directory), 'utf8'))));
  assert.equal(new Set(documents.map(document => document.id)).size, files.length);
  assert(documents.every(document => document.id.startsWith('workflow-example-')));
});

test('the fixed example catalog prepares independent drafts with actual Skill revisions and complete learning data', async () => {
  const skill = async name => { const content = 'fixture actual Skill ' + name; return { name, content, revision: 'sha256:' + createHash('sha256').update(content).digest('hex') }; };
  const examples = new WorkflowExamples({ backend: { state: 'ready' }, skill });
  assert.equal(examples.list().length, 10);
  for (const example of examples.list()) {
    const result = await examples.prepare(example.id, { workflowId: 'workflow-current-draft' });
    assert.equal(result.document.id, 'workflow-current-draft'); assert.equal(result.ready, true); assert.deepEqual(result.requirements, []);
    const plan = planWorkflow({ ...result.document, mode: 'execute' });
    assert.equal(example.requiresModel, example.kind === 'learn' || plan.skillNodes.length > 0);
    for (const node of plan.skillNodes) assert.equal(node.config.version, (await skill(node.config.skillRef)).revision);
    if (example.kind === 'learn') {
      const targets = learningImprovementTargets(plan);
      assert.equal(result.learningConfig.scope, targets.scope); assert.deepEqual(result.learningConfig.trainableNodeIds, targets.ids);
      assert.equal(result.learningConfig.maxRounds, 2); assert(result.learningConfig.trainingCases.length); assert(result.learningConfig.validationCases.length);
    }
  }
});

test('tool and whole-workflow examples target code without Skills and preserve a failed baseline', async () => {
  const examples = new WorkflowExamples({ backend: { state: 'ready' }, skill() { assert.fail('Code learning does not require a Skill'); } });
  for (const [id, scope, target] of [['tools-learning', 'tools', 'tools-code'], ['workflow-learning', 'workflow', 'workflow-passthrough']]) {
    const result = await examples.prepare(id, { workflowId: 'workflow-draft' });
    assert.equal(result.example.requiresModel, true); assert.equal(result.ready, true); assert.equal(result.document.nodes.length, 5);
    assert.equal(result.document.nodes.some(node => node.type === 'skill'), false);
    assert.equal(result.learningConfig.scope, scope); assert.deepEqual(result.learningConfig.trainableNodeIds, [target]);
    assert.equal(result.document.nodes.find(node => node.id === target).config.code, 'return input;');
    assert.equal(result.learningConfig.targetScore, 100); assert.equal(result.learningConfig.maxRounds, 2);
    assert.equal(result.learningConfig.trainingCases.length, 1); assert.equal(result.learningConfig.validationCases.length, 1);
    for (const item of [...result.learningConfig.trainingCases, ...result.learningConfig.validationCases]) {
      assert.notEqual(item.input.trim(), item.expected, 'The identity baseline must fail exact comparison');
      assert.equal(item.input.trim().toLowerCase(), item.expected, 'One general normalization rule must cover both groups');
    }
    const config = JSON.parse(await readFile(new URL(id + '.config.json', directory), 'utf8'));
    assert.equal(config.scope, scope); assert.deepEqual(config.trainableNodeIds, [target]);
    if (scope === 'workflow') assert.match(config.rubric, /删除旧透传业务节点 workflow-passthrough.*新增.*transform.*重新连接.*不能只原位修改/);
  }
});

test('code learning prerequisites expose connection, authentication and every required human permission', async () => {
  for (const id of ['tools-learning', 'workflow-learning']) {
    const disconnected = await new WorkflowExamples({ backend: { state: 'stopped' } }).prepare(id, { workflowId: 'workflow-draft' });
    assert.equal(disconnected.ready, false); assert.match(disconnected.requirements.join(' '), /Hermes/);
    const unauthenticated = await new WorkflowExamples({ backend: { state: 'ready', authenticated: false } }).prepare(id, { workflowId: 'workflow-draft' });
    assert.equal(unauthenticated.ready, false); assert.match(unauthenticated.requirements.join(' '), /认证/);
    for (const flag of ['workflowRead', 'workflowEdit', 'customNodes']) {
      const permissions = { workflowRead: true, workflowEdit: true, customNodes: true, [flag]: false }, original = structuredClone(permissions);
      const blocked = await new WorkflowExamples({ backend: { state: 'ready' }, assistantPermissionSettings: { get: () => ({ workflow: permissions }) } }).prepare(id, { workflowId: 'workflow-draft' });
      assert.equal(blocked.ready, false); assert.match(blocked.requirements.join(' '), /设置.*读取.*编辑.*自定义节点/);
      assert.deepEqual(permissions, original, 'Preparing an example must not change human permissions');
    }
  }
});

test('model requirements are explicit and do not stop dependency-free examples from loading', async () => {
  const disconnected = new WorkflowExamples({ backend: { state: 'stopped' }, skill() { assert.fail('No skill read while disconnected'); } });
  const local = await disconnected.prepare('local-data', { workflowId: 'workflow-draft' }); assert.equal(local.ready, true); assert.equal(local.document.nodes.some(node => node.type === 'skill'), false);
  const blocked = await disconnected.prepare('learning-text', { workflowId: 'workflow-draft' }); assert.equal(blocked.ready, false); assert.match(blocked.requirements.join(' '), /Hermes/);
  const missing = new WorkflowExamples({ backend: { state: 'ready' }, async skill() { throw Object.assign(Error('missing'), { httpStatus: 404 }); } });
  const result = await missing.prepare('humanizer', { workflowId: 'workflow-draft' }); assert.equal(result.ready, false); assert.match(result.requirements.join(' '), /humanizer/);
});

test('preparing examples accepts only catalog IDs and an exact draft identity without paths or writes', async () => {
  const examples = new WorkflowExamples({ backend: { state: 'stopped' } });
  await assert.rejects(examples.prepare('../local-data', { workflowId: 'workflow-draft' }), /示例/);
  await assert.rejects(examples.prepare('local-data', { workflowId: '../escape' }), /工作流/);
  await assert.rejects(examples.prepare('local-data', { workflowId: 'workflow-draft', path: '/tmp/custom' }), /字段|参数/);
});
