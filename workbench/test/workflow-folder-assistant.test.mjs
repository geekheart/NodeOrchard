import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Application } from '../src/application.mjs';
import { readConfig } from '../src/config.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { documentFingerprint } from '../shared/workflow/workflow-conversation-commands.mjs';

class Offline extends EventEmitter {
  constructor() { super(); this.state = 'stopped'; this.serverRequests = new Map(); this.calls = []; }
  async request(name) { this.calls.push(name); throw Error('No external calls in folder scope tests'); }
  async stop() {}
}
const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory = await mkdtemp('/private/tmp/workflow-folder-assistant-'), adapter = new Offline();
  const app = new Application(readConfig({ WORKBENCH_DATA_DIR: join(directory, 'data'), WORKBENCH_WORKSPACE_ROOT: join(directory, 'workspace') }), adapter);
  t.after(async () => { await app.close(); assert.deepEqual(adapter.calls, []); await rm(directory, { recursive: true, force: true }); });
  await app.workflowFoldersReady;
  return { app, directory };
}

test('independent diagnostics read only verified local copies of legacy artifacts and inputs without rewriting frozen paths', async t => {
  const { app, directory } = await fixture(t), document = createDocument({ schemaVersion: 2 }), input = join(app.config.workspaceRoot, 'old-input.txt');
  document.settings.outputDirectory = join(app.config.workspaceRoot, 'legacy-delivery');
  await writeFile(input, '已归集输入');
  document.nodes = [createNode('input', {}, { id: 'input', config: { sourceKind: 'file', path: input, defaultValue: input } }), createNode('tool', {}, { id: 'producer', config: { code: 'return input;' } })];
  app.workflowLibrary.save({ document, expectedRevision: 0 });
  const runId = randomUUID(), output = join(app.config.workspaceRoot, 'old-runs', runId), artifactPath = join(output, 'result.txt');
  await mkdir(output, { recursive: true }); await writeFile(artifactPath, '已归集产物');
  app.store.db.prepare('INSERT INTO workflow_file_runs(id,value) VALUES(?,?)').run(runId, JSON.stringify({ id: runId, runId, workflowId: document.id, outputDirectory: output }));
  const artifact = await app.workflowFiles.registerArtifact({ runId, nodeId: 'producer', attempt: 1, path: artifactPath });
  const run = { schemaVersion: 2, id: runId, workflowId: document.id, document, status: 'complete', outputDirectory: output,
    nodes: { producer: { status: 'complete', attempt: 1, artifacts: [artifact] } } };
  app.workflows.save(run);
  await app.workflowFolders.sync(document.id, { includeFiles: true });
  const frozen = app.store.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(runId).value;
  await rm(input); await rm(output, { recursive: true });
  const permissions = app.applicationAssistant.permissions, scope = await permissions.bind({ role: 'workflow', workflowId: document.id, document });
  const context = { workflowId: document.id, document, permissionScope: scope };
  const checked = await app.applicationAssistant.call('artifact.inspect', { runId, nodeId: 'producer', artifactId: artifact.id }, context);
  assert.equal(checked.verified, true); assert.equal(checked.content, '已归集产物');
  assert(checked.metadata.path.startsWith(app.workflowFolders.directory(document.id) + '/'));
  const preflight = await app.applicationAssistant.call('workflow.preflight', {}, context);
  assert.equal(preflight.ok, true); assert(preflight.manifest.entries[0].path.startsWith(app.workflowFolders.directory(document.id) + '/inputs/'));
  app.assistantModel.generate = async prompt => {
    assert(prompt.includes(app.workflowFolders.directory(document.id) + '/inputs/'));
    return JSON.stringify({ text: '准备代码候选', operations: [{ op: 'update-node', nodeId: 'producer', config: { code: 'return {updated: true};' } }] });
  };
  const proposal = await app.applicationAssistant.proposeWorkflow({ workflowId: document.id, request: '修改代码生成候选' }, context);
  assert.equal(proposal.baseFingerprint, documentFingerprint(document)); assert.equal(document.nodes[0].config.path, input);
  await assert.rejects(permissions.path(join(directory, 'unregistered.txt'), scope), /超出当前/);
  const another = createDocument({ schemaVersion: 2 }); app.workflowLibrary.save({ document: another, expectedRevision: 0 });
  const foreign = await permissions.bind({ role: 'workflow', workflowId: another.id, document: another });
  await assert.rejects(permissions.path(input, foreign), /超出当前/);
  assert.equal(app.store.db.prepare('SELECT value FROM workflow_runs WHERE id=?').get(runId).value, frozen);
  assert.equal(app.workflowLibrary.get(document.id).document.nodes[0].config.path, input);
  assert.equal(app.workflowLibrary.get(document.id).document.settings.outputDirectory, document.settings.outputDirectory);
  await assert.rejects(permissions.document({ ...document, settings: { ...document.settings, outputDirectory: join(directory, 'new-external-delivery') } }, scope, { baseDocument: document }), /超出当前/);
  const mapping = JSON.parse(await readFile(join(app.workflowFolders.directory(document.id), 'files.json'), 'utf8'));
  await writeFile(join(app.workflowFolders.directory(document.id), mapping.entries.find(item => item.artifactId === artifact.id).path), '副本被篡改');
  await assert.rejects(app.applicationAssistant.call('artifact.inspect', { runId, nodeId: 'producer', artifactId: artifact.id }, context), /副本|哈希|大小/);
});

test('schema1 operation and Skill sessions use a run folder owned by their workflow', async t => {
  const { app } = await fixture(t), directory = app.config.workspaceRoot, seen = [];
  let document = createDocument({ title: '旧格式流程' });
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'text' } }),
    createNode('tool', {}, { id: 'code', config: { inputType: 'text', outputType: 'text', code: 'return input;' } }), createNode('output', {}, { id: 'output' })];
  document = connectNodes(document, { sourceNode: 'input', sourcePort: 'out', targetNode: 'code', targetPort: 'in' });
  document = connectNodes(document, { sourceNode: 'code', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  app.captureModelRoute = async () => null;
  app.workflows.executeOperation = async ({ cwd, input, context }) => { seen.push({ cwd, context }); await writeFile(join(cwd, 'generated.txt'), input); return { output: input }; };
  const run = await app.workflows.start({ document, input: '旧工作流产物' });
  for (let count = 0; count < 100 && app.workflows.get(run.id).status === 'running'; count++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.workflows.get(run.id).status, 'complete');
  const expected = join(app.workflowFolders.directory(document.id), 'runs', run.id);
  assert.equal(seen[0].cwd, expected); assert.equal(seen[0].context.outputDirectory, expected);
  assert.equal(app.workflows.get(run.id).outputDirectory, expected);
  assert.equal(await readFile(join(expected, 'generated.txt'), 'utf8'), '旧工作流产物');
  assert.notEqual(expected, join(directory, app.preferences.defaultWorkspace));
  const revision = 'sha256:' + sha('fixture');
  const skill = createNode('skill', {}, { id: 'code', config: { inputType: 'text', outputType: 'text', skillRef: 'fixture', version: revision } });
  document = { ...document, id: 'workflow-' + randomUUID(), nodes: document.nodes.map(node => node.id === 'code' ? skill : node) };
  app.skill = async () => ({ name: 'fixture', revision, source: 'fixture' });
  app.createSession = async options => { seen.push(options); return { id: 'fixture-session' }; };
  app.workflows.prepareSkill = async () => ({ text: 'fixture', skill: { name: 'fixture', revision }, cleanup: async () => {} });
  app.submit = async () => {};
  const skillRun = await app.workflows.start({ document, input: 'Skill输入' });
  assert.equal(seen.at(-1).cwd, join(app.workflowFolders.directory(document.id), 'runs', skillRun.id));
});
