import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { AssistantDiagnosticTurn } from '../src/assistant-diagnostic-turn.mjs';

test('a default diagnostic wait has no local deadline beyond six minutes and still honors user cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const turn = new AssistantDiagnosticTurn({ scope: 'fixture', evidence: {} }), controller = new AbortController();
  let resolve, settled = false; const pending = turn.wait(new Promise(done => { resolve = done; }), controller.signal);
  pending.then(() => { settled = true; }, () => { settled = true; });
  t.mock.timers.tick(600000); await new Promise(done => setImmediate(done));
  assert.equal(settled, false); assert.equal(turn.maxDurationMs, null);
  resolve('confirmed provider result'); assert.equal(await pending, 'confirmed provider result');
  const cancelled = turn.wait(new Promise(() => {}), controller.signal); cancelled.catch(() => {});
  t.mock.timers.tick(600000); controller.abort(); await assert.rejects(cancelled, error => error.code === 'ABORT_ERR');
});

test('an expired parent wait consumes an already-created real model rejection without crashing the process', () => {
  const modelURL = new URL('../src/workflows/learning-model.mjs', import.meta.url).href;
  const diagnosticURL = new URL('../src/assistant-diagnostic-turn.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { EventEmitter } from 'node:events';
    import { DatabaseSync } from 'node:sqlite';
    import { LearningModel } from ${JSON.stringify(modelURL)};
    import { AssistantDiagnosticTurn } from ${JSON.stringify(diagnosticURL)};
    let at = 1000000; Date.now = () => at;
    const app = new EventEmitter(), db = new DatabaseSync(':memory:');
    app.store = { db }; app.interrupt = async () => {};
    let sessions = 0; app.createSession = async () => { sessions++; throw new Error('Expired calls cannot create sessions.'); };
    const model = new LearningModel(app, { purpose: 'assistant' });
    const turn = new AssistantDiagnosticTurn({ scope: 'fixture', evidence: {}, maxDurationMs: 1 });
    at += 2;
    await assert.rejects(turn.wait(model.generate('Fixed fixture only.', { deadlineAt: turn.started + turn.maxDurationMs })),
      error => error.code === 'ASSISTANT_TURN_TIMEOUT');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sessions, 0); assert.equal(model.pending.size, 0);
    await model.close(); db.close();
    console.log('expired-parent-wait-complete');
  `;
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '--eval', script],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /expired-parent-wait-complete/);
});

test('an admitted wait still propagates the authoritative rejection unchanged', async () => {
  const turn = new AssistantDiagnosticTurn({ scope: 'fixture', evidence: {} });
  const error = new Error('authoritative fixture failure');
  await assert.rejects(turn.wait(Promise.reject(error)), value => value === error);
});
