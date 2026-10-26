import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKFLOW_TOOLS, validateWorkflowToolConfig } from '../shared/workflow/workflow-tools.mjs';

test('portable guide packaging is an explicit tool with a reusable receipt input', () => {
  const tool = WORKFLOW_TOOLS.find(tool => tool.id === 'hdk.guide.package');
  assert(tool); assert.equal(tool.reviewRequired, false);
  assert.equal(tool.ports.inputs.length, 1); assert.equal(tool.ports.inputs[0].id, 'in');
  assert.equal(tool.ports.inputs[0].required, true);
  assert.doesNotThrow(() => validateWorkflowToolConfig({ type: 'tool', config: {
    executionMode: 'tool', toolName: tool.id, inputType: 'object', outputType: 'object', ...tool.defaultConfig } }));
});

test('portable guide packaging preserves reviewed assets and rejects incomplete or altered dependencies', () => {
  execFileSync(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'),
    ['-B', fileURLToPath(new URL('./guide-package.test.py', import.meta.url))],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1048576 });
});
