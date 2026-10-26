"""DAG capability boundaries using real temporary SQLite, ZIP and image files.

No EDA export, CAD conversion, Hermes, model, or production release gate is run.
Passing these tests establishes handoff integrity, not hardware verification.
"""
import concurrent.futures
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid
import zipfile

from PIL import Image

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
SPEC = importlib.util.spec_from_file_location('hdk_dag_boundaries', REPO / 'hdk/dag_capabilities.py')
capability = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capability)


class DAGCapabilityBoundaries(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='hdk-dag-boundaries-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.db_path = self.root / '.local/workbench.sqlite'
        self.db_path.parent.mkdir()
        with sqlite3.connect(self.db_path) as db:
            for table in ('workflow_runs', 'workflow_file_runs'):
                db.execute('CREATE TABLE ' + table + '(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
        self.run_id = str(uuid.uuid4())
        self.workflow_id = 'board-dag-fixture'
        self.output = self.root / 'outputs' / self.run_id
        self.out = self.output / 'prepare' / '版本-1'
        self.out.mkdir(parents=True)
        self.source = self.root / 'board.epro2'
        body = '\n'.join(json.dumps({'type': 'DOCHEAD'}) + '||' + json.dumps({'uuid': uid, 'docType': kind}) + '|'
                         for kind, uid in [('PCB', 'pcb-source'), ('SCH_PAGE', 'sch-source')])
        with zipfile.ZipFile(self.source, 'w') as archive:
            archive.writestr('project2.json', '{"title":"Test-only source"}')
            archive.writestr('source.epru', body)
        self.images = []
        for side, color in [('front', (30, 80, 100)), ('back', (70, 90, 100))]:
            path = self.root / (side + '.png')
            Image.new('RGB', (120, 200), color).save(path)
            self.images.append({'side': side, 'path': str(path), 'sha256': capability.sha(path)})
        self.profile_path = self.root / 'reviewed-photo-calibration.json'
        self.profile = {'format': 'workbench-pinout-photo-calibration', 'version': 1,
                        'sourceSha256': capability.sha(self.source), 'pcbUuid': 'pcb-source',
                        'views': [{'side': image['side'], 'reviewStatus': 'visually-reviewed', 'orientationReviewed': True,
                                   'expectedDeterminantSign': -1 if image['side'] == 'front' else 1,
                                   'image': {'sha256': image['sha256'], 'width': 120, 'height': 200}}
                                  for image in self.images]}
        self.save_profile()
        self.value = {'sourcePath': str(self.source), 'productCode': 'TEST', 'hardwareVersion': '1.0',
                      'releaseDate': '2026-10-25', 'images': self.images,
                      'pinoutPhotoProfilePath': str(self.profile_path)}
        self.attempt_id = str(uuid.uuid4())
        self.run = {'id': self.run_id, 'workflowId': self.workflow_id, 'schemaVersion': 2, 'status': 'running',
                    'document': {'schemaVersion': 2, 'nodes': [
                        {'id': 'prepare', 'type': 'tool', 'config': {'toolName': 'hdk.four.prepare'}}], 'edges': []},
                    'nodes': {'prepare': {'status': 'running', 'input': copy.deepcopy(self.value), 'attempt': 1,
                                          'attemptId': self.attempt_id, 'outputDirectory': str(self.out)}}}
        self.context = {'runId': self.run_id, 'workflowId': self.workflow_id, 'nodeId': 'prepare',
                        'attempt': 1, 'attemptId': self.attempt_id, 'outputDirectory': str(self.out),
                        'runOutputDirectory': str(self.output)}
        self.save_run()
        self.save_row('workflow_file_runs', self.run_id, {'runId': self.run_id, 'outputDirectory': str(self.output)})
        mocked = patch.object(capability, 'ROOT', self.root)
        mocked.start(); self.addCleanup(mocked.stop)
        if hasattr(capability, 'DATABASE'):
            mocked = patch.object(capability, 'DATABASE', self.db_path)
            mocked.start(); self.addCleanup(mocked.stop)
        mocked = patch.dict(os.environ, {'HDK_NODE_ID': 'prepare'}, clear=False)
        mocked.start(); self.addCleanup(mocked.stop)

    def save_row(self, table, ident, value):
        with sqlite3.connect(self.db_path) as db:
            db.execute('INSERT OR REPLACE INTO ' + table + '(id,value) VALUES(?,?)', (ident, json.dumps(value)))

    def save_run(self):
        self.save_row('workflow_runs', self.run_id, self.run)

    def save_profile(self):
        self.profile_path.write_text(json.dumps(self.profile))

    def completed_parent(self):
        receipt = capability.four('hdk.four.prepare', self.value, self.context)
        self.run['nodes']['prepare'].update(status='complete', output=receipt)
        self.save_run()
        return receipt

    def reference_parent(self):
        self.run['document']['nodes'][0]['config']['executionMode']='tool'
        proof=self.out/'proof.txt';proof.write_text('actual output evidence')
        data=capability.prepare(self.value)
        full=capability.receipt('hdk.four.prepare',data|{'proofFiles':[{'path':str(proof),'sha256':capability.sha(proof)}]},
            self.run,self.out,extra={'skillInput':{'largeActualInput':'source facts '*5000}})
        self.run['nodes']['prepare'].update(status='complete',output=full);self.save_run()
        reference={key:full[key] for key in ('runId','nodeId','operation','receiptPath','receiptSha256')}
        reference.update(kind='hdk-node-receipt-ref',attempt=1,attemptId=self.attempt_id)
        return full,reference,proof

    def test_compact_reference_loads_the_actual_full_receipt_with_large_skill_input_and_original_checks(self):
        full,reference,_=self.reference_parent();before=copy.deepcopy(self.run)
        self.assertGreater(len(json.dumps(full).encode()),60000)
        self.assertLess(len(json.dumps(reference).encode()),1000)
        self.assertEqual(capability.load(reference,self.run,'hdk.four.prepare'),capability.load(full,self.run,'hdk.four.prepare'))
        self.assertEqual(self.run,before)
        self.assertEqual(set(reference),capability.RECEIPT_REF_FIELDS)

    def test_reference_exact_fields_foreign_run_and_all_changed_identity_values_are_rejected(self):
        _,reference,_=self.reference_parent()
        invalid=[reference|{'extra':'untrusted'}, {k:v for k,v in reference.items() if k!='attempt'},
            reference|{'runId':str(uuid.uuid4())},reference|{'nodeId':'different-producer'},
            reference|{'operation':'hdk.four.native'},reference|{'receiptSha256':'f'*64},
            reference|{'receiptPath':str(self.out/'different.json')},reference|{'kind':'hdk-node-receipt'},
            reference|{'attemptId':''},reference|{'receiptSha256':'x'*64}]
        for value in invalid:
            with self.subTest(value=value),self.assertRaises(ValueError):capability.load(value,self.run)

    def test_reference_attempt_and_attempt_id_are_exact_current_values_not_coerced(self):
        _,reference,_=self.reference_parent()
        for patch_value in [{'attempt':2},{'attempt':True},{'attempt':0},{'attempt':'1'},{'attemptId':str(uuid.uuid4())}]:
            with self.subTest(patch=patch_value),self.assertRaises(ValueError):capability.load(reference|patch_value,self.run)
        self.run['nodes']['prepare']['attempt']=2;self.save_run()
        with self.assertRaises(ValueError):capability.load(reference,self.run)

    def test_reference_rejects_non_tool_code_wrong_frozen_operation_or_noncurrent_output(self):
        _,reference,_=self.reference_parent();original=copy.deepcopy(self.run)
        mutations=[lambda r:r['nodes']['prepare'].update(status='running'),
            lambda r:r['document']['nodes'][0].update(type='skill'),
            lambda r:r['document']['nodes'][0]['config'].update(executionMode='code'),
            lambda r:r['document']['nodes'][0]['config'].update(toolName='hdk.four.native'),
            lambda r:r['nodes']['prepare']['output'].update(kind='untrusted-receipt'),
            lambda r:r['nodes']['prepare']['output'].update(nodeId='different-producer'),
            lambda r:r['nodes']['prepare'].update(attemptId=str(uuid.uuid4())),
            lambda r:r['document']['nodes'].clear()]
        for mutate in mutations:
            self.run=copy.deepcopy(original);mutate(self.run);self.save_run()
            with self.subTest(run=self.run),self.assertRaises(ValueError):capability.load(reference,self.run)

    def test_reference_rejects_sibling_directory_wrong_basename_traversal_and_symlink_even_with_valid_hash(self):
        full,reference,_=self.reference_parent();original=copy.deepcopy(self.run)
        paths=[self.output/'sibling/版本-1/receipt.json',self.out/'other.json',
            Path(str(self.out)+'/../版本-1/receipt.json')]
        for path in paths:
            path.parent.mkdir(parents=True,exist_ok=True)
            if path.resolve()!=Path(full['receiptPath']):path.write_bytes(Path(full['receiptPath']).read_bytes())
            self.run=copy.deepcopy(original)
            self.run['nodes']['prepare']['output'].update(receiptPath=str(path))
            self.run['nodes']['prepare']['outputDirectory']=str(path.parent);self.save_run()
            with self.subTest(path=path),self.assertRaises(ValueError):capability.load(reference|{'receiptPath':str(path)},self.run)
        self.run=copy.deepcopy(original);self.save_run()
        actual=Path(full['receiptPath']);backup=self.out/'receipt-original.json';actual.rename(backup);actual.symlink_to(backup)
        with self.assertRaises(ValueError):capability.load(reference,self.run)

    def test_reference_keeps_both_source_and_proof_hash_failures_hard(self):
        _,reference,proof=self.reference_parent()
        for path in (self.source,proof):
            original=path.read_bytes();path.write_bytes(original+b'changed')
            try:
                with self.subTest(path=path),self.assertRaisesRegex(ValueError,'源资料或上游产物'):
                    capability.load(reference,self.run)
            finally:path.write_bytes(original)
        self.assertEqual(capability.load(reference,self.run)['operation'],'hdk.four.prepare')

    def test_reference_rejects_disk_operation_mismatch_even_with_updated_producer_sha(self):
        _,reference,_=self.reference_parent();path=Path(reference['receiptPath']);data=capability.read(path)
        data['operation']='hdk.four.native';path.write_text(json.dumps(data))
        reference['receiptSha256']=capability.sha(path)
        self.run['nodes']['prepare']['output']['receiptSha256']=reference['receiptSha256'];self.save_run()
        with self.assertRaisesRegex(ValueError,'上游能力类型'):capability.load(reference,self.run)

    def test_reference_does_not_accept_a_new_attempt_that_starts_during_full_receipt_read(self):
        _,reference,_=self.reference_parent();original_read=capability.read
        def read_then_supersede(path):
            data=original_read(path)
            self.run['nodes']['prepare'].update(attempt=2,attemptId=str(uuid.uuid4()));self.save_run()
            return data
        with patch.object(capability,'read',side_effect=read_then_supersede):
            with self.assertRaises(ValueError):capability.load(reference,self.run)

    def test_bound_accepts_only_actual_running_schema_two_node_snapshot(self):
        run, root, out = capability.bound('hdk.four.prepare', self.value, self.context)
        self.assertEqual(run['id'], self.run_id)
        self.assertEqual(root, self.output)
        self.assertEqual(out, self.out)
        self.assertFalse((self.out / 'receipt.json').exists())

    def test_bound_refuses_wrong_workflow_attempt_id_or_attempt_number(self):
        for key, value in [('workflowId', 'another-flow'), ('attemptId', str(uuid.uuid4())), ('attempt', 2)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                capability.bound('hdk.four.prepare', self.value, self.context | {key: value})

    def test_bound_refuses_different_input_wrong_tool_old_schema_or_nonrunning_node(self):
        original = copy.deepcopy(self.run)
        for mutate in [lambda run: run['document'].update(schemaVersion=1),
                       lambda run: run['nodes']['prepare'].update(status='complete'),
                       lambda run: run['document']['nodes'][0]['config'].update(toolName='hdk.four.cad'),
                       lambda run: run['nodes']['prepare'].update(input={'different': True})]:
            self.run = copy.deepcopy(original); mutate(self.run); self.save_run()
            with self.subTest(run=self.run), self.assertRaises(ValueError):
                capability.bound('hdk.four.prepare', self.value, self.context)

    def test_bound_cannot_write_sibling_node_old_attempt_or_outside_run_directory(self):
        for out in [self.output / 'sibling' / '版本-1', self.output / 'prepare' / '版本-2', self.root / 'outside']:
            out.mkdir(parents=True)
            with self.subTest(path=out), self.assertRaises(ValueError):
                capability.bound('hdk.four.prepare', self.value, self.context | {'outputDirectory': str(out)})

    def test_prepare_reads_real_native_zip_and_original_pngs_without_eda_or_model(self):
        result = capability.prepare(self.value)
        self.assertEqual(result['sourceSha256'], capability.sha(self.source))
        self.assertEqual(len(result['sourceFiles']), 4)
        self.assertEqual(result['request']['images'], self.images)

    def test_prepare_rejects_profile_for_another_source_or_pcb_before_conversion(self):
        original = copy.deepcopy(self.profile)
        for key, value in [('sourceSha256', '0' * 64), ('pcbUuid', 'another-pcb'), ('format', 'unknown'), ('version', 2)]:
            self.profile = copy.deepcopy(original); self.profile[key] = value; self.save_profile()
            with self.subTest(key=key), self.assertRaises(ValueError):
                capability.prepare(self.value)

    def test_prepare_rejects_unreviewed_wrong_photo_or_orientation_and_image_dimensions(self):
        original = copy.deepcopy(self.profile)
        for mutate in [lambda profile: profile['views'][0].update(reviewStatus='draft'),
                       lambda profile: profile['views'][0].update(orientationReviewed=False),
                       lambda profile: profile['views'][0]['image'].update(sha256='0' * 64),
                       lambda profile: profile['views'][0]['image'].update(width=121),
                       lambda profile: profile['views'][0].update(expectedDeterminantSign=1),
                       lambda profile: profile.update(views=profile['views'][:1])]:
            self.profile = copy.deepcopy(original); mutate(self.profile); self.save_profile()
            with self.subTest(profile=self.profile), self.assertRaises(ValueError):
                capability.prepare(self.value)

    def test_prepare_rejects_photo_bytes_changed_since_its_declared_sha(self):
        Image.new('RGB', (120, 200), 'red').save(self.images[0]['path'])
        with self.assertRaises(ValueError): capability.prepare(self.value)

    def test_current_parent_receipt_is_bound_to_complete_node_and_actual_bytes(self):
        parent = self.completed_parent()
        data = capability.load(parent, self.run, 'hdk.four.prepare')
        self.assertEqual(data['runId'], self.run_id)
        self.assertEqual(data['request'], self.value)
        self.assertEqual(data['sourceSha256'], capability.sha(self.source))

    def test_parent_hash_tamper_different_run_and_wrong_operation_are_rejected(self):
        parent = self.completed_parent()
        for changed in [parent | {'receiptSha256': '0' * 64}, parent | {'runId': str(uuid.uuid4())}]:
            with self.subTest(value=changed), self.assertRaises(ValueError): capability.load(changed, self.run)
        with self.assertRaises(ValueError): capability.load(parent, self.run, 'hdk.four.cad')
        Path(parent['receiptPath']).write_text('{"changed":true}')
        with self.assertRaises(ValueError): capability.load(parent, self.run)

    def test_parent_receipt_cannot_read_file_outside_this_run_even_with_correct_hash(self):
        parent = self.completed_parent()
        outside = self.root / 'outside-receipt.json'; outside.write_bytes(Path(parent['receiptPath']).read_bytes())
        changed = parent | {'receiptPath': str(outside), 'receiptSha256': capability.sha(outside)}
        self.run['nodes']['prepare']['output'] = changed; self.save_run()
        with self.assertRaises(ValueError): capability.load(changed, self.run)

    def test_parent_incomplete_or_stale_node_output_cannot_be_reused(self):
        parent = self.completed_parent()
        self.run['nodes']['prepare']['status'] = 'running'; self.save_run()
        with self.assertRaises(ValueError): capability.load(parent, self.run)
        self.run['nodes']['prepare'].update(status='complete', output=parent | {'receiptSha256': '0' * 64}); self.save_run()
        with self.assertRaises(ValueError): capability.load(parent, self.run)

    def test_parent_source_photo_and_calibration_changes_invalidate_handoff(self):
        parent = self.completed_parent()
        for path in [self.source, self.profile_path, Path(self.images[0]['path']), Path(self.images[1]['path'])]:
            original = path.read_bytes(); path.write_bytes(original + b'changed')
            try:
                with self.subTest(path=path), self.assertRaises(ValueError): capability.load(parent, self.run)
            finally: path.write_bytes(original)

    def test_receipt_tracks_original_artifact_and_nested_report_bytes(self):
        artifact = self.out / 'board.step'; artifact.write_bytes(b'test-only STEP bytes; no geometry claim')
        report = self.out / 'conversion-report.json'; report.write_text('{"fixture":"not a real converter report"}')
        parent = capability.receipt('hdk.four.native', {'sourceFiles': [], 'native': {'reportPath': str(report)}},
                                    self.run, self.out, [{'path': str(artifact), 'sha256': capability.sha(artifact)}])
        self.run['nodes']['prepare'].update(status='complete', output=parent); self.save_run()
        capability.load(parent, self.run, 'hdk.four.native')
        for path in (artifact, report):
            original = path.read_bytes(); path.write_bytes(original + b'changed')
            try:
                with self.subTest(path=path), self.assertRaises(ValueError): capability.load(parent, self.run)
            finally: path.write_bytes(original)

    def test_receipt_creation_never_replaces_prior_attempt(self):
        first = capability.four('hdk.four.prepare', self.value, self.context)
        original = Path(first['receiptPath']).read_bytes()
        with self.assertRaises(FileExistsError): capability.four('hdk.four.prepare', self.value, self.context)
        self.assertEqual(Path(first['receiptPath']).read_bytes(), original)

    def test_assets_preserve_converter_hash_instead_of_accepting_changed_output_as_new_truth(self):
        artifact = self.out / 'board.step'
        artifact.write_bytes(b'original converter result')
        original = {'path': str(artifact), 'sha256': capability.sha(artifact), 'bytes': artifact.stat().st_size}
        accepted = capability.assets([original])
        self.assertEqual(accepted[0]['sha256'], original['sha256'])
        artifact.write_bytes(b'changed before registration')
        with self.assertRaises(ValueError): capability.assets([original])

    def test_unknown_capability_is_rejected_without_writing_receipt(self):
        self.run['document']['nodes'][0]['config']['toolName'] = 'hdk.four.unknown'; self.save_run()
        with self.assertRaises(ValueError): capability.four('hdk.four.unknown', self.value, self.context)
        self.assertFalse((self.out / 'receipt.json').exists())

    def review_fixture(self):
        images = {'front': {'testOnlyReceipt': 'front'}, 'back': {'testOnlyReceipt': 'back'}}
        files, artifacts = [], []
        for image in self.images:
            path = self.out / ('candidate-' + image['side'] + '.png')
            path.write_bytes(Path(image['path']).read_bytes())
            file = {'path': str(path), 'sha256': capability.sha(path)}; files.append(file)
            artifacts.append(file | {'id': str(uuid.uuid4())})
        self.run['document']['nodes'].append({'id': 'image-review', 'type': 'human', 'config': {}})
        self.run['document']['edges'].append({'sourceNode': 'image-review', 'sourcePort': 'out', 'targetNode': 'verify', 'targetPort': 'images'})
        self.run['nodes']['image-review'] = {'status': 'complete', 'output': copy.deepcopy(images), 'artifacts': artifacts,
            'review': {'decision': 'approved', 'reviewedAt': '2026-10-25T12:00:00Z',
                       'artifactHashes': [{'id': item['id'], 'sha256': item['sha256']} for item in artifacts]}}
        self.save_run()
        return images, files, self.context | {'nodeId': 'verify'}

    def test_four_file_delivery_requires_human_approval_of_both_exact_current_images(self):
        images, files, context = self.review_fixture()
        actual_run = capability.row('workflow_runs', self.run_id)
        evidence = capability.reviewed_images(actual_run, context, images, files)
        self.assertEqual(evidence['nodeId'], 'image-review')
        self.assertEqual(len(evidence['artifactHashes']), 2)
        original = copy.deepcopy(actual_run)
        mutations = [lambda run: run['nodes']['image-review'].update(status='waiting_review'),
                     lambda run: run['nodes']['image-review']['review'].update(decision='revision_requested'),
                     lambda run: run['nodes']['image-review']['output'].update(front={'testOnlyReceipt': 'stale'}),
                     lambda run: run['nodes']['image-review']['artifacts'].pop(),
                     lambda run: run['nodes']['image-review']['review']['artifactHashes'][1].update(sha256='0' * 64),
                     lambda run: run['document']['nodes'][-1].update(type='tool')]
        for mutate in mutations:
            changed = copy.deepcopy(original); mutate(changed)
            with self.subTest(run=changed), self.assertRaises(ValueError):
                capability.reviewed_images(changed, context, images, files)

    def test_four_file_image_approval_cannot_vacuously_pass_when_an_image_artifact_is_missing(self):
        images, files, context = self.review_fixture()
        for incomplete in ([], files[:1], [files[0], files[0]]):
            with self.subTest(files=incomplete), self.assertRaises(ValueError):
                capability.reviewed_images(self.run, context, images, incomplete)

    def test_final_handoff_requires_actual_current_human_approval_and_exact_png_hashes(self):
        images={'front':{'receipt':'front-current'},'back':{'receipt':'back-current'}}
        files=[{'path':image['path'],'sha256':image['sha256']} for image in self.images]
        artifacts=[dict(file,id=str(uuid.uuid4())) for file in files]
        self.run['document']['nodes'].append({'id':'review','type':'human'})
        self.run['document']['edges']=[{'targetNode':'prepare','targetPort':'images','sourceNode':'review'}]
        review={'decision':'approved','reviewedAt':'2026-10-25T08:00:00Z',
                'artifactHashes':[{'id':item['id'],'sha256':item['sha256']} for item in artifacts]}
        human={'status':'complete','output':images,'review':review,'artifacts':artifacts}
        self.run['nodes']['review']=human
        proof=capability.reviewed_images(self.run,self.context,images,files)
        self.assertEqual(proof['artifactHashes'],review['artifactHashes'])
        original=copy.deepcopy(human)
        for mutate in [lambda h:h.update(status='waiting_review'),
                       lambda h:h['review'].update(decision='revision_requested'),
                       lambda h:h.update(output={'front':'old attempt'}),
                       lambda h:h['review']['artifactHashes'][0].update(sha256='0'*64),
                       lambda h:h['review'].update(artifactHashes=[]),
                       lambda h:h['artifacts'][0].update(path='/another/image.png')]:
            self.run['nodes']['review']=copy.deepcopy(original)
            mutate(self.run['nodes']['review'])
            with self.assertRaises(ValueError):capability.reviewed_images(self.run,self.context,images,files)

    def test_completed_merge_cannot_masquerade_as_approved_human(self):
        self.run['document']['nodes'].append({'id':'merge','type':'merge'})
        self.run['document']['edges']=[{'targetNode':'prepare','targetPort':'images','sourceNode':'merge'}]
        self.run['nodes']['merge']={'status':'complete','output':{},'review':{'decision':'approved'}}
        with self.assertRaises(ValueError):capability.reviewed_images(self.run,self.context,{},[])

    def test_parallel_prepare_processes_write_independent_bound_receipts(self):
        contexts = []
        for name in ('prepare-a', 'prepare-b'):
            out = self.output / name / '版本-1'; out.mkdir(parents=True)
            attempt = str(uuid.uuid4())
            self.run['document']['nodes'].append({'id': name, 'type': 'tool', 'config': {'toolName': 'hdk.four.prepare'}})
            self.run['nodes'][name] = {'status': 'running', 'input': self.value, 'attempt': 1, 'attemptId': attempt, 'outputDirectory': str(out)}
            contexts.append(self.context | {'nodeId': name, 'attemptId': attempt, 'outputDirectory': str(out)})
        self.save_run()
        script = "import importlib.util,json,sys; from pathlib import Path; p=json.load(sys.stdin); s=importlib.util.spec_from_file_location('parallel_bound',p['module']); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.ROOT=Path(p['root']); m.DATABASE=Path(p['root'])/'.local/workbench.sqlite'; print(json.dumps(m.four('hdk.four.prepare',p['value'],p['context'])))"
        def run(context):
            result = subprocess.run([sys.executable, '-B', '-c', script],
                                    input=json.dumps({'module': str(REPO / 'hdk/dag_capabilities.py'), 'root': str(self.root), 'value': self.value, 'context': context}),
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outputs = list(pool.map(run, contexts))
        self.assertEqual({output['nodeId'] for output in outputs}, {'prepare-a', 'prepare-b'})
        self.assertNotEqual(outputs[0]['receiptPath'], outputs[1]['receiptPath'])
        for output in outputs:
            self.assertEqual(capability.sha(output['receiptPath']), output['receiptSha256'])
            self.assertEqual(capability.read(output['receiptPath'])['runId'], self.run_id)


if __name__ == '__main__': unittest.main()
