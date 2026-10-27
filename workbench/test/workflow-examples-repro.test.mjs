import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateDocument } from '../shared/workflow/workflow-model.mjs';
import { planWorkflow } from '../shared/workflow/workflow-plan.mjs';
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
      assert(plan.learningBranch.improvementNode.config.targetSkillNodeIds.length > 0, 'Learning must name the trainable Skill');
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
  assert.equal(examples.list().length, 8);
  for (const example of examples.list()) {
    const result = await examples.prepare(example.id, { workflowId: 'workflow-current-draft' });
    assert.equal(result.document.id, 'workflow-current-draft'); assert.equal(result.ready, true); assert.deepEqual(result.requirements, []);
    const plan = planWorkflow({ ...result.document, mode: 'execute' });
    assert.equal(example.requiresModel, plan.skillNodes.length > 0);
    for (const node of plan.skillNodes) assert.equal(node.config.version, (await skill(node.config.skillRef)).revision);
    if (example.kind === 'learn') { assert.equal(result.learningConfig.maxRounds, 2); assert(result.learningConfig.trainingCases.length); assert(result.learningConfig.validationCases.length); }
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
