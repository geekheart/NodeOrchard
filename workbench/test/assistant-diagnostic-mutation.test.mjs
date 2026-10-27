import test from 'node:test';
import assert from 'node:assert/strict';
import { AssistantDiagnosticTurn, diagnosticRequestKey } from '../src/assistant-diagnostic-turn.mjs';

test('mutation receipts remain evidence without becoming reusable diagnostic cache', () => {
  const turn = new AssistantDiagnosticTurn({ scope: 'fixture' });
  for (const status of ['complete', 'partial', 'unknown']) {
    const args = { operationId: status }, key = diagnosticRequestKey('workflow.copy', args);
    turn.phase('mutation', '复制隔离样例');
    turn.record('workflow.copy', args, { operationId: status, status, executed: status === 'unknown' ? null : true }, { key, cacheable: false });
    assert.equal(turn.cache.has(key), false);
    assert.equal(turn.evidence.at(-1).status, status);
  }
  assert.equal(turn.transcript().length, 3);
  assert.deepEqual(turn.state.results, []);
  assert.equal(turn.state.mutationReceipts.length, 3);
  assert.equal(turn.state.mutationReceipts.at(-1).operationId, 'unknown');
});
