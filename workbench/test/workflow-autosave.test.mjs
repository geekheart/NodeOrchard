import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW_AUTOSAVE_DEFAULTS, workflowAutosavePolicy } from '../shared/workflow/workflow-autosave.mjs';

const defaults = { enabled: true, intervalMinutes: 10, intervalMs: 600_000 };

test('autosave defaults are frozen and missing or invalid preference containers use them', () => {
  assert.deepEqual(WORKFLOW_AUTOSAVE_DEFAULTS, { enabled: true, intervalMinutes: 10 });
  assert.equal(Object.isFrozen(WORKFLOW_AUTOSAVE_DEFAULTS), true);
  for (const value of [undefined, null, {}, [], '', 'false', 0, false, () => {}]) assert.deepEqual(workflowAutosavePolicy(value), defaults);
});

test('explicitly disabling autosave retains its valid interval', () => {
  assert.deepEqual(workflowAutosavePolicy({ workflowAutosaveEnabled: false, workflowAutosaveIntervalMinutes: 25 }),
    { enabled: false, intervalMinutes: 25, intervalMs: 1_500_000 });
  assert.deepEqual(workflowAutosavePolicy({ workflowAutosaveEnabled: false }), { ...defaults, enabled: false });
});

test('autosave accepts both minute boundaries without coercing values', () => {
  for (const intervalMinutes of [1, 1440]) assert.deepEqual(workflowAutosavePolicy({ workflowAutosaveIntervalMinutes: intervalMinutes }),
    { enabled: true, intervalMinutes, intervalMs: intervalMinutes * 60_000 });
  for (const value of [0, -1, 1441, 1.5, NaN, Infinity, -Infinity, '1', '1440', true, false, null, {}, [], 10n]) {
    assert.deepEqual(workflowAutosavePolicy({ workflowAutosaveIntervalMinutes: value }), defaults);
  }
});

test('bad enabled values fall back independently from a valid interval', () => {
  for (const value of ['false', 'true', 0, 1, null, [], {}, undefined]) assert.deepEqual(
    workflowAutosavePolicy({ workflowAutosaveEnabled: value, workflowAutosaveIntervalMinutes: 3 }),
    { enabled: true, intervalMinutes: 3, intervalMs: 180_000 });
});

test('autosave ignores inherited fields and never invokes accessors', () => {
  let reads = 0;
  const inherited = Object.create({ workflowAutosaveEnabled: false, workflowAutosaveIntervalMinutes: 1 });
  assert.deepEqual(workflowAutosavePolicy(inherited), defaults);
  const getters = Object.defineProperties({}, {
    workflowAutosaveEnabled: { get() { reads++; throw Error('must not read'); } },
    workflowAutosaveIntervalMinutes: { get() { reads++; throw Error('must not read'); } },
  });
  assert.deepEqual(workflowAutosavePolicy(getters), defaults); assert.equal(reads, 0);
  const unavailable = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('unavailable'); } });
  assert.deepEqual(workflowAutosavePolicy(unavailable), defaults);
});

test('normalization does not change input or share a mutable result with defaults', () => {
  const preferences = Object.freeze({ workflowAutosaveEnabled: false, workflowAutosaveIntervalMinutes: 7, extra: 'retained' });
  const before = { ...preferences }, value = workflowAutosavePolicy(preferences);
  assert.deepEqual(preferences, before); value.intervalMinutes = 500; value.enabled = true;
  assert.deepEqual(workflowAutosavePolicy(preferences), { enabled: false, intervalMinutes: 7, intervalMs: 420_000 });
  assert.deepEqual(workflowAutosavePolicy(Object.create(null)), defaults);
});
