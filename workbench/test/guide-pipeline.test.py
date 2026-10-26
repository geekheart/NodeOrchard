"""Guide stage contract tests, without model calls or browser conversion.

The real S31/P4 runs provide visual/export evidence separately. These fixtures
exercise immutable run binding, source changes, learning error recovery, image
coordinate transforms and the exact public quality summary consumed by learning.
"""
import base64
import copy
import importlib.util
import io
import hashlib
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
SPEC = importlib.util.spec_from_file_location('guide_pipeline_test', ROOT / 'hdk/guide_pipeline.py')
pipeline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pipeline)


class GuidePipelineTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.private = self.root / 'private'
        self.private.mkdir()
        self.output = self.root / 'outputs/BOARD_使用指南'
        (self.output / 'img').mkdir(parents=True)
        (self.output / 'sources').mkdir()
        self.source = self.root / 'source.epro2'
        self.source.write_bytes(b'bound source fixture; never supplied as a real EDA archive')
        self.run_id = str(uuid.uuid4())
        self.workflow_id = 'workflow-board-user-guide'
        self.document = {'id': self.workflow_id, 'nodes': [{'id': 'guide-prepare', 'type': 'tool', 'config': {'code': 'fixed fixture'}}], 'edges': []}
        self.run = {'id': self.run_id, 'workflowId': self.workflow_id, 'input': {'sourcePath': str(self.source)},
                    'document': self.document, 'learningId': 'learning-fixture'}
        images = []
        for side in ('front', 'back'):
            path = self.root / (side + '.png')
            Image.new('RGBA', (800, 1000), (40, 80, 100, 255)).save(path)
            images.append({'path': str(path), 'side': side, 'name': path.name, 'width': 800, 'height': 1000, 'note': '',
                           'regions': [{'id': side + '-connector', 'refs': ['J1' if side == 'front' else 'J2'],
                                        'titleZh': '接口', 'titleEn': 'Connector', 'x': 50, 'y': 100, 'w': 100, 'h': 200}]})
        self.facts = {'productCode': 'BOARD', 'images': images, 'sourceFiles': [], 'dimensions': {}, 'board': {'moduleRef': 'U1'},
                      'interfaces': [], 'components': [], 'development': {}, 'source': {'sha256': pipeline.sha(self.source)}}
        self.state = {'runId': self.run_id, 'workflowId': self.workflow_id, 'learningId': self.run['learningId'],
                      'outputPath': str(self.output), 'sources': [{'path': str(self.source), 'sha256': pipeline.sha(self.source)}],
                      'facts': self.facts, 'plans': {}, 'errors': {}, 'assets': {}, 'stage': 'prepare',
                      'nextInput': {'runId': self.run_id}}
        for name, value in [('PRIVATE', self.private), ('OUTPUTS', self.root / 'outputs'),
                            ('GATE', self.root / 'gate.json'), ('CONTRACT', self.root / 'contract.json')]:
            mock = patch.object(pipeline, name, value)
            mock.start(); self.addCleanup(mock.stop)
        target = self.root / 'known-result.md'; target.write_text('The user-provided known-result guide, evaluator only.')
        pipeline.write_json(pipeline.CONTRACT, {'pairedTrainingSource': {'sha256': pipeline.sha(self.source)},
                                              'references': [{'path': str(target), 'sha256': pipeline.sha(target), 'language': 'en'}]})
        pipeline._save(self.state)

    def plan(self):
        return {'regions': [{'id': image['regions'][0]['id'], 'titleZh': '接口', 'titleEn': 'Connector'} for image in self.facts['images']],
                'style': {'color': '#ef4444', 'dashed': True, 'stroke': 3, 'fontSize': 18, 'radius': 5}}

    def make_annotation_fixture(self):
        """Saved actual-shaped conversion records, without running the renderer."""
        entries = []
        selected, style = pipeline._validate_annotation(self.plan(), self.facts)
        for image in self.facts['images']:
            for language in ('zh', 'en'):
                name = image['side'] + '-' + language
                with patch.object(pipeline, '_process', return_value={'labels': [{'width': 90, 'height': 42}]}):
                    project = pipeline._annotation_project(image, selected, style, language, name)
                bound = self.output / 'sources' / (name + '.bound.oim.json')
                pipeline.write_json(bound, project)
                png = self.output / 'img' / (name + '.png')
                Image.new('RGBA', (20, 20), 'white').save(png)
                svg = self.output / 'img' / (name + '.svg'); svg.write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
                editable = self.output / 'img' / (name + '.oim.json'); pipeline.write_json(editable, project)
                manifest = {'converter': {'name': 'OpenInterfaceMark', 'commit': 'f8f92636b2eb87ac956997e77c9239cf483913fc'},
                            'source': {'path': str(bound), 'sha256': pipeline.sha(bound),
                                       'embeddedImage': {'sha256': hashlib.sha256(base64.b64decode(project['image']['src'].split(',', 1)[1])).hexdigest()}},
                            'artifacts': [{'path': str(path), 'sha256': pipeline.sha(path)} for path in (png, svg, editable)],
                            'verification': {'defaultExampleExported': False, 'pageErrors': [],
                                             **{key: True for key in ('freshContext', 'boundProjectReadbackMatched', 'imageDecodedDimensionsMatched', 'sourceHashMatched', 'pngDimensionsMatched', 'svgLabelCountMatched', 'svgEmbeddedImageMatched', 'allRequestsLocalGet')}}}
                manifest_path = self.output / 'img' / (name + '.conversion.json')
                pipeline.write_json(manifest_path, manifest)
                entries.append({**manifest, 'manifestPath': str(manifest_path), 'pngPath': str(png), 'svgPath': str(svg), 'projectPath': str(editable)})
        self.state['annotationManifests'] = entries
        return entries

    def make_diagram_fixture(self):
        """Mock boundary metadata; this fixture is never a real DrawIO export."""
        manifest = self.output / 'img/block.conversion.json'
        manifest.write_text('{"testOnly":true,"description":"verifier boundary fixture"}')
        self.state['blockDiagram'] = {'manifestPath': str(manifest)}
        return str(manifest)

    def test_private_state_rejects_other_run_and_mutated_sources(self):
        other = dict(self.run, workflowId='other-workflow')
        with self.assertRaises(ValueError):
            pipeline._load(other)
        self.source.write_bytes(b'changed source')
        with self.assertRaisesRegex(ValueError, '源资料'):
            pipeline._load(self.run)

    def test_run_snapshot_and_learning_memory_scope_are_bound(self):
        (self.root / '.local').mkdir()
        record = dict(self.run, currentNodeId='guide-prepare')
        with sqlite3.connect(self.root / '.local/workbench.sqlite') as db:
            db.execute('CREATE TABLE workflow_runs(id TEXT, value TEXT)')
            db.execute('INSERT INTO workflow_runs VALUES(?,?)', (self.run_id, json.dumps(record)))
        env = {'WORKBENCH_RUN_ID': self.run_id, 'WORKBENCH_WORKFLOW_ID': self.workflow_id,
               'WORKBENCH_NODE_ID': 'guide-prepare', 'WORKBENCH_LEARNING_ID': self.run['learningId']}
        with patch.object(pipeline, 'ROOT', self.root), patch.dict(os.environ, env, clear=True):
            self.assertEqual(pipeline._run('prepare')['id'], self.run_id)
            with patch.dict(os.environ, {'WORKBENCH_LEARNING_ID': ''}), self.assertRaises(ValueError):
                pipeline._run('prepare')
            with patch.dict(os.environ, {'WORKBENCH_NODE_ID': 'guide-write'}), self.assertRaises(ValueError):
                pipeline._run('prepare')

    def test_execution_waits_for_gate_learning_uses_only_paired_source(self):
        with self.assertRaises(ValueError):
            pipeline._gate(dict(self.run, learningId=''))
        pipeline._gate(self.run)
        self.source.write_bytes(b'wrong paired source')
        with self.assertRaisesRegex(ValueError, '配对'):
            pipeline._gate(self.run)

    def test_disguised_or_renamed_known_answer_is_blocked_before_fact_extraction(self):
        target = self.root / 'known-result.md'
        renamed = self.root / 'bsp-readme.md'; renamed.write_bytes(target.read_bytes())
        for path in (target, renamed):
            value = {'sourcePath': str(self.source), 'technicalDocuments': [{'path': str(path), 'role': 'bsp-board-notes'}]}
            with self.subTest(path=path), patch.object(pipeline, '_gate'), patch('hdk.guide_facts.prepare_guide_facts') as prepare:
                with self.assertRaisesRegex(ValueError, '已知答案'):
                    pipeline._prepare(value, dict(self.run, input=value))
                prepare.assert_not_called()

    def test_gate_fingerprint_changes_with_skill_version_or_execution_edges(self):
        document = {'id': self.workflow_id, 'nodes': [{'id': 'skill', 'type': 'skill', 'config': {'skillRef': 'small-skill', 'version': 'v1'}}], 'edges': []}
        baseline = pipeline.fingerprint(document)
        renamed = dict(document, title='New display title', mode='learn')
        self.assertEqual(pipeline.fingerprint(renamed), baseline)
        for change in ('skill', 'edge'):
            changed = copy.deepcopy(document)
            if change == 'skill': changed['nodes'][0]['config']['version'] = 'v2'
            else: changed['edges'].append({'sourceNode': 'input', 'targetNode': 'skill'})
            self.assertNotEqual(pipeline.fingerprint(changed), baseline)

    def test_prepare_uses_current_verified_command_blocks_not_reference_substrings(self):
        facts = copy.deepcopy(self.facts)
        shell = 'python "$IDF_PATH/tools/idf.py" --preview -C source -DIDF_TARGET=esp32p4 build'
        facts['development']['verifiedCommands'] = [{'shell': shell}]
        with patch.object(pipeline, '_gate'), patch('hdk.guide_facts.prepare_guide_facts', return_value=facts), patch('hdk.guide_sdk.enrich_guide_development', side_effect=lambda facts, request: facts):
            result = pipeline._prepare(self.run['input'], self.run)
        saved = json.loads((self.private / (self.run_id + '.json')).read_text())
        self.assertEqual(saved['facts']['requiredCommands'], [shell])
        self.assertNotIn('referenceExamples', result)
        self.assertNotIn('known-result', json.dumps(result))

    def test_prepare_refuses_missing_verified_development_commands(self):
        with patch.object(pipeline, '_gate'), patch('hdk.guide_facts.prepare_guide_facts', return_value=self.facts), patch('hdk.guide_sdk.enrich_guide_development', side_effect=lambda facts, request: facts):
            with self.assertRaisesRegex(ValueError, '命令'):
                pipeline._prepare(self.run['input'], self.run)

    def test_phases_cannot_be_skipped_or_replayed(self):
        for operation, prior in [('annotate', 'write'), ('write', 'prepare'), ('verify', 'annotate')]:
            with self.subTest(operation=operation), patch.object(pipeline, '_run', return_value=self.run), patch.object(pipeline, '_load', return_value={**self.state, 'stage': prior}):
                with self.assertRaisesRegex(ValueError, '顺序'):
                    pipeline.execute_stage(operation, {})

    def test_annotation_cannot_add_or_remove_reviewed_regions(self):
        plan = self.plan()
        pipeline._validate_annotation(plan, self.facts)
        for regions in (plan['regions'][:1], plan['regions'] + [dict(plan['regions'][0], id='invented')]):
            with self.assertRaises(ValueError):
                pipeline._validate_annotation(dict(plan, regions=regions), self.facts)

    def test_malformed_annotation_is_a_learning_diagnostic(self):
        plans = [dict(self.plan(), regions=[None]), dict(self.plan(), style=None), dict(self.plan(), style=[])]
        for plan in plans:
            with self.subTest(plan=plan), patch('hdk.guide_facts.compact_skill_facts', return_value={'productCode': 'BOARD'}), patch.object(pipeline, '_process') as process:
                state = copy.deepcopy(self.state)
                result = pipeline._annotate(plan, state)
                self.assertEqual(result['annotation']['status'], 'invalidPlan')
                self.assertTrue(state['errors']['annotation'])
                process.assert_not_called()

    def test_malformed_annotation_stops_ordinary_execution(self):
        state = copy.deepcopy(self.state); state['learningId'] = ''
        with self.assertRaises(ValueError):
            pipeline._annotate(dict(self.plan(), regions=[]), state)

    def test_annotation_project_uses_upstream_font_id_and_bound_pixel_transform(self):
        image = self.facts['images'][0]
        selected, style = pipeline._validate_annotation(self.plan(), self.facts)
        with patch.object(pipeline, '_process', return_value={'labels': [{'width': 90, 'height': 42}]}):
            result = pipeline._annotation_project(image, selected, style, 'en', 'interface_en')
        region = result['regions'][0]
        self.assertIn(region['fontFamily'], ('sans', 'serif', 'mono'))
        margin = (result['image']['width'] - 720) / 2
        self.assertAlmostEqual(region['x'], 50 * 0.9 + margin)
        self.assertAlmostEqual(region['y'], 100 * 0.9 + 60)
        self.assertAlmostEqual(region['w'], 100 * 0.9)
        self.assertEqual(region['code'], 'J1')
        self.assertEqual(region['title'], 'Connector')
        embedded = base64.b64decode(result['image']['src'].split(',', 1)[1])
        with Image.open(io.BytesIO(embedded)) as picture:
            self.assertEqual(picture.size, (result['image']['width'], 1020))
            self.assertEqual(picture.getpixel((int(margin) + 10, 70)), (40, 80, 100, 255))

    def test_invalid_narrative_is_a_learning_diagnostic(self):
        from hdk.guide_render import GuideRenderBlocked
        with patch.object(pipeline, '_supporting_assets'), patch('hdk.guide_render.render_source_diagram'), patch('hdk.guide_render.render_bundle', side_effect=GuideRenderBlocked('missing bilingual field')):
            result = pipeline._write_guide({'overview': None}, self.state)
        self.assertEqual(result['stage'], 'write')
        self.assertTrue(self.state['errors']['narrative'])

    def test_verify_keeps_exact_summary_and_separate_provenance(self):
        expected = {'schemaVersion': 1, 'checks': dict.fromkeys((
            'bilingual-files', 'source-pin-tables-zh', 'source-pin-tables-en',
            'annotation-exports', 'source-unchanged', 'drawio-block-diagram'), True)}
        evaluator_ids = [key for key in expected['checks'] if key not in ('annotation-exports', 'source-unchanged', 'drawio-block-diagram')]
        self.make_annotation_fixture()
        diagram_manifest = self.make_diagram_fixture()
        evaluation = {'checks': [{'id': key, 'passed': True, 'issues': []} for key in evaluator_ids], 'issues': []}
        with patch('hdk.guide_reference.evaluate_guide_bundle', return_value=evaluation), \
                patch('hdk.guide_drawio.verify_source_diagram', return_value={'passed': True}) as diagram_verifier:
            result = pipeline._verify(self.state['nextInput'], self.state)
        diagram_verifier.assert_called_once_with(diagram_manifest, self.state['facts'])
        self.assertEqual(result['qualitySummary'], expected)
        proof = json.loads(Path(result['reportPath']).read_text())
        self.assertEqual(proof['runId'], self.run_id)
        self.assertEqual(proof['blockDiagramManifest'], diagram_manifest)
        self.assertEqual(proof['visualReview'], 'required')
        self.assertEqual(result['physicalTestStatus'], 'not-run')
        self.assertTrue(proof['qualified'])

    def test_failed_drawio_verification_is_a_learning_diagnostic_not_a_pass(self):
        self.make_annotation_fixture(); self.make_diagram_fixture()
        evaluation = {'checks': [{'id': 'bilingual-files', 'passed': True, 'issues': []}], 'issues': []}
        with patch('hdk.guide_reference.evaluate_guide_bundle', return_value=evaluation), \
                patch('hdk.guide_drawio.verify_source_diagram', return_value={'passed': False}) as diagram_verifier:
            result = pipeline._verify(self.state['nextInput'], self.state)
        diagram_verifier.assert_called_once()
        self.assertIs(result['qualitySummary']['checks']['drawio-block-diagram'], False)
        self.assertIn('diagnostics', result['qualitySummary'])
        self.assertFalse(json.loads(Path(result['reportPath']).read_text())['qualified'])

    def test_execution_rejects_missing_or_failed_drawio_artifact(self):
        self.make_annotation_fixture(); self.state['learningId'] = ''
        evaluation = {'checks': [{'id': 'bilingual-files', 'passed': True, 'issues': []}], 'issues': []}
        with patch('hdk.guide_reference.evaluate_guide_bundle', return_value=evaluation), \
                patch('hdk.guide_drawio.verify_source_diagram') as diagram_verifier:
            with self.assertRaisesRegex(ValueError, '验收未通过'):
                pipeline._verify(self.state['nextInput'], self.state)
            diagram_verifier.assert_not_called()
        manifest = self.make_diagram_fixture()
        with patch('hdk.guide_reference.evaluate_guide_bundle', return_value=evaluation), \
                patch('hdk.guide_drawio.verify_source_diagram', return_value={'passed': False}) as diagram_verifier:
            with self.assertRaisesRegex(ValueError, '验收未通过'):
                pipeline._verify(self.state['nextInput'], self.state)
            diagram_verifier.assert_called_once_with(manifest, self.state['facts'])

    def test_annotation_manifests_are_reread_and_changed_exports_fail(self):
        entries = self.make_annotation_fixture()
        self.assertTrue(pipeline._verify_annotations(self.state))
        Path(entries[0]['pngPath']).write_bytes(b'changed after export')
        self.assertFalse(pipeline._verify_annotations(self.state))

    def test_annotation_source_manifest_or_converter_drift_is_rejected(self):
        entries = self.make_annotation_fixture()
        bound = Path(entries[0]['source']['path'])
        original = bound.read_bytes(); bound.write_bytes(b'changed bound source')
        self.assertFalse(pipeline._verify_annotations(self.state))
        bound.write_bytes(original)
        manifest_path = Path(entries[0]['manifestPath'])
        manifest = json.loads(manifest_path.read_text()); manifest['converter']['commit'] = 'wrong-commit'
        pipeline.write_json(manifest_path, manifest)
        entries[0]['converter']['commit'] = 'wrong-commit'
        self.assertFalse(pipeline._verify_annotations(self.state))

    def test_annotation_artifacts_cannot_escape_bundle(self):
        entries = self.make_annotation_fixture()
        outside = self.root / 'outside.png'; outside.write_bytes(b'old artifact')
        manifest_path = Path(entries[0]['manifestPath'])
        manifest = json.loads(manifest_path.read_text())
        manifest['artifacts'][0] = {'path': str(outside), 'sha256': pipeline.sha(outside)}
        pipeline.write_json(manifest_path, manifest)
        entries[0]['artifacts'] = manifest['artifacts']
        self.assertFalse(pipeline._verify_annotations(self.state))

    def test_verify_rejects_stale_receipt(self):
        with self.assertRaisesRegex(ValueError, '回执'):
            pipeline._verify({'runId': 'old-run'}, self.state)


if __name__ == '__main__':
    unittest.main()
