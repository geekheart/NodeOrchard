import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCadOptions, convertStepToCad, cadDependenciesStatus, OPENSTEP2DWG_COMMIT } from '../scripts/openstep2dwg-convert.mjs';

const base = { inputStep: '/tmp/board.step', outputDir: '/tmp/cad-out', basename: 'WT9932P4C61-TINY_CAD_V1.0_2026-10-24', date: '2026-10-24' };

test('CAD wrapper keeps drawing units/options explicit and pins the actual upstream converter', () => {
  const result = validateCadOptions(base);
  assert.equal(OPENSTEP2DWG_COMMIT, 'afd6a844e39ba0a205918dc866b60211f978b2b9');
  assert.equal(result.detail, 'full');
  assert.equal(result.rotation, 0);
  assert.equal(result.layout, 'inspection');
  assert.equal(result.date, '2026-10-24');
});

test('CAD wrapper rejects output traversal and malformed STEP/model parameters before opening a browser', () => {
  for (const basename of ['../CAD', 'nested/CAD', 'nested\\CAD', '.', '..', 'bad\u0000CAD', '']) assert.throws(() => validateCadOptions({ ...base, basename }));
  for (const extra of [{ inputStep: 'not-a-step.dwg' }, { rotation: 45 }, { detail: 'strip-all' }, { layout: 'unknown' }, { timeoutMs: -1 }, { title: 'bad\nTitle' }]) assert.throws(() => validateCadOptions({ ...base, ...extra }));
});

test('CAD wrapper refuses ambiguous or invalid drawing dates', () => {
  for (const date of ['2026-02-30', '2026-13-01', '24-10-2026', '2026-1-1', undefined]) assert.throws(() => validateCadOptions({ ...base, date }));
  assert.equal(validateCadOptions({ ...base, date: '2028-02-29' }).date, '2028-02-29');
});

test('missing STEP fails offline before converter checkout or browser dependencies are needed', async () => {
  await assert.rejects(convertStepToCad({ ...base, inputStep: '/missing-offline-source.step', repository: '/missing-converter' }), { code: 'ENOENT' });
});

test('empty and non-STEP bytes fail offline without creating deliverables', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openstep-input-test-'));
  try {
    const inputStep = join(directory, 'source.step');
    for (const text of ['', 'This is not a STEP model']) {
      await writeFile(inputStep, text);
      await assert.rejects(convertStepToCad({ ...base, inputStep, repository: '/missing-converter', outputDir: join(directory, 'output') }), /STEP file is empty, invalid/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pre-cancelled CAD operation cannot launch a browser or read its source', async () => {
  const controller = new AbortController(); controller.abort(Error('cancelled offline'));
  await assert.rejects(convertStepToCad({ ...base, signal: controller.signal }), /cancelled offline/);
});

test('missing converter dependencies report not-ready without launching conversion', async () => {
  const status = await cadDependenciesStatus({ repository: '/missing-converter', verificationPython: '/missing-python' });
  assert.equal(status.ready, false);
  assert.equal(status.checks.pinnedCommit, false);
  assert.equal(status.checks.playwright, false);
  assert.equal(status.checks.ezdxf143, false);
});
