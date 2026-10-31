import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDocument, createNode, connectNodes, validateDocument } from '../shared/workflow/workflow-model.mjs';
import { runMaintenanceReproduction } from '../src/application-maintenance-reproduction.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, config = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'maintenance-reproduction-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let document = { ...createDocument({ schemaVersion: 2 }), nodes: [
    createNode('input', {}, { id: 'input', config: { outputType: 'object', defaultValue: { value: 'frozen' } } }),
    createNode('tool', {}, { id: 'code', config: { inputType: 'object', outputType: 'object', code: 'return input;', ...config } }),
    createNode('output', {}, { id: 'output' }),
  ] };
  for (const [sourceNode, targetNode] of [['input', 'code'], ['code', 'output']]) document = connectNodes(document, { sourceNode, sourcePort: 'out', targetNode, targetPort: 'in' });
  const record = { id: document.id, revision: 4, lifecycle: 'active', document };
  const run = { id: 'run-frozen', workflowId: document.id, document: structuredClone(document), input: { value: 'original' },
    nodes: { input: { status: 'complete', output: { value: 'original' } }, code: { status: 'error', input: { value: 'original' } } }, sourceManifest: [] };
  const app = { config: { appRoot: root, projectRoot: root }, workflowLibrary: { get: () => structuredClone(record) }, workflows: { get: () => structuredClone(run) } };
  const input = { snapshot: { workflowId: document.id, expectedRevision: 4, runId: run.id, nodeIds: ['code'] }, inputSource: 'run', materials: [] };
  return { root, app, input, record, run, directory: join(root, 'isolated') };
}
const verified = { kind: 'macos-seatbelt', status: 'verified' };
const fakeSandbox = run => async () => ({ sandbox: verified, run });

test('frozen source run node input is isolated without starting or saving the original workflow', async t => {
  const f = await fixture(t); const before = JSON.stringify([f.record, f.run]); let calls = 0;
  f.app.workflows.start = f.app.workflowLibrary.save = () => { throw Error('original write'); };
  const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory,
    sandboxFactory: fakeSandbox(async options => { calls++; assert.equal(options.request.code, 'return input;');
      assert.deepEqual(options.request.input, { value: 'original' }); assert.ok(options.cwd.startsWith(f.directory));
      assert.equal(options.env.WORKBENCH_DATABASE_PATH, undefined); return { status: 'passed', exitCode: 0,
        envelope: { ok: true, output: { reproduced: true } }, stdout: 'diagnostic log', stderr: '' }; }) });
  assert.equal(result.status, 'passed'); assert.equal(calls, 1); assert.equal(result.policy.originalRunExecuted, false);
  assert.equal(result.policy.modelCalls, 0); assert.equal(result.policy.sourceWrites, false);
  assert.equal(result.nodeResults[0].output.reproduced, true); assert.match(result.snapshotHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify([f.record, f.run]), before);
});

test('saved default input is available but callers cannot submit code, commands, document or arbitrary input', async t => {
  const f = await fixture(t); const input = { ...f.input, snapshot: { ...f.input.snapshot, runId: undefined }, inputSource: 'defaults' };
  delete input.snapshot.runId;
  const result = await runMaintenanceReproduction(f.app, input, { directory: f.directory,
    sandboxFactory: fakeSandbox(async options => ({ status: 'passed', envelope: { ok: true, output: options.request.input }, stdout: '', stderr: '' })) });
  assert.deepEqual(result.nodeResults[0].output, { value: 'frozen' });
  for (const key of ['code', 'command', 'input', 'document', 'env', 'path']) {
    await assert.rejects(runMaintenanceReproduction(f.app, { ...input, [key]: 'untrusted' }, { directory: join(f.root, key) }), { code: 'REPRODUCTION_ARGUMENT_INVALID' });
  }
});

test('stale ownership, learning runs and child runs are rejected before sandbox execution', async t => {
  for (const mutation of [f => { f.record.revision++; }, f => { f.run.workflowId = 'other'; },
    f => { f.run.learningId = 'learning'; }, f => { f.run.memoryScopeId = 'memory'; }, f => { f.run.parentRunId = 'parent'; },
    f => { f.run.document.mode = 'learn'; }]) {
    const f = await fixture(t); mutation(f); let called = false;
    await assert.rejects(runMaintenanceReproduction(f.app, f.input, { directory: f.directory, sandboxFactory: async () => { called = true; } }));
    assert.equal(called, false);
  }
});

test('unverified or unavailable Seatbelt never runs business code and never falls back to host', async t => {
  for (const sandbox of [{ kind: 'macos-seatbelt', status: 'unavailable', code: 'sandbox_probe_failed' }, { kind: 'other', status: 'verified' }]) {
    const f = await fixture(t); let called = false;
    const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory,
      sandboxFactory: async () => ({ sandbox, run: async () => { called = true; } }) });
    assert.equal(result.status, 'unavailable'); assert.equal(called, false);
  }
});

test('non-macOS reports isolation unavailable before any business process', async t => {
  const f = await fixture(t);
  const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory, platform: 'linux' });
  assert.equal(result.status, 'unavailable'); assert.equal(result.sandbox.code, 'platform_unsupported');
});

test('one execution directory is a one-shot admission and cannot silently replay success or unknown work', async t => {
  const f = await fixture(t); let calls = 0;
  const options = { directory: f.directory, sandboxFactory: fakeSandbox(async () => { calls++; return { status: 'passed', envelope: { ok: true, output: null } }; }) };
  await runMaintenanceReproduction(f.app, f.input, options);
  await assert.rejects(runMaintenanceReproduction(f.app, f.input, options), { code: 'REPRODUCTION_REPLAY_REFUSED' });
  assert.equal(calls, 1);
});

test('an existing nonempty or symlink directory is never adopted as an isolated execution root', async t => {
  const f = await fixture(t); await mkdir(f.directory); await writeFile(join(f.directory, 'keep.txt'), 'original');
  await assert.rejects(runMaintenanceReproduction(f.app, f.input, { directory: f.directory }), { code: 'REPRODUCTION_DIRECTORY_INVALID' });
  assert.equal(await readFile(join(f.directory, 'keep.txt'), 'utf8'), 'original');
  const link = join(f.root, 'link'); await symlink(f.directory, link);
  await assert.rejects(runMaintenanceReproduction(f.app, f.input, { directory: link }), { code: 'REPRODUCTION_ARGUMENT_INVALID' });
});

test('hash-bound registered material is copied and exact frozen input paths are remapped', async t => {
  const f = await fixture(t), source = join(f.root, 'part.step'), bytes = Buffer.from('ISO-10303-21;fixture');
  await writeFile(source, bytes); f.run.nodes.code.input = { path: source };
  f.run.sourceManifest = { version: 1, workflowId: f.record.id,
    entries: [{ kind: 'file', path: source, sha256: digest(bytes), size: bytes.length }] };
  const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory,
    sandboxFactory: fakeSandbox(async options => { assert.notEqual(options.request.input.path, source);
      assert.deepEqual(await readFile(options.request.input.path), bytes);
      return { status: 'passed', envelope: { ok: true, output: { copied: true } } }; }) });
  assert.equal(result.status, 'passed'); assert.equal(result.materials.length, 1);
  assert.deepEqual(await readFile(source), bytes);
});

test('changed material hash and symlinked source material are refused before business execution', async t => {
  for (const linked of [false, true]) {
    const f = await fixture(t), source = join(f.root, 'part.step'); await writeFile(source, 'source');
    let path = source; if (linked) { path = join(f.root, 'link.step'); await symlink(source, path); }
    f.run.nodes.code.input = { path }; f.run.sourceManifest = [{ kind: 'file', path, sha256: digest(linked ? 'source' : 'different'), size: 6 }];
    let called = false; await assert.rejects(runMaintenanceReproduction(f.app, f.input, { directory: f.directory,
      sandboxFactory: async () => { called = true; } })); assert.equal(called, false);
  }
});

test('human node and unapproved upstream human gate remain waiting review without execution', async t => {
  const f = await fixture(t); f.run.document.nodes[1] = createNode('human', {}, { id: 'code' }); let called = false;
  const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory,
    sandboxFactory: async () => { called = true; } });
  assert.equal(result.status, 'waiting_review'); assert.equal(called, false); assert.equal(result.policy.automaticallyApprovesReviews, false);
});

test('logs and artifact manifests are bounded; symlinks are not registered as real artifacts', async t => {
  const f = await fixture(t);
  const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory,
    sandboxFactory: fakeSandbox(async options => { await writeFile(join(options.cwd, 'result.gif'), 'GIF89a-fixture');
      await symlink(join(f.root, 'not-readable'), join(options.cwd, 'escape'));
      return { status: 'passed', envelope: { ok: true, output: null }, stdout: 'token=PRIVATE ' + 'x'.repeat(100000), stderr: '' }; }) });
  assert.equal(result.status, 'passed'); assert.equal(result.logs.truncated, true);
  assert.ok(Buffer.byteLength(result.logs.stdout) <= 32768); assert.equal(result.logs.stdout.includes('PRIVATE'), false);
  assert.equal(result.artifacts.some(item => item.path.endsWith('escape')), false);
  assert.equal(result.artifacts.find(item => item.path.endsWith('result.gif')).requiresHumanReview, true);
  assert.equal(result.artifacts.every(item => /^[a-f0-9]{64}$/.test(item.sha256)), true);
});

test('pre-cancelled execution is not admitted and unsupported Skill does not start Hermes', async t => {
  const f = await fixture(t), abort = new AbortController(); abort.abort();
  await assert.rejects(runMaintenanceReproduction(f.app, f.input, { directory: f.directory, signal: abort.signal }), { code: 'ABORTED' });
  f.run.document.nodes[1] = createNode('skill', {}, { id: 'code', config: { inputType: 'object' } });
  const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory });
  assert.equal(result.status, 'unsupported'); assert.equal(result.code, 'node_type_unsupported');
});

test('pure built-in tools preserve the real executor input contract rather than coercing bad input', async t => {
  const f = await fixture(t, { executionMode: 'tool', toolName: 'text.trim', inputType: 'any', outputType: 'text' });
  const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory, sandboxFactory: fakeSandbox(async () => { throw Error('built-in must not launch code'); }) });
  assert.equal(result.status, 'failed'); assert.equal(result.nodeResults[0].errorCode, 'TOOL_INPUT_INVALID');
});

test('cancellation arriving with a worker result cannot become a successful reproduction receipt', async t => {
  const f = await fixture(t), controller = new AbortController();
  const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory, signal: controller.signal,
    sandboxFactory: fakeSandbox(async () => { controller.abort(); return { status: 'passed', envelope: { ok: true, output: 'partial' } }; }) });
  assert.equal(result.status, 'cancelled'); assert.equal(result.nodeResults[0].status, 'cancelled');
});

test('actual Seatbelt verifies external read/write and network denial before a frozen local-code fixture', { timeout: 120000 }, async t => {
  const code = `const fs = await import('node:fs');
    fs.writeFileSync(context.outputDirectory + '/fixture.txt', 'isolated-result');
    return { value: input.value, isolated: context.isolatedReproduction, hasCredentials: Boolean(process.env.OPENAI_API_KEY || process.env.HERMES_HOME) };`;
  const f = await fixture(t, { code });
  const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory });
  if (process.env.WORKBENCH_REPRODUCTION_NATIVE === '1') {
    assert.equal(result.status, 'passed', JSON.stringify({ status: result.status, code: result.code, sandbox: result.sandbox, nodes: result.nodeResults, logs: result.logs }));
    assert.equal(result.sandbox.status, 'verified');
    assert.deepEqual(result.nodeResults[0].output, { value: 'original', isolated: true, hasCredentials: false });
    assert.equal(result.artifacts.length, 1);
  } else if (result.status === 'unavailable') {
    assert.equal(result.sandbox.status, 'unavailable'); assert.equal(result.nodeResults.length, 0);
  } else {
    assert.equal(result.status, 'passed'); assert.equal(result.sandbox.status, 'verified');
  }
});

test('internal validated candidate replaces only isolated business config while source input and snapshot remain frozen', async t => {
  const f = await fixture(t), original = JSON.stringify(f.run), candidate = structuredClone(f.run.document);
  candidate.nodes[1].config.code = 'return { fixed: input.value };';
  candidate.nodes[0].config.defaultValue = { value: 'must-not-be-used' };
  const baseSnapshotHash = 'sha256:' + digest(JSON.stringify(validateDocument(f.run.document)));
  const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory,
    trustedCandidate: { document: candidate, baseSnapshotHash },
    sandboxFactory: fakeSandbox(async options => { assert.equal(options.request.code, candidate.nodes[1].config.code);
      assert.deepEqual(options.request.input, { value: 'original' });
      return { status: 'passed', envelope: { ok: true, output: { fixed: true } } }; }) });
  assert.equal(result.status, 'passed'); assert.equal(result.snapshotHash, baseSnapshotHash);
  assert.match(result.candidateHash, /^sha256:[a-f0-9]{64}$/); assert.notEqual(result.candidateHash, result.snapshotHash);
  assert.equal(JSON.stringify(f.run), original);
  await assert.rejects(runMaintenanceReproduction(f.app, { ...f.input, trustedCandidate: { document: candidate } },
    { directory: join(f.root, 'forbidden') }), { code: 'REPRODUCTION_ARGUMENT_INVALID' });
});

test('internal candidate cannot change source ownership, target node type or original human authorization', async t => {
  for (const change of [doc => { doc.id = 'other'; }, doc => { doc.mode = 'learn'; }, doc => { doc.nodes[1].type = 'transform'; }]) {
    const f = await fixture(t), candidate = structuredClone(f.run.document); change(candidate);
    await assert.rejects(runMaintenanceReproduction(f.app, f.input, { directory: f.directory, trustedCandidate: { document: candidate } }));
  }
  const f = await fixture(t), candidate = structuredClone(f.run.document);
  await assert.rejects(runMaintenanceReproduction(f.app, f.input, { directory: f.directory,
    trustedCandidate: { document: candidate, baseSnapshotHash: 'sha256:' + '0'.repeat(64) } }), { code: 'REPRODUCTION_CANDIDATE_STALE' });
  f.run.document.nodes[1] = createNode('human', {}, { id: 'code' });
  candidate.nodes[1] = createNode('human', {}, { id: 'code' });
  const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory, trustedCandidate: { document: candidate } });
  assert.equal(result.status, 'waiting_review');
});

test('actual isolated Python worker can launch the three fixed local CLI version commands', { timeout: 120000, skip: process.env.WORKBENCH_REPRODUCTION_NATIVE !== '1' }, async t => {
  const code = `import subprocess, re, pathlib
results = {}
for name, args, pattern in [('freecad', ['FreeCADCmd', '--log-file', context['outputDirectory'] + '/freecad.log', '--version'], r'FreeCAD\\s+(\\d+\\.\\d+\\.\\d+)'), ('blender', ['blender', '--background', '--factory-startup', '--version'], r'Blender\\s+(\\d+\\.\\d+\\.\\d+)'), ('ffmpeg', ['ffmpeg', '-version'], r'ffmpeg version\\s+(\\d+\\.\\d+\\.\\d+)')]:
    run = subprocess.run(args, capture_output=True, text=True, timeout=20)
    found = re.search(pattern, run.stdout + run.stderr)
    if run.returncode != 0 or not found:
        log = pathlib.Path(context['outputDirectory'], 'freecad.log')
        raise RuntimeError(name + ' version unavailable: ' + str(run.returncode) + ' ' + (run.stdout + run.stderr)[:1000] + (log.read_text()[:2000] if log.exists() else 'no-freecad-log'))
    results[name] = found.group(1)
return results`;
  const f = await fixture(t, { language: 'python', code });
  const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory });
  if (process.env.WORKBENCH_REPRODUCTION_NATIVE === '1') {
    assert.equal(result.status, 'passed', JSON.stringify({ status: result.status, code: result.code, sandbox: result.sandbox, nodes: result.nodeResults, logs: result.logs }));
    assert.deepEqual(Object.keys(result.nodeResults[0].output).sort(), ['blender', 'ffmpeg', 'freecad']);
  } else if (result.status === 'unavailable') assert.equal(result.nodeResults.length, 0);
  else assert.equal(result.status, 'passed', JSON.stringify(result.nodeResults));
});

test('native FreeCAD to Blender CPU frames to FFmpeg GIF stays inside the verified sandbox', {
  timeout: 180000, skip: process.env.WORKBENCH_REPRODUCTION_CLI_BUSINESS !== '1',
}, async t => {
  const code = `import pathlib, subprocess, os
root = pathlib.Path(context['outputDirectory'])
step, mesh = root / 'fixture.step', root / 'fixture.stl'
macro = root / 'fixture.FCMacro'
macro.write_text('\\n'.join(['import FreeCAD, Part, Mesh', 'doc=FreeCAD.newDocument("IsolatedFixture")', 'obj=doc.addObject("Part::Feature","Box")', 'obj.Shape=Part.makeBox(1,1,1)', 'doc.recompute()', 'obj.Shape.exportStep(' + repr(str(step)) + ')', 'Mesh.export([obj], ' + repr(str(mesh)) + ')']))
def invoke(args):
    run = subprocess.run(args, capture_output=True, text=True, timeout=65)
    if run.returncode != 0:
        crash = pathlib.Path(os.environ['TMPDIR'], 'blender.crash.txt')
        raise RuntimeError(str(args[0]) + ' failed: ' + str(run.returncode) + ' ' + (run.stdout + run.stderr)[-500:] + (crash.read_text()[-2500:] if crash.exists() else ''))
invoke(['FreeCADCmd', str(macro)])
script = root / 'blender-fixture.py'
script.write_text('\\n'.join(['import bpy', 'bpy.ops.wm.read_factory_settings(use_empty=True)', 'bpy.ops.wm.stl_import(filepath=' + repr(str(mesh)) + ')', 'obj=bpy.context.object', 'scene=bpy.context.scene', 'scene.render.engine="CYCLES"', 'scene.cycles.device="CPU"', 'scene.cycles.samples=1', 'scene.render.resolution_x=64', 'scene.render.resolution_y=64', 'scene.render.resolution_percentage=100', 'world=bpy.data.worlds.new("World")', 'world.use_nodes=True', 'world.node_tree.nodes["Background"].inputs[0].default_value=(0.5,0.6,0.7,1)', 'scene.world=world', 'camera=bpy.data.cameras.new("Camera")', 'cam=bpy.data.objects.new("Camera",camera)', 'scene.collection.objects.link(cam)', 'cam.location=(3,-4,3)', 'from mathutils import Vector', 'cam.rotation_euler=(Vector((0.5,0.5,0.5))-cam.location).to_track_quat("-Z","Y").to_euler()', 'scene.camera=cam', 'scene.render.image_settings.file_format="PNG"', 'for i in (1,2):', '    obj.location.x=(i-1)*0.3', '    scene.render.filepath=' + repr(str(root / 'frame')) + '+str(i)+".png"', '    bpy.ops.render.render(write_still=True)']))
invoke(['blender', '--background', '--factory-startup', '--python', str(script)])
gif = root / 'fixture.gif'
invoke(['ffmpeg', '-y', '-v', 'error', '-framerate', '2', '-i', str(root / 'frame%d.png'), str(gif)])
return {'step':step.exists(),'mesh':mesh.exists(),'frames':sum((root / ('frame' + str(i) + '.png')).exists() for i in (1,2)),'gifBytes':gif.stat().st_size}`;
  const f = await fixture(t, { language: 'python', code });
  const result = await runMaintenanceReproduction(f.app, f.input, { directory: f.directory });
  assert.equal(result.status, 'passed', JSON.stringify({ status: result.status, code: result.code, sandbox: result.sandbox, nodes: result.nodeResults, logs: result.logs }));
  assert.equal(result.sandbox.status, 'verified'); assert.equal(result.nodeResults[0].output.frames, 2);
  assert.equal(result.nodeResults[0].output.step, true); assert.ok(result.nodeResults[0].output.gifBytes > 100);
  const gif = result.artifacts.find(item => item.path.endsWith('fixture.gif'));
  assert.ok(gif); assert.equal(gif.requiresHumanReview, true); assert.equal(gif.reviewStatus, 'not-approved');
  const bytes = await readFile(join(f.directory, gif.path)); assert.match(bytes.subarray(0, 6).toString(), /^GIF8[79]a$/);
  if (process.env.WORKBENCH_REPRODUCTION_EVIDENCE_DIR) {
    const evidence = process.env.WORKBENCH_REPRODUCTION_EVIDENCE_DIR; await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'maintenance-reproduction-native.gif'), bytes);
    await writeFile(join(evidence, 'maintenance-reproduction-native.json'), JSON.stringify({ status: result.status, sandbox: result.sandbox,
      policy: result.policy, output: result.nodeResults[0].output, artifacts: result.artifacts, durationMs: result.durationMs }, null, 2));
  }
});

test('native cancellation stops an already-running isolated worker and timeout is never a successful receipt', {
  timeout: 120000, skip: process.env.WORKBENCH_REPRODUCTION_NATIVE !== '1',
}, async t => {
  const f = await fixture(t, { code: `const fs=await import('node:fs');fs.writeFileSync(context.outputDirectory+'/ready','1'); await new Promise(resolve=>setTimeout(resolve,60000));return {};` });
  const controller = new AbortController(); let detected = false, polling;
  const stop = new Promise(resolveStop => {
    polling = setInterval(async () => {
      if (await readFile(join(f.directory, 'workspace/code/ready')).then(() => true, () => false)) { detected = true; clearInterval(polling); controller.abort(); resolveStop(); }
    }, 20);
  });
  const pending = runMaintenanceReproduction(f.app, f.input, { directory: f.directory, signal: controller.signal });
  const safety = setTimeout(() => controller.abort(), 20000);
  let result;
  try { result = await pending; if (detected) await stop; } finally { clearInterval(polling); clearTimeout(safety); }
  assert.equal(detected, true); assert.equal(result.status, 'cancelled'); assert.equal(result.nodeResults[0].status, 'cancelled');
  const timed = await fixture(t, { code: 'await new Promise(resolve=>setTimeout(resolve,60000));return {};' });
  const expired = await runMaintenanceReproduction(timed.app, timed.input, { directory: timed.directory, timeoutMs: 50 });
  assert.equal(expired.status, 'failed'); assert.equal(expired.nodeResults[0].errorCode, 'REPRODUCTION_TIMEOUT');
});
