"""Guide DAG handoff integrity with real isolated ZIP/PNG/PDF/Git/SQLite files.

Synthetic completed engineering receipts exercise import boundaries only. They
are explicitly not EDA/CAD/DrawIO/browser exports or professional acceptance.
No model, real workflow, production source or historical gate is executed.
"""
import copy
import base64
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
import xml.etree.ElementTree as ET

from PIL import Image
from pypdf import PdfWriter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from hdk import guide_dag as guide

SPEC = importlib.util.spec_from_file_location('guide_dag_api_fixture', ROOT / 'hdk/dag_capabilities.py')
api = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(api)


class GuideDAGTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='guide-dag-contract-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve(); self.db = self.root / 'state.sqlite'
        with sqlite3.connect(self.db) as db:
            for table in ('workflow_runs', 'workflow_file_runs'):
                db.execute('CREATE TABLE ' + table + '(id TEXT PRIMARY KEY,value TEXT NOT NULL)')
        patcher = patch.object(api, 'DATABASE', self.db); patcher.start(); self.addCleanup(patcher.stop)
        contract = patch.object(guide.guide_reference, 'DEFAULT_CONTRACT', ROOT / 'test/fixtures/guide-editorial-contract.json')
        contract.start(); self.addCleanup(contract.stop)
        self.source = self.root / 'board.epro2'
        records = [({'type': 'DOCHEAD'}, {'uuid': 'pcb-current', 'docType': 'PCB'}),
                   ({'type': 'COMPONENT', 'id': 'connector'}, {'x': 10, 'y': 20, 'angle': 0}),
                   ({'type': 'ATTR'}, {'parentId': 'connector', 'key': 'Designator', 'value': 'J1'}),
                   ({'type': 'ATTR'}, {'parentId': 'connector', 'key': 'Device', 'value': 'connector-device'}),
                   ({'type': 'COMPONENT', 'id': 'module'}, {'x': 10, 'y': 40, 'angle': 0}),
                   ({'type': 'ATTR'}, {'parentId': 'module', 'key': 'Designator', 'value': 'U1'}),
                   ({'type': 'ATTR'}, {'parentId': 'module', 'key': 'Device', 'value': 'module-device'}),
                   ({'type': 'PAD_NET', 'id': json.dumps(['PAD_NET', 'module', '1'])}, {'padNet': 'IO51'}),
                   ({'type': 'PAD_NET', 'id': json.dumps(['PAD_NET', 'connector', '1'])}, {'padNet': 'IO51'}),
                   ({'type': 'DOCHEAD'}, {'uuid': 'sch-current', 'docType': 'SCH_PAGE'}),
                   ({'type': 'ATTR'}, {'parentId': 'sch-j1', 'key': 'Designator', 'value': 'J1'}),
                   ({'type': 'ATTR'}, {'parentId': 'sch-u1', 'key': 'Designator', 'value': 'U1'}),
                   ({'type': 'DOCHEAD'}, {'uuid': 'module-device', 'docType': 'DEVICE'}),
                   ({'type': 'META'}, {'title': 'WT0132S31-S1', 'attributes': {'Symbol': 'module-symbol'}}),
                   ({'type': 'DOCHEAD'}, {'uuid': 'connector-device', 'docType': 'DEVICE'}),
                   ({'type': 'META'}, {'title': 'X6511-TEST', 'attributes': {'Symbol': 'connector-symbol'}}),
                   ({'type': 'DOCHEAD'}, {'uuid': 'module-symbol', 'docType': 'SYMBOL'}),
                   ({'type': 'ATTR'}, {'parentId': 'pin', 'key': 'Pin Number', 'value': '1'}),
                   ({'type': 'ATTR'}, {'parentId': 'pin', 'key': 'Pin Name', 'value': 'IO51'}),
                   ({'type': 'DOCHEAD'}, {'uuid': 'connector-symbol', 'docType': 'SYMBOL'}),
                   ({'type': 'ATTR'}, {'parentId': 'pin', 'key': 'Pin Number', 'value': '1'}),
                   ({'type': 'ATTR'}, {'parentId': 'pin', 'key': 'Pin Name', 'value': '1'})]
        with zipfile.ZipFile(self.source, 'w') as file:
            file.writestr('project2.json', '{"title":"guide integrity fixture"}')
            file.writestr('board.epru', '\n'.join(json.dumps(h) + '||' + json.dumps(b) + '|' for h, b in records))
        self.images = []
        for side, color in (('front', '#334455'), ('back', '#8899aa')):
            file = self.root / (side + '.png'); Image.new('RGB', (120, 200), color).save(file)
            self.images.append({'side': side, 'path': str(file), 'sha256': api.sha(file)})
        sdk_files = {name: 'source fixture ' + name for name in guide.SDK_PATHS}
        self.sdk_path, sdk_commit = self.repository('sdk', guide.guide_sdk.SDK_REPOSITORY, sdk_files)
        bsp_files = {name: 'source fixture ' + name for name in (
            guide.guide_sdk.BLINK_SOURCE, 'components/wt_bsp/boards/TEST-BOARD/Kconfig.projbuild',
            'components/wt_bsp/tools/wt_bsp_project.cmake', 'examples/get-started/blink/CMakeLists.txt')}
        self.bsp_path, bsp_commit = self.repository('bsp', guide.guide_sdk.BSP_REPOSITORY, bsp_files)
        for key, value in (('SDK_COMMIT', sdk_commit), ('BSP_COMMIT', bsp_commit)):
            patcher = patch.object(guide.guide_sdk, key, value); patcher.start(); self.addCleanup(patcher.stop)
        self.template_path = self.root / 'original.drawio'
        self.template_path.write_text('<mxfile><diagram name="Original"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>')
        self.profile = {'format': 'workbench-guide-profile', 'version': 1,
                        'sourceSha256': api.sha(self.source), 'pcbUuid': 'pcb-current',
                        'drawioTemplate': {'path': str(self.template_path), 'sha256': api.sha(self.template_path)},
                        'images': [{k: i[k] for k in ('side', 'sha256')} | {
                            'width': 120, 'height': 200, 'reviewStatus': 'visually-reviewed',
                            'regions': [{'id': i['side'] + '-usb', 'refs': ['J1'], 'titleZh': 'FUSB',
                                         'titleEn': 'USB port', 'coordinateSpace': 'normalized',
                                         'x': .1, 'y': .2, 'w': .2, 'h': .3}]} for i in self.images],
                        'technicalDocuments': [],
                        'bspRepository': {'path': str(self.bsp_path), 'remote': guide.guide_sdk.BSP_REPOSITORY, 'commit': bsp_commit},
                        'sdkRepository': {'path': str(self.sdk_path), 'remote': guide.guide_sdk.SDK_REPOSITORY, 'commit': sdk_commit}}
        self.profile_path = self.root / 'guide-profile.json'; self.save_profile()
        self.origin = self.make_run('four', 'complete')
        self.foreign_root = Path(self.origin['outputDirectory'])
        original = self.origin_node('four-prepare', 'hdk.four.prepare', {
            'sourceSha256': api.sha(self.source), 'request': {'sourcePath': str(self.source),
                'productCode': 'TEST-BOARD', 'images': self.images},
            'sourceFiles': [{'path': str(self.source), 'sha256': api.sha(self.source)}, *self.images]})
        self.original_token = original
        verify_dir = self.foreign_root / 'four-verify' / '版本-1'; verify_dir.mkdir(parents=True)
        self.engineering = []
        for name in ('TEST-BOARD_CAD_V1.0.dwg', 'TEST-BOARD_3D_V1.0.step'):
            file = verify_dir / name; file.write_bytes(b'Integrity fixture only; never a real CAD export')
            self.engineering.append({'path': str(file)})
        for name, color in (('TEST-BOARD_CAD_V1.0.png', 'white'),
                            ('TEST-BOARD_Pinout_V1.0.png', 'green'), ('TEST-BOARD_Pinout_Back_V1.0.png', 'blue')):
            file = verify_dir / name; Image.new('RGB', (160, 220), color).save(file)
            self.engineering.append({'path': str(file)})
        file = verify_dir / 'TEST-BOARD_SCH_V1.0.pdf'
        writer = PdfWriter(); writer.add_blank_page(width=200, height=100)
        with file.open('wb') as stream: writer.write(stream)
        self.engineering.append({'path': str(file)})
        reviewed = [{'id': 'fixture-' + str(i), 'path': f['path'], 'sha256': api.sha(f['path'])}
                    for i, f in enumerate(self.engineering) if '_Pinout_' in f['path']]
        self.origin['document']['nodes'].append({'id': 'four-review', 'type': 'human', 'config': {}})
        human_value = {'front': 'fixture front receipt', 'back': 'fixture back receipt'}
        self.origin['nodes']['four-review'] = {'status': 'complete', 'output': human_value, 'artifacts': reviewed,
            'review': {'decision': 'approved', 'reviewedAt': '2026-10-25T00:00:00Z', 'artifactHashes': reviewed}}
        self.origin['document']['edges'].append({'sourceNode': 'four-review', 'sourcePort': 'output',
            'targetNode': 'four-verify', 'targetPort': 'images'})
        self.foreign_token = self.origin_node('four-verify', 'hdk.four.verify', {
            'status': 'complete', 'runId': self.origin['id'], 'sourceSha256': api.sha(self.source),
            'checks': {'integrity-fixture-only': True},
            'humanReview': {'nodeId': 'four-review', 'artifactHashes': reviewed}}, self.engineering)
        self.value = {'sourcePath': str(self.source), 'frontImage': self.images[0]['path'],
                      'backImage': self.images[1]['path'], 'guideProfilePath': str(self.profile_path),
                      'fourFilesDirectory': str(verify_dir), 'productCode': 'TEST-BOARD',
                      'hardwareVersion': '1.0', 'releaseDate': '2026-10-25'}
        self.run = self.make_run('guide', 'running')
        self.context = self.add_node('prepare', 'hdk.guide.prepare', self.value)

    def row(self, table, value):
        with sqlite3.connect(self.db) as db:
            db.execute('INSERT OR REPLACE INTO ' + table + '(id,value) VALUES(?,?)', (value['id'], json.dumps(value)))

    def save_run(self): self.row('workflow_runs', self.run)
    def save_profile(self): self.profile_path.write_text(json.dumps(self.profile))

    def repository(self, name, remote, files):
        root = self.root / name; root.mkdir()
        def git(*args):
            return subprocess.run(['git', '-C', str(root), *args], capture_output=True, check=True).stdout.decode().strip()
        git('init', '-q'); git('config', 'user.name', 'Guide integrity fixture')
        git('config', 'user.email', 'guide-fixture@example.invalid'); git('config', 'commit.gpgsign', 'false')
        git('remote', 'add', 'origin', remote)
        for name, text in files.items():
            file = root / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_text(text)
        git('add', '.'); git('commit', '-qm', 'Isolated guide contract fixture')
        return root, git('rev-parse', 'HEAD')

    def make_run(self, title, status):
        ident = str(uuid.uuid4()); output = self.root / 'outputs' / title / ident; output.mkdir(parents=True)
        run = {'id': ident, 'workflowId': title, 'status': status, 'outputDirectory': str(output),
               'document': {'schemaVersion': 2, 'nodes': [], 'edges': []}, 'nodes': {}}
        self.row('workflow_runs', run)
        self.row('workflow_file_runs', {'id': ident, 'runId': ident, 'outputDirectory': str(output)})
        return run

    def origin_node(self, ident, operation, data, files=()):
        output = Path(self.origin['outputDirectory']) / ident / '版本-1'; output.mkdir(parents=True, exist_ok=True)
        self.origin['document']['nodes'].append({'id': ident, 'type': 'tool', 'config': {'toolName': operation}})
        with patch.dict(os.environ, {'HDK_NODE_ID': ident}):
            token = api.receipt(operation, data, self.origin, output, api.assets(files))
        self.origin['nodes'][ident] = {'status': 'complete', 'attempt': 1, 'outputDirectory': str(output), 'output': token}
        self.row('workflow_runs', self.origin)
        return token

    def add_node(self, ident, operation, value):
        output = Path(self.run['outputDirectory']) / ident / '版本-1'; output.mkdir(parents=True)
        attempt = str(uuid.uuid4())
        self.run['document']['nodes'].append({'id': ident, 'type': 'tool', 'config': {'toolName': operation}})
        self.run['nodes'][ident] = {'status': 'running', 'attempt': 1, 'attemptId': attempt,
                                  'input': value, 'outputDirectory': str(output)}
        self.save_run()
        return {'runId': self.run['id'], 'workflowId': self.run['workflowId'], 'nodeId': ident,
                'attempt': 1, 'attemptId': attempt, 'outputDirectory': str(output),
                'runOutputDirectory': self.run['outputDirectory']}

    def completed_prepare(self):
        result = guide.guide('hdk.guide.prepare', self.value, self.context, api)
        self.run['nodes']['prepare'].update(status='complete', output=result); self.save_run()
        return result

    def annotation_fixture(self, out, title):
        """Protocol fixture for a verifier, never claimed as an app export."""
        encoded = base64.b64encode(Path(self.images[0]['path']).read_bytes()).decode()
        image = {'width': 120, 'height': 200, 'src': 'data:image/png;base64,' + encoded}
        region = {'id': 'front-usb', 'code': 'J1', 'title': title, 'x': 12, 'y': 40, 'w': 24, 'h': 60}
        project = {'format': 'open-interface-mark', 'version': 1, 'image': image, 'regions': [region]}
        bound = out / 'bound.oim.json'; bound.write_text(json.dumps(project))
        saved = out / 'interface.oim.json'; saved.write_text(json.dumps(project))
        png = out / 'interface.png'; Image.new('RGB', (160, 240), 'white').save(png)
        svg = out / 'interface.svg'; root = ET.Element('svg', {'xmlns': 'http://www.w3.org/2000/svg'})
        ET.SubElement(root, 'image', {'href': image['src']})
        text = ET.SubElement(root, 'text'); ET.SubElement(text, 'tspan').text = 'J1'; ET.SubElement(text, 'tspan').text = title
        svg.write_text(ET.tostring(root, encoding='unicode'))
        verification = dict.fromkeys(('freshContext', 'boundProjectReadbackMatched', 'imageDecodedDimensionsMatched',
            'sourceHashMatched', 'pngDimensionsMatched', 'svgLabelCountMatched', 'svgEmbeddedImageMatched', 'allRequestsLocalGet'), True)
        verification.update(defaultExampleExported=False, pageErrors=[])
        manifest = {'converter': {'commit': 'f8f92636b2eb87ac956997e77c9239cf483913fc'},
                    'source': {'path': str(bound), 'sha256': api.sha(bound),
                               'embeddedImage': {'sha256': api.sha(self.images[0]['path'])}},
                    'regions': [region], 'png': {'width': 160, 'height': 240}, 'verification': verification,
                    'artifacts': [{'path': str(p), 'sha256': api.sha(p)} for p in (png, svg, saved)]}
        path = out / 'interface.conversion.json'; path.write_text(json.dumps(manifest))
        return {**manifest, 'pngPath': str(png), 'svgPath': str(svg), 'projectPath': str(saved), 'manifestPath': str(path)}

    def source_facts(self):
        return guide.guide_facts.prepare_guide_facts({
            'sourcePath': str(self.source), 'productCode': 'TEST-BOARD', 'hardwareVersion': '1.0',
            'releaseDate': '2026-10-25', 'images': [dict(image, path=self.images[i]['path']) for i, image in enumerate(self.profile['images'])]})

    def horizontal_annotation_fixture(self, out, facts, side, language):
        if not (ROOT / '.local/converters/OpenInterfaceMark/src/core.js').is_file():
            self.skipTest('Optional OpenInterfaceMark core integration: prepare the fixed checkout described in docs/openinterfacemark-integration.md, then run node scripts/openinterfacemark-convert.mjs --check')
        bindings = guide._annotation_source_bindings(facts)
        selected = {ident: {'id': ident, 'titleZh': b['nameChoicesZh'][0], 'titleEn': b['nameChoicesEn'][0]} for ident, b in bindings.items()}
        style = {'color': '#ef4444', 'dashed': True, 'stroke': 3, 'fontSize': 18, 'radius': 5}
        image = next(i for i in facts['images'] if i['side'] == side)
        project, layout = guide._horizontal_annotation_project(image, selected, style, bindings, language, 'horizontal-fixture',
            metrics=[{'width': 260, 'ascent': 18, 'descent': 5} for _ in image['regions']],
            presentation=guide._annotation_presentation(facts.get('annotationPresentation')))
        bound = out / 'bound.oim.json'; bound.write_text(json.dumps(project))
        saved = out / 'interface.oim.json'; saved.write_text(json.dumps(project))
        png = out / 'interface.png'
        Image.new('RGBA', (project['image']['width'], project['image']['height']), 'white').save(png)
        svg = out / 'interface.svg'
        script = """import {readFileSync,writeFileSync} from 'node:fs';import {validateProject,exportSVG} from './.local/converters/OpenInterfaceMark/src/core.js';const p=JSON.parse(readFileSync(process.argv[1]));validateProject(p);writeFileSync(process.argv[2],exportSVG(p,{format:'svg',background:'white',scale:1}));"""
        subprocess.run([str(guide.legacy.NODE), '--input-type=module', '--eval', script, str(bound), str(svg)], cwd=ROOT, check=True, capture_output=True)
        from xml.etree import ElementTree
        xml = ElementTree.parse(svg).getroot()
        with Image.open(png) as im:
            # Protocol PNG dimensions match actual core export bounds, rather
            # than pretending this fixture is the browser raster exporter.
            png_size = (int(xml.get('width')), int(xml.get('height')))
        Image.new('RGBA', png_size, 'white').save(png)
        verification = dict.fromkeys(('freshContext', 'boundProjectReadbackMatched', 'imageDecodedDimensionsMatched',
            'sourceHashMatched', 'pngDimensionsMatched', 'svgLabelCountMatched', 'svgEmbeddedImageMatched', 'allRequestsLocalGet'), True)
        verification.update(defaultExampleExported=False, pageErrors=[])
        embedded = base64.b64decode(project['image']['src'].split(',')[1])
        import hashlib
        manifest = {'converter': {'commit': 'f8f92636b2eb87ac956997e77c9239cf483913fc'},
            'source': {'path': str(bound), 'sha256': api.sha(bound), 'embeddedImage': {'sha256': hashlib.sha256(embedded).hexdigest()}},
            'regions': [{k: r[k] for k in ('id', 'code', 'title', 'x', 'y', 'w', 'h')} for r in project['regions']],
            'png': {'width': png_size[0], 'height': png_size[1]}, 'verification': verification,
            'artifacts': [{'path': str(p), 'sha256': api.sha(p)} for p in (png, svg, saved)]}
        path = out / 'interface.conversion.json'; path.write_text(json.dumps(manifest))
        return {**manifest, 'pngPath': str(png), 'svgPath': str(svg), 'projectPath': str(saved), 'manifestPath': str(path)}, layout

    def complete_fixture_node(self, ident, operation, data, files):
        context = self.add_node(ident, operation, {})
        with patch.dict(os.environ, {'HDK_NODE_ID': ident}):
            token = api.receipt(operation, data, self.run, Path(context['outputDirectory']), api.assets(files))
        self.run['nodes'][ident].update(status='complete', output=token); self.save_run()
        return token

    def five_images(self, presentation=None, *, bilingual=False, separate=False, show_designators=True):
        specification = importlib.util.spec_from_file_location('guide_dag_diagram_fixture', ROOT / 'test/python/test_guide_drawio.py')
        fixture = importlib.util.module_from_spec(specification); specification.loader.exec_module(fixture)
        facts = self.source_facts(); values, files = {}, []
        if presentation is not None: facts['annotationPresentation'] = presentation
        if bilingual:
            facts['diagramPresentation'] = {'languages': ['zh', 'en']}
            if not show_designators: facts['diagramPresentation']['showDesignators'] = False
        for port, (side, language) in guide.IMAGE_PORTS.items():
            context = self.add_node(port, 'hdk.guide.annotate-' + side + '-' + language, {})
            out = Path(context['outputDirectory']); annotation, layout = self.horizontal_annotation_fixture(out, facts, side, language)
            data = {'facts': facts, 'annotation': annotation, 'annotationLayout': layout,
                    'annotationSkill': {'nodeId': 'annotation-skill', 'ref': 'fixture', 'version': '1'}, 'annotationPlan': {}}
            with patch.dict(os.environ, {'HDK_NODE_ID': port}):
                token = api.receipt('hdk.guide.annotate-' + side + '-' + language, data, self.run, out, api.assets(annotation['artifacts']))
            self.run['nodes'][port].update(status='complete', output=token); self.save_run()
            values[port] = token; files.append({'path': annotation['pngPath'], 'sha256': api.sha(annotation['pngPath'])})
        context = self.add_node('diagram', 'hdk.guide.drawio', {})
        out = Path(context['outputDirectory'])
        if bilingual:
            spec = importlib.util.spec_from_file_location('guide_bilingual_export_fixtures', ROOT / 'test/python/test_guide_drawio_template_v2.py')
            fixtures = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixtures)
            from hdk import guide_drawio_template_v2 as adapter
            fixtures.make_template(self.template_path); executable = self.root / 'drawio-not-executed'; executable.write_text('fixture')
            with patch.dict(os.environ, {'WORKBENCH_DRAWIO': str(executable)}), patch.object(adapter.subprocess, 'run', side_effect=fixtures.write_export_fixture):
                diagrams = adapter.render_bilingual_source_diagrams(facts, out / 'block.svg', template_path=self.template_path, show_designators=show_designators)
            diagram = diagrams['en']; data = {'facts': facts, 'diagram': diagram, 'diagrams': diagrams,
                'drawioTemplate': {'path': str(self.template_path), 'sha256': api.sha(self.template_path)}}
            diagram_files = [Path(image[k + 'Path']) for image in diagrams.values() for k in ('drawio', 'png', 'svg')]
        else:
            manifest_path, manifest = fixture.fixture_bundle(out, facts)
            diagram = {'manifestPath': str(manifest_path), **{k + 'Path': v['path'] for k, v in manifest['artifacts'].items()}}
            data = {'facts': facts, 'diagram': diagram}; diagram_files = [Path(v['path']) for v in manifest['artifacts'].values()]
        with patch.dict(os.environ, {'HDK_NODE_ID': 'diagram'}):
            token = api.receipt('hdk.guide.drawio', data, self.run, out, api.assets([{'path': str(p)} for p in diagram_files]))
        self.run['nodes']['diagram'].update(status='complete', output=token); self.save_run(); values['diagram'] = token
        files.extend({'path': image['pngPath'], 'sha256': api.sha(image['pngPath'])} for image in guide._diagram_images(data).values())
        approved = [{**f, 'id': 'approved-' + str(i)} for i, f in enumerate(files)]
        self.run['document']['nodes'].append({'id': 'review', 'type': 'human', 'config': {}})
        self.run['nodes']['review'] = {'status': 'complete', 'output': values, 'artifacts': approved,
            'review': {'decision': 'approved', 'reviewedAt': '2026-10-25T00:00:00Z', 'artifactHashes': approved}}
        context = self.add_node('author', 'hdk.guide.author-input', {'images': values})
        self.run['document']['edges'].append({'sourceNode': 'review', 'sourcePort': 'output', 'targetNode': 'author', 'targetPort': 'images'})
        if separate:
            diagram_token = values.pop('diagram')
            self.diagram_token = diagram_token
            self.run['nodes']['review']['output'] = copy.deepcopy(values)
            self.run['nodes']['review']['artifacts'] = approved[:4]
            self.run['nodes']['review']['review']['artifactHashes'] = approved[:4]
            self.run['document']['nodes'].append({'id': 'diagram-review', 'type': 'human', 'config': {}})
            self.run['nodes']['diagram-review'] = {'status': 'complete', 'output': diagram_token, 'artifacts': approved[4:],
                'review': {'decision': 'approved', 'reviewedAt': '2026-10-25T00:00:00Z', 'artifactHashes': approved[4:]}}
            self.run['document']['edges'].append({'sourceNode': 'diagram-review', 'sourcePort': 'out', 'targetNode': 'author', 'targetPort': 'diagram'})
        self.save_run()
        return facts, values, files, context

    def test_prepare_binds_native_regions_photos_git_blobs_and_completed_four_receipt(self):
        token = self.completed_prepare(); data = api.load(token, self.run, 'hdk.guide.prepare')
        self.assertEqual(data['pcbUuid'], 'pcb-current')
        self.assertEqual(data['request']['images'][0]['regions'][0]['x'], 12)
        self.assertEqual(data['request']['images'][0]['regions'][0]['w'], 24)
        self.assertEqual(data['fourReceipt']['receiptSha256'], api.sha(self.foreign_token['receiptPath']))
        self.assertGreater(len(data['repositoryBlobs']), 12)
        self.assertNotIn('referenceExamples', json.dumps(data))
        self.assertNotIn('knownResultArtifacts', json.dumps(data))

    def test_photo_source_dimensions_regions_and_cross_side_ids_fail_before_skills(self):
        original = copy.deepcopy(self.profile)
        mutations = [lambda p: p.update(sourceSha256='0' * 64), lambda p: p.update(pcbUuid='another'),
                     lambda p: p['images'][0].update(sha256='0' * 64), lambda p: p['images'][0].update(width=121),
                     lambda p: p['images'][0].update(reviewStatus='draft'),
                     lambda p: p['images'][0]['regions'][0].update(refs=['MISSING']),
                     lambda p: p['images'][0]['regions'][0].update(x=.95),
                     lambda p: p['images'][1]['regions'][0].update(id='front-usb')]
        for mutate in mutations:
            self.profile = copy.deepcopy(original); mutate(self.profile); self.save_profile()
            with self.subTest(profile=self.profile), self.assertRaises(ValueError): guide.prepare(self.value, api)
        self.assertFalse((Path(self.context['outputDirectory']) / 'receipt.json').exists())

    def test_derived_or_known_result_documents_cannot_be_execution_inputs(self):
        document = self.root / 'OTHER_User_Guide.md'; document.write_text('known-result fixture')
        for role in ('pinout', 'schematic-preview', 'target-guide', 'technical-source'):
            self.profile['technicalDocuments'] = [{'path': str(document), 'role': role}]; self.save_profile()
            with self.subTest(role=role), self.assertRaises(ValueError): guide.prepare(self.value, api)

    def test_stale_import_learning_import_and_revoked_review_are_rejected(self):
        original = copy.deepcopy(self.origin)
        for mutate in (lambda r: r.update(status='waiting_review'), lambda r: r.update(learningId='training'),
                       lambda r: r['nodes']['four-review']['review'].update(decision='rejected'),
                       lambda r: r['nodes']['four-verify'].update(attempt=2)):
            self.origin = copy.deepcopy(original); mutate(self.origin); self.row('workflow_runs', self.origin)
            with self.subTest(run=self.origin), self.assertRaises(ValueError): guide.prepare(self.value, api)

    def test_prepare_is_attempt_bound_and_cannot_overwrite_existing_receipt(self):
        with self.assertRaises(ValueError): guide.guide('hdk.guide.prepare', self.value, self.context | {'attempt': 2}, api)
        self.completed_prepare()
        self.run['nodes']['prepare']['status'] = 'running'; self.save_run()
        with self.assertRaises(FileExistsError): guide.guide('hdk.guide.prepare', self.value, self.context, api)

    def test_import_four_generates_actual_pdf_preview_and_binds_each_engineering_asset(self):
        token = self.completed_prepare(); value = {'prepared': token}
        context = self.add_node('import', 'hdk.guide.import-four', value)
        result = guide.guide('hdk.guide.import-four', value, context, api)
        self.run['nodes']['import'].update(status='complete', output=result); self.save_run()
        data = api.load(result, self.run, 'hdk.guide.import-four')
        self.assertEqual(len(data['engineeringDocuments']), 7)
        with Image.open(Path(context['outputDirectory']) / 'schematic-preview.png') as photo:
            self.assertEqual(photo.size, (400, 200))
        docs, _ = guide.guide_facts._documents(data['engineeringDocuments'], api.sha(self.source))
        self.assertTrue(all(d['binding']['artifactHashVerified'] for d in docs))
        conversion = api.read(Path(context['outputDirectory']) / 'schematic-preview.conversion.json')
        self.assertEqual(conversion['page'], 1)
        self.assertEqual(conversion['source']['sha256'], api.sha(next(i['path'] for i in data['engineeringDocuments'] if i['role'] == 'schematic-pdf')))

    def test_actual_annotation_input_exposes_all_renderer_bounds_before_the_skill_runs(self):
        prepared_token = self.completed_prepare()
        import_value = {'prepared': prepared_token}
        import_context = self.add_node('import', 'hdk.guide.import-four', import_value)
        engineering_token = guide.guide('hdk.guide.import-four', import_value, import_context, api)
        self.run['nodes']['import'].update(status='complete', output=engineering_token); self.save_run()
        value = {'prepared': prepared_token, 'engineering': engineering_token}
        context = self.add_node('facts', 'hdk.guide.facts', value)
        # SDK evidence is independently covered elsewhere. Here only its command
        # enrichment is isolated; native facts/imports/receipt/Skill port are real.
        with patch.object(guide.guide_facts, '_onboarding', return_value=None), \
                patch.object(guide.guide_facts, '_manual_download', return_value=None), \
                patch.object(guide.guide_sdk, 'enrich_guide_development', side_effect=lambda facts, request:
                    {**facts, 'development': {'verifiedCommands': [{'shell': 'idf.py build'}]}}):
            token = guide.guide('hdk.guide.facts', value, context, api)
        data = api.read(token['receiptPath']); delivered = token['annotationInput']
        self.assertEqual(delivered, data['annotationInput'], 'the actual Skill port must contain the contract')
        self.assertEqual(data['facts']['annotationPresentation'], {'labelMode': 'source-detail'})
        contract = delivered['planContract']; defaults = contract['style']; rules = contract['styleConstraints']
        self.assertEqual(set(defaults), {'color', 'dashed', 'stroke', 'fontSize', 'radius', 'orientation', 'connectors'})
        self.assertEqual(defaults['fontSize'], 18)
        self.assertEqual(defaults['orientation'], 'horizontal'); self.assertEqual(defaults['connectors'], 'straight')
        self.assertEqual(rules['color']['pattern'], '^#[a-fA-F0-9]{6}$')
        self.assertEqual(rules['dashed']['type'], 'boolean')
        self.assertEqual(rules['orientation']['enum'], ['horizontal'])
        self.assertEqual(rules['connectors']['enum'], ['straight'])
        self.assertFalse(rules['additionalKeys'])
        expected = {'stroke': (1, 8), 'fontSize': (12, 22), 'radius': (0, 20)}
        for key, limits in expected.items():
            self.assertEqual((rules[key]['minimum'], rules[key]['maximum']), limits)
            self.assertEqual(rules[key]['type'], 'number'); self.assertEqual(rules[key]['default'], defaults[key])
        self.assertEqual(contract['regions']['titleZh']['maxLength'], 90)
        self.assertEqual(contract['regions']['titleEn']['maxLength'], 90)
        self.assertIn('exactly once', contract['regions']['coverage'])
        self.assertIn('nameChoicesZh', contract['regions']['titleZh']['choices'])
        self.assertIn('nameChoicesEn', contract['regions']['titleEn']['choices'])
        regions = [r for image in delivered['images'] for r in image['regions']]
        plan = {'regions': [{'id': r['id'], 'titleZh': r['nameChoicesZh'][0], 'titleEn': r['nameChoicesEn'][0]} for r in regions],
                'style': copy.deepcopy(defaults)}
        guide._validate_annotation_v2(plan, data['facts'])
        for key, (low, high) in expected.items():
            for boundary in (low, high):
                changed = copy.deepcopy(plan); changed['style'][key] = boundary
                guide._validate_annotation_v2(changed, data['facts'])
            for invalid in (low - 1, high + 1, True):
                changed = copy.deepcopy(plan); changed['style'][key] = invalid
                with self.subTest(key=key, invalid=invalid), self.assertRaises(ValueError):
                    guide._validate_annotation_v2(changed, data['facts'])
        plan['style']['fontSize'] = 28
        with self.assertRaisesRegex(ValueError, 'fontSize'):
            guide._validate_annotation_v2(plan, data['facts'])

    def test_changed_source_profile_sdk_or_four_artifact_invalidates_parent(self):
        token = self.completed_prepare()
        paths = [self.profile_path, self.template_path, self.sdk_path / 'install.sh', Path(self.engineering[0]['path'])]
        for path in paths:
            before = path.read_bytes(); path.write_bytes(before + b' changed')
            try:
                with self.subTest(path=path), self.assertRaises(ValueError):
                    prepared = guide._load(token, self.run, 'hdk.guide.prepare', api)
                    guide._import_four(prepared, Path(self.context['outputDirectory']), api)
            finally: path.write_bytes(before)

    def test_drawio_review_feedback_is_bound_to_its_tool_receipt_and_revalidation(self):
        facts_context = self.add_node('facts', 'hdk.guide.facts', {})
        data = {'facts': self.source_facts(), 'sourceFiles': [], 'proofFiles': [],
                'drawioTemplate': {'path': str(self.template_path), 'sha256': api.sha(self.template_path)}}
        with patch.dict(os.environ, {'HDK_NODE_ID': 'facts'}):
            facts_token = api.receipt('hdk.guide.facts', data, self.run, Path(facts_context['outputDirectory']))
        self.run['nodes']['facts'].update(status='complete', output=facts_token); self.save_run()
        value = {'facts': facts_token}; context = self.add_node('drawio', 'hdk.guide.drawio', value)
        feedback = 'DrawIO的连线还是有点问题，通过软件反馈帮修改。'
        calls = []
        def render(facts, target, *, template_path, review_feedback='', show_designators=True):
            # Only the handoff is under test; these are explicit protocol fixture
            # files, not DrawIO exports or a claimed business-quality acceptance.
            calls.append(('render', review_feedback, template_path))
            self.assertTrue(show_designators)
            paths = {kind + 'Path': str(Path(target).with_suffix('.' + kind)) for kind in ('drawio', 'svg', 'png')}
            for path in paths.values(): Path(path).write_bytes(b'explicit drawio protocol fixture')
            audit = Path(target).with_suffix('.audit.json')
            api.write(audit, {'reviewFeedback': review_feedback, 'feedbackScope': 'edge-layout-only; no relationship or executable instructions'})
            manifest = Path(target).with_suffix('.manifest.json'); api.write(manifest, {'fixture': True})
            return {**paths, 'auditPath': str(audit), 'manifestPath': str(manifest)}
        def verify(manifest_path, facts, *, template_path, review_feedback='', show_designators=True):
            calls.append(('verify', review_feedback, template_path))
            self.assertTrue(show_designators)
            return {'passed': True, 'scope': 'protocol fixture only'}
        from hdk import guide_drawio_template_v2 as adapter
        with patch.object(adapter, 'render_source_diagram', side_effect=render), \
                patch.object(adapter, 'verify_source_diagram', side_effect=verify):
            result = guide.guide('hdk.guide.drawio', value, context | {'reviewFeedback': feedback}, api)
            self.run['nodes']['drawio'].update(status='complete', output=result); self.save_run()
            saved = api.load(result, self.run, 'hdk.guide.drawio')
            self.assertEqual(saved['drawioReviewFeedback'], feedback)
            self.assertEqual(api.read(saved['drawioLayoutAudit']['path'])['reviewFeedback'], feedback)
            self.assertIn(saved['drawioLayoutAudit'], saved['proofFiles'])
            self.assertEqual(calls, [('render', feedback, str(self.template_path)), ('verify', feedback, str(self.template_path))])
            guide._verify_diagram(saved, saved['facts'])
            self.assertEqual(calls[-1], ('verify', feedback, str(self.template_path)))
            self.assertEqual(len(result['artifacts']), 3, 'audit must be hash-bound without adding a fourth review image')
        Path(saved['drawioLayoutAudit']['path']).write_text('{}')
        with self.assertRaisesRegex(ValueError, '变化'):
            api.load(result, self.run, 'hdk.guide.drawio')

    def test_skill_plan_must_be_current_complete_skill_with_exact_input(self):
        expected = {'facts': 'current fixture'}; plan = {'bounded': 'plan'}
        self.run['document']['nodes'].append({'id': 'skill', 'type': 'skill', 'config': {'skillRef': 'guide-fixture', 'version': '1'}})
        self.run['document']['edges'].append({'sourceNode': 'skill', 'sourcePort': 'output', 'targetNode': 'prepare', 'targetPort': 'plan'})
        self.run['nodes']['skill'] = {'status': 'complete', 'input': expected, 'output': plan}
        self.assertEqual(guide._skill(self.run, self.context, plan, expected)['ref'], 'guide-fixture')
        for changed in ({'status': 'running'}, {'input': {'facts': 'stale'}}, {'output': {'wrong': True}}):
            old = self.run['nodes']['skill']; self.run['nodes']['skill'] = old | changed
            with self.subTest(changed=changed), self.assertRaises(ValueError): guide._skill(self.run, self.context, plan, expected)
            self.run['nodes']['skill'] = old

    def test_only_bounded_skill_schema_failure_is_recoverable_in_learning(self):
        facts = self.source_facts()
        for learning in (False, True):
            expected = api.InvalidLearningPlan if learning else ValueError
            with self.assertRaises(expected):
                guide._annotation({}, facts, 'front', 'zh', self.root, api, learning)
            with self.assertRaises(expected): guide._assemble({}, {}, self.root, api, learning)
        with self.assertRaisesRegex(ValueError, '未知'):
            guide.guide('hdk.guide.arbitrary', {}, {}, api)

    def test_missing_or_partial_five_image_gate_is_rejected_without_author_call(self):
        for images in ({}, {'frontZh': {}}, {**dict.fromkeys(guide.IMAGE_PORTS, {}), 'diagram': {}, 'extra': {}}):
            with self.subTest(images=images), self.assertRaises(ValueError):
                guide._illustrations(images, self.run, self.context, {}, api)

    def test_five_actual_image_paths_require_one_current_approval_covering_all_hashes(self):
        facts, images, files, context = self.five_images()
        _, consumed, review = guide._illustrations(images, self.run, context, facts, api)
        self.assertEqual(len(consumed), 5); self.assertEqual(review['nodeId'], 'review')
        self.run['nodes']['review']['review']['artifactHashes'].pop()
        with self.assertRaises(ValueError): guide._illustrations(images, self.run, context, facts, api)

    def test_approved_annotation_svg_or_png_cannot_change_before_author_input(self):
        facts, images, files, context = self.five_images()
        png = Path(files[0]['path']); png.write_bytes(png.read_bytes() + b'changed')
        with self.assertRaises(ValueError): guide._illustrations(images, self.run, context, facts, api)

    def test_annotation_verifier_reads_project_png_svg_not_only_receipt_booleans(self):
        out = self.root / 'export-fixture'; out.mkdir(); entry = self.annotation_fixture(out, 'USB port')
        self.assertTrue(guide._verify_annotation(entry, out, api))
        svg = Path(entry['svgPath']); svg.write_text(svg.read_text().replace('USB port', 'unbound label'))
        # Even a self-updated file hash cannot hide a different actual label.
        for artifact in entry['artifacts']:
            if artifact['path'] == str(svg): artifact['sha256'] = api.sha(svg)
        manifest = {k: v for k, v in entry.items() if k not in ('pngPath', 'svgPath', 'projectPath', 'manifestPath')}
        Path(entry['manifestPath']).write_text(json.dumps(manifest))
        self.assertFalse(guide._verify_annotation(entry, out, api))

    def test_v2_plan_supports_horizontal_straight_and_rejects_unsupported_modes(self):
        facts = self.source_facts(); bindings = guide._annotation_source_bindings(facts)
        plan = {'regions': [{'id': ident, 'titleZh': b['nameChoicesZh'][0], 'titleEn': b['nameChoicesEn'][0]} for ident, b in bindings.items()],
                'style': {'color': '#ef4444', 'dashed': True, 'stroke': 3, 'fontSize': 18, 'radius': 5,
                          'orientation': 'horizontal', 'connectors': 'straight'}}
        _, style, _ = guide._validate_annotation_v2(plan, facts)
        self.assertNotIn('orientation', style, 'legacy style fields are passed separately from v2 layout policy')
        for key, value in (('orientation', 'portrait'), ('connectors', 'elbow'), ('unknown', True)):
            changed = copy.deepcopy(plan); changed['style'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): guide._validate_annotation_v2(changed, facts)
        changed = copy.deepcopy(plan); changed['regions'][0]['titleZh'] = '不存在的摄像头'
        with self.assertRaises(ValueError): guide._validate_annotation_v2(changed, facts)

    def test_annotation_names_and_net_mapping_come_from_native_refs_not_profile_titles(self):
        facts = self.source_facts()
        for image in facts['images']:
            for region in image['regions']: region.update(titleZh='虚构摄像头', titleEn='Invented camera')
        bindings = guide._annotation_source_bindings(facts); item = bindings['front-usb']
        self.assertEqual(item['refs'], ['J1']); self.assertEqual(item['sourceComponents'][0]['part'], 'X6511-TEST')
        self.assertEqual(item['sourceComponents'][0]['pins'], [{'number': '1', 'name': '1', 'net': 'IO51'}])
        self.assertNotIn('摄像头', item['titleZh']); self.assertNotIn('Invented', item['titleEn'])
        for mutate in (lambda f: f['images'][0]['regions'][0].update(refs=['MISSING']),
                       lambda f: f['components'][0].update(sourceComponentId='wrong'),
                       lambda f: f['components'][0]['pins'][0].update(net='C61_IO999')):
            changed = copy.deepcopy(facts); mutate(changed)
            with self.subTest(facts=changed), self.assertRaises(ValueError): guide._annotation_source_bindings(changed)

    def test_english_name_policy_is_frozen_from_profile_and_exposes_internal_bilingual_contract(self):
        self.profile['annotationPresentation'] = {'labelMode': 'english-name-only'}; self.save_profile()
        prepared = guide.prepare(self.value, api)
        self.assertEqual(prepared['annotationPresentation'], self.profile['annotationPresentation'])
        self.assertNotIn('annotationPresentation', prepared['request'], 'legacy fact request contracts remain unchanged')
        contract = guide._annotation_plan_contract(prepared['annotationPresentation'])
        self.assertEqual(contract['presentation']['displayLanguage'], 'en')
        self.assertEqual(contract['presentation']['visibleFields'], ['English function name'])
        self.assertEqual(contract['regions']['requiredKeys'], ['id', 'titleZh', 'titleEn'])
        self.assertEqual(contract['regions']['titleEn']['maxLength'], 40)
        self.assertIn('including the Chinese-guide branches', contract['titles'])
        self.assertIn('Internal titleZh', contract['titles'])
        for invalid in ({'labelMode': 'chinese'}, {'labelMode': 'english-name-only', 'refs': []}, 'english-name-only'):
            self.profile['annotationPresentation'] = invalid; self.save_profile()
            with self.subTest(policy=invalid), self.assertRaisesRegex(ValueError, '显示策略'): guide.prepare(self.value, api)

    def test_all_four_english_only_branches_keep_source_bindings_and_pass_real_core_svg_and_five_image_review(self):
        facts, values, files, context = self.five_images({'labelMode': 'english-name-only'})
        illustrations, selected, review = guide._illustrations(values, self.run, context, facts, api)
        self.assertEqual(len(selected), 5); self.assertEqual(review['nodeId'], 'review')
        for port, data in illustrations.items():
            if port == 'diagram': continue
            project = api.read(data['annotation']['projectPath']); layout = data['annotationLayout']
            self.assertEqual(layout['annotationPresentation'], {'labelMode': 'english-name-only'})
            self.assertEqual(layout['displayLanguage'], 'en')
            self.assertEqual(layout['orientation'], 'horizontal'); self.assertEqual(layout['connectors'], 'straight')
            for region in project['regions']:
                bound = next(item for item in layout['sourceBindings'] if item['id'] == region['id'])
                self.assertIn(region['code'], bound['nameChoicesEn']); self.assertEqual(region['title'], '')
                self.assertNotEqual(region['code'], '/'.join(bound['refs']))
                self.assertTrue(bound['sourceComponents'][0]['part']); self.assertTrue(bound['sourceComponents'][0]['pins'])
                self.assertFalse(any(component['part'] in region['code'] for component in bound['sourceComponents']))
        labels = guide._rendered_annotation_labels(illustrations)
        self.assertEqual(len(labels), 4); self.assertEqual({item['ref'] for item in labels}, {'J1'})
        self.assertTrue(all(item['title'] == 'Expansion header' for item in labels))

    def test_english_label_mode_rejects_visible_models_chinese_refs_and_modified_source_geometry(self):
        facts = self.source_facts(); facts['annotationPresentation'] = {'labelMode': 'english-name-only'}
        out = self.root / 'english-only'; out.mkdir()
        entry, layout = self.horizontal_annotation_fixture(out, facts, 'front', 'zh')
        self.assertTrue(guide._verify_annotation_layout(entry, layout, facts))
        original = api.read(entry['projectPath'])
        for change in (lambda region: region.update(code='J1'), lambda region: region.update(title='X6511-TEST'),
                       lambda region: region.update(title='中文名称'), lambda region: region.update(code='Expansion header · X6511-TEST'),
                       lambda region: region.update(x=region['x'] + 1)):
            project = copy.deepcopy(original); change(project['regions'][0]); Path(entry['projectPath']).write_text(json.dumps(project))
            with self.subTest(project=project['regions'][0]): self.assertFalse(guide._verify_annotation_layout(entry, layout, facts))
        Path(entry['projectPath']).write_text(json.dumps(original))
        changed = copy.deepcopy(layout); changed['sourceBindings'][0]['sourceComponents'][0]['pins'][0]['net'] = 'wrong'
        self.assertFalse(guide._verify_annotation_layout(entry, changed, facts))
        changed = copy.deepcopy(layout); changed['annotationPresentation'] = {'labelMode': 'source-detail'}
        self.assertFalse(guide._verify_annotation_layout(entry, changed, facts))
        tree = ET.parse(entry['svgPath']); span = next(item for item in tree.getroot().iter() if item.tag.rsplit('}', 1)[-1] == 'tspan')
        span.text = 'Expansion header 中文 X6511-TEST'; tree.write(entry['svgPath'], encoding='unicode')
        self.assertFalse(guide._verify_annotation_layout(entry, layout, facts), 'actual SVG visible labels must match the source-bound English name')

    def test_prepared_english_policy_preserves_source_inputs_and_never_rewrites_the_profile(self):
        original = copy.deepcopy(self.profile)
        previous = guide.prepare(self.value, api)
        self.assertEqual(previous['annotationPresentation'], {'labelMode': 'source-detail'})
        self.profile['annotationPresentation'] = {'labelMode': 'english-name-only'}; self.save_profile()
        current = guide.prepare(self.value, api)
        self.assertEqual(current['annotationPresentation'], {'labelMode': 'english-name-only'})
        self.assertEqual(current['request'], previous['request'])
        self.assertEqual(current['sourceSha256'], previous['sourceSha256'])
        self.assertEqual(api.read(self.profile_path), original | {'annotationPresentation': {'labelMode': 'english-name-only'}})

    def test_english_names_with_refs_show_native_jx_but_never_models_or_chinese(self):
        facts = self.source_facts(); facts['annotationPresentation'] = {'labelMode': 'english-name-with-ref'}
        illustrations = {}
        for port, (side, language) in guide.IMAGE_PORTS.items():
            out = self.root / ('with-ref-' + port); out.mkdir()
            entry, layout = self.horizontal_annotation_fixture(out, facts, side, language)
            self.assertTrue(guide._verify_annotation(entry, out, api)); self.assertTrue(guide._verify_annotation_layout(entry, layout, facts))
            project = api.read(entry['projectPath'])
            self.assertEqual(project['regions'][0]['code'], 'J1'); self.assertEqual(project['regions'][0]['title'], 'Expansion header')
            self.assertNotIn('X6511-TEST', project['regions'][0]['title'])
            changed = copy.deepcopy(project); changed['regions'][0]['code'] = 'J8'; Path(entry['projectPath']).write_text(json.dumps(changed))
            self.assertFalse(guide._verify_annotation_layout(entry, layout, facts), 'visible references must match the actual schematic component')
            Path(entry['projectPath']).write_text(json.dumps(project))
            illustrations[port] = {'annotation': entry, 'annotationLayout': layout}
        self.assertEqual(guide._rendered_annotation_labels(illustrations), [{'ref': 'J1', 'title': 'Expansion header'}] * 4)

    def test_localized_photo_labels_show_correct_language_and_native_refs_without_models(self):
        facts = self.source_facts(); facts['annotationPresentation'] = {'labelMode': 'localized-name-with-refs'}
        contract = guide._annotation_plan_contract(facts['annotationPresentation'])
        self.assertEqual(contract['presentation']['displayLanguage'], 'branch-language')
        self.assertEqual(contract['presentation']['visibleFields'], ['source references', 'localized function name'])
        self.assertIn('plus titleZh', contract['titles']); self.assertIn('plus titleEn', contract['titles'])
        illustrations = {}
        for port, (side, language) in guide.IMAGE_PORTS.items():
            out = self.root / ('localized-' + port); out.mkdir()
            entry, layout = self.horizontal_annotation_fixture(out, facts, side, language)
            self.assertTrue(guide._verify_annotation(entry, out, api)); self.assertTrue(guide._verify_annotation_layout(entry, layout, facts))
            project = api.read(entry['projectPath']); region = project['regions'][0]
            expected = '扩展排针' if language == 'zh' else 'Expansion header'
            self.assertEqual(region['code'], 'J1'); self.assertEqual(region['title'], expected)
            self.assertEqual(layout['displayLanguage'], language); self.assertNotIn('X6511-TEST', region['title'])
            project['regions'][0]['title'] = 'Expansion header' if language == 'zh' else '扩展排针'
            Path(entry['projectPath']).write_text(json.dumps(project))
            self.assertFalse(guide._verify_annotation_layout(entry, layout, facts), 'a different branch language must not pass its source-bound labels')
            project['regions'][0]['title'] = expected; Path(entry['projectPath']).write_text(json.dumps(project))
            illustrations[port] = {'annotation': entry, 'annotationLayout': layout}
        labels = guide._rendered_annotation_labels(illustrations)
        self.assertEqual({item['language'] for item in labels}, {'zh', 'en'})
        self.assertEqual({item['side'] for item in labels}, {'front', 'back'})
        self.assertTrue(all(item['ref'] == 'J1' and item['title'] == ('扩展排针' if item['language'] == 'zh' else 'Expansion header') for item in labels))

    def test_localized_six_image_review_rejects_branch_language_swaps_and_binds_hidden_drawio_refs(self):
        facts, values, files, context = self.five_images({'labelMode': 'localized-name-with-refs'}, bilingual=True, separate=True, show_designators=False)
        illustrations, selected, review = guide._illustrations(values, self.run, context, facts, api, diagram_value=self.diagram_token)
        self.assertEqual(len(selected), 6); self.assertEqual(review['mode'], 'separate')
        self.assertTrue(guide._verify_diagram(illustrations['diagram'], facts)['passed'])
        wrong = copy.deepcopy(facts); wrong['diagramPresentation']['showDesignators'] = True
        with self.assertRaises(ValueError): guide._verify_diagram(illustrations['diagram'], wrong)
        for image in illustrations['diagram']['diagrams'].values():
            self.assertFalse(api.read(image['manifestPath'])['showDesignators'])
        token = values['frontZh']; data = api.read(token['receiptPath'])
        data['annotationLayout']['language'] = 'en'; Path(token['receiptPath']).write_text(json.dumps(data)); token['receiptSha256'] = api.sha(token['receiptPath'])
        self.run['nodes']['frontZh']['output'] = copy.deepcopy(token); self.run['nodes']['review']['output'] = copy.deepcopy(values); self.save_run()
        with self.assertRaisesRegex(ValueError, '正反面和文档语言'):
            guide._illustrations(values, self.run, context, facts, api, diagram_value=self.diagram_token)

    def test_bilingual_diagrams_support_six_file_combined_review_and_two_independent_human_ports(self):
        facts, values, files, context = self.five_images({'labelMode': 'english-name-with-ref'}, bilingual=True, separate=True)
        illustrations, selected, review = guide._illustrations(values, self.run, context, facts, api, diagram_value=self.diagram_token)
        self.assertEqual(len(selected), 6); self.assertEqual(review['mode'], 'separate')
        self.assertEqual(review['annotations']['nodeId'], 'review'); self.assertEqual(review['diagram']['nodeId'], 'diagram-review')
        self.assertEqual(set(illustrations['diagram']['diagrams']), {'zh', 'en'})
        self.assertTrue(guide._verify_diagram(illustrations['diagram'], facts)['passed'])
        original = copy.deepcopy(self.run)
        for node_id in ('review', 'diagram-review'):
            self.run = copy.deepcopy(original); self.run['nodes'][node_id]['review']['artifactHashes'].pop(); self.save_run()
            with self.subTest(node=node_id), self.assertRaises(ValueError):
                guide._illustrations(values, self.run, context, facts, api, diagram_value=self.diagram_token)
        self.run = copy.deepcopy(original)
        combined = {**values, 'diagram': self.diagram_token}
        approved = original['nodes']['review']['artifacts'] + original['nodes']['diagram-review']['artifacts']
        self.run['nodes']['review'].update(output=combined, artifacts=approved)
        self.run['nodes']['review']['review']['artifactHashes'] = approved; self.save_run()
        _, selected, review = guide._illustrations(combined, self.run, context, facts, api)
        self.assertEqual(len(selected), 6); self.assertEqual(review['nodeId'], 'review')
        changed = copy.deepcopy(illustrations['diagram']); changed['diagrams']['zh'] = changed['diagrams']['en']
        with self.assertRaises(ValueError): guide._verify_diagram(changed, facts)

    def test_each_markdown_binds_its_own_language_diagram_and_final_check_rejects_cross_language_links(self):
        spec = importlib.util.spec_from_file_location('guide_language_render_fixture', ROOT / 'test/python/test_guide_render.py')
        fixture = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixture)
        facts = fixture.facts(); facts['diagramPresentation'] = {'languages': ['zh', 'en']}
        facts['annotationPresentation'] = {'labelMode': 'localized-name-with-refs'}
        out = self.root / 'bilingual-docs'; (out / 'img').mkdir(parents=True)
        assets = {}
        for language in ('zh', 'en'):
            for extension, base in (('png', 'block'), ('svg', 'block_svg'), ('drawio', 'block_drawio')):
                path = out / 'img' / ('block.' + language + '.' + extension); path.write_text('test file')
                assets[base + '_' + language] = 'img/' + path.name
                if language == 'en': assets[base] = 'img/' + path.name
            for base in ('interface', 'interface_back'):
                key = base + ('_en' if language == 'en' else '')
                path = out / 'img' / (key + '.png'); path.write_text('test file'); assets[key] = 'img/' + path.name
        rendered = guide._render_guide_bundle(facts, fixture.narrative(), out, assets)
        bundle = {'facts': facts, 'rendered': rendered}; self.assertTrue(guide._verify_document_diagrams(bundle))
        self.assertTrue(guide._verify_document_annotations(bundle))
        for language in ('zh', 'en'):
            text = Path(rendered[language + 'Path']).read_text()
            self.assertIn('(img/block.' + language + '.png)', text)
            for item in rendered['renderedFiles']: self.assertEqual(api.sha(item['path']), item['sha256'])
        path = Path(rendered['enPath']); original = path.read_text()
        path.write_text(original.replace('img/interface_en.png', 'img/interface.png'))
        self.assertFalse(guide._verify_document_annotations(bundle))
        path.write_text(original.replace('img/block.en.', 'img/block.zh.'))
        self.assertFalse(guide._verify_document_diagrams(bundle))

    def test_prepare_accepts_reviewed_pixel_regions_and_preserves_photo_and_source_identities(self):
        previous = guide.prepare(self.value, api)
        self.profile['annotationPresentation'] = {'labelMode': 'english-name-with-ref'}
        self.profile['diagramPresentation'] = {'languages': ['zh', 'en']}
        for image in self.profile['images']:
            image['regions'][0].update(coordinateSpace='pixels', x=10, y=36, w=28, h=64)
        self.save_profile()
        current = guide.prepare(self.value, api)
        self.assertEqual(current['annotationPresentation'], {'labelMode': 'english-name-with-ref'})
        self.assertEqual(current['diagramPresentation'], {'languages': ['zh', 'en']})
        for image, prior in zip(current['request']['images'], previous['request']['images']):
            for key in ('sha256', 'side', 'width', 'height', 'note', 'path'):
                self.assertEqual(image[key], prior[key])
            region, old = image['regions'][0], prior['regions'][0]
            for key in ('id', 'refs', 'titleZh', 'titleEn'):
                self.assertEqual(region[key], old[key])
            self.assertEqual({key: region[key] for key in ('x', 'y', 'w', 'h')}, {'x': 10, 'y': 36, 'w': 28, 'h': 64})
        self.assertEqual(api.read(self.profile_path), self.profile, 'validation must not rewrite reviewed calibration')

    def test_localized_policy_and_hidden_diagram_designators_keep_prepared_geometry_and_original_binding(self):
        self.profile['annotationPresentation'] = {'labelMode': 'english-name-with-ref'}
        self.profile['diagramPresentation'] = {'languages': ['zh', 'en']}; self.save_profile()
        previous = guide.prepare(self.value, api)
        self.profile['annotationPresentation'] = {'labelMode': 'localized-name-with-refs'}
        self.profile['diagramPresentation'] = {'languages': ['zh', 'en'], 'showDesignators': False}; self.save_profile()
        current = guide.prepare(self.value, api)
        self.assertEqual(current['annotationPresentation'], {'labelMode': 'localized-name-with-refs'})
        self.assertEqual(current['diagramPresentation'], {'languages': ['zh', 'en'], 'showDesignators': False})
        for key in ('request', 'sourceSha256', 'pcbUuid', 'drawioTemplate', 'fourReceipt', 'repositoryBlobs'):
            self.assertEqual(current[key], previous[key], key)
        self.assertEqual(api.read(self.profile_path), self.profile)

    def test_horizontal_planner_preserves_pixels_regions_and_source_bindings_without_an_upstream_checkout(self):
        facts = self.source_facts(); unchanged = copy.deepcopy(facts)
        bindings = guide._annotation_source_bindings(facts)
        selected = {ident: {'id': ident, 'titleZh': item['nameChoicesZh'][0], 'titleEn': item['nameChoicesEn'][0]}
                    for ident, item in bindings.items()}
        style = {'color': '#ef4444', 'dashed': True, 'stroke': 3, 'fontSize': 18, 'radius': 5}
        for image in facts['images']:
            with self.subTest(side=image['side']):
                project, proof = guide._horizontal_annotation_project(image, selected, style, bindings, 'en', 'synthetic-planner',
                    metrics=[{'width': 200, 'ascent': 18, 'descent': 5} for _ in image['regions']],
                    presentation={'labelMode': 'english-name-with-ref'})
                self.assertEqual(proof['rotationClockwiseDegrees'], 90)
                self.assertEqual(proof['sourcePhotoSha256'], api.sha(image['path']))
                self.assertEqual(proof['sourceBindings'], [bindings[item['id']] for item in image['regions']])
                bounds = proof['photoBounds']
                with Image.open(image['path']) as original:
                    rotated = original.convert('RGBA').transpose(Image.Transpose.ROTATE_270)
                with Image.open(io.BytesIO(base64.b64decode(project['image']['src'].split(',')[1]))) as encoded:
                    canvas = encoded.convert('RGBA')
                self.assertGreater(canvas.width, canvas.height)
                self.assertEqual(canvas.crop((bounds['x'], bounds['y'], bounds['x'] + rotated.width,
                    bounds['y'] + rotated.height)).tobytes(), rotated.tobytes())
                for region, source in zip(project['regions'], image['regions']):
                    self.assertEqual(region['code'], '/'.join(bindings[source['id']]['refs']))
                    self.assertEqual({key: region[key] for key in ('x', 'y', 'w', 'h')}, {
                        'x': image['height'] - source['y'] - source['h'] + bounds['x'],
                        'y': source['x'] + bounds['y'], 'w': source['h'], 'h': source['w']})
                with self.assertRaisesRegex(ValueError, '测量数量'):
                    guide._horizontal_annotation_project(image, selected, style, bindings, 'en', 'invalid-metrics', metrics=[])
        self.assertEqual(facts, unchanged)

    def test_horizontal_proof_checks_lossless_source_pixels_coordinates_and_actual_core_routes(self):
        facts = self.source_facts(); out = self.root / 'horizontal'; out.mkdir()
        entry, layout = self.horizontal_annotation_fixture(out, facts, 'front', 'en')
        self.assertEqual(layout['rotationClockwiseDegrees'], 90)
        self.assertEqual(layout['photoBounds']['width'], 200); self.assertEqual(layout['photoBounds']['height'], 120)
        self.assertTrue(guide._verify_annotation(entry, out, api))
        self.assertTrue(guide._verify_annotation_layout(entry, layout, facts))
        for mutate in (lambda p: p['sourceToCanvas'].update(e=p['sourceToCanvas']['e'] + 1),
                       lambda p: p.update(rotationClockwiseDegrees=0),
                       lambda p: p['sourceBindings'][0]['sourceComponents'][0]['pins'][0].update(net='wrong')):
            changed = copy.deepcopy(layout); mutate(changed)
            with self.subTest(proof=changed): self.assertFalse(guide._verify_annotation_layout(entry, changed, facts))
        xml = ET.parse(entry['svgPath']); line = next(e for e in xml.getroot().iter() if e.tag.rsplit('}', 1)[-1] == 'polyline')
        points = [p.split(',') for p in line.get('points').split()]; points[1][0] = str(float(points[1][0]) + 2)
        points[1][1] = str(float(points[1][1]) + 2); line.set('points', ' '.join(','.join(p) for p in points)); xml.write(entry['svgPath'])
        self.assertFalse(guide._verify_annotation_layout(entry, layout, facts), 'a real elbow/diagonal in SVG must fail')

    def test_horizontal_proof_rejects_modified_embedded_pixels_or_region_geometry(self):
        facts = self.source_facts(); out = self.root / 'horizontal-tamper'; out.mkdir()
        entry, layout = self.horizontal_annotation_fixture(out, facts, 'front', 'zh')
        project = api.read(entry['projectPath']); project['regions'][0]['x'] += 1
        Path(entry['projectPath']).write_text(json.dumps(project))
        self.assertFalse(guide._verify_annotation_layout(entry, layout, facts))
        project['regions'][0]['x'] -= 1
        import io
        with Image.open(io.BytesIO(base64.b64decode(project['image']['src'].split(',')[1]))) as embedded:
            pixels = embedded.convert('RGBA')
        bounds = layout['photoBounds']; pixels.putpixel((bounds['x'] + 10, bounds['y'] + 10), (255, 0, 0, 255))
        stream = io.BytesIO(); pixels.save(stream, format='PNG'); project['image']['src'] = 'data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode()
        Path(entry['projectPath']).write_text(json.dumps(project))
        self.assertFalse(guide._verify_annotation_layout(entry, layout, facts))

    def test_source_mapping_error_remains_hard_in_learning(self):
        facts = self.source_facts(); facts['components'][0]['pins'][0]['net'] = 'wrong'
        with self.assertRaises(ValueError) as caught:
            guide._annotation({}, facts, 'front', 'zh', self.root, api, True)
        self.assertNotIsInstance(caught.exception, api.InvalidLearningPlan)

    def test_prepare_requires_real_selected_template_and_freezes_its_original_sha(self):
        self.profile['drawioTemplate']['sha256'] = '0' * 64; self.save_profile()
        with self.assertRaisesRegex(ValueError, 'SHA'): guide.prepare(self.value, api)
        self.profile.pop('drawioTemplate'); self.save_profile()
        with self.assertRaisesRegex(ValueError, 'DrawIO'): guide.prepare(self.value, api)

    def test_large_original_photo_keeps_exact_pixels_and_scales_style_for_readability(self):
        facts = self.source_facts(); image = facts['images'][0]
        photo = self.root / 'large-reviewed-source.png'
        pixels = Image.new('RGBA', (1200, 2200), (30, 60, 90, 255)); pixels.putpixel((10, 20), (255, 0, 120, 170)); pixels.save(photo)
        image.update(path=str(photo), name=photo.name, width=1200, height=2200, sha256=api.sha(photo))
        bindings = guide._annotation_source_bindings(facts)
        selected = {ident: {'id': ident, 'titleZh': b['nameChoicesZh'][0], 'titleEn': b['nameChoicesEn'][0]} for ident, b in bindings.items()}
        style = {'color': '#ef4444', 'dashed': True, 'stroke': 3, 'fontSize': 18, 'radius': 5}
        project, layout = guide._horizontal_annotation_project(image, selected, style, bindings, 'en', 'large fixture', metrics=[{'width': 600, 'ascent': 40, 'descent': 8}])
        self.assertEqual(layout['effectiveStyle']['fontSize'], 44)
        self.assertEqual(layout['requestedStyle']['fontSize'], 18)
        self.assertEqual((layout['photoBounds']['width'], layout['photoBounds']['height']), (2200, 1200))
        import io
        with Image.open(io.BytesIO(base64.b64decode(project['image']['src'].split(',')[1]))) as embedded:
            bounds = layout['photoBounds']; crop = embedded.crop((bounds['x'], bounds['y'], bounds['x'] + bounds['width'], bounds['y'] + bounds['height']))
            self.assertEqual(crop.tobytes(), pixels.transpose(Image.Transpose.ROTATE_270).tobytes())


if __name__ == '__main__': unittest.main()
