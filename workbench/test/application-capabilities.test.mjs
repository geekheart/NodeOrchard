import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ApplicationCapabilities, APPLICATION_ASSISTANT_TOOLS } from '../src/application-capabilities.mjs';
import { ApplicationAssistant } from '../src/application-assistant.mjs';
import { NODE_TYPES, createDocument, createNode, connectNodes, nodeConfigurationContract } from '../shared/workflow/workflow-model.mjs';
import { workflowCapabilityManifest, workflowNodeContract, codeRuntimeContract } from '../shared/workflow/workflow-capability-contract.mjs';
import { applyWorkflowOperations } from '../shared/workflow/workflow-conversation-commands.mjs';
import { OPERATION_LIMITS, executeOperation } from '../src/workflows/workflow-operations.mjs';
import { DEFAULT_ASSISTANT_PERMISSIONS } from '../src/application-assistant-permissions.mjs';
import { APPLICATION_SUPERVISOR_TOOLS } from '../src/application-supervisor-tools.mjs';
import { APPLICATION_CONVERSATION_HUB_TOOLS } from '../src/application-conversation-hub.mjs';
import { ASSISTANT_MODEL_TOOLS } from '../src/assistant-model-tools.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function application(t) {
  const app = new EventEmitter(), db = new DatabaseSync(':memory:');
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'application-capability-permissions-'));
  app.config = { workspaceRoot }; app.preferences = { defaultWorkspace: '.' };
  app.assistantPermissionSettings = { get: () => ({ revision: 1, ...structuredClone(DEFAULT_ASSISTANT_PERMISSIONS) }) };
  app.store = { db }; app.diagnostics = { tools: () => [], snapshot: async () => ({}) }; app.publish = () => {};
  app.captureModelRoute = async () => ({ provider: 'fixture', model: 'fixture' });
  const assistant = new ApplicationAssistant(app); t.after(async () => { await assistant.close(); db.close(); rmSync(workspaceRoot, { recursive: true, force: true }); });
  return { app, assistant, capabilities: assistant.capabilities };
}

test('node capability discovery covers every real node and derives configuration keys from the model', () => {
  for (const schemaVersion of [1, 2]) {
    const manifest = workflowCapabilityManifest({ schemaVersion, section: 'nodes' });
    assert.deepEqual(manifest.nodes.map(row => row.type), NODE_TYPES.map(row => row.type));
    for (const row of manifest.nodes) {
      const actual = nodeConfigurationContract(row.type, { schemaVersion });
      assert.deepEqual(row.allowedConfigKeys, actual.allowedConfigKeys.filter(key => !['document', 'trigger', 'schedule', 'timezone'].includes(key)));
      assert.ok(Object.keys(row.defaults).every(key => row.allowedConfigKeys.includes(key)));
    }
  }
  const tool = workflowNodeContract('tool');
  assert.equal(tool.modes.find(row => row.mode === 'code').registrationRequired, false);
  assert.equal(tool.modes.find(row => row.mode === 'tool').registrationRequired, true);
  assert.deepEqual(tool.enums.language, ['javascript', 'python']);
  assert.equal(codeRuntimeContract().output.maxBytes, OPERATION_LIMITS.jsonBytes);
  assert.equal(codeRuntimeContract().policy.subprocessIsOsSandbox, false);
  assert.equal(codeRuntimeContract(1).files.supported, false);
});

test('code runtime discovery distinguishes Python dictionaries from JavaScript object properties', () => {
  const runtime = codeRuntimeContract(2);
  assert.deepEqual(runtime.files.directory, { javascript: 'context.outputDirectory', python: "context['outputDirectory']" });
  assert.equal(runtime.python.contextType, 'dict');
  assert.deepEqual(runtime.python.objectAccess, { required: "value['key']", optional: "value.get('key')" });
  assert.match(runtime.python.inputRule, /JSON.*对象.*dict/);
  assert.match(runtime.python.inputRule, /数组.*list/);
  assert.equal(runtime.javascript.contextType, 'object');
  for (const type of ['tool', 'transform']) assert.deepEqual(workflowNodeContract(type).runtime.files.directory, runtime.files.directory);
});

test('the advertised Python directory expression executes with plain dict context and JSON object input', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'python-context-contract-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = codeRuntimeContract(2);
  const code = `return {'directory': ${runtime.files.directory.python}, 'title': input['title'], 'missing': input.get('missing'), 'plainDicts': type(context) is dict and type(input) is dict}`;
  const result = await executeOperation({ node: { type: 'tool', config: { executionMode: 'code', language: 'python', code,
    inputType: 'object', outputType: 'object', timeoutSeconds: 5 } }, input: { title: 'fixture-poster' },
  cwd: directory, context: { outputDirectory: directory } });
  assert.deepEqual(result.output, { directory, title: 'fixture-poster', missing: null, plainDicts: true });
});

test('capability tools and internal Skills are discoverable without inventing executable permissions', async t => {
  const f = application(t), initial = await f.capabilities.bootstrap('请把 Skill 替换成 Python 代码节点导出 Excel');
  assert.ok(initial.loadedSkills.some(skill => skill.name === 'author-code-node'));
  assert.ok(initial.loadedSkills.some(skill => skill.name === 'edit-workflow'));
  assert.ok(initial.loadedSkills.every(skill => /^sha256:[a-f0-9]{64}$/.test(skill.revision)));
  assert.equal((await f.capabilities.bootstrap('你好')).loadedSkills.length, 0);
  const interfaces = await f.capabilities.read('app.capabilities', { section: 'interfaces' });
  assert.equal(interfaces.protocol.externalMcpServerAvailable, false);
  assert.equal(interfaces.protocol.diagnostics.batchQueries, 4);
  assert.equal(interfaces.protocol.diagnostics.persistedCheckpoints, true);
  assert.equal(interfaces.protocol.diagnostics.automaticReplay, false);
  assert.equal(interfaces.protocol.conversationIssues.retryLink, 'retryOfTurnId');
  assert.equal(interfaces.protocol.conversationIssues.automaticBusinessResolution, false);
  assert.equal(interfaces.protocol.conversationIssues.reviewIdentityRequired, true);
  assert.equal(interfaces.features.find(row => row.id === 'conversation-lifecycle').status, 'available');
  assert.equal(interfaces.features.find(row => row.id === 'conversation-pending-controls').status, 'ui-only');
  assert.equal(interfaces.features.find(row => row.id === 'conversation-issue-resolution').status, 'available');
  assert.deepEqual(interfaces.protocol.conversationIssues.resolutionCommands, ['这个问题解决了', '不用处理了']);
  assert.equal(interfaces.protocol.conversationIssues.resolutionRouting, 'local-command');
  assert.equal(interfaces.features.find(row => row.id === 'execution').status, 'ui-only');
  assert.equal(interfaces.features.find(row => row.id === 'business-code').status, 'proposal-only');
  assert.equal(interfaces.features.find(row => row.id === 'application-source-editing').status, 'unavailable');
  const recycle = interfaces.features.find(row => row.id === 'workflow-recycle-bin');
  assert.equal(recycle.status, 'ui-only'); assert.equal(recycle.requiresUserConfirmation, true); assert.deepEqual(recycle.tools, []);
  assert.match(recycle.note, /完整名称确认/);
  const tools = f.assistant.tools();
  assert.equal(new Set(tools.map(row => row.name)).size, tools.length);
  assert.ok(tools.every(row => row.inputSchema.additionalProperties === false));
  assert.deepEqual(tools.map(row => row.name), [...APPLICATION_ASSISTANT_TOOLS, ...APPLICATION_SUPERVISOR_TOOLS, ...APPLICATION_CONVERSATION_HUB_TOOLS, ...ASSISTANT_MODEL_TOOLS].map(row => row.name));
  assert.equal((await f.capabilities.read('assistant.skills.list')).skills.length, 4);
  assert.match((await f.capabilities.read('assistant.skills.read', { name: 'author-code-node' })).instructions, /node.describe/);
});

test('discovery tools reject unknown fields, unsafe accessors and invalid versions before reading anything', async t => {
  const { capabilities } = application(t); let invoked = false;
  await assert.rejects(capabilities.read('node.describe', { type: 'tool', path: '/private' }), /未知字段/);
  await assert.rejects(capabilities.read('app.capabilities', { section: 'skills', schemaVersion: 9 }), /版本无效/);
  await assert.rejects(capabilities.read('app.capabilities', { section: 'source' }), /分区无效/);
  await assert.rejects(capabilities.read('node.describe', { get type() { invoked = true; return 'tool'; } }), /访问器/);
  await assert.rejects(capabilities.read('assistant.skills.read', { name: '../SKILL.md' }), /未开放/);
  assert.equal(invoked, false);
});

test('workbench inspection projects current state without changing settings, schedules or models', async t => {
  const { app, capabilities } = application(t), calls = [];
  app.settings = async () => ({ preferences: { theme: 'dark' }, approvalMode: 'smart', runtime: { hermesHome: 'PRIVATE_HOME' } });
  app.modelOptions = async () => ({ current: { model: 'fixture' }, providers: [] });
  app.schedules = { list: id => { calls.push(id); return [{ id: 'schedule', enabled: false, input: 'PRIVATE_SCHEDULE_INPUT', document: { answer: 'PRIVATE_ANSWER' } }]; } };
  app.nodePresets = { list: () => [{ id: 'preset', title: '示例' }] };
  assert.deepEqual((await capabilities.read('workbench.inspect', { section: 'settings' })).preferences, { theme: 'dark' });
  assert.equal(JSON.stringify(await capabilities.read('workbench.inspect', { section: 'settings' })).includes('PRIVATE_HOME'), false);
  assert.equal((await capabilities.read('workbench.inspect', { section: 'models' })).current.model, 'fixture');
  const schedules = await capabilities.read('workbench.inspect', { section: 'schedules', workflowId: 'wf' });
  assert.deepEqual(calls, ['wf']); assert.equal(JSON.stringify(schedules).includes('PRIVATE_'), false);
  assert.equal((await capabilities.read('workbench.inspect', { section: 'node-presets' })).presets.length, 1);
});

test('the actual assistant broker discovers Python, probes runtime and proposes a real Skill replacement in isolation', async t => {
  const f = application(t), calls = [];
  let document = createDocument({ schemaVersion: 2, title: '隔离能力回归' });
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'object' } }),
    createNode('skill', { x: 300, y: 90 }, { id: 'old-export', config: { skillRef: 'existing', version: 'fixed', inputType: 'object', outputType: 'object' } }),
    createNode('output', {}, { id: 'output' })];
  document = connectNodes(document, { sourceNode: 'input', sourcePort: 'out', targetNode: 'old-export', targetPort: 'in' });
  document = connectNodes(document, { sourceNode: 'old-export', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  const before = structuredClone(document), replies = [
    { tool: 'node.describe', arguments: { type: 'tool', schemaVersion: 2 } },
    { tool: 'runtime.inspect', arguments: { language: 'python', modules: ['json'] } },
    { tool: 'workflow.propose', arguments: { request: '原位置替换 Skill 为 Python，保留上下游，代码先作为候选。' } },
    { text: '已生成真正替换生产节点的候选，尚未运行。', operations: [
      { op: 'add-node', ref: 'python-export', type: 'tool', x: 300, y: 90, config: { executionMode: 'code', language: 'python', inputType: 'object', outputType: 'object', code: "return {'data': input}" } },
      ...document.edges.map(edge => ({ op: 'remove-edge', edgeId: edge.id })),
      { op: 'connect', sourceNode: 'input', sourcePort: 'out', targetNode: 'python-export', targetPort: 'in' },
      { op: 'connect', sourceNode: 'python-export', sourcePort: 'out', targetNode: 'output', targetPort: 'in' },
      { op: 'remove-node', nodeId: 'old-export' },
    ] },
  ];
  f.app.assistantModel = { generate: async prompt => { calls.push(prompt); return JSON.stringify(replies.shift()); } };
  const result = await f.assistant.plan({ text: '把这个 Skill 替换成 Python 代码节点', document });
  const source = JSON.parse(calls[0].split('SOURCE_JSON=')[1].split('\nTOOL_RESULTS_JSON=')[0]);
  assert.ok(source.capabilities.workbench.code.languages.includes('python'));
  assert.equal(source.capabilities.workbench.code.registrationRequired, false);
  assert.ok(source.capabilities.loadedSkills.some(skill => skill.name === 'author-code-node'));
  const innerSource = JSON.parse(calls.at(-1).split('USER_SOURCE_JSON=')[1]);
  assert.equal(innerSource.runtimeContract.python.sourceFormat, 'function-body');
  assert.deepEqual(innerSource.runtimeContract.files.directory, { javascript: 'context.outputDirectory', python: "context['outputDirectory']" });
  assert.equal(innerSource.runtimeEvidence[0].language, 'python');
  assert.ok(innerSource.runtimeEvidence[0].modules.some(row => row.name === 'json' && row.available));
  assert.deepEqual(result.validation, { editorValidated: true, applied: false, executed: false });
  const applied = applyWorkflowOperations(document, result.operations).document;
  assert.equal(applied.nodes.some(node => node.id === 'old-export'), false);
  const replacement = applied.nodes.find(node => node.type === 'tool');
  assert.equal(replacement.config.language, 'python'); assert.equal(replacement.x, 300); assert.equal(applied.edges.length, 2);
  assert.deepEqual(document, before); assert.equal(calls.length, 4);
  assert.deepEqual(result.evidence.map(row => row.tool), ['node.describe', 'runtime.inspect', 'workflow.propose']);
});
