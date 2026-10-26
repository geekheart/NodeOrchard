import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('hdk_export', Path(__file__).resolve().parents[1] / 'hdk/exporter/export_hdk.py')
hdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hdk)

def zipped(entries):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        for name, data in entries.items(): z.writestr(name, data)
    return out.getvalue()

def workbook(headers):
    cells = ''.join(f'<c r="{chr(65+i)}1" t="inlineStr"><is><t>{v}</t></is></c>' for i, v in enumerate(headers))
    body = '<c r="A2"><v>1</v></c><c r="B2"><v>1</v></c><c r="D2" t="inlineStr"><is><t>J1</t></is></c>' if headers == hdk.BOM_HEADERS else '<c r="A2" t="inlineStr"><is><t>J1</t></is></c><c r="M2" t="inlineStr"><is><t>No</t></is></c>'
    sheet = f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">{cells}</row><row r="2">{body}</row></sheetData></worksheet>'
    return zipped({'xl/worksheets/sheet1.xml': sheet})

def pdf(assembly=False):
    from pypdf import PdfWriter
    writer = PdfWriter(); writer.add_blank_page(width=300, height=200)
    if assembly:
        writer.add_outline_item('顶面自动位号图', 0)
        writer.add_blank_page(width=300, height=200)
        writer.add_outline_item('底面自动位号图', 1)
    out = io.BytesIO(); writer.write(out); return out.getvalue()

def dxf(points=((0, 0), (1, 0), (1, 1), (0, 1)), closed=True, references=False):
    pairs = [(0, 'SECTION'), (2, 'ENTITIES'), (0, 'LWPOLYLINE'), (8, 'Board-Outline-Layer'), (90, len(points)), (70, int(closed))]
    for x, y in points: pairs.extend([(10, x), (20, y)])
    if references:
        pairs.extend([(0, 'LWPOLYLINE'), (8, 'Top-Layer'), (90, 4), (70, 1)])
        for x, y in ((0.4, 0.4), (0.6, 0.4), (0.6, 0.6), (0.4, 0.6)): pairs.extend([(10, x), (20, y)])
    pairs.extend([(0, 'ENDSEC'), (0, 'EOF')])
    return '\n'.join(str(v) for pair in pairs for v in pair).encode()

def canvas_snapshot(x=0, y=0):
    return {'canvasOrigin': {'offsetX': x, 'offsetY': y}, 'dataOriginOnCanvas': {'x': -x, 'y': -y}}

class EnvironmentNative(hdk.Native):
    """In-memory CLI protocol fixture; never starts an editor or creates a real project."""
    def __init__(self, root, environment):
        super().__init__('/fixture-no-executable', root / 'evidence')
        self.environment, self.calls, self.sessions, self.serial = environment, [], {}, 0

    def command(self, args, timeout=190):
        self.calls.append((args, timeout))
        if args == ['session', 'list']:
            return list(self.sessions.values())
        if args[0] == 'open':
            self.serial += 1; session = 'owned-fixture-' + str(self.serial)
            self.sessions[session] = {'sessionId': session, 'headless': True, 'origin': 'cli'}
            return {'sessionId': session}
        if args[:2] == ['session', 'close']:
            self.sessions.pop(args[args.index('--session') + 1]); return {}
        if args[0] == 'invoke':
            action = json.loads(args[args.index('--args') + 1])
            if action['action'] == 'environment': return self.environment
            if action['action'] == 'import':
                (Path(action['folderPath']) / 'fixture.eprj2').write_text('protocol-only fixture, not an EDA project')
                return {'uuid': 'owned-fixture-project'}
        raise AssertionError('Unexpected fixture command: ' + str(args))

class ExportSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.parent = Path(self.temp.name)
        self.source = self.parent / 'input.epro2'
        source = '\n'.join('{"type":"DOCHEAD"}||' + json.dumps({'docType': t, 'uuid': uid}) + '|' for t, uid in [('PCB', 'pcb-source'), ('SCH_PAGE', 'sch-source')])
        self.source.write_bytes(zipped({'project2.json': '{"title":"源工程"}', 'source.epru': source}))
        self.request = {'sourcePath': str(self.source), 'outputParent': str(self.parent), 'productCode': 'WT9932S31-TINY', 'hardwareVersion': 'V1.0', 'releaseDate': '2026-10-24'}
        self.request['plan'] = {'packageName': 'WT9932S31-TINY_HDK_V1.0', 'paths': hdk.expected_paths('WT9932S31-TINY', 'V1.0', '2026-10-24'), 'supplementalDirectories': ['重要器件手册', '生产资料/07_测试说明'], 'checks': {'stencilFromCurrentGerber': True, 'checkDocumentReferences': True, 'excludeOsMetadata': True, 'exportFromInputOnly': True}}

    def tearDown(self): self.temp.cleanup()

    def test_preflight_is_read_only_and_does_not_invoke_cli(self):
        before = self.source.read_bytes()
        report = hdk.export(self.request, executable='/not-a-cli')
        self.assertEqual(report['status'], 'preflight')
        self.assertEqual(self.source.read_bytes(), before)
        self.assertFalse(Path(report['outputPath']).exists())
        self.assertEqual(report['source']['pcb']['uuid'], 'pcb-source')
        self.assertTrue(report['missing'])

    def test_refuses_existing_package_to_protect_example(self):
        (self.parent / self.request['plan']['packageName']).mkdir()
        with self.assertRaisesRegex(hdk.Blocked, '已存在'): hdk.validate_request(self.request)

    def test_refuses_model_changing_a_single_target_path(self):
        self.request['plan']['paths']['gerber'] = '../golden.zip'
        with self.assertRaisesRegex(hdk.Blocked, '命名'): hdk.validate_request(self.request)

    def test_refuses_missing_provenance_checks(self):
        del self.request['plan']['checks']['exportFromInputOnly']
        with self.assertRaises(hdk.Blocked): hdk.validate_request(self.request)

    def test_refuses_invalid_dates_and_product_path_injection(self):
        self.request['releaseDate'] = '2026-02-30'
        with self.assertRaises(hdk.Blocked): hdk.validate_request(self.request)
        self.request['releaseDate'] = '2026-10-24'
        self.request['productCode'] = '../test'
        with self.assertRaises(hdk.Blocked): hdk.validate_request(self.request)

    def test_zip_crc_checks_and_traversal(self):
        archive = zipped({'safe.txt': 'abc'})
        audited = hdk.audit_zip(archive)
        self.assertEqual(audited[0]['sha256'], hdk.digest(b'abc'))
        with self.assertRaises(hdk.Blocked): hdk.audit_zip(zipped({'../outside': 'abc'}))

    def test_native_coordinates_retain_all_fifteen_columns_and_non_smd(self):
        checked = hdk.validate_file('pickPlace', workbook(hdk.PNP_HEADERS))
        self.assertEqual(checked['designators'], ['J1'])
        self.assertEqual(checked['nonSmdRows'], 1)
        self.assertEqual(len(checked['headers']), 15)

    def test_rejects_lossy_or_reordered_spreadsheet_columns(self):
        with self.assertRaises(hdk.Blocked): hdk.validate_file('pickPlace', workbook(hdk.PNP_HEADERS[:13]))
        with self.assertRaises(hdk.Blocked): hdk.validate_file('bom', workbook(hdk.BOM_HEADERS[::-1]))

    def test_rejects_empty_and_fake_deliverables(self):
        for kind, data in [('schematicPdf', b''), ('silkscreenPdf', b'%PDF-1.4 fake'), ('outlineDxf', b'not a DXF'), ('project', zipped({'test.txt': 'fake'}))]:
            with self.subTest(kind=kind), self.assertRaises(hdk.Blocked): hdk.validate_file(kind, data)

    def test_document_fingerprint_ignores_tickets_but_detects_route_changes(self):
        before = '{"type":"DOCHEAD","ticket":1}||{"uuid":"abc"}|\n{"type":"LINE","id":"r1","ticket":1}||{"x":1,"net":"GND"}|'
        timestamp = before.replace('"ticket":1', '"ticket":2')
        moved = before.replace('"x":1', '"x":2')
        self.assertEqual(hdk.stable_source(before), hdk.stable_source(timestamp))
        self.assertNotEqual(hdk.stable_source(before), hdk.stable_source(moved))

    def test_disk_verifier_reports_missing_files_instead_of_trusting_success(self):
        report = hdk.export(self.request)
        output = Path(report['outputPath']); output.mkdir()
        report['status'] = 'complete'
        report['checks']['originalSourceUnchanged'] = True
        file = self.parent / 'report.json'; file.write_text(json.dumps(report))
        checked = hdk.verify_report(file)
        self.assertEqual(checked['status'], 'blocked')
        self.assertEqual(checked['coreStatus'], 'blocked')
        self.assertGreaterEqual(len(checked['errors']), 7)

    def complete_report(self):
        report = hdk.export(self.request)
        output = Path(report['outputPath']); output.mkdir()
        gerber = zipped({'Gerber_TopPasteMaskLayer.GTP': 'TOP', 'Gerber_BottomPasteMaskLayer.GBP': 'BOTTOM'})
        data = {'gerber': gerber, 'bom': workbook(hdk.BOM_HEADERS), 'pickPlace': workbook(hdk.PNP_HEADERS), 'project': self.source.read_bytes(), 'schematicPdf': pdf(), 'silkscreenPdf': pdf(True), 'outlineDxf': dxf(references=True), 'topPaste': b'TOP', 'bottomPaste': b'BOTTOM'}
        for kind, content in data.items():
            file = output / report['plan']['paths'][kind]; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(content)
            report['artifacts'].append({'kind': kind, 'path': report['plan']['paths'][kind], 'bytes': len(content), 'sha256': hdk.digest(content), 'checks': {'passed': True}})
        evidence = self.parent / 'evidence'; evidence.mkdir()
        (evidence / 'outlineDxf.native').write_bytes(data['outlineDxf'])
        snap = '{"type":"COMPONENT","id":"c1"}||{"x":1}|\n{"type":"ATTR","id":"a1"}||{"parentId":"c1","key":"Designator","value":"J1"}|\n{"type":"ATTR","id":"a2"}||{"parentId":"c1","key":"Device","value":"dev1"}|\n{"type":"POLY","id":"outline"}||{"layerId":11,"path":["R",0,39.37,39.37,39.37,0,0]}|'
        for state in ('before', 'after'): (evidence / ('PCB-pcb-source-' + state + '.source')).write_text(snap)
        report['evidencePath'] = str(evidence)
        report['documents'] = [{'dochead': {'docType': 'PCB'}, **canvas_snapshot(), 'layers': [{'name': 'Board Outline Layer'}, {'name': 'Top Layer'}], 'componentPads': [{'designator': 'J1', 'componentId': 'c1', 'pads': [{'parentComponentId': 'c1', 'x': 19.685, 'y': 19.685}]}]}]
        report['checks']['documentSource'] = [{'uuid': 'pcb-source', 'docType': 'PCB', 'beforeSha256': hdk.digest(snap.encode()), 'afterSha256': hdk.digest(snap.encode())}]
        file = self.parent / 'report.json'; file.write_text(json.dumps(report))
        return report, output, file

    def test_independent_verifier_detects_stale_stencil_even_with_success_flags(self):
        report, output, file = self.complete_report()
        self.assertEqual(hdk.verify_report(file)['coreStatus'], 'complete')
        (output / report['plan']['paths']['topPaste']).write_bytes(b'OLD CASE TOP')
        checked = hdk.verify_report(file)
        self.assertEqual(checked['coreStatus'], 'blocked')
        self.assertTrue(any('topPaste' in error for error in checked['errors']))

    def test_os_metadata_is_recorded_and_excluded_without_deleting_or_failing_business_files(self):
        report, output, file = self.complete_report()
        before = self.source.read_bytes()
        metadata = ['.DS_Store', '生产资料/.DS_Store',
            '生产资料/07_测试说明/测试固件/project/managed_components/vendor/.DS_Store',
            '生产资料/07_测试说明/测试固件/project/managed_components/__MACOSX/vendor/source.c',
            '__MACOSX/nested/old.txt', 'nested/._sidecar']
        business = ['.gitignore', '.clangd/compile_flags.json', '.DS_Store.backup', '__MACOSX_project/source.c', 'node_modules/.cache/cache.data']
        for relative in metadata + business:
            path = output / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b'leave untouched')
        # A metadata record with a duplicate business kind cannot replace the
        # actual core manifest entry or increase its accepted artifact count.
        report['artifacts'].append({'kind': 'gerber', 'path': '__MACOSX/pretend-gerber.zip', 'checks': {'passed': True}})
        file.write_text(json.dumps(report))
        checked = hdk.verify_report(file)
        self.assertEqual(checked['coreStatus'], 'complete')
        self.assertEqual(checked['errors'], [])
        self.assertEqual(len(checked['artifacts']), 9)
        self.assertTrue(set(metadata).issubset(checked['excludedMetadata']))
        self.assertIn('__MACOSX/pretend-gerber.zip', checked['excludedMetadata'])
        self.assertTrue(set(business).isdisjoint(checked['excludedMetadata']))
        self.assertTrue(all(not hdk.is_os_metadata_path(a['path']) for a in checked['artifacts']))
        for relative in metadata + business: self.assertEqual((output / relative).read_bytes(), b'leave untouched')
        self.assertEqual(self.source.read_bytes(), before)

    def test_metadata_cannot_stand_in_for_a_missing_core_file(self):
        report, output, file = self.complete_report()
        gerber = next(a for a in report['artifacts'] if a['kind'] == 'gerber')
        original = output / gerber['path']
        metadata_path = output / 'nested/__MACOSX/current-Gerber.zip'
        metadata_path.parent.mkdir(parents=True); metadata_path.write_bytes(original.read_bytes()); original.unlink()
        report['artifacts'] = [a for a in report['artifacts'] if a['kind'] != 'gerber'] + [dict(gerber, path=metadata_path.relative_to(output).as_posix())]
        file.write_text(json.dumps(report))
        checked = hdk.verify_report(file)
        self.assertEqual(checked['coreStatus'], 'blocked')
        self.assertTrue(any(error.startswith('gerber:') for error in checked['errors']))
        self.assertFalse(any(a['kind'] == 'gerber' for a in checked['artifacts']))
        self.assertIn('nested/__MACOSX/current-Gerber.zip', checked['excludedMetadata'])
        self.assertTrue(metadata_path.is_file())

    def test_never_closes_reused_user_session(self):
        class Reused(hdk.Native):
            def __init__(self):
                super().__init__('/fake', self.parent if hasattr(self, 'parent') else Path('/tmp'))
                self.calls = []
            def command(self, args, timeout=190):
                self.calls.append(args)
                if args == ['session', 'list']: return [{'sessionId': 'user-session'}]
                if args[:1] == ['open']: return {'sessionId': 'user-session'}
                raise AssertionError('must not close/reuse user session')
        native = Reused()
        with self.assertRaises(hdk.Blocked): native.open(self.source)
        self.assertIsNone(native.session)
        self.assertIsNone(native.close())

    def test_online_or_web_import_fails_before_reading_or_importing_a_project(self):
        for environment in ({'isClient': True, 'isOnlineMode': True, 'isHalfOfflineMode': False, 'isOfflineMode': False},
                {'isClient': False, 'isHalfOfflineMode': True, 'isOfflineMode': False}, None):
            native = EnvironmentNative(self.parent, environment)
            with self.subTest(environment=environment), self.assertRaisesRegex(hdk.Blocked, r'\[environment\].*半离线.*全离线'):
                native.open(self.source)
            self.assertEqual(native.stage, 'environment')
            self.assertFalse((self.parent / 'native-project').exists())
            self.assertFalse(any(args[0] == 'invoke' and json.loads(args[args.index('--args') + 1])['action'] == 'import'
                for args, _ in native.calls))
            self.assertEqual(next(timeout for args, timeout in native.calls if args[0] == 'invoke'), 7)

    def test_half_and_full_offline_sessions_keep_the_owned_import_and_binding_lifecycle(self):
        for key in ('isHalfOfflineMode', 'isOfflineMode'):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory); source = root / 'input.epro2'; source.write_bytes(b'fixture')
                environment = {'isClient': True, 'isOnlineMode': False,
                    'isHalfOfflineMode': key == 'isHalfOfflineMode', 'isOfflineMode': key == 'isOfflineMode'}
                native = EnvironmentNative(root, environment); opened = native.open(source)
                self.assertEqual(opened['importEnvironment'], environment)
                self.assertEqual(opened['importedProject']['uuid'], 'owned-fixture-project')
                self.assertEqual(set(native.sessions), {opened['sessionId']})
                self.assertNotEqual(opened['sessionId'], opened['importSessionId'])
                native.close(); self.assertEqual(native.sessions, {})

    def test_environment_rpc_uses_a_short_timeout_and_preserves_an_uncertain_session(self):
        native = hdk.Native('/fixture-no-executable', self.parent); native.session = 'owned-fixture'
        with patch.object(hdk.subprocess, 'run', side_effect=hdk.subprocess.TimeoutExpired('fixture', 7)) as command:
            with self.assertRaisesRegex(hdk.Blocked, r'\[environment\].*超时'):
                native.invoke({'action': 'environment'})
            self.assertTrue(native.uncertain)
            self.assertIsNone(native.close())
            command.assert_called_once()
            self.assertEqual(command.call_args.kwargs['timeout'], 7)
            self.assertIn('5000', command.call_args.args[0])

    def test_rejects_bom_merging_distinct_device_uuids(self):
        raw = workbook(hdk.BOM_HEADERS)
        with zipfile.ZipFile(io.BytesIO(raw)) as z: sheet = z.read('xl/worksheets/sheet1.xml').decode()
        sheet = sheet.replace('<v>1</v></c><c r="D2"', '<v>2</v></c><c r="D2"').replace('>J1<', '>J1,J2<')
        data = zipped({'xl/worksheets/sheet1.xml': sheet})
        self.assertEqual(hdk.validate_file('bom', data)['designators'], ['J1', 'J2'])
        with self.assertRaisesRegex(hdk.Blocked, '不同器件'):
            hdk.check_bom_components(data, [{'designator': 'J1', 'device': {'uuid': {'uuid': 'one'}}}, {'designator': 'J2', 'device': 'two'}])

    def test_name_formulas_are_resolved_without_evaluation(self):
        self.assertEqual(hdk.resolved_name('={Value}', {'Value': '100nF'}), '100nF')
        self.assertEqual(hdk.resolved_name('={Manufacturer Part}', {'Manufacturer Part': 'PN123'}), 'PN123')
        with self.assertRaises(hdk.Blocked): hdk.resolved_name('={Missing}', {})
        with self.assertRaises(hdk.Blocked): hdk.resolved_name('=run()', {})

    def test_assembly_pages_follow_named_roles_instead_of_first_two(self):
        from pypdf import PdfWriter, PdfReader
        writer = PdfWriter()
        for i in range(4): writer.add_blank_page(width=100+i, height=100)
        writer.add_outline_item('底面自动位号图', 1)
        writer.add_outline_item('顶面自动位号图', 3)
        source = io.BytesIO(); writer.write(source)
        selected, audit = hdk.select_assembly_pdf(source.getvalue())
        self.assertEqual([d['nativePage'] for d in audit['selectedRoles']], [4, 2])
        self.assertEqual([float(p.mediabox.width) for p in PdfReader(io.BytesIO(selected)).pages], [103, 101])

    def test_no_bottom_stencil_requires_no_explicit_paste_layer(self):
        gerber = zipped({'top.GTP': 'real paste'})
        source = '{"type":"POLY","id":"paste"}||{"layerId":8}|'
        self.assertIsNone(hdk.bottom_paste_not_applicable(gerber, workbook(hdk.PNP_HEADERS), source))

    def test_dxf_requires_real_finite_two_dimensional_geometry(self):
        checked = hdk.validate_file('outlineDxf', dxf())
        self.assertEqual(checked['entityCount'], 1)
        self.assertEqual(checked['vertexCount'], 4)
        self.assertEqual(checked['vertexBoundsMm'], [0, 0, 1, 1])
        empty = b'0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF'
        for bad in [empty, dxf(((0, 0), (0, 0))), dxf(((0, 0), (1, 0))), dxf(((0, 0), (float('nan'), 1)))]:
            with self.subTest(data=bad), self.assertRaises(hdk.Blocked): hdk.validate_file('outlineDxf', bad)

    def test_dxf_geometry_must_match_the_current_source_outline(self):
        source = '{"type":"POLY","id":"outline"}||{"layerId":11,"path":["R",0,39.37,39.37,39.37,0,0]}|'
        self.assertTrue(hdk.check_dxf_source(dxf(), source)['passed'])
        with self.assertRaisesRegex(hdk.Blocked, '尺寸'):
            hdk.check_dxf_source(dxf(((0, 0), (2, 0), (2, 1), (0, 1))), source)
        source = '{"type":"POLY","id":"outline"}||{"layerId":11,"path":[0,0,"L",39.37,0,"L",39.37,39.37,"L",0,39.37]}|'
        self.assertTrue(hdk.check_dxf_source(dxf(), source)['passed'])
        with self.assertRaisesRegex(hdk.Blocked, '坐标'):
            hdk.check_dxf_source(dxf(((0, 0), (2, 0), (1, 1), (0, 1))), source)
        with self.assertRaisesRegex(hdk.Blocked, '实体数'):
            hdk.check_dxf_source(dxf(), '')

    def test_layered_dxf_counts_only_outline_and_preserves_current_connector_positions(self):
        source = '{"type":"COMPONENT","id":"c1"}||{"x":19.685,"y":19.685}|\n{"type":"ATTR","id":"ref"}||{"parentId":"c1","key":"Designator","value":"J1"}|\n{"type":"POLY","id":"outline"}||{"layerId":11,"path":["R",0,39.37,39.37,39.37,0,0]}|'
        document = {**canvas_snapshot(), 'layers': [{'name': 'Board Outline Layer'}, {'name': 'Top Layer'}], 'componentPads': [{'designator': 'J1', 'componentId': 'c1', 'pads': [{'parentComponentId': 'c1', 'x': 19.685, 'y': 19.685}]}]}
        data = dxf(references=True)
        geometry = hdk.validate_file('outlineDxf', data)
        self.assertEqual(geometry['entityCount'], 1)
        self.assertEqual(geometry['totalEntityCount'], 2)
        self.assertTrue(hdk.check_dxf_source(data, source)['passed'])
        references = hdk.check_dxf_references(data, source, document)
        self.assertEqual(references['componentCount'], 1)
        self.assertEqual(references['padCount'], 1)
        self.assertEqual(references['components'][0]['matchedLayers'], {'Top-Layer': 1})
        with self.assertRaisesRegex(hdk.Blocked, '只有板框'):
            hdk.check_dxf_references(dxf(), source, document)
        document['componentPads'][0]['pads'][0]['x'] = 999
        with self.assertRaisesRegex(hdk.Blocked, '焊盘位置'):
            hdk.check_dxf_references(data, source, document)
        document['componentPads'][0]['pads'][0]['parentComponentId'] = 'other-board-component'
        with self.assertRaisesRegex(hdk.Blocked, '归属'):
            hdk.check_dxf_references(data, source, document)

    def test_dxf_uses_the_bound_canvas_origin_for_outline_and_connector_locations(self):
        source = '\n'.join([
            '{"type":"CANVAS","id":"CANVAS"}||{"originX":100,"originY":200}|',
            '{"type":"COMPONENT","id":"c1"}||{"x":119.685,"y":219.685}|',
            '{"type":"ATTR","id":"ref"}||{"parentId":"c1","key":"Designator","value":"J1"}|',
            '{"type":"POLY","id":"outline"}||{"layerId":11,"path":["R",100,239.37,39.37,39.37,0,0]}|',
        ])
        document = {**canvas_snapshot(100, 200), 'layers': [{'name': 'Board Outline Layer'}, {'name': 'Top Layer'}],
            'componentPads': [{'designator': 'J1', 'componentId': 'c1', 'pads': [{'parentComponentId': 'c1', 'x': 119.685, 'y': 219.685}]}]}
        data = dxf(references=True)
        outline = hdk.check_dxf_source(data, source)
        self.assertEqual(outline['canvasOriginMil'], {'x': 100, 'y': 200})
        references = hdk.check_dxf_references(data, source, document)
        self.assertEqual(references['components'][0]['matchedPadCount'], 1)
        self.assertEqual(references['coordinateFrame'], 'native-canvas-origin')
        # Do not infer an arbitrary translation from the output bounds: a
        # changed PCB origin must fail against stale native geometry or getters.
        shifted_source = source.replace('"originX":100', '"originX":101')
        with self.assertRaisesRegex(hdk.Blocked, '尺寸'):
            hdk.check_dxf_source(data, shifted_source)
        with self.assertRaisesRegex(hdk.Blocked, '原点'):
            hdk.check_dxf_references(data, shifted_source, document)
        document['dataOriginOnCanvas']['x'] = 100
        with self.assertRaisesRegex(hdk.Blocked, '坐标转换'):
            hdk.check_dxf_references(data, source, document)

    def test_segmented_dxf_translation_is_bound_to_finite_unique_canvas_metadata(self):
        canvas = '{"type":"CANVAS","id":"CANVAS"}||{"originX":100,"originY":-200}|'
        source = canvas + '\n{"type":"POLY","id":"outline"}||{"layerId":11,"path":[100,-200,"L",139.37,-200,"L",139.37,-160.63,"L",100,-160.63]}|'
        self.assertTrue(hdk.check_dxf_source(dxf(), source)['passed'])
        with self.assertRaisesRegex(hdk.Blocked, '多个画布原点'):
            hdk.check_dxf_source(dxf(), source + '\n' + canvas)
        with self.assertRaisesRegex(hdk.Blocked, '有限坐标'):
            hdk.check_dxf_source(dxf(), source.replace('"originX":100', '"originX":null'))

if __name__ == '__main__': unittest.main()
