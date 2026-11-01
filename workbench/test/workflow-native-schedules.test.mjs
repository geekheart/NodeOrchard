import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { WorkflowSchedules } from '../src/workflows/workflow-schedules.mjs';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';

class NativeFixture extends EventEmitter {
  constructor() { super(); this.definitions = []; this.finishes = []; this.polls = 0; }
  sync(definitions) { this.definitions = structuredClone(definitions); return Promise.resolve({ engine: 'hermes-native' }); }
  status() { return { engine: 'hermes-native', status: 'ready' }; }
  poll() { this.polls++; return Promise.resolve(); }
  finish(receipt, result) { this.finishes.push({ receipt, result }); return Promise.resolve(); }
  close() { this.closed = true; }
  fire(definition, extra = {}) {
    const receipt = { scheduleId: definition.id, key: definition.key, jobId: 'native-job-1', executionId: randomUUID().replaceAll('-', ''),
      scheduledAt: definition.nextRunAt, nextRunAt: '2026-11-03T01:00:00.000Z', ...extra };
    this.emit('fire', receipt); return receipt;
  }
}
function setup(t) {
  const app = new EventEmitter(), db = new DatabaseSync(':memory:'), engine = new NativeFixture();
  let clock = Date.parse('2026-11-01T00:00:00Z');
  app.store = { db }; app.adapter = { state: 'ready' }; app.backend = { state: 'ready' };
  app.publish = (type, _session, payload) => app.emit('event', { type, payload });
  app.started = []; app.workflows = { get: () => ({ status: 'complete' }), start: async (body, options) => {
    await app.gate?.(); if (!options.canStart()) throw new Error('定时任务已暂停。');
    const run = { id: randomUUID(), status: 'running', startedAt: new Date(clock).toISOString() };
    app.started.push(body); options.onCreated(run); return run;
  } };
  const manager = new WorkflowSchedules(app, { engine, now: () => clock });
  let document = createDocument(); document.nodes = [createNode('input', { x: 0, y: 0 }, { id: 'input', config: { outputType: 'text' } }),
    createNode('tool', { x: 1, y: 0 }, { id: 'trim', config: { executionMode: 'tool', toolName: 'text.trim', inputType: 'text', outputType: 'text' } }),
    createNode('output', { x: 2, y: 0 }, { id: 'output' })];
  for (const [sourceNode, targetNode] of [['input', 'trim'], ['trim', 'output']]) document = connectNodes(document, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
  const body = { name: 'native timer', document, input: ' input ', timing: { kind: 'daily', time: '09:00', timezone: 'Asia/Shanghai' } };
  t.after(async () => { await manager.close(); db.close(); });
  return { app, manager, engine, db, body, setClock: value => { clock = Date.parse(value); },
    settle: async () => { await manager.nativeSync; await Promise.allSettled([...manager.nativeDispatches]); } };
}

test('production scheduling submits metadata to Hermes and never locally discovers a due workflow', async t => {
  const f = setup(t), row = f.manager.create(f.body); await f.settle();
  assert.equal(f.engine.definitions.length, 1);
  assert.deepEqual(Object.keys(f.engine.definitions[0]).sort(), ['enabled', 'id', 'key', 'name', 'nextRunAt', 'timing']);
  assert.equal(JSON.stringify(f.engine.definitions).includes('text.trim'), false);
  f.setClock(row.nextRunAt); await f.manager.tick();
  assert.equal(f.engine.polls, 1); assert.equal(f.app.started.length, 0);
  assert.equal(f.manager.get(row.id).lastTrigger, null);
});

test('a native fire uses the frozen workflow, persists receipt and acknowledges only once', async t => {
  const f = setup(t), row = f.manager.create(f.body); await f.settle(); f.setClock(row.nextRunAt);
  const receipt = f.engine.fire(f.engine.definitions[0]); await f.settle();
  assert.equal(f.app.started.length, 1); assert.equal(f.app.started[0].input, ' input ');
  assert.equal(f.manager.get(row.id).lastTrigger.nativeExecutionId, receipt.executionId);
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM workflow_schedule_native_receipts').get().count, 1);
  assert.equal(f.engine.finishes[0].result.status, 'started');
  f.engine.emit('fire', receipt); await f.settle();
  assert.equal(f.app.started.length, 1);
});

test('pause and stale native receipts cannot create a run or revive old definitions', async t => {
  const f = setup(t), row = f.manager.create(f.body); await f.settle(); const previous = f.engine.definitions[0];
  f.manager.setEnabled(row.id, false); await f.settle(); f.setClock(row.nextRunAt);
  f.engine.fire(previous); await f.settle();
  assert.equal(f.app.started.length, 0); assert.equal(f.engine.finishes[0].result.status, 'cancelled');
  assert.equal(f.manager.get(row.id).enabled, false);
});

test('native failure does not fall back to an application due-time scan', async t => {
  const f = setup(t), row = f.manager.create(f.body); await f.settle(); f.setClock(row.nextRunAt);
  f.engine.poll = async () => { throw new Error('native unavailable'); };
  await assert.rejects(f.manager.tick(), /native unavailable/);
  assert.equal(f.app.started.length, 0); assert.equal(f.manager.get(row.id).lastTrigger, null);
});

test('pausing a native claim while admission awaits files cancels execution', async t => {
  const f = setup(t), row = f.manager.create(f.body); await f.settle(); f.setClock(row.nextRunAt);
  let release; f.app.gate = () => new Promise(resolve => { release = resolve; });
  f.engine.fire(f.engine.definitions[0]);
  assert.equal(f.manager.pending.size, 1);
  f.manager.setEnabled(row.id, false); release(); await f.settle();
  assert.equal(f.app.started.length, 0); assert.equal(f.engine.finishes[0].result.status, 'cancelled');
});
