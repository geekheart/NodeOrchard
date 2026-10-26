"""Pinout capability boundary fixtures; no model, EDA or browser is run.

The real workflow supplies visual evidence separately. These tests ensure the
learning loop can retain presentation failures without admitting forged source
facts, old export evidence, different Skill output, or another run's receipt.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
SPEC = importlib.util.spec_from_file_location('pinout_pipeline_boundaries', ROOT / 'hdk/pinout_pipeline.py')
pipeline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pipeline)


class PinoutPipelineBoundaries(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.private = self.root / '.local/pinout-contexts'
        self.private.mkdir(parents=True)
        self.output = self.root / 'outputs/BOARD_Pinout'
        self.output.mkdir(parents=True)
        self.run_id = str(uuid.uuid4())
        self.native_id = str(uuid.uuid4())
        self.learning_id = str(uuid.uuid4())
        self.source = self.root / 'fixture.epro2'
        self.source.write_bytes(b'Bound test-only source. Not a real EDA archive.')
        self.profile = self.root / 'photo-calibration.json'
        self.profile.write_text('{"fixture":"reviewed calibration; not hardware evidence"}')
        self.images = []
        for side in ('front', 'back'):
            photo = self.root / (side + '.png')
            Image.new('RGBA', (120, 200), (30, 80, 100, 255)).save(photo)
            self.images.append({'side': side, 'path': str(photo), 'sha256': pipeline.sha(photo)})
        self.native_path = self.root / 'workspaces/four-files' / self.native_id / 'BOARD/.native-evidence/export-report.json'
        self.native_path.parent.mkdir(parents=True)
        self.native = {'status': 'complete', 'reportPath': str(self.native_path),
                       'source': {'path': str(self.source), 'sha256': pipeline.sha(self.source)},
                       'pinoutEvidence': {'componentPads': [{'testOnly': True}]}}
        self.native_path.write_text(json.dumps(self.native))
        self.native_context_path = self.root / '.local/four-files-contexts' / (self.native_id + '.json')
        self.native_context_path.parent.mkdir()
        self.native_context = {'stage': 'verify', 'result': {'status': 'complete'}, 'native': copy.deepcopy(self.native)}
        self.native_context_path.write_text(json.dumps(self.native_context))
        self.request = {'sourcePath': str(self.source), 'productCode': 'BOARD', 'hardwareVersion': '1.0',
                        'releaseDate': '2026-10-25', 'images': self.images,
                        'pinoutPhotoProfilePath': str(self.profile), 'nativeReportPath': str(self.native_path),
                        'nativeReportSha256': pipeline.sha(self.native_path), 'viewSides': ['front']}
        self.skill_input = {'task': 'plan-pinout-display', 'displayOptions': {'pinCount': 2}}
        self.plan = {'format': 'workbench-pinout-display-plan', 'version': 1, 'style': {}, 'displayAliases': []}
        self.skill = {'id': 'pinout-plan-skill', 'type': 'skill',
                      'config': {'skillRef': 'board-pinout', 'version': 'sha256:' + 'a' * 64}}
        self.run = {'id': self.run_id, 'workflowId': 'workflow-pinout', 'currentNodeId': 'pinout-prepare',
                    'learningId': self.learning_id, 'input': copy.deepcopy(self.request),
                    'document': {'nodes': [self.skill]},
                    'nodes': {'pinout-plan-skill': {'status': 'complete', 'input': self.skill_input, 'output': self.plan}}}
        self.db_path = self.root / '.local/workbench.sqlite'
        with sqlite3.connect(self.db_path) as db:
            db.execute('CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
        self.save_run(self.native_id, {'status': 'complete', 'workflowId': 'workflow-epro2-four-files'})
        self.save_run(self.run_id, self.run)
        self.state = {'runId': self.run_id, 'workflowId': self.run['workflowId'], 'learningId': self.learning_id,
                      'stage': 'prepare', 'request': copy.deepcopy(self.request), 'outputPath': str(self.output),
                      'sources': [{'path': str(path), 'sha256': pipeline.sha(path)} for path in
                                  (self.source, self.profile, self.native_path, *[Path(image['path']) for image in self.images])],
                      'prepared': {'views': []}, 'skillInput': self.skill_input, 'errors': {}}
        for name, value in [('ROOT', self.root), ('PRIVATE', self.private), ('OUTPUTS', self.root / 'outputs'),
                            ('CONTRACT', self.root / 'reference-contract.json')]:
            mocked = patch.object(pipeline, name, value)
            mocked.start(); self.addCleanup(mocked.stop)
        self.state_path = self.private / (self.run_id + '.json')
        self.save_state()

    def save_state(self):
        self.state_path.write_text(json.dumps(self.state))

    def save_run(self, ident, value):
        with sqlite3.connect(self.db_path) as db:
            db.execute('INSERT OR REPLACE INTO workflow_runs VALUES(?,?)', (ident, json.dumps(value)))

    def test_input_accepts_only_exact_completed_four_file_source_evidence(self):
        accepted = pipeline.validate_input(self.request)
        self.assertEqual(accepted['nativeReportPath'], str(self.native_path))
        self.assertEqual(accepted['viewSides'], ['front'])
        self.assertEqual(accepted['images'], self.images)

    def test_input_schema_and_selected_views_cannot_inject_an_output_or_duplicate_side(self):
        invalid = [dict(self.request, outputPath='/tmp/forged'), dict(self.request, viewSides=[]),
                   dict(self.request, viewSides=['front', 'front']), dict(self.request, viewSides=['top']),
                   dict(self.request, viewSides='front'), dict(self.request, viewSides=[None]),
                   {key: value for key, value in self.request.items() if key != 'nativeReportSha256'}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises((ValueError, TypeError)):
                pipeline.validate_input(value)

    def test_native_report_hash_and_original_photo_hash_are_enforced(self):
        with self.assertRaises(ValueError):
            pipeline.validate_input(dict(self.request, nativeReportSha256='0' * 64))
        photo = Path(self.images[0]['path'])
        photo.write_bytes(b'changed photograph')
        with self.assertRaises(ValueError):
            pipeline.validate_input(self.request)

    def test_export_report_outside_workflow_outputs_is_never_admitted(self):
        outside = self.root / 'old-export-report.json'
        outside.write_bytes(self.native_path.read_bytes())
        with self.assertRaisesRegex(ValueError, '已完成'):
            pipeline.validate_input(dict(self.request, nativeReportPath=str(outside), nativeReportSha256=pipeline.sha(outside)))

    def test_incomplete_or_other_workflow_native_runs_are_rejected(self):
        for native_run in [{'status': 'running', 'workflowId': 'workflow-epro2-four-files'},
                           {'status': 'complete', 'workflowId': 'another-workflow'}]:
            self.save_run(self.native_id, native_run)
            with self.subTest(native_run=native_run), self.assertRaises(ValueError):
                pipeline.validate_input(self.request)

    def test_private_native_context_must_exactly_match_the_report(self):
        changed = copy.deepcopy(self.native_context)
        changed['native']['source']['sha256'] = '0' * 64
        self.native_context_path.write_text(json.dumps(changed))
        with self.assertRaises(ValueError):
            pipeline.validate_input(self.request)

    def test_native_proof_cannot_be_reused_after_source_changes(self):
        self.source.write_bytes(b'new source contents')
        with self.assertRaises(ValueError):
            pipeline.validate_input(self.request)

    def test_run_binding_requires_real_node_workflow_and_learning_context(self):
        env = {'WORKBENCH_RUN_ID': self.run_id, 'WORKBENCH_WORKFLOW_ID': self.run['workflowId'],
               'WORKBENCH_NODE_ID': 'pinout-prepare', 'WORKBENCH_LEARNING_ID': self.learning_id}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(pipeline._run('prepare')['id'], self.run_id)
            for key, bad in [('WORKBENCH_RUN_ID', '../forged'), ('WORKBENCH_NODE_ID', 'pinout-verify'),
                             ('WORKBENCH_WORKFLOW_ID', 'other-workflow'), ('WORKBENCH_LEARNING_ID', '')]:
                with self.subTest(key=key), patch.dict(os.environ, {key: bad}), self.assertRaises(ValueError):
                    pipeline._run('prepare')

    def test_private_state_rejects_cross_workflow_stage_skips_and_changed_evidence(self):
        with self.assertRaises(ValueError):
            pipeline._load(dict(self.run, workflowId='other-workflow'), 'prepare')
        with self.assertRaises(ValueError):
            pipeline._load(self.run, 'render')
        self.native_path.write_text('{"forged":true}')
        with self.assertRaisesRegex(ValueError, '变化'):
            pipeline._load(self.run, 'prepare')

    def test_plan_must_be_the_actual_completed_skill_output_with_its_bound_input(self):
        bound = pipeline.checked_skill_plan(self.run, 'pinout-plan-skill', self.plan, self.skill_input)
        self.assertEqual(bound, {'ref': 'board-pinout', 'version': 'sha256:' + 'a' * 64})
        for step in [{'status': 'running', 'input': self.skill_input, 'output': self.plan},
                     {'status': 'complete', 'input': {'forged': True}, 'output': self.plan},
                     {'status': 'complete', 'input': self.skill_input, 'output': {'forged': True}}]:
            forged_run = copy.deepcopy(self.run); forged_run['nodes']['pinout-plan-skill'] = step
            with self.subTest(step=step), self.assertRaises(ValueError):
                pipeline.checked_skill_plan(forged_run, 'pinout-plan-skill', self.plan, self.skill_input)

    def test_selected_view_input_omits_answers_photo_pixels_and_calibration_coordinates(self):
        facts = {'source': {'sha256': pipeline.sha(self.source)}, 'pinCount': 2,
                 'connectors': [{'designator': 'J1', 'pins': [{'pad': '1', 'net': 'GND'}, {'pad': '2', 'net': 'IO38_U0RXD'}]}]}
        facts_path = self.root / 'facts.json'; facts_path.write_text(json.dumps(facts))
        views = [{'side': side, 'factsPath': str(facts_path), 'image': {'width': 120, 'height': 200},
                  'photoOriginal': {'sha256': image['sha256']}}
                 for side, image in zip(('front', 'back'), self.images)]
        value = pipeline.prepare_plan_input(views, self.request)
        self.assertEqual([view['side'] for view in value['views']], ['front'])
        self.assertEqual(value['displayOptions']['pins'][1]['net'], 'IO38_U0RXD')
        self.assertIn('MAIN RX0', value['displayOptions']['pins'][1]['allowedLabels'])
        serialized = json.dumps(value)
        for forbidden in ('referenceContract', 'referenceExamples', 'imageData', 'controlPoints', 'nativeReportPath'):
            self.assertNotIn(forbidden, serialized)
        self.assertLess(len(serialized.encode()), 64 * 1024)

    def test_invalid_display_choice_is_retained_as_a_learning_failure_for_optimization(self):
        with patch.object(pipeline, '_run', return_value=self.run), patch.object(pipeline, 'render_photo_plan', side_effect=ValueError('Display font size exceeds bounded choices')):
            receipt = pipeline.execute_stage('render', self.plan)
        saved = json.loads(self.state_path.read_text())
        self.assertEqual(saved['stage'], 'render')
        self.assertIn('Display font size', saved['errors']['plan'])
        with patch.object(pipeline, '_run', return_value=self.run), patch('hdk.pinout_learning.evaluate_pinout_views') as evaluator:
            result = pipeline.execute_stage('verify', receipt)
        evaluator.assert_not_called()
        self.assertFalse(result['qualitySummary']['passed'])
        self.assertTrue(all(value is False for value in result['qualitySummary']['checks'].values()))
        self.assertEqual(result['learningComparison']['plan'], self.plan)
        self.assertLess(len(json.dumps(result, ensure_ascii=False).encode()), 64 * 1024)
        report = json.loads(Path(result['reportPath']).read_text())
        self.assertEqual(report['visualReview'], 'required')

    def test_source_or_infrastructure_failures_are_not_converted_to_learning_diagnostics(self):
        for diagnostic in ('Source photograph hash changed', 'Converter crashed', 'Native pad ownership changed'):
            with self.subTest(diagnostic=diagnostic), patch.object(pipeline, '_run', return_value=self.run), patch.object(pipeline, 'render_photo_plan', side_effect=ValueError(diagnostic)):
                with self.assertRaisesRegex(ValueError, diagnostic):
                    pipeline.execute_stage('render', self.plan)
            self.assertEqual(json.loads(self.state_path.read_text())['stage'], 'prepare')

    def test_verify_cannot_accept_a_forged_success_boolean_or_another_receipt(self):
        self.state.update(stage='render', renderReceipt={'runId': self.run_id, 'stage': 'render', 'outputPath': str(self.output)})
        self.save_state()
        for value in [{'qualitySummary': {'passed': True}}, dict(self.state['renderReceipt'], runId=str(uuid.uuid4()))]:
            with self.subTest(value=value), patch.object(pipeline, '_run', return_value=self.run), self.assertRaisesRegex(ValueError, '回执'):
                pipeline.execute_stage('verify', value)

    def test_execution_mode_cannot_publish_a_failed_learning_result(self):
        self.run.pop('learningId')
        self.state.update(learningId='', stage='render', errors={'plan': 'Display aliases incomplete'},
                          plan=self.plan, skill={'ref': 'board-pinout', 'version': self.skill['config']['version']},
                          renderReceipt={'runId': self.run_id, 'stage': 'render', 'outputPath': str(self.output)})
        self.save_state()
        with patch.object(pipeline, '_run', return_value=self.run), self.assertRaisesRegex(ValueError, '先完成'):
            pipeline.execute_stage('verify', self.state['renderReceipt'])
        self.assertFalse(json.loads((self.output / 'Pinout验收.json').read_text())['passed'])


if __name__ == '__main__':
    unittest.main()
