"""HDK v2 contracts and real disk relocation; no EDA/model/SDK build runs.

Compiler and native business validators are mocked only in assembly fixtures;
the existing dedicated tests cover those validators. These tests exercise actual
files, hashes, immutable receipts, copied manifests, SOP rendering and links.
"""
import copy
import base64
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from hdk import full_dag as dag


class InvalidLearningPlan(ValueError):
    code = 'LEARNING_INVALID_PLAN'


class API:
    InvalidLearningPlan = InvalidLearningPlan

    def __init__(self, root):
        self.root, self.serial = root, 0
        self.run = {'id': 'test-run', 'workflowId': 'test-flow'}
        self.outputs = {}
        self.approved = set()
        self.reviewed = []

    def call(self, action, value):
        self.serial += 1
        node_id = action + '-' + str(self.serial)
        out = self.root / node_id / '版本-1'
        out.mkdir(parents=True)
        context = {'nodeId': node_id, 'outputDirectory': str(out)}
        return dag.full('hdk.full.' + action, value, context, self)

    def bound(self, operation, value, context):
        return self.run, self.root, Path(context['outputDirectory'])

    def assets(self, items):
        return [dict(item, role=item.get('kind', '')) for item in items]

    def receipt(self, operation, data, run, out, artifacts, extra=None):
        path = out / 'receipt.json'
        dag.write(path, data | {'operation': operation})
        result = {'kind': 'hdk-node-receipt', 'runId': run['id'], 'nodeId': os.environ['HDK_NODE_ID'],
            'operation': operation, 'receiptPath': str(path), 'receiptSha256': dag.sha(path), 'artifacts': artifacts}
        result.update(extra or {})
        self.outputs[result['nodeId']] = copy.deepcopy(result)
        return result

    def load(self, receipt, run, operation):
        if receipt.get('runId') != run['id'] or receipt.get('operation') != operation or self.outputs.get(receipt.get('nodeId')) != receipt:
            raise ValueError('stale or foreign fixture receipt')
        path = Path(receipt['receiptPath'])
        if dag.sha(path) != receipt['receiptSha256']:
            raise ValueError('receipt changed')
        data = dag.read(path)
        for item in data.get('sourceFiles', []) + data.get('proofFiles', []):
            if dag.sha(item['path']) != item['sha256']:
                raise ValueError('source or artifact changed')
        return data

    def reviewed_artifacts(self, run, context, value, files, port='images'):
        if port not in self.approved or not files:
            raise ValueError('current actual artifacts require human review: ' + port)
        for file in files:
            if dag.sha(file['path']) != file['sha256']:
                raise ValueError('approved artifact changed')
        self.reviewed.append(port)
        return {'nodeId': port + '-human', 'artifactHashes': [{'sha256': f['sha256']} for f in files]}


class FullDAGTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='hdk-full-dag-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.output = self.root / 'outputs'
        self.output.mkdir()
        self.api = API(self.output)
        self.source = self.root / 'source.epro2'
        with zipfile.ZipFile(self.source, 'w') as archive:
            archive.writestr('project2.json', '{"title":"Test source only"}')
            archive.writestr('source.epru', '\n'.join(json.dumps({'type': 'DOCHEAD'}) + '||' + json.dumps({'uuid': kind, 'docType': kind}) + '|'
                for kind in ('PCB', 'SCH_PAGE')))
        self.template = self.root / 'template.xlsx'
        self.template.write_bytes(b'test-only template bytes, not a manufacturing workbook')
        self.profile = self.root / 'profile.json'
        self.profile.write_text(json.dumps({'schemaVersion': 1, 'template': {'path': str(self.template), 'sha256': dag.sha(self.template)},
            'testRequirements': {'cameraSensor': 'sc2336', 'displayPanel': 'st7102-480x640', 'physicalTestStatus': 'not-run'},
            'processProfile': {'schemaVersion': 1}}))
        self.request = {'sourcePath': str(self.source), 'productCode': 'BOARD', 'hardwareVersion': '1.0',
            'releaseDate': '2026-10-25', 'profilePath': str(self.profile), 'templatePath': str(self.template)}
        self.board = {'source': {'path': str(self.source), 'sha256': dag.sha(self.source)},
            'board': {'primaryTarget': 'esp32p4', 'targets': ['esp32p4', 'esp32c61'], 'components': []},
            'peripherals': {}, 'warnings': []}
        self.facts = {'request': self.request, 'sourceSha256': dag.sha(self.source),
            'sourceFiles': [dag.file_ref(p) for p in (self.source, self.template, self.profile)],
            'boardFacts': self.board, 'nativeSource': dag.native_module().source_info(self.source),
            'testRequirements': {}, 'processProfile': {'schemaVersion': 1}, 'resources': {},
            'releaseQualification': {'legacyGateInherited': False}}

    def emit(self, operation, data, artifacts=()):
        self.api.serial += 1
        out = self.output / ('fixture-' + str(self.api.serial)) / '版本-1'
        out.mkdir(parents=True)
        os.environ['HDK_NODE_ID'] = out.parent.name
        return self.api.receipt('hdk.full.' + operation, data, self.api.run, out, self.api.assets(artifacts))

    def facts_receipt(self):
        return self.emit('prepare', self.facts)

    def prepare_patches(self):
        for target, kwargs in [(dag.firmware, {'inspect_board': lambda _: copy.deepcopy(self.board)}),
                (dag.process, {'prepare_process_request': lambda _: {'facts': {}}, '_xlsx_read': lambda _: (object(), [{}, {}]),
                    '_template_controls': lambda *_: ({str(n): {} for n in range(45)}, {})})]:
            mocked = patch.multiple(target, **kwargs)
            mocked.start(); self.addCleanup(mocked.stop)
        mocked = patch.object(dag, 'resource_preflight', return_value={'sdkCommit': 'fixture'})
        mocked.start(); self.addCleanup(mocked.stop)

    def report(self, folder, target='esp32p4', family='legacy'):
        area = self.root / folder
        source, build = area / 'source', area / 'build'
        source.mkdir(parents=True); build.mkdir()
        (source / 'main.c').write_text('/* test-only compiler fixture; not production source */')
        (source / 'dependencies.lock').write_text('fixture-lock')
        (source / 'managed_components').mkdir()
        dag.write(source / 'dependency-source-index.json', {'files': [], 'lockSha256': dag.sha(source / 'dependencies.lock')})
        app = build / 'factory.bin'
        app.write_bytes((folder + ' fixture application').encode())
        merged = area / 'merged.bin'
        merged.write_bytes(bytes(0x10000) + app.read_bytes())
        args = build / 'flasher_args.json'
        dag.write(args, {'flash_files': {'0x10000': app.name}, 'extra_esptool_args': {'chip': target},
            'write_flash_args': ['--flash-mode', 'dio', '--flash-size', '2MB' if target == 'esp32c61' else '4MB', '--flash-freq', '80m'],
            'flash_settings': {'flash_mode': 'dio', 'flash_size': '2MB' if target == 'esp32c61' else '4MB', 'flash_freq': '80m'}})
        elf = build / 'factory.elf'; elf.write_bytes(b'not a real ELF; business validator is explicitly mocked')
        log = area / 'build.log'; log.write_text('test fixture, no compilation was run')
        artifacts = []
        for path, role in [(source / 'main.c', 'source'), (source / 'dependencies.lock', 'dependencyLock'),
                (source / 'dependency-source-index.json', 'dependencySourceIndex'), (app, 'applicationBin'),
                (merged, 'mergedBin'), (args, 'flashArgs'), (elf, 'elf'), (log, 'buildLog')]:
            artifacts.append(dict(dag.file_ref(path), role=role, relativePath=path.relative_to(area).as_posix()))
        if target == 'esp32c61':
            guide = area / 'C61烧录说明.md'; guide.write_text('test fixture separate UART guide; not a hardware claim')
            artifacts.append(dict(dag.file_ref(guide), role='companionFlashGuide', relativePath=guide.name))
        result = {'schemaVersion': 1, 'status': 'compiled', 'target': target, 'physicalTestStatus': 'not-run',
            'boardSourceSha256': self.facts['sourceSha256'], 'boardFacts': self.board, 'profile': {'fixture': True},
            'packagePath': str(area.parent), 'artifactRoot': str(area), 'sourceDir': str(source),
            'manifestPath': str(area / 'firmware-manifest.json'), 'sourceSha256': 'source-fixture',
            'siliconRevisionFamily': family if target == 'esp32p4' else None, 'artifacts': artifacts,
            'buildCommand': ['fixture-compiler-not-executed', '-C', str(source)],
            'tests': [{'id': 'chip-info', 'scope': 'fixture-only test', 'expectedLog': 'fixture', 'operatorSteps': ['Operator must use actual hardware'], 'hardwareRequired': True}],
            'warnings': [], 'idf': {'version': 'fixture-no-real-build'},
            'flash': {'offsets': [{'offset': '0x10000', 'path': str(app), 'relativePath': app.relative_to(area).as_posix(), 'sha256': dag.sha(app)}],
                'flashArgsPath': str(args), 'mergedPath': str(merged), 'mergedOffset': '0x0'}}
        dag.write(result['manifestPath'], result)
        return result

    def compiled(self, *_args, **_kwargs):
        return {'status': 'complete', 'checks': {'fixtureBoundary': True}, 'errors': []}

    def native_fixture(self, broken=False):
        from pypdf import PdfWriter
        from pypdf.generic import NameObject, DecodedStreamObject
        from PIL import Image, ImageDraw
        writer = PdfWriter(); page = writer.add_blank_page(width=300, height=200)
        if broken:
            content = DecodedStreamObject(); content.set_data(b'BT /undefined 12 Tf (raw native fixture) Tj ET')
            page[NameObject('/Contents')] = writer._add_object(content)
        stream = io.BytesIO(); writer.write(stream); vector = stream.getvalue()
        image = Image.new('RGBA', (1600, 1200), (255, 255, 255, 0))
        ImageDraw.Draw(image).rectangle((30, 30, 1500, 1100), outline='red', width=6)
        stream = io.BytesIO(); image.save(stream, format='PNG'); png = stream.getvalue()
        native_calls = []
        core = dag.native_module()

        class FakeNative:
            def __init__(self, executable, evidence):
                self.executable, self.evidence, self.session = executable, evidence, 'fixture-owned-session'
            def open(self, path):
                return {'importedProject': {'uuid': 'fixture-owned-project'}}
            def invoke(self, args):
                if args['action'] == 'inspect':
                    return {'project': {'uuid': 'fixture-owned-project'}, 'pages': [{'uuid': 'SCH_PAGE'}]}
                if args['action'] == 'source':
                    return {'project': {'uuid': 'fixture-owned-project'}, 'source': 'unchanged fixture'}
                if args['action'] == 'export' and args['kind'] == 'schematicPdf':
                    return {'file': {'base64': base64.b64encode(vector).decode(), 'bytes': len(vector), 'name': 'actual-native.pdf'}}
                raise AssertionError('Unexpected fixture native operation')
            def command(self, args, timeout=190):
                # sch_native.Native.invoke must reuse this exact session and
                # existing PNG script, never create a second EDA session.
                self_session = args[args.index('--session') + 1]
                if self_session != self.session:
                    raise AssertionError('PNG session was not the owned native session')
                options = json.loads(args[args.index('--args') + 1]); native_calls.append(options)
                if options.get('expectedProjectUuid') != 'fixture-owned-project':
                    raise AssertionError('PNG source project was not bound')
                Path(options['outputPath']).write_bytes(png)
                return {'file': {'path': options['outputPath'], 'bytes': len(png)},
                    'exportOptions': {'api': 'fixture actual PNG export', 'size': options['pngSize']}}

        def export(request, execute=False):
            self.assertTrue(execute)
            output = Path(request['outputParent']); output.mkdir()
            evidence = output / 'evidence'; evidence.mkdir()
            native = core.Native('fixture-eda-never-launched', evidence)
            native.open(self.source); native.invoke({'action': 'inspect'}); native.invoke({'action': 'source'})
            result = native.invoke({'action': 'export', 'kind': 'schematicPdf'})
            raw = base64.b64decode(result['file']['base64'])
            (evidence / 'schematicPdf.native').write_bytes(raw)
            delivered, transformation = core.unpack_native_pdf(raw)
            (output / 'schematic.pdf').write_bytes(delivered)
            report = {'source': {'pages': [{'uuid': 'SCH_PAGE'}]}, 'outputPath': str(output), 'warnings': [],
                'reportPath': str(evidence / 'export-report.json'), 'evidencePath': str(evidence),
                'artifacts': [{'kind': 'schematicPdf', 'path': 'schematic.pdf', 'sha256': dag.sha(output / 'schematic.pdf'),
                    'checks': {'transformation': transformation} if transformation else {}}]}
            dag.write(report['reportPath'], report)
            return report
        core.Native, core.export = FakeNative, export
        return core, vector, native_calls

    def test_prepare_profile_freezes_explicit_template_and_never_inherits_old_gate(self):
        self.prepare_patches()
        value = dict(self.request); value.pop('templatePath')
        result = self.api.call('prepare', value)
        facts = self.api.load(result, self.api.run, 'hdk.full.prepare')
        self.assertEqual(facts['request']['templatePath'], str(self.template))
        self.assertEqual({f['path'] for f in facts['sourceFiles']}, {str(self.source), str(self.profile), str(self.template)})
        self.assertFalse(facts['releaseQualification']['legacyGateInherited'])
        self.template.write_bytes(b'changed template')
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.api.load(result, self.api.run, 'hdk.full.prepare')
        with self.assertRaisesRegex(ValueError, 'SHA'):
            self.api.call('prepare', value)

    def test_prepare_rejects_known_answers_and_physical_pass_claims(self):
        self.prepare_patches()
        with self.assertRaisesRegex(ValueError, '已知答案'):
            self.api.call('prepare', self.request | {'expected': {'passed': True}})
        data = dag.read(self.profile); data['testRequirements']['physicalTestStatus'] = 'passed'
        self.profile.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, '实测'):
            self.api.call('prepare', self.request)

    def test_single_named_facts_ports_unwrap_and_skill_inputs_do_not_receive_template_or_case(self):
        facts = self.facts_receipt()
        result = self.api.call('export-plan-input', {'facts': facts})
        self.assertEqual(result['skillInput']['productCode'], 'BOARD')
        self.assertNotIn(str(self.template), json.dumps(result['skillInput']))
        self.assertNotIn('expected', result['skillInput'])
        self.assertNotIn('boardFacts', result)

    def test_non_p4_branches_return_explicit_not_applicable_receipts_without_compile(self):
        self.facts['boardFacts']['board']['primaryTarget'] = 'esp32s31'
        facts = self.facts_receipt()
        with patch.object(dag.companion, 'compile_package') as c61, patch.object(dag.firmware, '_compile_one') as compile_one:
            for action, value in [('build-v3', {'facts': facts, 'plan': {}}), ('build-c61', {'facts': facts})]:
                result = self.api.call(action, value)
                data = self.api.load(result, self.api.run, 'hdk.full.' + action)
                self.assertFalse(data['applicable']); self.assertEqual(data['status'], 'notApplicable'); self.assertEqual(result['artifacts'], [])
            c61.assert_not_called(); compile_one.assert_not_called()

    def test_build_nodes_use_explicit_independent_family_and_never_recursive_compile(self):
        facts = self.facts_receipt(); calls = []
        def generate(board, plan, package, _revision_family=None):
            calls.append((package, _revision_family)); return {'packagePath': package}
        reports = [self.report('build-one', family='legacy'), self.report('build-two', family='v3')]
        with patch.object(dag.firmware, 'validate_profile', side_effect=lambda _b, p: p), \
                patch.object(dag.firmware, 'coverage', return_value={'complete': True}), \
                patch.object(dag.firmware, 'generate', side_effect=generate), \
                patch.object(dag.firmware, '_compile_one', side_effect=reports), \
                patch.object(dag.firmware, 'compile') as recursive, patch.object(dag, '_validate_build', side_effect=self.compiled):
            first = self.api.call('build-legacy', {'facts': facts, 'plan': {}})
            second = self.api.call('build-v3', {'facts': facts, 'plan': {}})
        recursive.assert_not_called(); self.assertEqual([r[1] for r in calls], ['legacy', 'v3']); self.assertNotEqual(calls[0][0], calls[1][0])
        self.assertEqual(self.api.load(first, self.api.run, 'hdk.full.build-legacy')['plan'], {})
        self.assertLess(len(json.dumps(first).encode()), 60000); self.assertLess(len(json.dumps(second).encode()), 60000)
        self.assertTrue(any(a['kind'] == 'firmware-source-archive' for a in first['artifacts']))

    def test_only_plan_errors_are_learning_recoverable_and_missing_process_plan_is_not_defaulted(self):
        self.api.run['learningId'] = 'fixture-learning'
        facts = self.facts_receipt()
        with self.assertRaises(InvalidLearningPlan):
            self.api.call('process', {'facts': facts})
        with patch.object(dag.firmware, 'validate_profile', side_effect=ValueError('bad selected test')):
            with self.assertRaises(InvalidLearningPlan):
                self.api.call('build-legacy', {'facts': facts, 'plan': {}})
        with patch.object(dag.firmware, 'validate_profile', side_effect=lambda _b, p: p), \
                patch.object(dag.firmware, 'coverage', return_value={'complete': True}), \
                patch.object(dag.firmware, 'generate', side_effect=RuntimeError('SDK missing')):
            with self.assertRaises(RuntimeError) as error:
                self.api.call('build-legacy', {'facts': facts, 'plan': {}})
        self.assertFalse(hasattr(error.exception, 'code'))

    def test_native_plan_boolean_contract_is_strict_and_cannot_reach_native_io_on_invalid_plan(self):
        facts = self.facts_receipt()
        native = dag.native_module()
        plan = {'packageName': 'BOARD_HDK_V1.0', 'paths': native.expected_paths('BOARD', '1.0', '2026-10-25'),
            'supplementalDirectories': ['重要器件手册', '生产资料/07_测试说明'],
            'checks': {'stencilFromCurrentGerber': True, 'checkDocumentReferences': True, 'excludeOsMetadata': True, 'exportFromInputOnly': True}}
        plan['checks']['exportFromInputOnly'] = 1
        with patch.object(native, 'export') as export, patch.object(dag, 'native_module', return_value=native):
            with self.assertRaisesRegex(ValueError, '导出与命名'):
                self.api.call('native', {'facts': facts, 'plan': plan})
            export.assert_not_called()

    def test_compiled_flag_without_independent_pass_and_all_actual_checks_is_rejected(self):
        report = self.report('false-compiled')
        for checked in [{'status': 'blocked', 'checks': {}, 'errors': ['fixture mismatch']},
                {'status': 'complete', 'checks': {'actualBytes': False}, 'errors': []}]:
            with patch.object(dag.firmware, 'validate_build', return_value=checked):
                with self.assertRaises(ValueError):
                    dag._validate_build(report, single=True)

    def test_native_environment_failure_is_shown_before_missing_output_verification(self):
        facts = self.facts_receipt(); native = dag.native_module()
        plan = {'packageName': 'BOARD_HDK_V1.0', 'paths': native.expected_paths('BOARD', '1.0', '2026-10-25'),
            'supplementalDirectories': ['重要器件手册', '生产资料/07_测试说明'],
            'checks': {'stencilFromCurrentGerber': True, 'checkDocumentReferences': True, 'excludeOsMetadata': True, 'exportFromInputOnly': True}}
        report = {'status': 'blocked', 'coreStatus': 'blocked', 'nativeStage': 'environment',
            'error': '客户端处于在线模式；请切换半离线或全离线', 'reportPath': '/fixture/no-complete-report.json'}
        with patch.object(dag, 'export_full_native', return_value=report), patch.object(dag, 'verify_full_native') as verify:
            with self.assertRaisesRegex(ValueError, r'\[environment\].*在线模式.*半离线'):
                self.api.call('native', {'facts': facts, 'plan': plan})
            verify.assert_not_called()
        report = dict(report, coreStatus='complete'); report.pop('error'); report.pop('nativeStage')
        with patch.object(dag, 'export_full_native', return_value=report), patch.object(dag, 'verify_full_native',
                return_value={'coreStatus': 'blocked', 'errors': ['independent-check-required']}) as verify:
            with self.assertRaisesRegex(ValueError, 'independent-check-required'):
                self.api.call('native', {'facts': facts, 'plan': plan})
            verify.assert_called_once_with(report['reportPath'])

    def test_full_native_adapter_preserves_good_original_vector_without_png_calls(self):
        core, vector, calls = self.native_fixture()
        with patch.object(dag, 'native_module', return_value=core):
            report = dag.export_full_native({'outputParent': str(self.root / 'native-good')})
        self.assertEqual(calls, [])
        self.assertEqual((Path(report['evidencePath']) / 'schematicPdf.native').read_bytes(), vector)
        self.assertEqual((Path(report['outputPath']) / 'schematic.pdf').read_bytes(), vector)
        self.assertEqual(report['fullNativeAdapter']['schematic']['mode'], 'original-vector-preserved')

    def test_full_native_fallback_reuses_owned_session_and_replays_archived_png_pixels_without_eda(self):
        core, vector, calls = self.native_fixture(broken=True)
        with patch.object(dag, 'native_module', return_value=core):
            report = dag.export_full_native({'outputParent': str(self.root / 'native-fallback')})
        raw_path = Path(report['evidencePath']) / 'schematicPdf.native'
        self.assertEqual(raw_path.read_bytes(), vector); self.assertEqual(len(calls), 1)
        transformation = report['artifacts'][0]['checks']['transformation']
        self.assertEqual(transformation['operation'], 'nativeRasterFallback')
        self.assertEqual(transformation['nativeArchiveSha256'], dag.sha(raw_path))
        self.assertFalse(transformation['textReconstruction'])
        rebuilt, _ = dag.replay_schematic(vector, transformation, report['source']['pages'])
        self.assertEqual(rebuilt, (Path(report['outputPath']) / 'schematic.pdf').read_bytes())
        self.assertEqual(len(calls), 1)  # replay never reaches a live native session
        image = transformation['pages'][0]
        Path(image['nativePath']).write_bytes(b'tampered original PNG')
        with self.assertRaisesRegex(ValueError, '原件|已变化'):
            dag.replay_schematic(vector, transformation, report['source']['pages'])

    def test_full_native_verifier_reconstructs_conversion_before_checking_every_pdf_font(self):
        core, vector, calls = self.native_fixture(broken=True)
        with patch.object(dag, 'native_module', return_value=core):
            report = dag.export_full_native({'outputParent': str(self.root / 'native-verify')})
        reader_core = dag.native_module()
        def verify(path):
            current = dag.read(path)
            replay, _ = reader_core.unpack_native_pdf((Path(current['evidencePath']) / 'schematicPdf.native').read_bytes())
            self.assertEqual(replay, (Path(current['outputPath']) / 'schematic.pdf').read_bytes())
            return {'coreStatus': 'complete', 'errors': [], 'outputPath': current['outputPath'],
                'artifacts': [{'kind': 'schematicPdf', 'path': 'schematic.pdf'}]}
        reader_core.verify_report = verify
        actual_factory = dag.native_module
        sequence = [reader_core]
        def modules():
            return sequence.pop() if sequence else actual_factory()
        with patch.object(dag, 'native_module', side_effect=modules):
            checked = dag.verify_full_native(report['reportPath'])
        self.assertEqual(checked['coreStatus'], 'complete')
        self.assertTrue(checked['fontAudits']['schematicPdf']['passed'])
        self.assertTrue(checked['schRendering']['independentPngReconstruction'])
        self.assertEqual(len(calls), 1)

    def test_full_native_font_audit_blocks_a_bad_assembly_pdf_even_if_legacy_flags_pass(self):
        core, bad_pdf, _ = self.native_fixture(broken=True)
        output = self.root / 'assembly-fonts'; output.mkdir()
        (output / 'assembly.pdf').write_bytes(bad_pdf)
        report_path = output / 'report.json'
        dag.write(report_path, {'source': {'pages': []}, 'artifacts': [{'kind': 'silkscreenPdf'}]})
        core.verify_report = lambda _: {'coreStatus': 'complete', 'errors': [], 'outputPath': str(output),
            'artifacts': [{'kind': 'silkscreenPdf', 'path': 'assembly.pdf'}]}
        with patch.object(dag, 'native_module', return_value=core):
            checked = dag.verify_full_native(report_path)
        self.assertEqual(checked['coreStatus'], 'blocked')
        self.assertFalse(checked['fontAudits']['silkscreenPdf']['passed'])
        self.assertTrue(any('字体' in error for error in checked['errors']))

    def test_aggregate_refuses_other_board_receipt_before_copy_or_manifest_generation(self):
        facts = self.facts_receipt()
        parents = {name: self.emit(operation, dag._common(self.facts) | {'applicable': True})
            for name, operation in [('legacy', 'build-legacy'), ('modern', 'build-v3'), ('c61', 'build-c61')]}
        data = self.api.load(parents['modern'], self.api.run, 'hdk.full.build-v3')
        data['sourceSha256'] = '0' * 64
        parents['modern'] = self.emit('build-v3', data)
        with patch.object(dag, 'aggregate_builds') as aggregate:
            with self.assertRaisesRegex(ValueError, '不同源'):
                self.api.call('firmware-aggregate', {'facts': facts, **parents})
            aggregate.assert_not_called()

    def test_three_build_relocation_keeps_upstream_immutable_and_supports_actual_sop_contract(self):
        reports = {'legacy': self.report('legacy'), 'modern': self.report('modern', family='v3'), 'c61': self.report('c61', target='esp32c61')}
        originals = {r['manifestPath']: Path(r['manifestPath']).read_bytes() for r in reports.values()}
        with patch.object(dag, '_validate_build', side_effect=self.compiled):
            aggregate, _, copies = dag.aggregate_builds(self.facts, reports, self.root / 'aggregate')
            moved, _, moved_copies = dag.relocate_aggregate(aggregate, self.root / 'sop-package')
        for path, data in originals.items():
            self.assertEqual(Path(path).read_bytes(), data)
        request = dag._sop_request(self.facts, moved, self.root / 'sop-package')
        result = dag.sop.render(request, self.root / 'sop-package/生产资料/07_测试说明', dag.sop.default_plan(request))
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(dag.sop.verify(result['markdownPath'], self.root / 'sop-package')['status'], 'complete')
        text = Path(result['markdownPath']).read_text()
        self.assertIn('硬件实测未进行', text); self.assertIn('P4分支 `legacy`', text); self.assertIn('P4分支 `v3`', text); self.assertIn('C61伴随芯片', text)
        self.assertEqual(moved['physicalTestStatus'], 'not-run')
        self.assertEqual(moved['buildCommand'], reports['legacy']['buildCommand'])
        for item in copies + moved_copies:
            self.assertTrue(Path(item['source']).is_file())
            self.assertEqual(item['sha256'], dag.sha(item['source']))
            self.assertEqual(item['deliveredSha256'], dag.sha(item['path']))
            if item['metadataRelocated']:
                self.assertTrue(item['path'].endswith(('firmware-manifest.json', 'generation-manifest.json', 'dependency-source-index.json')))
        self.assertEqual({v['family'] for v in moved['revisionVariants']}, {'legacy', 'v3'})
        for artifact in moved['artifacts']:
            self.assertEqual(dag.sha(artifact['path']), artifact['sha256'])
            self.assertTrue(Path(artifact['path']).is_relative_to(self.root / 'sop-package'))

    def test_copy_and_inventory_refuse_links_collisions_and_mutable_upstream(self):
        original = self.root / 'copy-source'; original.mkdir(); (original / 'a.txt').write_text('actual bytes')
        destination = self.root / 'copy-destination'
        dag.copy_tree(original, destination)
        with self.assertRaisesRegex(ValueError, '覆盖'):
            dag.copy_tree(original, destination)
        (original / 'link').symlink_to(self.source)
        with self.assertRaisesRegex(ValueError, '符号链接'):
            dag.inventory(original)

    def test_private_render_evidence_is_published_as_exact_visible_artifact_bytes(self):
        original = self.root / '.hdk/process-requirements/preview.png'
        original.parent.mkdir(parents=True); original.write_bytes(b'actual fixture preview bytes')
        published = dag.publish_file(original, self.output / 'visible-preview.png', 'process-preview')
        self.assertEqual(published['sha256'], dag.sha(original))
        self.assertFalse(any(part.startswith('.') for part in Path(published['path']).relative_to(self.output).parts))
        with self.assertRaisesRegex(ValueError, '覆盖'):
            dag.publish_file(original, self.output / 'visible-preview.png')

    @unittest.skipUnless(dag.process.DEFAULT_TEMPLATE.is_file(), 'Reviewed native process template unavailable')
    def test_process_attachment_adapter_uses_real_template_choice_and_preserves_all_other_bytes(self):
        original = dag.process.DEFAULT_TEMPLATE.read_bytes()
        source, sheets = dag.process._xlsx_read(original)
        # Move the option in a test-only copy to prove the adapter does not
        # hard-code the current production template's index of 2.
        member = sheets[1]['member']
        xml = source.read(member).decode()
        xml = dag.process._replace_cell(xml, 'A2', '4张')
        xml = dag.process._replace_cell(xml, 'A5', '1张')
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            for info in source.infolist():
                archive.writestr(info, xml.encode() if info.filename == member else source.read(info.filename))
        template = buffer.getvalue()
        updated, proof = dag.adapt_full_process_workbook(template, template)
        self.assertEqual(proof['selectionIndex'], 5)
        self.assertEqual(proof['selectionLabel'], '1张')
        self.assertEqual(proof['attachmentCount'], 1)
        self.assertEqual(proof['beforeSha256'], dag.hashlib.sha256(template).hexdigest())
        self.assertEqual(proof['afterSha256'], dag.hashlib.sha256(updated).hexdigest())
        before, before_sheets = dag.process._xlsx_read(template)
        controls, vml = dag.process._template_controls(before, before_sheets)
        after, after_sheets = dag.process._xlsx_read(updated)
        actual, _ = dag.process._template_controls(after, after_sheets)
        self.assertEqual(len(actual), 45)
        self.assertEqual(actual['1028']['prop'].attrib['sel'], '5')
        self.assertEqual(actual['1028']['state']['Sel'], '5')
        self.assertEqual(set(proof['changedMembers']), {controls['1028']['member'], vml})
        for name in before.namelist():
            if name not in proof['changedMembers']:
                self.assertEqual(before.read(name), after.read(name), name)
        _, snapshot = dag.process._control_snapshot_workbook(updated)
        attachment = next(c for c in snapshot['controls'] if c['shapeId'] == '1028')
        self.assertEqual(attachment['display'], '1张')
        self.assertEqual(dag.process.DEFAULT_TEMPLATE.read_bytes(), original)

    @unittest.skipUnless(dag.process.DEFAULT_TEMPLATE.is_file(), 'Reviewed native process template unavailable')
    def test_process_attachment_validation_detects_unselected_vml_and_keeps_manufacturing_confirmation(self):
        template = dag.process.DEFAULT_TEMPLATE.read_bytes()
        workbook = self.root / 'formal.xlsx'
        workbook.write_bytes(dag.adapt_full_process_workbook(template, template)[0])
        params = {'workbookPath': str(workbook), 'templatePath': str(dag.process.DEFAULT_TEMPLATE)}
        base = {'passed': True, 'checks': [{'name': 'old-engineering-check', 'passed': True}], 'unresolved': []}
        with patch.object(dag.process, 'validate_process_requirements', side_effect=lambda _: copy.deepcopy(base)):
            checked = dag.validate_full_process(params)
            self.assertTrue(checked['passed'])
            self.assertEqual(checked['checks'][-1]['name'], 'current-attachment-count')
            self.assertEqual(checked['unresolved'][0]['field'], 'fabricatorStackupAndCoupon')
            self.assertEqual(checked['unresolved'][0]['severity'], 'manufacturing-confirmation')
            source, sheets = dag.process._xlsx_read(workbook.read_bytes())
            _, vml = dag.process._template_controls(source, sheets)
            output = io.BytesIO()
            with zipfile.ZipFile(output, 'w') as archive:
                for info in source.infolist():
                    data = source.read(info.filename)
                    if info.filename == vml:
                        data = dag.process._set_vml_state(data.decode(), '1028', {'sel': 0}).encode()
                    archive.writestr(info, data)
            workbook.write_bytes(output.getvalue())
            rejected = dag.validate_full_process(params)
            self.assertFalse(rejected['passed'])
            self.assertFalse(rejected['checks'][-1]['passed'])
        source, sheets = dag.process._xlsx_read(template)
        member = sheets[1]['member']
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            for info in source.infolist():
                data = source.read(info.filename)
                if info.filename == member:
                    data = dag.process._replace_cell(data.decode(), 'A2', '没有此项').encode()
                archive.writestr(info, data)
        missing_option = output.getvalue()
        with self.assertRaisesRegex(ValueError, '唯一.*1张'):
            dag.adapt_full_process_workbook(missing_option, missing_option)

    @unittest.skipUnless(dag.process.DEFAULT_TEMPLATE.is_file(), 'Reviewed native process template unavailable')
    def test_full_process_generation_refreshes_formal_fields_preview_and_proof_after_private_adapter(self):
        original = dag.process.DEFAULT_TEMPLATE.read_bytes()
        package = self.root / 'new-process-attempt'
        formal = package / 'production/formal.xlsx'
        qa = package / '.hdk/process-requirements'
        fields_path = qa / 'fields.json'
        unresolved = [{'field': 'fabricatorStackupAndCoupon', 'severity': 'manufacturing-confirmation', 'detail': 'fixture factory confirmation'}]
        def generate(params):
            self.assertFalse(params['render'])
            formal.parent.mkdir(parents=True); qa.mkdir(parents=True)
            formal.write_bytes(original)
            dag.write(fields_path, {'fields': [], 'controlEdits': {}, 'unresolved': unresolved})
            dag.write(qa / 'validation.json', {'passed': True})
            return {'workbookPath': str(formal), 'fieldsReportPath': str(fields_path), 'artifacts': [
                {'kind': 'process-requirements', 'path': str(formal), 'sha256': dag.sha(formal)}], 'unresolved': unresolved}
        def render(path, directory):
            self.assertNotEqual(path.read_bytes(), original)
            _, snapshot = dag.process._control_snapshot_workbook(path.read_bytes())
            self.assertEqual(next(c for c in snapshot['controls'] if c['shapeId'] == '1028')['display'], '1张')
            return {'status': 'rendered', 'sourceWorkbookSha256': dag.sha(path), 'fixture': 'renderer boundary only; no visual claim'}
        with patch.object(dag.process, 'generate_process_requirements', side_effect=generate), \
                patch.object(dag.process, 'validate_process_requirements', return_value={'passed': True, 'checks': []}), \
                patch.object(dag.process, '_render', side_effect=render) as renderer:
            result = dag.generate_full_process({'packagePath': str(package), 'templatePath': str(dag.process.DEFAULT_TEMPLATE), 'render': True})
        renderer.assert_called_once()
        fields = dag.read(fields_path)
        self.assertEqual(fields['controlEdits']['1028'], {'sel': result['fullV2Adapter']['selectionIndex']})
        self.assertEqual(fields['nativeValidation'], result['validation'])
        self.assertEqual(dag.read(qa / 'validation.json'), result['validation'])
        self.assertEqual(fields['render']['sourceWorkbookSha256'], dag.sha(formal))
        self.assertEqual(result['artifacts'][0]['sha256'], dag.sha(formal))
        self.assertEqual(fields['unresolved'], unresolved)
        self.assertEqual(result['unresolved'], unresolved)
        self.assertEqual(Path(result['fullV2Adapter']['originalWorkbookPath']).read_bytes(), original)
        self.assertEqual(result['fullV2Adapter']['afterSha256'], dag.sha(formal))
        self.assertEqual(dag.process.DEFAULT_TEMPLATE.read_bytes(), original)

    def test_final_assembly_requires_current_human_gates_and_preserves_sop_body_and_wiring(self):
        facts = self.facts_receipt()
        reports = {'legacy': self.report('final-legacy'), 'modern': self.report('final-modern', family='v3'), 'c61': self.report('final-c61', target='esp32c61')}
        with patch.object(dag, '_validate_build', side_effect=self.compiled):
            aggregate, checked, _ = dag.aggregate_builds(self.facts, reports, self.root / 'aggregate-final')
            firm = self.emit('firmware-aggregate', dag._common(self.facts) | {'build': aggregate, 'verification': checked})
            sop_input = dag._sop_request(self.facts, aggregate, self.root / 'aggregate-final')
            sop_receipt = self.api.call('sop', {'facts': facts, 'firmware': firm, 'plan': dag.sop.default_plan(sop_input)})
        native_root = self.root / 'native-package'; native_root.mkdir()
        relative = '项目工程/BOARD_2026-10-25.epro2'; exported = native_root / relative; exported.parent.mkdir(); exported.write_bytes(self.source.read_bytes())
        preview = native_root / 'preview.png'; preview.write_bytes(b'fixture-review-image, not a real rendering')
        native_report = native_root / 'native-report.json'; dag.write(native_report, {'fixture': 'native validator is mocked'})
        native = self.emit('native', dag._common(self.facts) | {'native': {'reportPath': str(native_report)},
            'plan': {'packageName': 'BOARD_HDK_V1.0', 'paths': {'project': relative}}, 'packagePath': str(native_root),
            'reviewFiles': [dag.file_ref(preview)], 'proofFiles': dag.inventory(native_root)})
        process_root = self.root / 'process-package'; workbook = process_root / '生产资料/06_工艺要求/BOARD-1V0-20261025.xlsx'; workbook.parent.mkdir(parents=True); workbook.write_bytes(b'fixture workbook, independent validator mocked')
        proc = self.emit('process', dag._common(self.facts) | {'result': {'workbookPath': str(workbook)}, 'plan': {}, 'packagePath': str(process_root),
            'reviewFiles': [dag.file_ref(workbook)], 'proofFiles': dag.inventory(process_root)})
        manual_root = self.root / 'manual-package'; manual_dir = manual_root / '重要器件手册'; manual_dir.mkdir(parents=True)
        (manual_dir / 'fixture.pdf').write_bytes(b'%PDF-fixture; real business validator mocked')
        dag.write(manual_dir / '资料来源索引.json', {'sourceSha256': self.facts['sourceSha256'], 'documents': []})
        manuals = self.emit('datasheets', dag._common(self.facts) | {'packagePath': str(manual_root), 'proofFiles': dag.inventory(manual_root)})
        value = {'facts': facts, 'native': native, 'process': proc, 'firmware': firm, 'sop': sop_receipt, 'datasheets': manuals}
        with self.assertRaisesRegex(ValueError, 'human review'):
            self.api.call('verify', value)
        self.api.approved = {'native', 'process', 'sop'}
        native_check = {'coreStatus': 'complete', 'errors': [], 'artifacts': [{'kind': 'project', 'path': relative, 'sha256': dag.sha(exported)}]}
        with patch.object(dag, '_validate_build', side_effect=self.compiled), \
                patch.object(dag, 'verify_full_native', return_value=native_check), \
                patch.object(dag, 'validate_full_process', return_value={'passed': True, 'unresolved': dag._process_unresolved()}), \
                patch.object(dag.datasheets, 'verify', return_value={'status': 'complete', 'checks': {'fixture': True}}):
            result = self.api.call('verify', value)
        data = self.api.load(result, self.api.run, 'hdk.full.verify')
        self.assertTrue(data['qualified']); self.assertEqual(result['physicalTestStatus'], 'not-run')
        proof = dag.read(data['reportPath']); self.assertTrue(proof['sopRelocation']['bodyAndWiringUnchanged'])
        self.assertEqual(proof['unresolved'][0]['field'], 'fabricatorStackupAndCoupon')
        self.assertEqual(proof['unresolved'][0]['branch'], 'process')
        self.assertEqual(result['unresolved'], proof['unresolved'])
        self.assertFalse(result['releaseQualified'])
        self.assertEqual(set(self.api.reviewed), {'native', 'process', 'sop'})
        self.assertEqual(dag.sop_v2.verify(proof['sop']['markdownPath'], result['packagePath'])['status'], 'complete')
        self.assertLess(len(json.dumps(result).encode()), 60000)
        source_sop = self.api.load(sop_receipt, self.api.run, 'hdk.full.sop')
        before, after = Path(source_sop['rendered']['markdownPath']), Path(proof['sop']['markdownPath'])
        self.assertEqual(dag._sop_semantics(before.read_text()), dag._sop_semantics(after.read_text()))
        self.assertEqual(dag.sha(before.parent / 'images/wiring.svg'), dag.sha(after.parent / 'images/wiring.svg'))
        comparison = result['learningComparison']
        self.assertEqual(set(comparison['plans']), {'export', 'process', 'firmware', 'sop'})
        self.assertEqual(comparison['plans']['firmware'], aggregate['profile'])
        self.assertEqual(comparison['factsSummary']['sourceSha256'], self.facts['sourceSha256'])
        self.assertEqual(comparison['artifactInventory']['fileCount'], len(proof['artifacts']))
        self.assertFalse(comparison['releaseQualified']); self.assertFalse(comparison['legacyGateInherited'])
        self.assertEqual(comparison['verificationEvidence'][0]['sha256'], dag.sha(data['reportPath']))
        # A huge real inventory stays in its report; it must not expand the
        # controller JSON or accidentally include all raw component facts.
        large_facts = copy.deepcopy(self.facts)
        large_facts['boardFacts']['board']['components'] = [{'expectedAnswer': 'evaluator-only-secret' * 10000}]
        parents = {key: self.api.load(value[key], self.api.run, 'hdk.full.' + action) for key, action in
            [('native', 'native'), ('process', 'process'), ('firmware', 'firmware-aggregate'), ('sop', 'sop'), ('datasheets', 'datasheets')]}
        large = dag.learning_comparison(large_facts, parents, result['qualitySummary'], proof['artifacts'] * 1000,
            Path(data['reportPath']), Path(result['packagePath']))
        self.assertLess(len(json.dumps(large).encode()), 20000)
        self.assertLessEqual(len(large['artifactInventory']['samplePaths']), 24)
        self.assertNotIn('evaluator-only-secret', json.dumps(large))
        self.api.run['learningId'] = 'full-learning-fixture'
        with patch.object(dag, '_validate_build', side_effect=self.compiled), \
                patch.object(dag, 'verify_full_native', return_value=native_check), \
                patch.object(dag, 'validate_full_process', return_value={'passed': True, 'unresolved': dag._process_unresolved()}), \
                patch.object(dag.datasheets, 'verify', return_value={'status': 'complete', 'checks': {'fixture': True}}):
            candidate = self.api.call('verify', value)
        self.assertEqual(candidate['status'], 'learning-candidate')
        self.assertTrue(candidate['qualified']); self.assertFalse(candidate['releaseQualified'])
        candidate_data = self.api.load(candidate, self.api.run, 'hdk.full.verify')
        candidate_proof = dag.read(candidate_data['reportPath'])
        self.assertEqual(candidate_proof['status'], 'learning-candidate')
        self.assertEqual(candidate_proof['qualificationScope'], 'current-run-engineering-artifacts')
        self.assertFalse(candidate_proof['releaseQualified'])
        self.assertEqual(candidate['learningComparison']['plans'], comparison['plans'])
        self.assertEqual(candidate['learningComparison']['qualitySummary'], comparison['qualitySummary'])
        self.assertLess(len(json.dumps(candidate).encode()), 60000)
        with patch.object(dag, '_validate_build', side_effect=ValueError('corrupt actual ELF')):
            with self.assertRaisesRegex(ValueError, 'corrupt actual ELF') as failure:
                self.api.call('verify', value)
        self.assertNotIsInstance(failure.exception, InvalidLearningPlan)

    def fixture_sop_request(self):
        # Disk fixtures use the exact audited drivers, not a compiler or board.
        locations = {3:'J3.17',4:'J3.18',5:'J3.19',6:'J3.20',9:'J3.21',10:'J3.22',11:'J3.23',
            20:'J3.24',21:'J3.25',22:'J3.26',23:'J3.27',26:'J4.18',27:'J4.17',28:'J4.16',29:'J4.15',
            30:'J4.19',31:'J4.14',32:'J4.20',33:'J4.21',45:'J4.7',46:'J4.6',47:'J4.5',48:'J4.4',49:'J4.3',50:'J4.2'}
        board = copy.deepcopy(self.board)
        board['board'].update(modulePart='WT01P461-S1', moduleRef='U1', components=[{'designator':'U1', 'pins':
            [{'name':name, 'net':net} for name,net in [('C61_U0RXD','link-tx'),('IO54','link-tx'),
                ('C61_U0TXD','link-rx'),('IO53','link-rx'),('C61_EN','reset'),('IO52','reset'),
                ('C61_IO9','boot'),('IO2','boot')] + [('C61_IO'+str(g),'C61_IO'+str(g)) for g in (0,1,5,6)]]}])
        headers = {'J3':[], 'J4':[]}
        for gpio,pin in locations.items():
            designator,pad = pin.split('.')
            headers[designator].append({'pad':pad,'gpio':gpio,'net':'IO'+str(gpio)})
        headers['J3'] += [{'pad':str(pad), 'gpio':None, 'net':'C61_IO'+str(gpio)} for gpio,pad in ((0,10),(1,11),(5,13),(6,14))]
        board['peripherals'] = {'headers':[{'designator':key,'pins':pins} for key,pins in headers.items()],
            'rgb':None,'buttons':[],'sd':None,'camera':None}
        area = self.root / 'fixture-sop-package'; area.mkdir()
        def build(name,target,design,config,prefix,count,asset):
            folder = area / name; source = folder / 'source'; main = source / 'main'; main.mkdir(parents=True)
            pairs = [{'output':row['output'],'input':row['input']} for row in design['connections']]
            (main / 'main.c').write_bytes(asset.read_bytes())
            (main / config).write_text(f'#define {count} {len(pairs)}\n' +
                f'static const int {prefix}_out[] = {{'+','.join(str(p['output']) for p in pairs)+'};\n'+
                f'static const int {prefix}_in[] = {{'+','.join(str(p['input']) for p in pairs)+'};\n')
            current = {'target':target, 'sourceDir':str(source),'artifactRoot':str(folder),
                'manifestPath':str(folder/'firmware-manifest.json'), 'boardSourceSha256':board['source']['sha256'],
                'profile':{'fixturePairs':pairs}, 'fixtureDesign':design,
                'artifacts':[dict(dag.file_ref(p),role='source') for p in sorted(main.iterdir())]}
            dag.write(current['manifestPath'],current)
            return current
        report = build('p4','esp32p4',dag.firmware.design_fixture(board),'hdk_board_config.h','hdk_fixture','HDK_FIXTURE_COUNT',dag.firmware.ASSETS/'main/main.c')
        child = build('c61','esp32c61',dag.companion.fixture_design(board),'companion_config.h','hdk_c61_fixture','HDK_C61_FIXTURE_COUNT',dag.companion.ASSETS/'main/main.c')
        report['companion'] = {'manifestPath':child['manifestPath']}
        report['tests'] = [{'id':'gpio-loopback'},{'id':'companion-gpio-loopback'}]
        return {'boardFacts':board,'firmware':report,'packagePath':str(area)}

    def test_sop_binds_actual_compiled_pairs_and_expands_shared_group_without_safety_claims(self):
        request = self.fixture_sop_request()
        contract = dag.sop_v2.fixture_contract(request)
        p4,c61 = contract['branches']
        self.assertEqual((p4['pairCount'],p4['gpioCount'],p4['electricalGroupCount'],p4['readbackCount']),(13,25,12,52))
        self.assertEqual((c61['pairCount'],c61['gpioCount'],c61['electricalGroupCount'],c61['readbackCount']),(2,4,2,8))
        self.assertEqual(p4['groups'][0],[3,4,5])
        text = dag.sop_v2._fixture_markdown(contract)
        self.assertIn('J3.17 / IO3 / GPIO3 | J3.18 / IO4 / GPIO4',text)
        self.assertIn('J3.18 / IO4 / GPIO4 | J3.19 / IO5 / GPIO5',text)
        self.assertIn('同一电气组，禁止当作独立回路',text)
        self.assertIn('本资料不宣称带电插拔已验证安全',text)
        self.assertIn('隔离状态下的启动FAIL不是正式治具判定',text)
        self.assertIn('gpio_reset_pin不等同全脚输入',text)
        self.assertIn('应用hello不证明已执行该初始化',text)
        self.assertNotIn('断电按profile',text)
        self.assertEqual(len(contract['sourceEvidence']),6)
        steps = dag.sop_v2._operator_steps({'id':'companion-link'},contract)['operatorSteps']
        self.assertIn('不闭合治具',steps[-1])
        self.assertNotIn('c61-fixture',' '.join(steps))

    def test_sop_rejects_equal_coverage_with_different_pair_topology(self):
        request = self.fixture_sop_request()
        # Same 25 GPIO coverage is insufficient: swap two receiving endpoints.
        pairs = request['firmware']['profile']['fixturePairs']
        pairs[2]['input'],pairs[3]['input'] = pairs[3]['input'],pairs[2]['input']
        with self.assertRaisesRegex(ValueError,'配对.*fixtureDesign'):
            dag.sop_v2.fixture_contract(request)

    def test_sop_rejects_rehashed_config_or_driver_changes(self):
        request = self.fixture_sop_request(); report = request['firmware']
        config = Path(report['sourceDir']) / 'main/hdk_board_config.h'
        original = config.read_text(); config.write_text(original.replace('{4,5,9,','{5,4,9,'))
        for item in report['artifacts']:
            if item['path'] == str(config): item.update(dag.file_ref(config))
        with self.assertRaisesRegex(ValueError,'逐对拓扑.*实际编译数组'):
            dag.sop_v2.fixture_contract(request)
        config.write_text(original)
        for item in report['artifacts']:
            if item['path'] == str(config): item.update(dag.file_ref(config))
        source = Path(report['sourceDir'])/'main/main.c'; source.write_text(source.read_text()+'\n/* changed audited timing */\n')
        for item in report['artifacts']:
            if item['path'] == str(source): item.update(dag.file_ref(source))
        with self.assertRaisesRegex(ValueError,'驱动源码已变化'):
            dag.sop_v2.fixture_contract(request)

    def test_sop_rejects_wrong_connector_net_and_renders_real_readable_fixture_png(self):
        request = self.fixture_sop_request(); contract = dag.sop_v2.fixture_contract(request)
        svg = self.root/'fixture.svg'; png = self.root/'fixture.png'
        svg.write_text(dag.sop_v2.diagram('BOARD',contract)); dag.sop_v2.render_png(svg,png)
        from PIL import Image
        with Image.open(png) as image:
            self.assertEqual(image.size,(1600,1158))
        self.assertIn('三针共线 / 两个测试对',svg.read_text())
        self.assertIn('共享端点',svg.read_text())
        self.assertIn('marker-start="url(#arrow)"',svg.read_text())
        self.assertIn('GPIO6',svg.read_text()); self.assertIn('C61_IO6',svg.read_text())
        header = request['boardFacts']['peripherals']['headers'][0]
        next(p for p in header['pins'] if p['pad']=='17')['net']='WRONG'
        with self.assertRaisesRegex(ValueError,'连接器针号/网络不一致'):
            dag.sop_v2.fixture_contract(request)

    def test_private_sop_moves_complete_source_inventory_to_bound_appendix_and_rejects_tamper(self):
        reports = {'legacy':self.report('index-legacy'),'modern':self.report('index-modern',family='v3'),
            'c61':self.report('index-c61',target='esp32c61')}
        with patch.object(dag,'_validate_build',side_effect=self.compiled):
            report,_,_ = dag.aggregate_builds(self.facts,reports,self.root/'indexed-package')
        request = dag._sop_request(self.facts,report,self.root/'indexed-package')
        result = dag.sop_v2.render(request,self.root/'indexed-package/生产资料/07_测试说明',dag.sop.default_plan(request))
        self.assertEqual(result['status'],'complete')
        main = Path(result['markdownPath']); text = main.read_text(); index = main.parent/dag.sop_v2.INDEX_MD
        self.assertNotIn('source/main.c',text)
        self.assertIn('source/main.c',index.read_text())
        self.assertIn('构建附件索引 SHA-256：`'+dag.sha(index)+'`',text)
        inventory = json.loads((main.parent/dag.sop_v2.INDEX_JSON).read_text())
        self.assertEqual(len(inventory),len(report['artifacts']))
        index.write_text(index.read_text().replace('source/main.c','source/not-actual.c',1))
        checked = dag.sop_v2.verify(main,self.root/'indexed-package')
        self.assertEqual(checked['status'],'failed')
        self.assertTrue(any('完整附件索引' in error for error in checked['errors']))

    def test_sop_relocation_normalizer_does_not_hide_operator_or_topology_changes(self):
        first = '构建附件索引 SHA-256：`'+'a'*64+'`\n闭合GPIO3与GPIO4前等待READY\n'
        hashes_only = first.replace('a'*64,'b'*64)
        self.assertEqual(dag._sop_semantics(first),dag._sop_semantics(hashes_only))
        self.assertNotEqual(dag._sop_semantics(first),dag._sop_semantics(first.replace('GPIO4','GPIO5')))
        self.assertNotEqual(dag._sop_semantics(first),dag._sop_semantics(first.replace('等待READY','上电前')))


if __name__ == '__main__':
    unittest.main()
