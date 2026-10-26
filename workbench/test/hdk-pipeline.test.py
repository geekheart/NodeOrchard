"""Release-gate and capability boundaries; no real EDA, build, or new-board export.

Every mutable path and SQLite record belongs to a TemporaryDirectory. These
tests deliberately use invalid tiny files where real validators must be called,
so a reported 'compiled' flag cannot replace independent artifact validation.
"""
from contextlib import closing
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


pipeline = load_module('hdk_pipeline_boundary_tests', ROOT / 'hdk/pipeline.py')
runner = load_module('hdk_capability_boundary_tests', ROOT / 'hdk/capability_runner.py')


class PipelineBoundaries(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.private = self.root / 'private'
        self.contract = self.root / 'contract.json'
        self.gate = self.root / 'gate.json'
        self.inventory = self.root / 'reference-inventory.json'
        self.template = self.root / 'process-template.xlsx'
        self.template.write_bytes(b'immutable process template fixture')
        for name, value in [('ROOT', self.root), ('PRIVATE', self.private),
                            ('CONTRACT', self.contract), ('GATE', self.gate),
                            ('REFERENCE_INVENTORY', self.inventory), ('TEMPLATE', self.template)]:
            mocked = patch.object(pipeline, name, value)
            mocked.start(); self.addCleanup(mocked.stop)
        self.run_id, self.learning_id = str(uuid.uuid4()), str(uuid.uuid4())
        self.source = self.root / 'approved-paired-source.epro2'
        self.source.write_bytes(b'approved paired training source fixture')
        self.package = self.root / 'run-output/BOARD_HDK_V1.0'
        self.package.mkdir(parents=True)
        self.document = {
            'id': 'hdk-full-workflow',
            'nodes': [{'id': node_id, 'type': 'skill', 'config': {'version': 'sha-fixed'}}
                      for node_id in sorted(pipeline.SKILL_NODE_IDS)] + [
                {'id': 'hdk-process-fill', 'type': 'code', 'config': {'code': 'pipeline.fill_process(input)'}},
                {'id': 'hdk-finalize', 'type': 'code', 'config': {'code': 'pipeline.finalize(input)'}}],
            'edges': [],
        }
        self.input = {'sourcePath': str(self.source), 'productCode': 'BOARD',
                      'hardwareVersion': '1.0', 'releaseDate': '2026-10-24'}
        self.record = {'id': self.run_id, 'workflowId': self.document['id'],
                       'learningId': self.learning_id, 'status': 'complete',
                       'document': self.document, 'input': self.input,
                       'currentNodeId': 'hdk-finalize'}
        golden = self.root / 'golden-original'; golden.mkdir()
        golden_file = golden / 'reference.txt'; golden_file.write_text('original untouched reference fixture')
        self.inventory.write_text(json.dumps({'caseRoot': str(golden), 'files': [
            {'path': golden_file.name, 'sha256': pipeline.sha(golden_file)}]}))
        self.schema = self.root / 'skills/hdk-test-firmware/references/profile.schema.json'
        self.schema.parent.mkdir(parents=True); self.schema.write_text('{"type":"object"}')
        criteria = ['nativeExport', 'releaseNaming', 'processTemplate', 'firmwareBuild',
                    'firmwareCoverage', 'testSop', 'datasheets', 'evidence']
        self.contract.write_text(json.dumps({'pairedSource': str(self.source),
            'pairedSourceSha256': pipeline.sha(self.source), 'referenceInventorySha256': pipeline.sha(self.inventory),
            'criteria': [{'id': x} for x in criteria]}))
        (self.root / '.local').mkdir()
        self.db_path = self.root / '.local/workbench.sqlite'
        with closing(sqlite3.connect(self.db_path)) as db:
            db.execute('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, value TEXT)')
            db.execute('CREATE TABLE workflow_learning (id TEXT PRIMARY KEY, value TEXT)')
            db.commit()
        self.save_record()
        self.environment = {'WORKBENCH_RUN_ID': self.run_id, 'WORKBENCH_LEARNING_ID': self.learning_id,
                            'WORKBENCH_WORKFLOW_ID': self.document['id'], 'WORKBENCH_NODE_ID': 'hdk-finalize'}
        mocked = patch.dict(os.environ, self.environment, clear=True)
        mocked.start(); self.addCleanup(mocked.stop)
        self.base = SimpleNamespace(context=lambda: (os.environ['WORKBENCH_RUN_ID'], self.root / 'receipt.json'),
            verify=lambda value: {'coreExportStatus': 'complete', 'validationErrors': [],
                                  'qualitySummary': {'sourceConsistency': {'inputUnchanged': True}}})
        mocked = patch.object(pipeline, '_base', return_value=self.base)
        mocked.start(); self.addCleanup(mocked.stop)
        self.actual_admit_node = pipeline._admit_node
        mocked = patch.object(pipeline, '_admit_node')
        mocked.start(); self.addCleanup(mocked.stop)
        self.state = {'runId': self.run_id, 'learningId': self.learning_id,
            'request': self.input | {'sourceSha256': pipeline.sha(self.source),
                'outputParent': str(self.package.parent)},
            'packagePath': str(self.package), 'boardFacts': {}, 'testRequirements': {},
            'plans': {}, 'results': {}, 'errors': {}}
        pipeline._write(self.state)

    def save_record(self):
        with closing(sqlite3.connect(self.db_path)) as db:
            db.execute('INSERT OR REPLACE INTO workflow_runs VALUES (?,?)', (self.run_id, json.dumps(self.record)))
            db.commit()

    def save_job(self, **changes):
        job = {'id': self.learning_id, 'status': 'complete', 'bestScore': 100,
            'bestDocument': self.document, 'bestRound': 1,
            'memoryPolicy': {'mode': 'batch-snapshot', 'memoryWriteAllowed': False, 'externalMemoryAllowed': False},
            'rounds': [{'index': 1, 'status': 'complete',
                        'cases': [{'id': 'paired-case', 'role': 'training', 'runId': self.run_id, 'score': 100}]}]}
        job.update(changes)
        with closing(sqlite3.connect(self.db_path)) as db:
            db.execute('INSERT OR REPLACE INTO workflow_learning VALUES (?,?)', (self.learning_id, json.dumps(job)))
            db.commit()
        return job

    def disk_proof(self):
        artifact = self.package / '工艺要求.xlsx'
        artifact.write_bytes(b'file actually reviewed in this run')
        paths = {'schematicPdf': '原理图.pdf', 'silkscreenPdf': '丝印图.pdf', 'processXlsx': artifact.name}
        for kind, name in paths.items():
            if kind != 'processXlsx': (self.package / name).write_bytes(('reviewed ' + kind).encode())
        self.state['plans']['export'] = {'paths': paths}
        self.state['results']['process'] = {'workbookPath': str(artifact)}
        pipeline._write(self.state)
        report = self.package.parent / '完整流水线验收.json'
        report.write_text(json.dumps({'runId': self.run_id, 'packagePath': str(self.package),
            'sourceSha256': pipeline.sha(self.source), 'qualified': True,
            'checks': {r['id']: True for r in json.loads(self.contract.read_text())['criteria']},
            'artifacts': [{'path': name, 'bytes': (self.package / name).stat().st_size,
                'sha256': pipeline.sha(self.package / name)} for name in paths.values()]}))
        review = self.root / 'visual-review.json'
        review.write_text(json.dumps({'status': 'passed', 'learningId': self.learning_id,
            'runs': [{'runId': self.run_id, 'artifacts': [{'kind': kind, 'path': name,
                'sha256': pipeline.sha(self.package / name), 'status': 'passed'}
                for kind, name in paths.items()]}]}))
        proof = {'runId': self.run_id, 'role': 'training', 'reportPath': str(report),
                 'reportSha256': pipeline.sha(report), 'packagePath': str(self.package)}
        return artifact, report, review, proof

    def execution_gate(self):
        self.save_job()
        artifact, report, review, proof = self.disk_proof()
        implementations = {}
        for relative in pipeline.REQUIRED_IMPLEMENTATIONS:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('immutable implementation fixture: ' + relative)
            implementations[relative] = pipeline.sha(path)
        self.gate.write_text(json.dumps({'status': 'qualified', 'learningId': self.learning_id,
            'documentFingerprint': pipeline.definition(self.document), 'contractSha256': pipeline.sha(self.contract),
            'implementationHashes': implementations, 'caseProof': [proof],
            'visualReviewPath': str(review), 'visualReviewSha256': pipeline.sha(review),
            'templateSha256': pipeline.sha(self.template), 'profileSchemaSha256': pipeline.sha(self.schema)}))
        self.record.pop('learningId', None)
        self.save_record()
        os.environ.pop('WORKBENCH_LEARNING_ID', None)
        return artifact, report, review

    def test_unqualified_execution_and_forged_learning_environment_are_blocked(self):
        self.record.pop('learningId'); self.save_record()
        with self.assertRaises(ValueError): pipeline.check_release_gate()
        os.environ.pop('WORKBENCH_LEARNING_ID')
        with self.assertRaises(ValueError): pipeline.check_release_gate()

    def test_learning_rejects_unseen_source_before_any_capability_or_output(self):
        unseen = self.root / 'unseen-new-board.epro2'; unseen.write_bytes(b'different input source')
        self.record['input'] = self.input | {'sourcePath': str(unseen)}; self.save_record()
        with patch.object(pipeline, 'invoke') as invoke:
            with self.assertRaisesRegex(ValueError, '配对|P4|训练源'): pipeline.preflight(self.record['input'])
        invoke.assert_not_called()

    def test_real_approved_training_source_passes_the_pre_export_gate(self):
        pipeline.check_release_gate()

    def test_preflight_rejects_input_different_from_server_snapshot(self):
        with patch.object(pipeline, 'invoke') as invoke:
            with self.assertRaisesRegex(ValueError, '快照'): pipeline.preflight(self.input | {'productCode': 'OTHER'})
        invoke.assert_not_called()

    def test_source_modified_mid_run_cannot_reach_next_capability(self):
        self.source.write_bytes(b'source changed after preflight')
        with patch.object(pipeline, 'invoke') as invoke:
            with self.assertRaisesRegex(ValueError, '发生变化'): pipeline.fill_process({})
        invoke.assert_not_called()

    def test_wrong_workflow_or_node_context_cannot_reuse_private_receipt(self):
        self.actual_admit_node('hdk-finalize')
        for environment in ({'WORKBENCH_WORKFLOW_ID': 'other-workflow'},
                            {'WORKBENCH_NODE_ID': 'other-node'}):
            with self.subTest(environment=environment), patch.dict(os.environ, environment):
                with self.assertRaises(ValueError): self.actual_admit_node('hdk-finalize')
        self.record['currentNodeId'] = 'other-node'; self.save_record()
        with self.assertRaises(ValueError): self.actual_admit_node('hdk-finalize')

    def test_ai_profile_cannot_replace_module_route_source_or_destination(self):
        malicious = {'sourcePath': '/tmp/not-approved.epro2', 'packagePath': '/tmp/not-this-run',
                     'module': 'os', 'method': 'system', 'templatePath': '/tmp/fake-template.xlsx'}
        os.environ['WORKBENCH_NODE_ID'] = 'hdk-process-fill'
        self.record['currentNodeId'] = 'hdk-process-fill'; self.save_record()
        with patch.object(pipeline, 'invoke', return_value={'status': 'generated'}) as invoke:
            pipeline.fill_process(malicious)
        args = invoke.call_args.args
        self.assertEqual(args[:2], ('process_requirements', 'generate_process_requirements'))
        self.assertEqual(args[2]['sourcePath'], str(self.source))
        self.assertEqual(args[2]['packagePath'], str(self.package))
        self.assertEqual(args[2]['templatePath'], str(pipeline.TEMPLATE))
        self.assertEqual(args[2]['profile'], malicious)

    def test_process_input_identifies_sd_signals_without_guessing_from_net_names(self):
        self.state['boardFacts'] = {'peripherals': {'sd': {'designator': 'J11',
            'pins': {'d0': 39, 'd1': 40, 'd2': 41, 'd3': 42, 'clk': 43, 'cmd': 44}}},
            'netGpioMap': {**{'IO' + str(i): i for i in range(39, 45)}, 'OTHER': 10}}
        pipeline._write(self.state)
        with patch.object(pipeline, 'invoke', return_value={'facts': {}}) as invoke:
            prepared = pipeline.prepare_process({})
        self.assertEqual(prepared['facts']['interfaces']['sd']['signalNets'],
            ['IO39', 'IO40', 'IO41', 'IO42', 'IO43', 'IO44'])
        self.assertEqual(invoke.call_args.args[:2], ('process_requirements', 'prepare_process_request'))

    def test_process_input_keeps_usb_filter_source_pins_without_assigning_gpio_protocols(self):
        choke = {'designator': 'L2', 'part': 'SOURCE_FILTER', 'pins': [
            {'name': '1', 'net': 'USB_DN'}, {'name': '2', 'net': 'IO24'},
            {'name': '3', 'net': 'IO25'}, {'name': '4', 'net': 'USB_DP'}]}
        self.state['boardFacts'] = {'peripherals': {'usb': [{'pins': [
            {'name': 'Dp1', 'net': 'USB_DP'}, {'name': 'Dn1', 'net': 'USB_DN'}]}]},
            'board': {'components': [choke, {'designator': 'L1', 'part': 'POWER',
                'pins': [{'net': '3.3V'}, {'net': 'POWER_SWITCH'}]}]}}
        pipeline._write(self.state)
        with patch.object(pipeline, 'invoke', return_value={'facts': {}}):
            prepared = pipeline.prepare_process({})
        self.assertEqual(prepared['facts']['interfaces']['usbSignalPathComponents'], [choke])

    def test_empty_implementation_attestation_never_releases_new_input(self):
        self.execution_gate()
        gate = json.loads(self.gate.read_text()); gate['implementationHashes'] = {}; self.gate.write_text(json.dumps(gate))
        with self.assertRaises(ValueError): pipeline.check_release_gate()

    def test_complete_learning_score_without_disk_proof_cannot_release_new_input(self):
        self.execution_gate()
        gate = json.loads(self.gate.read_text()); gate['caseProof'] = []; self.gate.write_text(json.dumps(gate))
        with self.assertRaisesRegex(ValueError, '真实案例'): pipeline.check_release_gate()

    def test_changed_original_case_or_fixed_template_invalidates_qualification(self):
        self.execution_gate()
        pipeline.check_release_gate()
        self.template.write_bytes(b'changed template after qualification')
        with self.assertRaisesRegex(ValueError, '模板'): pipeline.check_release_gate()
        self.template.write_bytes(b'immutable process template fixture')
        (self.root / 'golden-original/reference.txt').write_text('changed original after training')
        with self.assertRaisesRegex(ValueError, '原案例'): pipeline.check_release_gate()

    def test_execution_rechecks_qualified_case_proof_after_artifact_mutation(self):
        artifact, _, _ = self.execution_gate()
        pipeline.check_release_gate()
        artifact.write_bytes(b'mutated after qualification')
        with self.assertRaises(ValueError): pipeline.check_release_gate()

    def test_execution_rechecks_qualified_report_and_visual_review_bytes(self):
        for kind in ['report', 'review']:
            with self.subTest(kind=kind):
                _, report, review = self.execution_gate()
                (report if kind == 'report' else review).write_text('{}')
                with self.assertRaises(ValueError): pipeline.check_release_gate()

    def test_qualifying_requires_real_completed_run_and_fresh_artifact_acceptance(self):
        self.save_job()
        _, report, review, _ = self.disk_proof()
        self.record['status'] = 'error'; self.save_record()
        with patch.object(pipeline, 'finalize') as final:
            with self.assertRaises(ValueError): pipeline.qualify_learning(self.learning_id, self.document, str(review))
        final.assert_not_called()
        self.record['status'] = 'complete'; self.save_record()
        with patch.object(pipeline, 'finalize', return_value={'qualified': False, 'reportPath': str(report)}) as final:
            with self.assertRaises(ValueError): pipeline.qualify_learning(self.learning_id, self.document, str(review))
        final.assert_called_once()
        self.assertFalse(self.gate.exists())

    def test_qualifying_rejects_render_record_for_different_bytes(self):
        self.save_job()
        _, report, review, _ = self.disk_proof()
        data = json.loads(review.read_text()); data['runs'][0]['artifacts'][0]['sha256'] = '0' * 64
        review.write_text(json.dumps(data))
        with patch.object(pipeline, 'finalize', return_value={'qualified': True, 'reportPath': str(report), 'packagePath': str(self.package)}):
            with self.assertRaisesRegex(ValueError, '当前产物'): pipeline.qualify_learning(self.learning_id, self.document, str(review))
        self.assertFalse(self.gate.exists())

    def test_qualifying_rejects_one_file_mislabeled_as_three_visual_artifacts(self):
        self.save_job()
        artifact, report, review, _ = self.disk_proof()
        data = json.loads(review.read_text())
        for row in data['runs'][0]['artifacts']:
            row.update(path=artifact.name, sha256=pipeline.sha(artifact))
        review.write_text(json.dumps(data))
        with patch.object(pipeline, 'finalize', return_value={'qualified': True,
                'reportPath': str(report), 'packagePath': str(self.package)}):
            with self.assertRaisesRegex(ValueError, '渲染检查'):
                pipeline.qualify_learning(self.learning_id, self.document, str(review))
        self.assertFalse(self.gate.exists())

    def test_outside_workbook_is_rejected_before_validator_can_accept_it(self):
        outside = self.root / 'old-run.xlsx'; outside.write_bytes(b'old run workbook')
        self.state['results']['process'] = {'workbookPath': str(outside)}
        self.state['plans']['process'] = {}; pipeline._write(self.state)
        with patch.object(pipeline, 'invoke', return_value={'passed': True}) as invoke:
            with self.assertRaisesRegex(ValueError, '本次交付'): pipeline.finalize({})
        invoke.assert_not_called()

    def test_compiled_flag_and_files_cannot_replace_firmware_validator(self):
        artifacts = []
        for role in ['elf', 'applicationBin', 'buildLog', 'flashArgs', 'mergedBin']:
            path = self.package / (role + '.fake'); path.write_text('invalid firmware bytes')
            artifacts.append({'role': role, 'path': str(path), 'sha256': pipeline.sha(path)})
        self.state['results']['firmware'] = {'status': 'compiled', 'artifacts': artifacts,
            'target': 'esp32s31', 'tests': [{'id': 'chip-info'}]}
        self.state['plans']['firmware'] = {'tests': ['chip-info']}
        self.state['results']['datasheets'] = {'indexPath': str(self.package / 'index.json'), 'pending': []}
        pipeline._write(self.state)
        def invoke(module, method, *args, **kwargs):
            if module == 'test_firmware':
                self.assertEqual(method, 'validate_build')
                return {'status': 'blocked', 'checks': {'boardFeatureCoverage': False}, 'errors': ['bad ELF']}
            return {'status': 'complete', 'checks': {'files': True}, 'errors': []}
        with patch.object(pipeline, 'invoke', side_effect=invoke): result = pipeline.finalize({})
        self.assertFalse(result['qualitySummary']['checks']['firmwareBuild'])
        self.assertFalse(result['qualitySummary']['checks']['firmwareCoverage'])
        self.assertFalse(result['qualified'])

    def test_datasheet_complete_label_does_not_hide_failed_independent_check(self):
        self.state['results']['datasheets'] = {'indexPath': str(self.package / 'index.json'), 'pending': []}
        pipeline._write(self.state)
        with patch.object(pipeline, 'invoke', return_value={
            'status': 'complete', 'errors': [], 'checks': {'moduleDocumentPresent': False}}):
            result = pipeline.finalize({})
        self.assertFalse(result['qualitySummary']['checks']['datasheets'])

    def test_delivery_inventory_excludes_only_known_os_metadata_without_deleting_files(self):
        names = ['project.epro2', '.gitignore', '.DS_Store', 'source/._main.c', '__MACOSX/resource']
        for name in names:
            path = self.package / name; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(name)
        inventory = pipeline._all_artifacts(self.package)
        self.assertEqual({row['path'] for row in inventory}, {'project.epro2', '.gitignore'})
        self.assertTrue(all((self.package / name).exists() for name in names))


class CapabilityRouteBoundaries(unittest.TestCase):
    def call(self, request, importer=None):
        with patch.object(runner.sys, 'stdin', io.StringIO(json.dumps(request))), \
                patch.object(runner.importlib, 'import_module', side_effect=importer) as imported, \
                patch.object(runner.sys, 'path', list(runner.sys.path)):
            result = runner.main()
        return result, imported

    def test_module_and_method_allowlist_reject_before_any_import(self):
        for module, method in [('../../outside', 'run'), ('os', 'system'),
                               ('process_requirements', '__dict__'), ('test_firmware', 'eval')]:
            with self.subTest(module=module, method=method), \
                    patch.object(runner.sys, 'stdin', io.StringIO(json.dumps({'module': module, 'method': method}))), \
                    patch.object(runner.importlib, 'import_module') as imported:
                with self.assertRaises(ValueError): runner.main()
                imported.assert_not_called()

    def test_extra_ai_module_path_field_cannot_change_allowed_import(self):
        calls = []
        def importer(name):
            calls.append(name)
            return SimpleNamespace(prepare_process_request=lambda value: {'seen': value})
        result, _ = self.call({'module': 'process_requirements', 'method': 'prepare_process_request',
            'modulePath': '/tmp/evil.py', 'args': [{'module': 'os', 'method': 'system'}]}, importer)
        self.assertEqual(calls, ['hdk.process_requirements'])
        self.assertEqual(result, {'ok': True, 'result': {'seen': {'module': 'os', 'method': 'system'}}})


if __name__ == '__main__':
    unittest.main()
