import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPinoutWorkflow, createPinoutLearningConfig } from './fixtures/pinout-workflow.mjs';
import { planWorkflow } from '../shared/workflow/workflow-plan.mjs';
import { normalizeWorkflowDataset } from '../shared/workflow/workflow-dataset.mjs';

const baseRevision = 'sha256:' + 'a'.repeat(64);

test('Pinout stage boundaries bind actual source reports, private runs, Skill I/O and recoverable learning diagnostics', () => {
  const python = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
  execFileSync(python, ['-B', fileURLToPath(new URL('./pinout-pipeline.test.py', import.meta.url))],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1048576 });
});

test('Pinout learning executes only the photograph Pinout capability and targets its one Skill', () => {
  const document = createPinoutWorkflow({ skillRevision: baseRevision, pipelinePath: '/tmp/pinout-fixture/pinout_pipeline.py' });
  const planned = planWorkflow(document);
  assert.deepEqual(planned.nodeOrder, [
    'pinout-input', 'pinout-prepare', 'pinout-plan-skill', 'pinout-render', 'pinout-verify', 'pinout-output',
  ]);
  assert.deepEqual(planned.skillNodes.map(node => node.config.skillRef), ['board-pinout']);
  assert.deepEqual(planned.learningBranch.improvementNode.config.targetSkillNodeIds, ['pinout-plan-skill']);
  assert.equal(planned.learningBranch.sourceNodeId, 'pinout-verify');
  assert.equal(planned.learningBranch.evaluationNode.config.valuePath, 'learningComparison');
  assert.equal(planned.learningBranch.evaluationNode.config.comparison, 'model');
  for (const node of planned.operationNodes.filter(node => node.type === 'tool')) {
    assert.equal(node.config.failurePolicy, 'stop');
    assert.match(node.config.code, /pinout_pipeline/);
    assert.doesNotMatch(node.config.code, /four_files_pipeline|export_native|openstep2dwg/);
  }
});

test('rebuilding a Pinout document preserves the selected learned immutable Skill', () => {
  const previous = createPinoutWorkflow({ skillRevision: baseRevision });
  const selected = previous.nodes.find(node => node.id === 'pinout-plan-skill');
  selected.config.skillRef = 'wb-learn-12345678-1234-1234-1234-123456789012';
  selected.config.version = 'sha256:' + 'b'.repeat(64);
  const rebuilt = createPinoutWorkflow({ skillRevision: baseRevision, previous });
  const skill = rebuilt.nodes.find(node => node.id === 'pinout-plan-skill');
  assert.equal(skill.config.skillRef, selected.config.skillRef);
  assert.equal(skill.config.version, selected.config.version);
  assert.equal(rebuilt.mode, 'execute');
});

test('training and validation use distinct views without supplying the reference answer as execution input', () => {
  const request = {
    sourcePath: '/tmp/pinout-fixture/source.epro2', productCode: 'BOARD', hardwareVersion: '1.0', releaseDate: '2026-10-25',
    nativeReportPath: '/tmp/pinout-fixture/verified-export-report.json', nativeReportSha256: 'c'.repeat(64),
    pinoutPhotoProfilePath: '/tmp/pinout-fixture/reviewed-photo-calibration.json',
    images: ['front', 'back'].map(side => ({ side, path: '/tmp/pinout-fixture/' + side + '.png', sha256: 'd'.repeat(64) })),
  };
  const expected = { referenceContract: { imageSha256: 'e'.repeat(64) }, qualitySummary: { checks: { truePadLeaders: true } } };
  const config = createPinoutLearningConfig({ request, expected });
  const dataset = normalizeWorkflowDataset({ trainingCases: config.trainingCases, validationCases: config.validationCases });
  assert.deepEqual(dataset.trainingCases[0].input.viewSides, ['front']);
  assert.deepEqual(dataset.validationCases[0].input.viewSides, ['back']);
  for (const item of [...dataset.trainingCases, ...dataset.validationCases]) {
    assert.deepEqual(item.expected, expected);
    assert.equal(item.input.referenceContract, undefined);
    assert.equal(item.input.expected, undefined);
    assert.equal(item.input.nativeReportSha256, request.nativeReportSha256);
    assert.ok(Buffer.byteLength(JSON.stringify(item.input)) < 64 * 1024);
  }
  assert.deepEqual(config.trainableNodeIds, ['pinout-plan-skill']);
  assert.equal(config.targetScore, 95);
  assert.equal(config.maxRounds, 5);
  assert.match(config.rubric, /没有看到 PNG/);
  assert.match(config.rubric, /验证集的输入、输出和反馈不得进入优化提示或持久记忆/);
  assert.equal(request.viewSides, undefined);
});
