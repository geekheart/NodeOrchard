import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowRuns } from '../src/workflows/workflow-runs.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'capability-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

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
  const input = { workspaceRoot: join(root, 'forged-workspace'), databasePath: join(root, 'forged.sqlite'), outputDirectory: '/forged-output' };
  const run = await app.workflows.start({ document, input });
  for (let index = 0; index < 200 && !['complete', 'error'].includes(app.workflows.get(run.id).status); index++) await delay(5);
  assert.equal(app.workflows.get(run.id).status, 'complete'); assert.equal(requests.length, 1);
  assert.equal(requests[0].context.workspaceRoot, app.config.workspaceRoot);
  assert.equal(requests[0].context.databasePath, join(app.config.dataDir, 'workbench.sqlite'));
  assert.deepEqual(requests[0].input, input);
  assert.notEqual(requests[0].context.outputDirectory, input.outputDirectory);
});
