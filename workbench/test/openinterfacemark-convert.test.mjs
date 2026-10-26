import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateInterfaceMarkOptions, validateInterfaceMarkProject, inspectInterfaceMarkPng, convertInterfaceMark, checkInterfaceMarkDependencies, OPENINTERFACEMARK_COMMIT } from '../scripts/openinterfacemark-convert.mjs';

const base = { projectPath: '/tmp/board.oim.json', outputDir: '/tmp/interface-test-out', basename: 'board-front' };

test('annotation converter pins upstream and rejects ambiguous output names or options', () => {
  assert.equal(OPENINTERFACEMARK_COMMIT, 'f8f92636b2eb87ac956997e77c9239cf483913fc');
  assert.equal(validateInterfaceMarkOptions(base).timeoutMs, 180000);
  for (const basename of ['', '.', '..', '../front', 'x/y', 'x\\y', 'x\u0000y']) assert.throws(() => validateInterfaceMarkOptions({ ...base, basename }), /basename/);
  for (const extra of [{ projectPath: 'image.png' }, { outputDir: '' }, { timeoutMs: 0 }, { timeoutMs: 600001 }]) assert.throws(() => validateInterfaceMarkOptions({ ...base, ...extra }));
});

test('annotation plan cannot be silently repaired, stripped or exported without actual regions', () => {
  const raw = { format: 'open-interface-mark', version: 1, name: 'test', image: {}, regions: [{ id: 'r1' }], exportSettings: { background: 'white', scale: 1 } };
  const validator = ({ format, version, ...document }) => structuredClone(document);
  assert.deepEqual(validateInterfaceMarkProject(raw, validator), raw);
  assert.throws(() => validateInterfaceMarkProject({ ...raw, version: 2 }, validator), /version 1/);
  assert.throws(() => validateInterfaceMarkProject({ ...raw, regions: [] }, validator), /actual planned/);
  assert.throws(() => validateInterfaceMarkProject({ ...raw, exportSettings: undefined }, validator), /exportSettings/);
  assert.throws(() => validateInterfaceMarkProject(raw, value => ({ ...validator(value), regions: [{ id: 'r1', x: 0 }] })), /change or discard/);
  assert.throws(() => validateInterfaceMarkProject({ ...raw, arbitraryField: true }, value => { const { arbitraryField, ...document } = validator(value); return document; }), /change or discard/);
});

test('annotation PNG verification rejects wrong signature, empty dimensions and excessive raster size', () => {
  assert.throws(() => inspectInterfaceMarkPng(Buffer.from('not PNG')), /not a PNG/);
  const bytes = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes); bytes.write('IHDR',12); bytes.writeUInt32BE(800,16); bytes.writeUInt32BE(600,20); bytes[25]=6;
  assert.deepEqual(inspectInterfaceMarkPng(bytes), { width:800, height:600, colorType:6 });
  bytes.writeUInt32BE(0,16); assert.throws(() => inspectInterfaceMarkPng(bytes), /dimensions/);
  bytes.writeUInt32BE(16000,16); bytes.writeUInt32BE(16000,20); assert.throws(() => inspectInterfaceMarkPng(bytes), /dimensions/);
});

test('invalid annotation input and cancellation fail before requiring a browser or converter checkout', async () => {
  const controller = new AbortController(); controller.abort(Error('cancelled offline'));
  await assert.rejects(convertInterfaceMark({ ...base, signal: controller.signal }), /cancelled offline/);
  const directory = await mkdtemp(join(tmpdir(), 'interface-input-test-'));
  try {
    const projectPath = join(directory, 'input.json');
    for (const [text, expected] of [['', /empty/], ['{', /not valid JSON/], ['{"format":"other","version":1}', /version 1/]]) {
      await writeFile(projectPath, text);
      await assert.rejects(convertInterfaceMark({ ...base, projectPath, repository:'/missing-converter', outputDir:join(directory,'output') }), expected);
    }
  } finally { await rm(directory, { recursive:true, force:true }); }
});

test('annotation dependency audit reports missing source and runtime without conversion', async () => {
  const result = await checkInterfaceMarkDependencies({ repository:'/missing-converter', playwrightPath:'/missing-playwright.mjs' });
  assert.equal(result.ready, false);
  assert.equal(result.checks.pinnedCommit, false);
  assert.equal(result.checks.dist, false);
  assert.equal(result.checks.playwrightReady, false);
});
