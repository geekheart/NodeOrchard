import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePreparedAlignment } from '../scripts/openpinmap-convert.mjs';
import { isPinoutLayoutError, pinoutDAGFailure, validateDAGPinoutRequest, parseDAGPinoutArguments } from '../scripts/openpinmap-dag-convert.mjs';

function fixture() {
  return { project: { format: 'openpinmap', version: 2, state: { width: 1000, height: 800, imageX: 250, imageY: 250, imageScale: 100,
    groups: [{ connector: 'J3', layout: 'vertical', labelRotation: 0, scale: 1, rotation: 0, mirrorX: false, mirrorY: false,
      gap: 50, pins: [{ name: 'GND' }, { name: 'IO1' }] }] } },
    alignment: { version: 1, image: { width: 400, height: 300 }, anchors: [{ connector: 'J3', side: 'left', firstPadPixel: [300, 350] }] } };
}
function thrown(fn) { try { fn(); } catch (error) { return error; } assert.fail('Expected an actual converter error'); }

test('the real imported parent alignment throw is a correctable layout choice', () => {
  const { project, alignment } = fixture();
  const error = thrown(() => resolvePreparedAlignment(project, alignment, [{ width: 100, height: 60 }]));
  assert.match(error.message, /capsule height 60/);
  assert.equal(isPinoutLayoutError(error), true, error.stack);
  assert.equal(pinoutDAGFailure(error).code, 'PINOUT_LAYOUT_INVALID');
  assert.equal(pinoutDAGFailure(error).error, error.message);
  const canvasError = thrown(() => resolvePreparedAlignment(project, alignment, [{ width: 400, height: 32 }]));
  assert.equal(isPinoutLayoutError(canvasError), true);
});

test('same-message errors, browser frames, causes and stderr strings are hard failures', () => {
  const { project, alignment } = fixture();
  const actual = thrown(() => resolvePreparedAlignment(project, alignment, [{ width: 100, height: 60 }]));
  assert.equal(isPinoutLayoutError(new Error(actual.message)), false);
  assert.equal(isPinoutLayoutError({ message: actual.message, stack: actual.stack }), false);
  assert.equal(isPinoutLayoutError(actual.message), false);
  assert.equal(isPinoutLayoutError(new Error(actual.message, { cause: actual })), false);
  const browser = new Error(actual.message);
  browser.stack = `Error: ${actual.message}\n    at resolvePreparedAlignment (http://127.0.0.1:49801/app.js:108:13)\n    at page.evaluate (http://127.0.0.1:49801/app.js:203:22)`;
  assert.equal(isPinoutLayoutError(browser), false);
  assert.equal(pinoutDAGFailure(browser).code, 'PINOUT_CONVERSION_FAILED');
});

test('real geometry and source-alignment failures are never softened', () => {
  const { project, alignment } = fixture();
  const errors = [
    thrown(() => resolvePreparedAlignment(project, { ...alignment, anchors: [] }, [{ width: 100, height: 32 }])),
    thrown(() => resolvePreparedAlignment(project, { ...alignment, anchors: [{ ...alignment.anchors[0], connector: 'wrong' }] }, [{ width: 100, height: 32 }])),
    thrown(() => resolvePreparedAlignment({ ...project, state: { ...project.state, groups: [{ ...project.state.groups[0], scale: 2 }] } }, alignment, [{ width: 100, height: 32 }])),
    Object.assign(new Error('ENOENT: source file not found'), { code: 'ENOENT' }),
  ];
  for (const error of errors) { assert.equal(isPinoutLayoutError(error), false); assert.equal(pinoutDAGFailure(error).code, 'PINOUT_CONVERSION_FAILED'); }
});

test('the wrapper accepts only bounded path metadata and emits structured CLI errors', () => {
  assert.deepEqual(validateDAGPinoutRequest({ projectPath: '/tmp/project.json', outputDir: '/tmp/output', basename: 'board' }),
    { projectPath: '/tmp/project.json', outputDir: '/tmp/output', basename: 'board' });
  for (const request of [null, [], {}, { projectPath: 'a.json', outputDir: '/tmp', basename: 'a', repository: '/untrusted' },
    { projectPath: 'a.json', outputDir: '/tmp', basename: '' }]) assert.throws(() => validateDAGPinoutRequest(request));
  const script = fileURLToPath(new URL('../scripts/openpinmap-dag-convert.mjs', import.meta.url));
  const invalid = spawnSync(process.execPath, [script], { input: '{"projectPath":"x.json"}', encoding: 'utf8' });
  assert.equal(invalid.status, 0);
  const envelope = JSON.parse(invalid.stdout); assert.equal(envelope.ok, false); assert.equal(envelope.code, 'PINOUT_CONVERSION_FAILED');
  const oversized = spawnSync(process.execPath, [script], { input: ' '.repeat(16385), encoding: 'utf8' });
  assert.equal(JSON.parse(oversized.stdout).code, 'PINOUT_CONVERSION_FAILED'); assert.match(oversized.stdout, /16 KiB/);
  assert.deepEqual(parseDAGPinoutArguments(['--project', '/tmp/p.json', '--output-dir', '/tmp/output', '--basename', 'board']), { projectPath: '/tmp/p.json', outputDir: '/tmp/output', basename: 'board' });
  assert.throws(() => parseDAGPinoutArguments(['--project', 'a.json', '--project', 'b.json']), /repeated/);
  const flags = spawnSync(process.execPath, [script, '--unknown', 'x'], { encoding: 'utf8' });
  assert.equal(flags.status, 0); assert.equal(JSON.parse(flags.stdout).code, 'PINOUT_CONVERSION_FAILED');
});
