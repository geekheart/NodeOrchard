// Migration protocol tests only. No model, exporter, CAD converter, compiler or
// production workflow executes here; isolated artifacts do not attest HDK quality.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDocument, createNode, connectNodes } from '../shared/workflow/workflow-model.mjs';
import { WorkflowFiles } from '../src/workflows/workflow-files.mjs';
import { WorkflowRuns } from '../src/workflows/workflow-runs.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const python = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const id = () => 'node-' + randomUUID();
const digest = value => createHash('sha256').update(value).digest('hex');
function runPython(source, input) {
  return JSON.parse(execFileSync(python, ['-I', '-B', '-c', "import sys\nsys.path.insert(0, sys.argv[1])\n" + source, root], {
    cwd: root, input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1024 * 1024,
  }));
}
async function until(check) {
  for (let attempt = 0; attempt < 1200; attempt++) { const result = check(); if (result) return result; await delay(5); }
  throw Error('Timed out waiting for isolated migration protocol run');
}

test('fresh IDs and input validation keep manifest binding; reviewed stage outputs preserve a direct approval and final result', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'workflow-version-protocol-')));
  const db = new DatabaseSync(join(directory, 'workbench.sqlite'));
  const app = new EventEmitter(); app.store = { db }; app.config = { workspaceRoot: directory, dataDir: directory }; app.preferences = {};
  app.publish = (type, sessionId, payload) => app.emit('event', { type, sessionId, payload });
  app.workflowFiles = new WorkflowFiles(app, { allowedRoots: [directory] });
  const calls = [];
  const manager = new WorkflowRuns(app, { executeOperation: async ({ node, input, cwd, context }) => {
    calls.push(node.id);
    // Exercise the real Python current-run/attempt/directory binder against the
    // actual JS engine's SQLite record; do not substitute its checks with a stub.
    const bound = runPython(`
import json
from pathlib import Path
from hdk import dag_capabilities as api
p = json.loads(sys.stdin.read())
api.DATABASE = Path(p['context']['databasePath'])
run, root, out = api.bound(p['operation'], p['input'], p['context'])
assert run['document']['id'] == p['context']['workflowId']
assert run['nodes'][p['context']['nodeId']]['input'] == p['input']
if p['review']:
    value = p['input']
    approved = api.reviewed_artifacts(run, p['context'], value,
        [{'path': value['path'], 'sha256': api.sha(value['path'])}], port='in')
    print(json.dumps({'approvedNodeId': approved['nodeId']}))
else:
    print(json.dumps({'workflowId': run['workflowId'], 'sourcePath': p['input']['sourcePath']}))
`, { context, operation: node.config.toolName, input, review: node.id === consumer.id });
    if (node.id === producer.id) {
      assert.equal(bound.sourcePath, sourcePath);
      const path = join(cwd, 'protocol-candidate.svg');
      await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12"/></svg>');
      return { output: { path, sourcePath, sourceSha256: digest(sourceBytes) }, artifacts: [{ path, kind: 'image' }] };
    }
    assert.equal(bound.approvedNodeId, review.id);
    return { output: { protocolApproved: true, sourceSha256: input.sourceSha256 } };
  } }); app.workflows = manager;
  t.after(async () => { await manager.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  const sourceBytes = 'isolated source binding fixture, not a real EPRO2';
  const sourcePath = join(directory, 'source.epro2'); await writeFile(sourcePath, sourceBytes);
  const make = (type, config = {}) => createNode(type, { x: 0, y: 0 }, { id: id(), config });
  const inputNode = make('input', { outputType: 'object', fieldName: 'sources', fields: [
    { key: 'sourcePath', label: '原始工程', kind: 'file', required: true, extensions: ['.epro2'], role: 'source' },
    { key: 'productCode', label: '产品型号', kind: 'text', required: true },
  ] });
  const validation = make('validation', { inputType: 'object', outputType: 'object', rules: [
    { valuePath: 'sourcePath', check: 'nonempty' }, { valuePath: 'productCode', check: 'nonempty' },
  ] });
  const producer = make('tool', { executionMode: 'tool', toolName: 'hdk.full.prepare', inputType: 'object', outputType: 'object', reviewImages: true });
  const review = make('human', { inputType: 'object', outputType: 'object', reviewTargetNodeId: producer.id });
  const consumer = make('tool', { executionMode: 'tool', toolName: 'hdk.full.verify-delivery', inputType: 'object', outputType: 'object' });
  const finalNode = make('output', { stage: 'final', fileName: '最终协议结果.json' });
  // Deliberately append a stage after the final node: final result semantics
  // must use stage classification rather than array order or currentNodeId.
  const stage = make('output', { stage: 'intermediate', fileName: '审核后阶段回执.json' });
  let document = { ...createDocument({ schemaVersion: 2, title: '迁移协议验收（无硬件执行）' }),
    nodes: [inputNode, validation, producer, review, consumer, finalNode, stage] };
  for (const [source, target] of [[inputNode, validation], [validation, producer], [producer, review], [review, consumer], [consumer, finalNode], [review, stage]]) {
    document = connectNodes(document, { sourceNode: source.id, sourcePort: 'out', targetNode: target.id, targetPort: 'in' });
  }
  const started = await manager.start({ document, input: { sourcePath, productCode: 'PROTOCOL-ONLY' } });
  const waiting = await until(() => ['waiting_review', 'error', 'unknown'].includes(manager.get(started.id).status) && manager.get(started.id));
  assert.equal(waiting.status, 'waiting_review', waiting.error);
  assert.deepEqual(calls, [producer.id]);
  assert.equal(waiting.nodes[validation.id].validation.passed, true);
  assert.deepEqual(waiting.nodes[producer.id].input, waiting.nodes[inputNode.id].output);
  assert(waiting.sourceManifest.entries.every(entry => entry.nodeId === inputNode.id));
  assert.equal(waiting.sourceManifest.workflowId, document.id);
  assert.equal(waiting.sourceManifest.entries.find(entry => entry.key === 'sourcePath').sha256, digest(sourceBytes));
  assert.equal(waiting.nodes[stage.id].status, 'pending');
  await manager.approve(started.id, { nodeId: review.id, action: 'approve' });
  const complete = await until(() => manager.get(started.id).status === 'complete' && manager.get(started.id));
  assert.deepEqual(calls, [producer.id, consumer.id]);
  assert.deepEqual(complete.output, { protocolApproved: true, sourceSha256: digest(sourceBytes) });
  assert.deepEqual(complete.stageOutputs[stage.id], complete.nodes[review.id].output);
  assert.deepEqual(JSON.parse(await readFile(complete.nodes[stage.id].savedPath, 'utf8')), complete.nodes[review.id].output);
  assert.equal(complete.nodes[consumer.id].input.path, complete.nodes[producer.id].output.path);
});

test('archiving an old workflow keeps explicit foreign receipt imports valid but never relaxes run, source or approval integrity', () => {
  const result = runPython(`
import copy, importlib.util, json, sqlite3
from pathlib import Path
spec = importlib.util.spec_from_file_location('migration_real_receipt_fixture', Path(sys.argv[1]) / 'test/hdk-dag-capabilities.test.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
case = m.DAGCapabilityBoundaries('runTest')
case.setUp()
try:
    api = m.capability
    token = case.completed_parent()
    case.run['status'] = 'complete'; case.save_run()
    with sqlite3.connect(case.db_path) as db:
        db.execute('CREATE TABLE workflow_lifecycle(workflow_id TEXT PRIMARY KEY,lifecycle TEXT NOT NULL)')
        db.execute('INSERT INTO workflow_lifecycle VALUES(?,?)', (case.workflow_id, 'archived'))
    imported = api.foreign_receipt(token['receiptPath'], 'hdk.four.prepare', api.sha(case.source))
    assert imported['importedReceipt']['nodeId'] == 'prepare'
    assert imported['request']['images'] == case.images
    rejected = []
    original = copy.deepcopy(case.run)
    for change in ('learning', 'waiting_review', 'new-attempt'):
        case.run = copy.deepcopy(original)
        if change == 'learning': case.run['learningId'] = 'isolated-learning'
        elif change == 'waiting_review': case.run['status'] = 'waiting_review'
        else: case.run['nodes']['prepare']['attempt'] = 2
        case.save_run()
        try: api.foreign_receipt(token['receiptPath'], 'hdk.four.prepare', api.sha(case.source))
        except ValueError: rejected.append(change)
    assert len(rejected) == 3
    case.run = original; case.save_run(); case.source.write_bytes(b'changed input after old approval')
    try: api.foreign_receipt(token['receiptPath'], 'hdk.four.prepare')
    except ValueError: rejected.append('modified-source')
    assert len(rejected) == 4
    print(json.dumps({'archivedImportAccepted': True, 'rejected': rejected}))
finally: case.doCleanups()
`, {});
  assert.equal(result.archivedImportAccepted, true);
  assert.deepEqual(result.rejected, ['learning', 'waiting_review', 'new-attempt', 'modified-source']);
});

test('fresh Skill and image IDs preserve actual guide plan provenance despite sibling stage outputs', () => {
  const result = runPython(`
import copy, json
from hdk.guide_dag import _skill
p = json.loads(sys.stdin.read())
skill_id, image_id, stage_id = p['ids']
facts = {'current': 'source-bound-guide-facts'}
plan = {'labels': ['J7 Reset', 'J8 BOOT']}
run = {'document': {'nodes': [
    {'id': skill_id, 'type': 'skill', 'config': {'skillRef': 'fixed-annotation', 'version': 'sha256:' + 'a'*64}},
    {'id': image_id, 'type': 'tool'}, {'id': stage_id, 'type': 'output'}],
    'edges': [{'sourceNode': skill_id, 'targetNode': image_id, 'targetPort': 'plan'},
              {'sourceNode': image_id, 'targetNode': stage_id, 'targetPort': 'in'}]},
    'nodes': {skill_id: {'status': 'complete', 'input': facts, 'output': plan}}}
proof = _skill(run, {'nodeId': image_id}, plan, facts)
assert proof == {'nodeId': skill_id, 'ref': 'fixed-annotation', 'version': 'sha256:' + 'a'*64}
forged = copy.deepcopy(run); forged['document']['edges'][0]['sourceNode'] = stage_id
try: _skill(forged, {'nodeId': image_id}, plan, facts)
except ValueError: pass
else: raise AssertionError('a stage output cannot replace the true plan Skill')
try: _skill(run, {'nodeId': image_id}, plan, {'other': 'facts'})
except ValueError: pass
else: raise AssertionError('other facts must not bind to the current plan')
print(json.dumps(proof))
`, { ids: [id(), id(), id()] });
  assert.equal(result.ref, 'fixed-annotation'); assert.equal(result.version, 'sha256:' + 'a'.repeat(64));
});

test('guide import finds the unique prepared photo source after validation and stages, including archived source workflows', () => {
  const result = runPython(`
import copy, importlib.util, json, os, shutil, sqlite3
from pathlib import Path
from hdk.guide_dag import _four_photo_binding
p = json.loads(sys.stdin.read())
prepare_id, input_id, validation_id, human_id, verify_id, stage_id = p['ids']
spec = importlib.util.spec_from_file_location('migration_photo_source_fixture', Path(sys.argv[1]) / 'test/hdk-dag-capabilities.test.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
case = m.DAGCapabilityBoundaries('runTest'); case.setUp()
try:
    api = m.capability
    case.out = case.output / prepare_id / '版本-1'; case.out.mkdir(parents=True)
    record = case.run['nodes'].pop('prepare'); record['outputDirectory'] = str(case.out)
    case.run['nodes'][prepare_id] = record
    case.run['document']['nodes'][0]['id'] = prepare_id
    case.context.update(nodeId=prepare_id, outputDirectory=str(case.out))
    os.environ['HDK_NODE_ID'] = prepare_id; case.save_run()
    prepared_token = api.four('hdk.four.prepare', case.value, case.context)
    case.run['nodes'][prepare_id].update(status='complete', output=prepared_token)
    case.save_run()
    exported = []
    for image in case.images:
        path = case.output / ('TEST_Pinout_' + image['side'] + '.png')
        shutil.copyfile(image['path'], path)
        exported.append({'path': str(path), 'sha256': api.sha(path)})
    artifacts = [dict(item, id='registered-' + str(i)) for i, item in enumerate(exported)]
    hashes = [{'id': item['id'], 'sha256': item['sha256']} for item in artifacts]
    reviewed_value = {'front': {'bound': 'current-front'}, 'back': {'bound': 'current-back'}}
    case.run['nodes'][human_id] = {'status': 'complete', 'output': reviewed_value,
        'artifacts': artifacts, 'review': {'decision': 'approved', 'reviewedAt': '2026-10-26T00:00:00Z', 'artifactHashes': hashes}}
    case.run['nodes'][input_id] = {'status': 'complete', 'output': copy.deepcopy(case.value)}
    case.run['nodes'][validation_id] = {'status': 'complete', 'output': copy.deepcopy(case.value)}
    case.run['document']['nodes'][0:0] = [
        {'id': input_id, 'type': 'input'}, {'id': validation_id, 'type': 'validation'}]
    case.run['document']['nodes'].extend([
        {'id': human_id, 'type': 'human'}, {'id': verify_id, 'type': 'tool', 'config': {'toolName': 'hdk.four.verify'}},
        {'id': stage_id, 'type': 'output', 'config': {'stage': 'intermediate'}}])
    case.run['document']['edges'].extend([
        {'sourceNode': input_id, 'targetNode': validation_id, 'targetPort': 'in'},
        {'sourceNode': validation_id, 'targetNode': prepare_id, 'targetPort': 'in'},
        {'sourceNode': human_id, 'targetNode': verify_id, 'targetPort': 'images'},
        {'sourceNode': human_id, 'targetNode': stage_id, 'targetPort': 'in'}])
    out = case.output / verify_id / '版本-1'; out.mkdir(parents=True)
    os.environ['HDK_NODE_ID'] = verify_id
    token = api.receipt('hdk.four.verify', {'status': 'complete', 'checks': {'source': True},
        'sourceSha256': api.sha(case.source), 'humanReview': {'nodeId': human_id, 'artifactHashes': hashes},
        'proofFiles': exported}, case.run, out)
    case.run['nodes'][verify_id] = {'status': 'complete', 'output': token,
        'outputDirectory': str(out), 'attempt': 1, 'attemptId': 'verify-photo-attempt'}
    case.run['status'] = 'complete'; case.save_run()
    with sqlite3.connect(case.db_path) as db:
        db.execute('CREATE TABLE workflow_lifecycle(workflow_id TEXT PRIMARY KEY,lifecycle TEXT NOT NULL)')
        db.execute('INSERT INTO workflow_lifecycle VALUES(?,?)', (case.workflow_id, 'archived'))
    imported = api.foreign_receipt(token['receiptPath'], 'hdk.four.verify', api.sha(case.source))
    request = {'images': copy.deepcopy(case.images), 'productCode': case.value['productCode']}
    photo_source = _four_photo_binding(imported, request, api)
    assert photo_source['importedReceipt']['nodeId'] == prepare_id
    assert photo_source['request']['images'] == case.images
    wrong = copy.deepcopy(request); wrong['images'][0]['sha256'] = '0'*64
    try: _four_photo_binding(imported, wrong, api)
    except ValueError: pass
    else: raise AssertionError('archival cannot relax photo/source matching')
    print(json.dumps({'preparedNodeId': prepare_id, 'archiveAccepted': True, 'differentPhotoRejected': True}))
finally: case.doCleanups()
`, { ids: [id(), id(), id(), id(), id(), id()] });
  assert.equal(result.archiveAccepted, true); assert.equal(result.differentPhotoRejected, true);
  assert.match(result.preparedNodeId, /^node-/);
});
