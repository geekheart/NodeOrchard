import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { planWorkflow } from '../shared/workflow/workflow-plan.mjs';
import { createGuideWorkflow } from './fixtures/guide-workflow.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('guide stages bind run, memory scope, source hashes and recoverable Skill plans', () => {
  const python = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
  const result = spawnSync(python, ['-I', path.join(root, 'test/guide-pipeline.test.py')], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('guide graph executes the same capability chain and excludes learning branch in execution', () => {
  const document = createGuideWorkflow();
  const plan = planWorkflow(document);
  assert.deepEqual(plan.operationNodes.map(node => node.id), ['prepare', 'annotation-skill', 'annotate', 'author-skill', 'write', 'verify']);
  assert.equal(plan.learningBranch.evaluationNode.id, 'evaluation');
  assert.deepEqual(plan.learningBranch.improvementNode.config.targetSkillNodeIds, ['author-skill', 'annotation-skill']);
  assert.equal(document.mode, 'execute');
  for (const node of document.nodes.filter(node => node.type === 'skill')) {
    assert.match(node.config.version, /^sha256:[a-f0-9]{64}$/);
  }
});
