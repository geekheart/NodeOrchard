import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { capabilityEnvironment } from '../src/workflows/workflow-capabilities.mjs';
import { WorkflowRuns } from '../src/workflows/workflow-runs.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'capability-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('capability env permits explicit local path configuration while rejecting inherited workspace and credentials', () => {
  const context = { workspaceRoot: join(tmpdir(), 'configured-workspace') };
  const environment = {
    PATH: '/usr/bin:/bin', HOME: tmpdir(), WORKBENCH_WORKSPACE_ROOT: '/global-wrong-workspace',
    WORKBENCH_HDK_SOURCE_ROOT: '/local-input', WORKBENCH_HDK_PROCESS_TEMPLATE: '/local/template.xlsx',
    WORKBENCH_HDK_PINOUT_REFERENCE: '/local/pinout.png', WORKBENCH_HDK_ESPRESSIF_HOME: '/local/espressif',
    WORKBENCH_HDK_COMPILER_BIN: '/local/compiler', WORKBENCH_HDK_CMAKE_BIN: '/local/cmake',
    WORKBENCH_HDK_NINJA_BIN: '/local/ninja', WORKBENCH_HDK_RESOURCE_OVERLAY: '/local/resources.local.json',
    OPENAI_API_KEY: 'fixture-credential', WORKBENCH_HDK_ACCESS_TOKEN: 'fixture-credential',
    WORKBENCH_DATA_DIR: '/untrusted-data-directory', PYTHONPATH: '/untrusted-import',
  };
  const env = capabilityEnvironment(context, environment);
  assert.equal(env.WORKBENCH_WORKSPACE_ROOT, context.workspaceRoot);
  for (const key of Object.keys(environment).filter(key => key.startsWith('WORKBENCH_HDK_') && !key.endsWith('TOKEN'))) assert.equal(env[key], environment[key]);
  for (const key of ['OPENAI_API_KEY', 'WORKBENCH_HDK_ACCESS_TOKEN', 'WORKBENCH_DATA_DIR', 'PYTHONPATH']) assert.equal(env[key], undefined);
  assert.equal(capabilityEnvironment(undefined, environment).WORKBENCH_WORKSPACE_ROOT, undefined);
  for (const workspaceRoot of ['relative/path', 5, '/bad\0path']) assert.throws(() => capabilityEnvironment({ workspaceRoot }, environment), { code: 'CONTEXT_INVALID' });
});

test('a child Python process resolves the configured workspace resource overlay in isolation', async t => {
  const root = await temporary(t), workspaceRoot = join(root, 'workspace');
  await mkdir(join(workspaceRoot, 'config'), { recursive: true });
  const catalog = join(root, 'catalog.json'), sourcePath = join(root, 'private.pdf');
  await writeFile(catalog, JSON.stringify({ resources: [{ id: 'fixture', sha256: 'a'.repeat(64), url: 'https://example.invalid/manual.pdf' }] }));
  await writeFile(join(workspaceRoot, 'config/hdk-resources.local.json'), JSON.stringify({ schemaVersion: 1, resources: { fixture: { sourcePath } } }));
  const script = `import json, sys\nfrom pathlib import Path\nsys.path.insert(0, sys.argv[1])\nfrom hdk import datasheets\ndatasheets.CATALOG = Path(sys.argv[2])\nprint(json.dumps(datasheets.load_catalog(datasheets.CATALOG)['resources'][0]))`;
  const env = capabilityEnvironment({ workspaceRoot }, { PATH: process.env.PATH, HOME: tmpdir(), WORKBENCH_WORKSPACE_ROOT: join(root, 'wrong-global-workspace') });
  const run = spawnSync('python3', ['-I', '-B', '-c', script, fileURLToPath(new URL('../', import.meta.url)), catalog], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const resource = JSON.parse(run.stdout);
  assert.equal(resource.sourcePath, sourcePath); assert.equal(resource.sha256, 'a'.repeat(64));
});

test('DAG operation context binds app workspace and database independently from input fields', async t => {
  const root = await temporary(t);
  const db = new DatabaseSync(join(root, 'state.sqlite'));
  const app = new EventEmitter(); app.config = { workspaceRoot: root, dataDir: join(root, 'data'), appRoot: root }; app.store = { db }; app.preferences = {};
  app.publish = (type, sessionId, payload) => app.emit('event', { type, sessionId, payload });
  const requests = [];
  app.workflows = new WorkflowRuns(app, { executeOperation: async request => { requests.push(request); return { output: request.input }; } });
  t.after(async () => { await app.workflows.close(); db.close(); });
  const node = (type, id, config = {}) => createNode(type, { x: 0, y: 0 }, { id, config: { ...(type === 'input' ? { outputType: 'object' } : type === 'tool' ? { inputType: 'object', outputType: 'object', executionMode: 'code', language: 'javascript', code: 'return input;' } : {}), ...config } });
  let document = { ...createDocument({ title: 'Context isolation', schemaVersion: 2 }), nodes: [node('input', 'input'), node('tool', 'operation'), node('output', 'output')] };
  document = connectNodes(document, { sourceNode: 'input', sourcePort: 'out', targetNode: 'operation', targetPort: 'in' });
  document = connectNodes(document, { sourceNode: 'operation', sourcePort: 'out', targetNode: 'output', targetPort: 'in' });
  const input = { workspaceRoot: join(root, 'forged-workspace'), databasePath: join(root, 'forged.sqlite'), WORKBENCH_HDK_RESOURCE_OVERLAY: '/forged-overlay.json' };
  const run = await app.workflows.start({ document, input });
  for (let index = 0; index < 200 && !['complete', 'error'].includes(app.workflows.get(run.id).status); index++) await delay(5);
  assert.equal(app.workflows.get(run.id).status, 'complete'); assert.equal(requests.length, 1);
  assert.equal(requests[0].context.workspaceRoot, app.config.workspaceRoot);
  assert.equal(requests[0].context.databasePath, join(app.config.dataDir, 'workbench.sqlite'));
  assert.deepEqual(requests[0].input, input);
  assert.equal(capabilityEnvironment(requests[0].context, {}).WORKBENCH_HDK_RESOURCE_OVERLAY, undefined);
});
