"""Four-file stage boundaries using private temporary fixtures only.

No native EDA, browser rendering, or actual CAD conversion runs here. Small PDF,
PNG and STEP-format fixtures exercise admission and hash/provenance rejection;
the end-to-end real-model evidence is recorded separately by the workflow run.
"""
import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock, call
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('four_files_pipeline_boundaries', ROOT / 'hdk/four_files_pipeline.py')
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)
CAD_COMMIT = 'afd6a844e39ba0a205918dc866b60211f978b2b9'
PIN_COMMIT = 'de6196839c6cf8126f4bf29b9792f73c17013b44'


class FourFileBoundaries(unittest.TestCase):
    def test_pdf_with_missing_font_resource_is_rejected_even_when_page_is_readable(self):
        from pypdf import PdfReader, PdfWriter
        from pypdf.generic import DecodedStreamObject, NameObject
        writer = PdfWriter(); page = writer.add_blank_page(width=100, height=100)
        stream = DecodedStreamObject(); stream.set_data(b'BT /undefined 12 Tf 10 10 Td (truncated native text) Tj ET')
        page[NameObject('/Contents')] = writer._add_object(stream)
        buffer = io.BytesIO(); writer.write(buffer); buffer.seek(0)
        reader = PdfReader(buffer)
        self.assertEqual(len(reader.pages), 1)
        self.assertEqual(pipeline.pdf_font_check(reader), {'passed': False, 'missingFonts': ['/undefined']})

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.private = self.root / 'private'
        self.outputs = self.root / 'outputs'
        self.run_id = str(uuid.uuid4())
        self.workflow_id = 'workflow-epro2-four-files'
        self.source = self.root / 'fixture.epro2'
        self.source.write_bytes(b'immutable source fixture; not a real EDA archive')
        from PIL import Image
        self.front_photo = self.root / 'front.png'
        self.back_photo = self.root / 'back.jpg'
        Image.new('RGB', (120, 200), 'white').save(self.front_photo)
        Image.new('RGB', (120, 200), 'silver').save(self.back_photo)
        self.photo_profile = self.root / 'reviewed-photo-pins.json'
        self.photo_profile.write_text('{"fixture":"reviewed calibration; not real hardware evidence"}')
        self.output = self.outputs / self.run_id / 'BOARD_four_files'
        self.output.mkdir(parents=True)
        self.request = {'sourcePath': str(self.source), 'productCode': 'BOARD', 'hardwareVersion': '1.0', 'releaseDate': '2026-10-24'}
        self.state = {'runId': self.run_id, 'workflowId': self.workflow_id, 'stage': 'preflight',
                      'sourceSha256': pipeline.sha(self.source), 'request': self.request,
                      'outputParent': str(self.output.parent), 'outputPath': str(self.output), 'files': []}
        for name, value in [('PRIVATE', self.private), ('OUTPUTS', self.outputs)]:
            mocked = patch.object(pipeline, name, value)
            mocked.start(); self.addCleanup(mocked.stop)
        mocked = patch.dict(os.environ, {'WORKBENCH_RUN_ID': self.run_id, 'WORKBENCH_WORKFLOW_ID': self.workflow_id, 'WORKBENCH_NODE_ID': 'four-native'}, clear=True)
        mocked.start(); self.addCleanup(mocked.stop)
        self.private.mkdir()
        self.state_path = self.private / (self.run_id + '.json')
        self.save()

    def save(self):
        self.state_path.write_text(json.dumps(self.state), encoding='utf-8')

    def bind_pinout_skill(self):
        """Immutable run fixture for the new shared capability boundary."""
        self.skill_input = {'task': 'plan-pinout-display', 'displayOptions': {'pinCount': 2}}
        self.display_plan = {'format': 'workbench-pinout-display-plan', 'version': 1,
                             'style': {'preset': 'reference-compact'}, 'displayAliases': []}
        self.state.update(stage='pin-facts', skillInput=self.skill_input)
        self.save(); self.operation('pinout')
        self.skill_run = {'id': self.run_id, 'workflowId': self.workflow_id, 'currentNodeId': 'four-pinout',
                          'document': {'nodes': [{'id': 'four-pinout-skill', 'type': 'skill',
                                                 'config': {'skillRef': 'wb-learn-12345678-1234-1234-1234-123456789012',
                                                            'version': 'sha256:' + 'a' * 64}}]},
                          'nodes': {'four-pinout-skill': {'status': 'complete',
                                                        'input': self.skill_input, 'output': self.display_plan}}}
        (self.root / '.local').mkdir(exist_ok=True)
        self.db_path = self.root / '.local/workbench.sqlite'
        with sqlite3.connect(self.db_path) as db:
            db.execute('CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
        self.save_skill_run()
        mocked = patch.object(pipeline, 'ROOT', self.root)
        mocked.start(); self.addCleanup(mocked.stop)

    def save_skill_run(self):
        with sqlite3.connect(self.db_path) as db:
            db.execute('INSERT OR REPLACE INTO workflow_runs VALUES(?,?)', (self.run_id, json.dumps(self.skill_run)))

    def operation(self, operation):
        os.environ['WORKBENCH_NODE_ID'] = pipeline.NODES[operation]

    def photo_request(self):
        return self.request | {'images': [
            {'side': 'front', 'path': str(self.front_photo), 'sha256': pipeline.sha(self.front_photo)},
            {'side': 'back', 'path': str(self.back_photo), 'sha256': pipeline.sha(self.back_photo)}],
            'pinoutPhotoProfilePath': str(self.photo_profile)}

    def bind_photo_sources(self):
        self.state['request'] = self.photo_request()
        self.state['photoSources'] = [*self.state['request']['images'],
            {'path': str(self.photo_profile), 'sha256': pipeline.sha(self.photo_profile)}]
        self.save()

    def make_verify_fixture(self):
        from pypdf import PdfWriter
        from PIL import Image
        pdf, step, png, dwg = [self.output / name for name in ('BOARD_SCH_V1.0.pdf', 'BOARD_3D_V1.0.step', 'BOARD_Pinout_V1.0.png', 'BOARD_CAD_V1.0.dwg')]
        writer = PdfWriter(); writer.add_blank_page(width=595, height=842)
        with pdf.open('wb') as stream: writer.write(stream)
        step.write_text("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n#1=MANIFOLD_SOLID_BREP('test-only-format-fixture',#2);\n#2=CLOSED_SHELL('',());\nENDSEC;\nEND-ISO-10303-21;\n")
        Image.new('RGB', (200, 200), 'white').save(png)
        dwg.write_bytes(b'AC1015test-only-format-fixture; not a real DWG')
        self.state['files'] = [pipeline._artifact(path, kind, self.output) for path, kind in [(pdf, 'schematicPdf'), (step, 'step'), (png, 'pinout'), (dwg, 'cad')]]
        image = self.output / 'PCB_top.png'; Image.new('RGB', (100, 100), 'white').save(image)
        project = self.output / 'BOARD_Pinout_V1.0.openpinmap.json'
        project_data = {'format': 'openpinmap', 'version': 2, 'state': {'name': 'BOARD', 'width': 200, 'height': 200, 'imageData': 'data:image/png;base64,' + base64.b64encode(image.read_bytes()).decode(), 'groups': [{'name': 'J1', 'pins': [{'name': '1:GND', 'net': 'GND', 'color': '#2ecc71'}]}]}, 'workbenchAlignment': {'version': 1, 'sourceSha256': self.state['sourceSha256'], 'pcbUuid': 'pcb-fixture', 'imageSha256': pipeline.sha(image)}}
        project.write_text(json.dumps(project_data))
        saved_project = self.output / 'BOARD_Pinout_V1.0.project.json'
        saved_project.write_text(json.dumps({key: project_data[key] for key in ('format', 'version', 'state')}))
        facts = self.output / 'BOARD_Pinout_V1.0.facts.json'
        self.state['pinFacts'] = {'status': 'ready', 'validated': True, 'projectPath': str(project), 'factsPath': str(facts), 'pinCount': 1}
        facts_data = {'source': {'path': str(self.source), 'sha256': self.state['sourceSha256']}, 'pcbUuid': 'pcb-fixture', 'pinCount': 1,
                      'image': {'path': str(image), 'sha256': pipeline.sha(image), 'width': 100, 'height': 100},
                      'alignment': {'method': 'native-source-pad-net-and-calibrated-top-image', 'calibration': {'passed': True, 'maxErrorPx': 0}},
                      'preparation': self.state['pinFacts']}
        facts.write_text(json.dumps(facts_data))
        cad_project = self.output / 'BOARD_CAD_V1.0.openstep2dwg.json'; cad_project.write_text('{"format":"OpenStep2DWG","version":1}')
        artifact = lambda path: {'name': path.name, 'path': str(path), 'bytes': path.stat().st_size, 'sha256': pipeline.sha(path)}
        self.cad_manifest = self.output / 'BOARD_CAD_V1.0.conversion.json'
        cad_data = {'converter': {'name': 'OpenStep2DWG', 'version': '1.0.1', 'repository': 'https://github.com/geekheart/OpenStep2DWG', 'commit': CAD_COMMIT, 'execution': 'isolated-headless-chrome-browser-workers'},
                    'source': {'path': str(step), 'sha256': pipeline.sha(step), 'bytes': step.stat().st_size},
                    'verification': {'freshConversion': True, 'sourceHashMatched': True, 'dwgHeader': 'AC1015', 'roundtripEntityCountsMatched': True, 'independentGeometryPassed': True, 'mismatchedEntities': 0, 'auditErrors': 0, 'allRequestsLocalGet': True, 'pageErrors': []},
                    'artifacts': [artifact(dwg), artifact(cad_project)], 'limitations': ['test fixture']}
        self.cad_manifest.write_text(json.dumps(cad_data))
        self.state['cad'] = copy.deepcopy(cad_data) | {'manifestPath': str(self.cad_manifest)}
        self.pin_manifest = self.output / 'BOARD_Pinout_V1.0.conversion.json'
        pin_data = {'converter': {'name': 'OpenPinMap', 'version': '1.2.0', 'repository': 'https://github.com/geekheart/OpenPinMap', 'commit': PIN_COMMIT, 'execution': 'isolated-headless-chrome-local-renderer'},
                    'source': {'path': str(project), 'sha256': pipeline.sha(project), 'bytes': project.stat().st_size}, 'pinCount': 1,
                    'alignment': {'labelCentersResolvedUsingRendererFontMetrics': True, 'sourceSha256': self.state['sourceSha256'], 'imageSha256': pipeline.sha(image)},
                    'verification': {'freshContext': True, 'defaultExampleUsed': False, 'boundProjectReadbackMatched': True, 'sourceHashMatched': True, 'pngDimensionsMatched': True, 'svgLabelCountMatched': True, 'svgEmbeddedImageMatched': True, 'allRequestsLocalGet': True, 'pageErrors': []},
                    'artifacts': [artifact(png), artifact(saved_project)]}
        self.pin_manifest.write_text(json.dumps(pin_data))
        self.state['pinout'] = copy.deepcopy(pin_data) | {'manifestPath': str(self.pin_manifest), 'pngPath': str(png), 'projectPath': str(saved_project)}
        self.state['native'] = {'status': 'complete', 'source': {'sha256': self.state['sourceSha256']}, 'outputPath': str(self.output), 'artifacts': self.state['files'][:2], 'checks': {'originalSourceUnchanged': True, 'inputCopyUnchanged': True}}
        self.state['stage'] = 'pinout'
        self.save()

    def make_photo_verify_fixture(self):
        """Synthetic two-side provenance, never a claim of a real board export."""
        from PIL import Image
        self.make_verify_fixture(); self.bind_photo_sources()
        artifact = lambda path: {'name': path.name, 'path': str(path), 'bytes': path.stat().st_size, 'sha256': pipeline.sha(path)}
        self.state['photoArchives'] = []
        for source in self.state['request']['images']:
            copied = self.output / (source['side'] + '-original' + Path(source['path']).suffix)
            shutil.copyfile(source['path'], copied)
            self.state['photoArchives'].append(dict(pipeline._artifact(copied, 'photoOriginal', self.output), side=source['side']))
        copied_profile = self.output / 'photo-calibration.json'; shutil.copyfile(self.photo_profile, copied_profile)
        self.state['photoArchives'].append(pipeline._artifact(copied_profile, 'photoCalibration', self.output))
        original_project = json.loads(Path(self.state['pinFacts']['projectPath']).read_text())
        original_facts = json.loads(Path(self.state['pinFacts']['factsPath']).read_text())
        original_manifest = json.loads(self.pin_manifest.read_text())
        pin_facts, pinouts = [], []
        for side in ('front', 'back'):
            source = next(item for item in self.state['request']['images'] if item['side'] == side)
            image_path = self.output / (side + '-derived.png')
            with Image.open(source['path']) as original:
                original.convert('RGBA').save(image_path)
                info = {'path': source['path'], 'sha256': source['sha256'], 'bytes': Path(source['path']).stat().st_size,
                        'width': original.width, 'height': original.height}
            image = info | {'path': str(image_path), 'sha256': pipeline.sha(image_path), 'bytes': image_path.stat().st_size}
            photograph = {'side': side, 'kind': 'actual-photograph', 'original': info, 'cropBox': [0, 0, 120, 200],
                'derived': image, 'profile': {'path': str(self.photo_profile), 'sha256': pipeline.sha(self.photo_profile)},
                'transformation': 'transparent-margin-crop-only', 'pixelsUnchanged': True, 'revisionCaveat': 'test-only photo fixture'}
            project_path = self.output / (side + '.openpinmap.json')
            project = copy.deepcopy(original_project)
            project['state']['imageData'] = 'data:image/png;base64,' + base64.b64encode(image_path.read_bytes()).decode()
            project['workbenchAlignment'].update(imageSha256=pipeline.sha(image_path), photograph=photograph)
            project_path.write_text(json.dumps(project))
            saved_project = self.output / (side + '.project.json')
            saved_project.write_text(json.dumps({key: project[key] for key in ('format', 'version', 'state')}))
            png = self.output / ('BOARD_Pinout_V1.0.png' if side == 'front' else 'BOARD_Pinout_Back_V1.0.png')
            Image.new('RGB', (200, 240), 'white').save(png)
            facts_path = self.output / (side + '.facts.json')
            preparation = {'side': side, 'status': 'ready', 'validated': True, 'pinCount': 1,
                           'projectPath': str(project_path), 'factsPath': str(facts_path)}
            facts = copy.deepcopy(original_facts)
            facts.update(image=image, photograph=photograph, preparation=preparation,
                connectors=[{'designator': 'J1', 'pins': [{'pad': '1', 'net': 'GND'}]}])
            facts['alignment'].update(worldToPixel=[1 if side == 'front' else -1, 0, 0, 1, 0, 0], view=side)
            facts_path.write_text(json.dumps(facts))
            manifest_path = self.output / (side + '.conversion.json')
            manifest = copy.deepcopy(original_manifest)
            manifest['source'] = artifact(project_path)
            manifest['alignment'].update(imageSha256=pipeline.sha(image_path), photograph=photograph)
            manifest['artifacts'] = [artifact(png), artifact(saved_project)]
            manifest_path.write_text(json.dumps(manifest))
            pin_facts.append(preparation)
            pinouts.append(manifest | {'side': side, 'pinCount': 1, 'pngPath': str(png), 'projectPath': str(saved_project),
                'manifestPath': str(manifest_path), 'factsPath': str(facts_path)})
        self.state['pinFacts'] = pin_facts[0]
        self.state['photoPinFacts'] = {'status': 'ready', 'validated': True, 'views': pin_facts}
        self.state['pinout'] = pinouts[0]; self.state['pinoutViews'] = pinouts
        self.state['files'] = [file for file in self.state['files'] if file['kind'] != 'pinout'] + [pipeline._artifact(pinouts[0]['pngPath'], 'pinout', self.output)]
        self.state['supplementaryFiles'] = [pipeline._artifact(pinouts[1]['pngPath'], 'pinoutBack', self.output)]
        self.save()

    def test_run_and_node_binding_cannot_be_overridden_by_receipt(self):
        for variable, bad in [('WORKBENCH_RUN_ID', '../forged'), ('WORKBENCH_NODE_ID', 'four-cad'), ('WORKBENCH_WORKFLOW_ID', '../other')]:
            with self.subTest(variable=variable), patch.dict(os.environ, {variable: bad}):
                with self.assertRaises((ValueError, KeyError, OSError)):
                    pipeline._load(pipeline._receipt(self.state), 'native')

    def test_exact_private_receipt_rejects_forged_fields(self):
        for key, value in [('runId', str(uuid.uuid4())), ('workflowId', 'other-workflow'), ('sourceSha256', '0' * 64), ('outputPath', '/tmp/unowned'), ('stage', 'native'), ('files', [{'kind': 'cad', 'path': '/tmp/old.dwg', 'bytes': 1, 'sha256': '0' * 64}])]:
            receipt = pipeline._receipt(self.state); receipt[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): pipeline._load(receipt, 'native')

    def test_receipt_from_another_run_is_rejected(self):
        other = str(uuid.uuid4())
        with patch.dict(os.environ, {'WORKBENCH_RUN_ID': other}), self.assertRaises((ValueError, OSError)):
            pipeline._load(pipeline._receipt(self.state), 'native')

    def test_stages_cannot_be_skipped_or_replayed(self):
        self.operation('cad')
        with self.assertRaises(ValueError): pipeline._load(pipeline._receipt(self.state), 'cad')
        self.state['stage'] = 'native'; self.save(); self.operation('native')
        with self.assertRaises(ValueError): pipeline._load(pipeline._receipt(self.state), 'native')

    def test_input_hash_change_aborts_before_native_call(self):
        self.source.write_bytes(b'changed original')
        with self.assertRaises(ValueError): pipeline._load(pipeline._receipt(self.state), 'native')

    def test_input_schema_rejects_paths_and_unapproved_options(self):
        for extra in [{'productCode': '../BOARD'}, {'hardwareVersion': '../1.0'}, {'releaseDate': '2026-02-30'}, {'cadRotation': True}, {'cadRotation': 45}, {'cadLayout': 'random'}, {'cadDetail': 'deleteParts'}, {'outputPath': '/tmp/injected'}, {'sourcePath': str(self.root / 'missing.epro2')}]:
            with self.subTest(extra=extra), self.assertRaises((ValueError, OSError)):
                pipeline.validate_input(self.photo_request() | extra)

    def test_new_input_requires_both_hash_bound_photos_and_reviewed_profile(self):
        request = self.photo_request()
        accepted = pipeline.validate_input(request)
        self.assertEqual(accepted['images'], [{**image, 'path': str(Path(image['path']).resolve())} for image in request['images']])
        self.assertEqual(accepted['pinoutPhotoProfilePath'], str(self.photo_profile.resolve()))
        self.assertEqual(accepted['sourcePath'], str(self.source.resolve()))
        for missing in ('images', 'pinoutPhotoProfilePath'):
            bad = copy.deepcopy(request); del bad[missing]
            with self.subTest(missing=missing), self.assertRaises(ValueError):
                pipeline.validate_input(bad)
        with self.assertRaises(ValueError):
            pipeline.validate_input(self.request)

    def test_photo_input_rejects_missing_duplicate_unknown_sides_and_stale_hashes(self):
        mutations = [
            ('missing-back', lambda value: value.update(images=value['images'][:1])),
            ('duplicate-side', lambda value: value['images'][1].update(side='front')),
            ('unknown-side', lambda value: value['images'][1].update(side='bottom')),
            ('sha256', lambda value: value['images'][0].update(sha256='0' * 64)),
            ('malformed-sha256', lambda value: value['images'][0].update(sha256='not-a-hash')),
            ('unknown-image-option', lambda value: value['images'][0].update(useNativePcb=True)),
            ('missing-image', lambda value: value['images'][0].update(path=str(self.root / 'absent.png'))),
            ('missing-profile', lambda value: value.update(pinoutPhotoProfilePath=str(self.root / 'absent.json')))]
        for name, change in mutations:
            bad = self.photo_request(); change(bad)
            with self.subTest(name=name), self.assertRaises((ValueError, OSError)):
                pipeline.validate_input(bad)

    def test_photo_input_checks_actual_image_format_and_dimensions(self):
        from PIL import Image
        for name, size, format in [('small.png', (16, 200), 'PNG'), ('not-photo.gif', (120, 200), 'GIF')]:
            bad_photo = self.root / name; Image.new('RGB', size).save(bad_photo, format=format)
            request = self.photo_request()
            request['images'][0].update(path=str(bad_photo), sha256=pipeline.sha(bad_photo))
            with self.subTest(name=name), self.assertRaises(ValueError):
                pipeline.validate_input(request)
        invalid = self.root / 'invalid.png'; invalid.write_bytes(b'not an image')
        request = self.photo_request()
        request['images'][0].update(path=str(invalid), sha256=pipeline.sha(invalid))
        with self.assertRaises((ValueError, OSError)):
            pipeline.validate_input(request)

    def test_every_later_stage_rechecks_both_photos_and_calibration_before_work(self):
        self.bind_photo_sources()
        for operation in pipeline.STAGES[1:]:
            self.state['stage'] = pipeline.STAGES[pipeline.STAGES.index(operation) - 1]
            self.save(); self.operation(operation)
            for source in (self.front_photo, self.back_photo, self.photo_profile):
                original = source.read_bytes(); source.write_bytes(original + b'changed')
                with self.subTest(operation=operation, source=source.name), patch.object(pipeline, '_process') as process:
                    with self.assertRaisesRegex(ValueError, '实拍图|校准'):
                        pipeline.execute_stage(operation, pipeline._receipt(self.state))
                    process.assert_not_called()
                source.write_bytes(original)

    def test_preflight_persists_exact_photo_and_calibration_hashes(self):
        self.operation('preflight'); self.state_path.unlink()
        with patch('hdk.four_files_native.core.source_info', return_value={'sha256': pipeline.sha(self.source)}), \
                patch.object(pipeline, '_process', return_value={'ready': True}), \
                patch.object(pipeline, 'OUTPUTS', self.root / 'new-preflight-outputs'):
            pipeline.execute_stage('preflight', self.photo_request())
        stored = json.loads(self.state_path.read_text())
        self.assertEqual({item['side'] for item in stored['request']['images']}, {'front', 'back'})
        self.assertEqual(stored['photoSources'], [*stored['request']['images'],
            {'path': str(self.photo_profile.resolve()), 'sha256': pipeline.sha(self.photo_profile)}])

    def test_output_paths_refuse_outside_and_symlink_files(self):
        outside = self.root / 'old.dwg'; outside.write_bytes(b'old')
        symlink = self.output / 'symlink.dwg'; symlink.symlink_to(outside)
        for path in (outside, symlink, self.output / 'missing.dwg', self.output):
            with self.subTest(path=path), self.assertRaises(ValueError): pipeline._inside(path, self.output)

    def test_negative_pinout_preparation_blocks_progress_and_persists_reason(self):
        self.state['stage'] = 'cad'; self.state['native'] = {'reportPath': str(self.output / 'native.json')}; self.save(); self.operation('pin-facts')
        negative = {'status': 'blocked', 'validated': False, 'reason': 'ambiguous pad numbering', 'factsPath': str(self.output / 'facts.json'), 'projectPath': None}
        with patch('hdk.pinout_facts.prepare_pinout', return_value=negative), patch.object(pipeline, '_process') as process:
            with self.assertRaisesRegex(ValueError, 'Pinout'):
                pipeline.execute_stage('pin-facts', pipeline._receipt(self.state))
            process.assert_not_called()
        stored = json.loads(self.state_path.read_text())
        self.assertEqual(stored['stage'], 'cad')
        self.assertFalse(stored['pinFacts']['validated'])

    def test_photo_pin_facts_uses_both_photos_and_never_native_pcb_background(self):
        self.bind_photo_sources(); self.state['stage'] = 'cad'
        self.state['native'] = {'reportPath': str(self.output / 'native.json'), 'boardImagePath': '/unused/native-top.png'}
        self.save(); self.operation('pin-facts')
        views = [{'side': side, 'projectPath': str(self.output / (side + '.json')),
                  'factsPath': str(self.output / (side + '.facts.json')), 'pinCount': 54}
                 for side in ('front', 'back')]
        ready = {'status': 'ready', 'validated': True, 'views': views}
        skill_input = {'task': 'plan-pinout-display', 'displayOptions': {'pinCount': 54},
                       'views': [{'side': 'front'}, {'side': 'back'}]}
        with patch('hdk.pinout_facts.prepare_photo_pinouts', return_value=ready) as photo, \
                patch('hdk.pinout_facts.prepare_pinout') as legacy, \
                patch('hdk.pinout_pipeline.prepare_plan_input', return_value=skill_input) as shared_input:
            result = pipeline.execute_stage('pin-facts', pipeline._receipt(self.state))
        legacy.assert_not_called()
        self.assertEqual(photo.call_count, 1)
        invocation = photo.call_args.args[0]
        self.assertEqual(invocation['images'], self.state['request']['images'])
        self.assertEqual(invocation['photoProfilePath'], str(self.photo_profile))
        self.assertEqual(invocation['nativeMetaPath'], self.state['native']['reportPath'])
        self.assertNotIn('boardImagePath', invocation)
        shared_input.assert_called_once_with(views, self.state['request'])
        self.assertEqual(result, skill_input)
        stored = json.loads(self.state_path.read_text())
        self.assertEqual(stored['photoPinFacts'], ready)
        self.assertEqual(stored['pinFacts']['side'], 'front')
        self.assertEqual(stored['stage'], 'pin-facts')
        self.assertEqual(stored['skillInput'], skill_input)

    def test_pinout_skill_boundary_accepts_only_the_selected_completed_snapshot(self):
        self.bind_pinout_skill()
        stored, _ = pipeline._load(self.display_plan, 'pinout')
        self.assertEqual(stored['pinoutSkill'], {
            'ref': 'wb-learn-12345678-1234-1234-1234-123456789012', 'version': 'sha256:' + 'a' * 64})
        for value in [dict(self.display_plan, forged=True), pipeline._receipt(self.state), {'planFromOtherRun': True}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                pipeline._load(value, 'pinout')

    def test_pinout_skill_rejects_changed_input_output_or_incomplete_step(self):
        self.bind_pinout_skill(); baseline = copy.deepcopy(self.skill_run)
        for mutation in [lambda run: run['nodes']['four-pinout-skill'].update(status='running'),
                         lambda run: run['nodes']['four-pinout-skill'].update(input={'task': 'foreign-input'}),
                         lambda run: run['nodes']['four-pinout-skill'].update(output={'planFromOtherRun': True}),
                         lambda run: run['document'].update(nodes=[])]:
            self.skill_run = copy.deepcopy(baseline); mutation(self.skill_run); self.save_skill_run()
            with self.assertRaises(ValueError):
                pipeline._load(self.display_plan, 'pinout')

    def test_pinout_skill_rejects_cross_workflow_node_and_learning_scope(self):
        self.bind_pinout_skill(); baseline = copy.deepcopy(self.skill_run)
        for key, changed in [('workflowId', 'foreign-workflow'), ('currentNodeId', 'four-verify'),
                             ('learningId', str(uuid.uuid4()))]:
            self.skill_run = dict(baseline, **{key: changed}); self.save_skill_run()
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, '不可变'):
                pipeline._load(self.display_plan, 'pinout')
        self.skill_run = baseline; self.save_skill_run()
        with patch.dict(os.environ, {'WORKBENCH_RUN_ID': str(uuid.uuid4())}), self.assertRaises((ValueError, OSError)):
            pipeline._load(self.display_plan, 'pinout')

    def test_four_file_pinout_reuses_the_same_renderer_and_fixed_skill_plan(self):
        self.bind_pinout_skill()
        original_views = [{'side': 'front', 'factsPath': 'source-front-facts'}, {'side': 'back', 'factsPath': 'source-back-facts'}]
        self.state['photoPinFacts'] = {'views': original_views}
        self.state['native'] = {'reportPath': str(self.output / 'source-native-report.json')}
        rendered_views = []
        for side in ('front', 'back'):
            image = self.output / (side + '.png')
            from PIL import Image
            Image.new('RGB', (120, 200), 'white').save(image)
            rendered_views.append({'side': side, 'pngPath': str(image)})
        prepared = {'views': [{'side': side, 'factsPath': 'planned-' + side} for side in ('front', 'back')]}
        self.save()
        planned = {'displayPlan': self.display_plan, 'prepared': prepared, 'views': rendered_views}
        with patch('hdk.pinout_pipeline.render_photo_plan', return_value=planned) as shared_renderer, patch.object(pipeline, '_process') as legacy_converter:
            result = pipeline.execute_stage('pinout', self.display_plan)
        shared_renderer.assert_called_once_with(self.state['request'], original_views, self.state['native']['reportPath'],
                                               self.state['outputPath'], self.display_plan)
        legacy_converter.assert_not_called()
        stored = json.loads(self.state_path.read_text())
        self.assertEqual(stored['pinoutDisplayPlan'], self.display_plan)
        self.assertEqual(stored['photoPinFacts'], prepared)
        self.assertEqual(stored['pinoutViews'], rendered_views)
        self.assertEqual(stored['stage'], 'pinout')
        self.assertEqual(result['stage'], 'pinout')
        self.assertEqual([item['kind'] for item in stored['files']], ['pinout'])
        self.assertEqual([item['kind'] for item in stored['supplementaryFiles']], ['pinoutBack'])

    def test_unready_or_incomplete_photo_preparation_cannot_fall_back_to_native(self):
        self.bind_photo_sources(); self.state['stage'] = 'cad'
        self.state['native'] = {'reportPath': str(self.output / 'native.json')}
        self.save(); self.operation('pin-facts')
        for preparation in [{'status': 'blocked', 'validated': False, 'views': []},
                            {'status': 'ready', 'validated': True, 'views': [{'side': 'front'}]},
                            {'status': 'ready', 'validated': True, 'views': [{'side': 'front'}, {'side': 'front'}]},
                            {'status': 'ready', 'validated': True, 'views': [{'side': 'back'}, {'side': 'back'}]}]:
            shutil.rmtree(self.output / 'sources', ignore_errors=True)
            with self.subTest(preparation=preparation), \
                    patch('hdk.pinout_facts.prepare_photo_pinouts', return_value=preparation), \
                    patch('hdk.pinout_facts.prepare_pinout') as legacy:
                with self.assertRaisesRegex(ValueError, '实拍图'):
                    pipeline.execute_stage('pin-facts', pipeline._receipt(self.state))
                legacy.assert_not_called()
                stored = json.loads(self.state_path.read_text())
                self.assertEqual(stored['stage'], 'cad')

    def test_photo_pinout_renders_both_views_and_keeps_front_as_core_artifact(self):
        from PIL import Image
        self.bind_photo_sources(); self.state['stage'] = 'pin-facts'
        views, rendered = [], []
        for side in ('front', 'back'):
            project = self.output / (side + '.openpinmap.json'); project.write_text('{}')
            png = self.output / (side + '.png'); Image.new('RGB', (120, 200), 'white').save(png)
            views.append({'side': side, 'projectPath': str(project), 'factsPath': str(self.output / (side + '.facts.json'))})
            rendered.append({'pngPath': str(png), 'projectPath': str(self.output / (side + '.project.json'))})
        self.state['photoPinFacts'] = {'status': 'ready', 'validated': True, 'views': views}
        self.state['pinFacts'] = dict(views[0], status='ready', validated=True)
        self.save(); self.operation('pinout')
        with patch.object(pipeline, '_process', side_effect=rendered) as converter:
            pipeline.execute_stage('pinout', pipeline._receipt(self.state))
        self.assertEqual(converter.call_count, 2)
        commands = [invocation.args[0] for invocation in converter.call_args_list]
        self.assertIn(str(self.output / 'front.openpinmap.json'), [str(value) for value in commands[0]])
        self.assertIn(str(self.output / 'back.openpinmap.json'), [str(value) for value in commands[1]])
        self.assertIn('BOARD_Pinout_V1.0', commands[0])
        self.assertIn('BOARD_Pinout_Back_V1.0', commands[1])
        stored = json.loads(self.state_path.read_text())
        self.assertEqual(stored['pinout']['side'], 'front')
        self.assertEqual([view['side'] for view in stored['pinoutViews']], ['front', 'back'])
        self.assertEqual([item['kind'] for item in stored['files']], ['pinout'])
        self.assertEqual([item['kind'] for item in stored['supplementaryFiles']], ['pinoutBack'])

    def test_changed_step_never_reaches_cad_converter(self):
        step = self.output / 'board.step'; step.write_bytes(b'original step')
        self.state['files'] = [pipeline._artifact(step, 'step', self.output)]; self.state['stage'] = 'native'; self.save(); self.operation('cad')
        step.write_bytes(b'changed step')
        with patch.object(pipeline, '_process') as process:
            with self.assertRaises(ValueError): pipeline.execute_stage('cad', pipeline._receipt(self.state))
            process.assert_not_called()

    def test_process_rejects_bad_or_oversized_protocol_and_failed_command(self):
        for program in ["print('not-json')", "print('[]')", "print('x'*65537)", "import sys;print('{}');sys.exit(2)"]:
            with self.subTest(program=program), self.assertRaises(ValueError): pipeline._process([sys.executable, '-c', program])

    def test_process_timeout_cannot_be_reported_as_success(self):
        with self.assertRaisesRegex(ValueError, '时限'): pipeline._process([sys.executable, '-c', 'import time;time.sleep(0.5)'], timeout=0.01)

    def test_timeout_requests_graceful_converter_abort_before_any_force_kill(self):
        child = Mock()
        child.wait.side_effect = [subprocess.TimeoutExpired(['converter'], 5), None]
        with patch.object(pipeline.subprocess, 'Popen', return_value=child), self.assertRaisesRegex(ValueError, '时限'):
            pipeline._process(['converter'], timeout=5)
        child.terminate.assert_called_once_with()
        child.kill.assert_not_called()
        self.assertEqual(child.wait.call_args_list, [call(timeout=5), call(timeout=10)])

    def test_timeout_force_kills_converter_only_after_graceful_deadline(self):
        child = Mock()
        child.wait.side_effect = [subprocess.TimeoutExpired(['converter'], 5), subprocess.TimeoutExpired(['converter'], 10), None]
        with patch.object(pipeline.subprocess, 'Popen', return_value=child), self.assertRaisesRegex(ValueError, '时限'):
            pipeline._process(['converter'], timeout=5)
        child.terminate.assert_called_once_with()
        child.kill.assert_called_once_with()
        self.assertEqual(child.wait.call_args_list, [call(timeout=5), call(timeout=10), call()])

    def test_existing_preflight_cannot_replace_private_context(self):
        self.operation('preflight')
        before = self.state_path.read_bytes()
        with self.assertRaises(ValueError): pipeline.execute_stage('preflight', self.photo_request())
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_native_receipt_cannot_redirect_output_to_another_run(self):
        outside = self.root / 'unowned-output'; outside.mkdir()
        report = {'status': 'complete', 'source': {'sha256': self.state['sourceSha256']}, 'outputPath': str(outside), 'artifacts': []}
        with patch('hdk.four_files_native.export_native', return_value=report), self.assertRaises(ValueError):
            pipeline.execute_stage('native', pipeline._receipt(self.state))

    def test_private_fixture_is_accepted_only_as_admission_fixture(self):
        self.make_verify_fixture()
        self.assertEqual(pipeline.verify_files(self.state)['status'], 'complete')

    def test_two_photo_fixture_is_admitted_with_both_views_and_editable_projects(self):
        self.make_photo_verify_fixture()
        result = pipeline.verify_files(self.state)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual({view['side'] for view in result['pinoutViews']}, {'front', 'back'})
        self.assertTrue(all(view['pixelsUnchanged'] for view in result['pinoutViews']))
        for key in ('pinoutActualPhotographs', 'pinoutBothSidesVerified', 'pinoutOppositeViewsVerified', 'pinoutRetainedPhotoPixels'):
            self.assertIs(result['checks'][key], True)
        self.assertIn(self.state['pinoutViews'][1]['projectPath'], result['editableProjects'])
        self.assertIn('实拍图', result['pinoutBackground'])

    def failed_presentation_fixture(self):
        """A fixed evaluator result, not a fabricated successful image review."""
        self.make_photo_verify_fixture()
        self.state['pinoutSkill'] = {'ref': 'board-pinout', 'version': 'sha256:' + 'a' * 64}
        self.state['pinoutDisplayPlan'] = {'format': 'workbench-pinout-display-plan', 'version': 1,
                                           'style': {'preset': 'engineering'}, 'displayAliases': []}
        return {'passed': False, 'qualitySummary': {'passed': False, 'checks': {'transparent-portrait': False}},
                'learningComparison': {'qualitySummary': {'passed': False, 'checks': {'transparent-portrait': False}},
                                       'diagnostics': [{'check': 'transparent-portrait', 'message': 'fixture white landscape export'}]}}

    def test_failed_pinout_style_blocks_ordinary_four_file_delivery(self):
        presentation = self.failed_presentation_fixture()
        with patch('hdk.pinout_learning.evaluate_pinout_views', return_value=presentation) as evaluator:
            with self.assertRaisesRegex(ValueError, 'pinoutLearnedPresentation'):
                pipeline.verify_files(self.state)
        evaluator.assert_called_once()
        self.assertEqual(evaluator.call_args.args[0], self.state['pinoutViews'])
        saved = json.loads((self.output / 'Pinout样式验收.json').read_text())
        self.assertFalse(saved['passed'])

    def test_learning_retains_style_failure_and_real_diagnostics_for_the_target_skill(self):
        presentation = self.failed_presentation_fixture()
        with patch.dict(os.environ, {'WORKBENCH_LEARNING_ID': str(uuid.uuid4())}), \
                patch('hdk.pinout_learning.evaluate_pinout_views', return_value=presentation):
            result = pipeline.verify_files(self.state)
        self.assertEqual(result['status'], 'complete')
        self.assertFalse(result['checks']['pinoutLearnedPresentation'])
        self.assertTrue(all(value for key, value in result['checks'].items() if key != 'pinoutLearnedPresentation'))
        self.assertEqual(result['pinoutSkill'], self.state['pinoutSkill'])
        self.assertEqual(result['pinoutLearningComparison']['diagnostics'], presentation['learningComparison']['diagnostics'])
        self.assertEqual(result['pinoutLearningComparison']['plan'], self.state['pinoutDisplayPlan'])

    def test_learning_cannot_soften_failed_engineering_provenance_alongside_style_failure(self):
        presentation = self.failed_presentation_fixture()
        cad = json.loads(self.cad_manifest.read_text())
        cad['verification']['independentGeometryPassed'] = False
        self.cad_manifest.write_text(json.dumps(cad))
        with patch.dict(os.environ, {'WORKBENCH_LEARNING_ID': str(uuid.uuid4())}), \
                patch('hdk.pinout_learning.evaluate_pinout_views', return_value=presentation), \
                self.assertRaisesRegex(ValueError, 'cadIndependentGeometry'):
            pipeline.verify_files(self.state)

    def test_final_photo_admission_rechecks_originals_and_profile_without_stage_loader(self):
        self.make_photo_verify_fixture()
        for path in (self.front_photo, self.back_photo, self.photo_profile):
            original = path.read_bytes(); path.write_bytes(original + b'changed')
            with self.subTest(path=path.name), self.assertRaisesRegex(ValueError, '实拍图|校准'):
                pipeline.verify_files(self.state)
            path.write_bytes(original)

    def test_final_photo_admission_rejects_missing_duplicate_sides_and_archives(self):
        self.make_photo_verify_fixture(); baseline = copy.deepcopy(self.state)
        mutations = [('missing-back', lambda value: value.update(pinoutViews=value['pinoutViews'][:1])),
                     ('duplicate-side', lambda value: value['pinoutViews'][1].update(side='front')),
                     ('missing-photo-copy', lambda value: value.update(photoArchives=[item for item in value['photoArchives'] if item.get('side') != 'back'])),
                     ('missing-calibration-copy', lambda value: value.update(photoArchives=[item for item in value['photoArchives'] if item['kind'] != 'photoCalibration']))]
        for name, change in mutations:
            value = copy.deepcopy(baseline); change(value)
            with self.subTest(name=name), self.assertRaises(ValueError): pipeline.verify_files(value)

    def test_back_photo_artifacts_receive_the_same_hash_and_converter_admission(self):
        self.make_photo_verify_fixture(); back = self.state['pinoutViews'][1]
        for key in ('pngPath', 'projectPath'):
            path = Path(back[key]); original = path.read_bytes(); path.write_bytes(original + b'changed')
            with self.subTest(key=key), self.assertRaises(ValueError): pipeline.verify_files(self.state)
            path.write_bytes(original)
        path = Path(back['manifestPath']); baseline = json.loads(path.read_text())
        mutations = [('commit', lambda value: value['converter'].update(commit='0' * 40)),
                     ('converter-name', lambda value: value['converter'].update(name='OtherRenderer')),
                     ('source-project', lambda value: value['source'].update(sha256='0' * 64)),
                     ('default-example', lambda value: value['verification'].update(defaultExampleUsed=True)),
                     ('embedded-proof', lambda value: value['verification'].update(svgEmbeddedImageMatched=False)),
                     ('photo-side', lambda value: value['alignment']['photograph'].update(side='front'))]
        for name, change in mutations:
            value = copy.deepcopy(baseline); change(value); path.write_text(json.dumps(value))
            with self.subTest(name=name), self.assertRaises(ValueError): pipeline.verify_files(self.state)
        path.write_text(json.dumps(baseline))

    def test_back_view_paths_must_be_unique_actual_manifest_artifacts(self):
        self.make_photo_verify_fixture(); baseline = copy.deepcopy(self.state)
        front = baseline['pinoutViews'][0]
        for field in ('pngPath', 'projectPath'):
            value = copy.deepcopy(baseline)
            value['pinoutViews'][1][field] = front[field]
            with self.subTest(redirect=field), self.assertRaisesRegex(ValueError, '导出清单'):
                pipeline.verify_files(value)
        manifest_path = Path(baseline['pinoutViews'][1]['manifestPath'])
        manifest = json.loads(manifest_path.read_text())
        for name, artifacts in [('missing-png', manifest['artifacts'][1:]),
                                ('missing-project', manifest['artifacts'][:1]),
                                ('empty', []), ('duplicate-png', manifest['artifacts'] + manifest['artifacts'][:1])]:
            manifest_path.write_text(json.dumps(manifest | {'artifacts': artifacts}))
            with self.subTest(manifest=name), self.assertRaisesRegex(ValueError, '导出清单'):
                pipeline.verify_files(self.state)
        manifest_path.write_text(json.dumps(manifest))

    def test_back_image_must_have_one_unchanged_supplementary_receipt(self):
        self.make_photo_verify_fixture(); baseline = copy.deepcopy(self.state)
        for name, receipts in [('missing', []), ('duplicate', baseline['supplementaryFiles'] * 2)]:
            value = copy.deepcopy(baseline); value['supplementaryFiles'] = receipts
            with self.subTest(receipt=name), self.assertRaisesRegex(ValueError, '附加产物'):
                pipeline.verify_files(value)
        for field, bad in [('bytes', 1), ('sha256', '0' * 64)]:
            value = copy.deepcopy(baseline); value['supplementaryFiles'][0][field] = bad
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, '附加产物'):
                pipeline.verify_files(value)

    def test_photo_admission_rejects_changed_electrical_map_or_same_mirror_direction(self):
        self.make_photo_verify_fixture(); path = Path(self.state['pinoutViews'][1]['factsPath'])
        baseline = json.loads(path.read_text())
        for name, change in [('net', lambda value: value['connectors'][0]['pins'][0].update(net='IO0')),
                             ('pin-number', lambda value: value['connectors'][0]['pins'][0].update(pad='2')),
                             ('same-view-direction', lambda value: value['alignment'].update(worldToPixel=[1, 0, 0, 1, 0, 0]))]:
            value = copy.deepcopy(baseline); change(value); path.write_text(json.dumps(value))
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, '针序|镜像'):
                pipeline.verify_files(self.state)
        path.write_text(json.dumps(baseline))

    def test_photo_admission_rejects_recolored_image_even_when_hashes_are_coordinated(self):
        from PIL import Image
        self.make_photo_verify_fixture(); view = self.state['pinoutViews'][1]
        facts_path = Path(view['factsPath']); facts = json.loads(facts_path.read_text())
        manifest_path = Path(view['manifestPath']); manifest = json.loads(manifest_path.read_text())
        project_path = Path(manifest['source']['path']); project = json.loads(project_path.read_text())
        image_path = Path(facts['image']['path'])
        with Image.open(image_path) as image:
            changed = image.copy(); changed.putpixel((50, 50), (255, 0, 0, 255)); changed.save(image_path)
        digest = pipeline.sha(image_path)
        facts['image']['sha256'] = digest
        for binding in (facts['photograph'], project['workbenchAlignment']['photograph'], manifest['alignment']['photograph']):
            binding['derived']['sha256'] = digest
        project['workbenchAlignment']['imageSha256'] = digest
        project['state']['imageData'] = 'data:image/png;base64,' + base64.b64encode(image_path.read_bytes()).decode()
        project_path.write_text(json.dumps(project))
        manifest['source']['sha256'] = pipeline.sha(project_path)
        manifest_path.write_text(json.dumps(manifest)); facts_path.write_text(json.dumps(facts))
        with self.assertRaisesRegex(ValueError, '像素'):
            pipeline.verify_files(self.state)

    def test_all_four_artifacts_are_bound_by_bytes_and_hash(self):
        self.make_verify_fixture()
        for artifact in self.state['files']:
            path = Path(artifact['path']); original = path.read_bytes(); path.write_bytes(original + b'changed')
            with self.subTest(kind=artifact['kind']), self.assertRaises(ValueError): pipeline.verify_files(self.state)
            path.write_bytes(original)

    def test_original_source_is_rechecked_at_final_admission(self):
        self.make_verify_fixture(); self.source.write_bytes(b'changed after all stages')
        with self.assertRaises(ValueError): pipeline.verify_files(self.state)

    def test_cad_provenance_requires_fixed_commit_actual_step_and_actual_dwg(self):
        self.make_verify_fixture(); baseline = json.loads(self.cad_manifest.read_text())
        mutations = [('commit', lambda value: value['converter'].update(commit='0' * 40)),
                     ('source', lambda value: value['source'].update(sha256='0' * 64)),
                     ('dwgHash', lambda value: value['artifacts'][0].update(sha256='0' * 64)),
                     ('fresh', lambda value: value['verification'].update(freshConversion=False)),
                     ('roundtrip', lambda value: value['verification'].update(roundtripEntityCountsMatched=False))]
        for name, change in mutations:
            value = copy.deepcopy(baseline); change(value); self.cad_manifest.write_text(json.dumps(value))
            with self.subTest(name=name), self.assertRaises(ValueError): pipeline.verify_files(self.state)
        self.cad_manifest.write_text(json.dumps(baseline))

    def test_pinout_provenance_requires_fixed_commit_bound_project_actual_png(self):
        self.make_verify_fixture(); baseline = json.loads(self.pin_manifest.read_text())
        mutations = [('commit', lambda value: value['converter'].update(commit='0' * 40)),
                     ('project', lambda value: value['source'].update(sha256='0' * 64)),
                     ('pngHash', lambda value: value['artifacts'][0].update(sha256='0' * 64)),
                     ('example', lambda value: value['verification'].update(defaultExampleUsed=True)),
                     ('readback', lambda value: value['verification'].update(boundProjectReadbackMatched=False))]
        for name, change in mutations:
            value = copy.deepcopy(baseline); change(value); self.pin_manifest.write_text(json.dumps(value))
            with self.subTest(name=name), self.assertRaises(ValueError): pipeline.verify_files(self.state)
        self.pin_manifest.write_text(json.dumps(baseline))

    def test_pinout_negative_facts_cannot_be_overridden_by_state_true(self):
        self.make_verify_fixture(); facts_path = Path(self.state['pinFacts']['factsPath']); facts = json.loads(facts_path.read_text())
        facts['preparation']['validated'] = False; facts['preparation']['status'] = 'blocked'; facts_path.write_text(json.dumps(facts))
        with self.assertRaises(ValueError): pipeline.verify_files(self.state)


if __name__ == '__main__':
    unittest.main()
