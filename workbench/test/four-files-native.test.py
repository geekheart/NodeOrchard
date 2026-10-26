"""Native export safety/receipts, without launching or editing EDA."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('four_files_native_test', Path(__file__).resolve().parents[1] / 'hdk/four_files_native.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def archive():
    body = '\n'.join('{"type":"DOCHEAD"}||' + json.dumps({'docType': kind, 'uuid': uid}) + '|'
        for kind, uid in [('PCB', 'pcb-source'), ('SCH_PAGE', 'sch-source')])
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as target:
        target.writestr('project2.json', '{"title":"Original source"}')
        target.writestr('source.epru', body)
    return out.getvalue()


def pdf():
    from pypdf import PdfWriter
    out = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=300, height=200)
    writer.write(out)
    return out.getvalue()


def undefined_font_pdf():
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import NameObject, DecodedStreamObject
    writer = PdfWriter()
    writer.clone_document_from_reader(PdfReader(io.BytesIO(pdf())))
    stream = DecodedStreamObject()
    stream.set_data(b'BT /undefined 12 Tf 10 20 Td (raw native low-byte text) Tj ET')
    writer.pages[0][NameObject('/Contents')] = writer._add_object(stream)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


STEP = b"""ISO-10303-21;
HEADER;
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
#1=MANIFOLD_SOLID_BREP('Board',#2);
#2=CLOSED_SHELL('',());
ENDSEC;
END-ISO-10303-21;
"""


class FakeNative:
    instances = []
    fail_kind = None
    wrong_project = False
    wrong_file_path = False
    mismatched_size = False
    changed_records = False
    changed_source = None
    def __init__(self, executable, evidence):
        self.evidence, self.session, self.uncertain, self.closed = evidence, 'owned-copy', False, False
        self.source_calls = {}
        self.calls = []
        type(self).instances.append(self)
    def open(self, path):
        self.copy = path
        return {'sessionId': self.session, 'importedProject': {'uuid': 'owned-project'}}
    def close(self):
        self.closed = True
        return {'sessionId': self.session, 'status': 'closed'}
    def invoke(self, args):
        self.calls.append(args)
        action = args['action']
        if action == 'inspect':
            return {'project': {'uuid': 'different-project' if self.wrong_project else 'owned-project'},
                'pcbs': [{'uuid':'pcb-source'}], 'pages':[{'uuid':'sch-source'}], 'pcbNativeReady': True}
        if action == 'source':
            uid = args['documentUuid']
            self.source_calls[uid] = self.source_calls.get(uid, 0) + 1
            extra = '\n{"type":"LINE","id":"route"}||{"x":2}|' if self.changed_records and self.source_calls[uid] > 1 else ''
            return {'source': '{"type":"DOCHEAD"}||' + json.dumps({'uuid':uid,'docType':args['documentType']}) + '|' + extra}
        if action == 'export':
            if self.changed_source:
                self.changed_source.write_bytes(b'changed original source')
            if self.fail_kind == args['kind']:
                raise module.Blocked('native capability unavailable')
            data = STEP if args['kind'] == 'step' else pdf()
            Path(args['outputPath']).write_bytes(data)
            return {'file': {'path': '/wrong/receipt' if self.wrong_file_path else args['outputPath'],
                'bytes': len(data) + int(self.mismatched_size), 'name': 'native export'},
                'exportOptions': {'autoGenerateModels': False} if args['kind'] == 'step' else {}}
        raise AssertionError(args)


class NativeExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'input.epro2'
        self.source.write_bytes(archive())
        self.request = {'sourcePath':str(self.source), 'outputParent':str(self.root),
            'productCode':'WT9932P4C61-TINY','hardwareVersion':'1.0','releaseDate':'2026-10-24'}
        for key, value in {'instances':[], 'fail_kind':None, 'wrong_project':False, 'wrong_file_path':False,
            'mismatched_size':False, 'changed_records':False, 'changed_source':None}.items():
            setattr(FakeNative,key,value)
        self.mock = patch.object(module, 'Native', FakeNative)
        self.mock.start()
        self.addCleanup(self.mock.stop)
        self.addCleanup(self.temp.cleanup)
    def test_preflight_reads_only_and_does_not_create_or_open_anything(self):
        before = list(self.root.iterdir())
        result = module.export_native(self.request)
        self.assertEqual(result['status'],'preflight')
        self.assertIsNone(result['outputPath'])
        self.assertEqual(list(self.root.iterdir()),before)
        self.assertEqual(FakeNative.instances,[])
        self.assertEqual(result['names'], {'step':'WT9932P4C61-TINY_3D_V1.0.step','schematicPdf':'WT9932P4C61-TINY_SCH_V1.0.pdf'})
    def test_strict_request_refuses_path_injection_dates_and_wrong_contract(self):
        for change in ({'productCode':'../overwrite'},{'releaseDate':'2026-02-30'}, {'hardwareVersion':'1.0/escape'},
                {'sourcePath':None},{'extra':'not an approved capability'}):
            with self.subTest(change=change), self.assertRaises(module.Blocked):
                module.export_native(dict(self.request,**change))
        self.assertEqual(FakeNative.instances,[])
    def test_completed_exports_are_real_disk_files_with_case_names_and_immutable_sources(self):
        original = self.source.read_bytes()
        result = module.export_native(self.request,True)
        self.assertEqual(result['status'],'complete')
        self.assertEqual(self.source.read_bytes(),original)
        self.assertTrue(FakeNative.instances[-1].closed)
        self.assertTrue(result['checks']['originalSourceUnchanged'])
        self.assertTrue(result['checks']['inputCopyUnchanged'])
        self.assertTrue(all(item['recordsUnchanged'] for item in result['checks']['documentSource']))
        self.assertEqual({a['kind'] for a in result['artifacts']},{'step','schematicPdf'})
        for item in result['artifacts']:
            path = Path(item['path'])
            self.assertEqual(path.name,result['names'][item['kind']])
            self.assertEqual(module.core.digest(path.read_bytes()),item['sha256'])
            self.assertTrue(path.is_relative_to(Path(result['outputPath'])))
            self.assertTrue(item['checks']['passed'])
        persisted = json.loads(Path(result['reportPath']).read_text())
        self.assertEqual(persisted['status'],'complete')
        self.assertEqual(persisted['artifacts'],result['artifacts'])
    def test_every_execution_is_a_new_directory_and_existing_deliverables_are_untouched(self):
        first = module.export_native(self.request,True)
        sentinel = Path(first['outputPath']) / 'user-owned.txt'
        sentinel.write_text('keep')
        second = module.export_native(self.request,True)
        self.assertNotEqual(first['outputPath'],second['outputPath'])
        self.assertEqual(sentinel.read_text(),'keep')
    def test_wrong_project_is_blocked_before_any_export(self):
        FakeNative.wrong_project = True
        result = module.export_native(self.request,True)
        self.assertEqual(result['status'],'blocked')
        self.assertFalse(any(a['action']=='export' for a in FakeNative.instances[-1].calls))
        self.assertTrue(FakeNative.instances[-1].closed)
    def test_failed_step_keeps_independently_valid_pdf_and_a_blocked_receipt(self):
        FakeNative.fail_kind = 'step'
        result = module.export_native(self.request,True)
        self.assertEqual(result['status'],'blocked')
        self.assertEqual([a['kind'] for a in result['artifacts']],['schematicPdf'])
        self.assertTrue(FakeNative.instances[-1].closed)
        self.assertEqual(result['errors'][0]['kind'],'step')
    def test_original_source_or_effective_document_changes_never_pass(self):
        for attribute, value in [('changed_records',True),('changed_source',self.source)]:
            with self.subTest(attribute=attribute):
                self.source.write_bytes(archive())
                setattr(FakeNative,attribute,value)
                result = module.export_native(self.request,True)
                self.assertEqual(result['status'],'blocked')
                self.assertTrue(FakeNative.instances[-1].closed)
                setattr(FakeNative,attribute,False if attribute=='changed_records' else None)
    def test_native_receipt_cannot_claim_a_different_file_or_wrong_size(self):
        for attribute in ('wrong_file_path','mismatched_size'):
            with self.subTest(attribute=attribute):
                setattr(FakeNative,attribute,True)
                result = module.export_native(self.request,True)
                self.assertEqual(result['status'],'blocked')
                self.assertEqual(result['artifacts'],[])
                setattr(FakeNative,attribute,False)
    def test_step_requires_complete_exchange_sections_real_solid_and_valid_references(self):
        checked = module.validate_step(STEP)
        self.assertEqual(checked['solidCount'],1)
        self.assertEqual(checked['cadKernelReview'],'required')
        for bad in (b'not step', STEP.replace(b'END-ISO-10303-21;',b''), STEP.replace(b'#2);',b'#9);'),
                STEP.replace(b'MANIFOLD_SOLID_BREP',b'EMPTY'),STEP.replace(b'#2=CLOSED',b'#1=CLOSED')):
            with self.subTest(bad=bad),self.assertRaises(module.Blocked):
                module.validate_step(bad)
    def test_step_like_entity_reference_in_a_product_name_is_not_a_real_reference(self):
        checked = module.validate_step(STEP.replace(b"'Board'",b"'Board #999 says ''hello'''"))
        self.assertEqual(checked['entityCount'],2)

    def test_native_non_geometric_context_defect_is_visible_and_not_silently_repaired(self):
        native = STEP.replace(b'#2=CLOSED_SHELL', b"#3=DESIGN_CONTEXT('',#99,'design');\n#2=CLOSED_SHELL")
        checked = module.validate_step(native)
        self.assertFalse(checked['allReferencesComplete'])
        self.assertTrue(checked['geometryReferencesComplete'])
        self.assertEqual(checked['nativeMetadataWarnings'][0]['missingEntityId'],'99')
        self.assertEqual(checked['cadKernelReview'],'required')
        with self.assertRaises(module.Blocked):
            module.validate_step(native.replace(b'DESIGN_CONTEXT',b'PRODUCT_DEFINITION'))

    def calibration_fixture(self, drift=0, leftover=False):
        from PIL import Image, ImageDraw
        image_path = self.root / 'pcb-top.png'
        image = Image.new('RGB',(300,200),(20,20,20))
        image.save(image_path)
        def receipt(path):
            return {'path':str(path),'bytes':path.stat().st_size}
        final_path = Path(str(image_path)+'.after.png')
        final = image.copy()
        if leftover: final.putpixel((30,30),(250,0,0))
        final.save(final_path)
        raw = {'image':receipt(image_path),'finalImage':receipt(final_path),'markerFrame':'data','calibration':[],'pads':[]}
        for index, (x,y) in enumerate([(0,0),(100,100),(100,0),(0,100)]):
            point = {'x':x,'y':y,'componentId':'j1-id','parentComponentId':'j1-id','designator':'J1',
                'number':str(index+1),'net':f'IO{index}','primitiveId':f'j1-pad-{index}'}
            raw['pads'].append(point)
            marked = image.copy()
            pixel_x,pixel_y = 2*x+10+(drift if index==3 else 0),150-y
            draw = ImageDraw.Draw(marked)
            draw.line((pixel_x-3,pixel_y,pixel_x+3,pixel_y),fill=(255,0,0))
            draw.line((pixel_x,pixel_y-3,pixel_x,pixel_y+3),fill=(255,0,0))
            path = Path(str(image_path)+f'.control-{index}.png')
            marked.save(path)
            raw['calibration'].append({'point':point,'image':receipt(path)})
        return raw,image_path

    def test_native_image_mapping_uses_three_measured_points_and_an_independent_fourth(self):
        raw,path = self.calibration_fixture()
        evidence = module._pinout_evidence(raw,'source-sha','pcb-source',path)
        self.assertEqual(evidence['worldToPixel'],[2,0,0,-1,10,150])
        self.assertEqual(evidence['coordinateFrame'],'pcb-data-mil')
        self.assertEqual(evidence['calibration']['maxErrorPx'],0)
        self.assertEqual(evidence['calibration']['independentCheckCount'],1)
        self.assertTrue(evidence['calibration']['cleanImageRestored'])
        self.assertEqual([p['number'] for p in evidence['componentPads'][0]['pads']],['1','2','3','4'])
        self.assertEqual(evidence['image']['sha256'],module.core.digest(path.read_bytes()))

    def test_fourth_control_point_error_or_residual_marker_blocks_pinout_calibration(self):
        for options in ({'drift':3},{'leftover':True}):
            with self.subTest(options=options), self.assertRaises(module.Blocked):
                raw,path = self.calibration_fixture(**options)
                module._pinout_evidence(raw,'source-sha','pcb-source',path)

    def raster_native(self, blank=False, size=(1600,1200), zipped=False, alpha=False):
        from PIL import Image, ImageDraw
        image = Image.new('RGBA' if alpha else 'RGB',size,(255,255,255,0) if alpha else 'white')
        if not blank:
            drawing = ImageDraw.Draw(image)
            drawing.rectangle((50,50,size[0]-50,size[1]-50),outline='red',width=4)
            drawing.line((100,150,size[0]-100,size[1]-100),fill='green',width=4)
        out = io.BytesIO()
        image.save(out,format='PNG')
        data = out.getvalue()
        if zipped:
            out = io.BytesIO()
            with zipfile.ZipFile(out,'w') as archive_file:
                archive_file.writestr('actual-source-page.png',data)
            data = out.getvalue()
        class RasterNative:
            calls = []
            def invoke(self,args):
                self.calls.append(args)
                Path(args['outputPath']).write_bytes(data)
                return {'file':{'path':args['outputPath'],'bytes':len(data)},'exportOptions':{'fileType':'PNG'}}
        return RasterNative()

    def test_good_native_vector_pdf_is_not_rasterized_or_rewritten(self):
        native = self.raster_native()
        original = pdf()
        result, checks, transformation = module.export_pdf_with_fallback(native,original,
            pages=[{'uuid':'sch-source'}],bound_args={'expectedProjectUuid':'owned-project'},evidence=self.root)
        self.assertEqual(result,original)
        self.assertEqual(native.calls,[])
        self.assertIsNone(transformation)
        self.assertTrue(checks['fontAudit']['passed'])

    def test_undefined_font_uses_exact_native_page_pixels_preserving_original_vector_and_paper(self):
        native = self.raster_native(zipped=True)
        original = undefined_font_pdf()
        self.assertFalse(module.pdf_font_audit(original)['passed'])
        result, checks, transformation = module.export_pdf_with_fallback(native,original,
            pages=[{'uuid':'sch-source'}],bound_args={'expectedProjectUuid':'owned-project'},evidence=self.root)
        self.assertTrue(checks['fontAudit']['passed'])
        self.assertEqual(checks['fontAudit']['missingFontSelectionCount'],0)
        self.assertEqual(transformation['operation'],'nativeRasterFallback')
        self.assertTrue(transformation['imagePixelsUnchanged'])
        self.assertTrue(transformation['paperSizesUnchanged'])
        self.assertFalse(transformation['textReconstruction'])
        self.assertEqual(Path(transformation['originalVectorPath']).read_bytes(),original)
        self.assertEqual(transformation['pages'][0]['documentUuid'],'sch-source')
        self.assertEqual(transformation['pages'][0]['width'],1600)
        self.assertEqual(native.calls[0]['expectedProjectUuid'],'owned-project')
        self.assertEqual(native.calls[0]['documentUuid'],'sch-source')
        self.assertEqual(native.calls[0]['kind'],'schematicPng')
        self.assertEqual(transformation['visualCheckStatus'],'required')
        from pypdf import PdfReader
        page = PdfReader(io.BytesIO(result)).pages[0]
        self.assertEqual(list(page.mediabox),[0,0,300,200])

    def test_empty_or_low_resolution_native_page_never_becomes_a_successful_compatibility_pdf(self):
        for index, options in enumerate(({'blank':True},{'size':(300,200)})):
            evidence = self.root / str(index)
            evidence.mkdir()
            with self.subTest(options=options),self.assertRaises(module.Blocked):
                module.export_pdf_with_fallback(self.raster_native(**options),undefined_font_pdf(),
                    pages=[{'uuid':'sch-source'}],bound_args={},evidence=evidence)

    def test_native_png_transparency_is_preserved_as_lossless_pdf_soft_mask(self):
        result, checks, transformation = module.export_pdf_with_fallback(self.raster_native(alpha=True),undefined_font_pdf(),
            pages=[{'uuid':'sch-source'}],bound_args={},evidence=self.root)
        self.assertTrue(checks['fontAudit']['passed'])
        expected = transformation['pages'][0]['alphaPixelSha256']
        self.assertIsNotNone(expected)
        from pypdf import PdfReader
        image = next(iter(PdfReader(io.BytesIO(result)).pages[0]['/Resources']['/XObject'].values())).get_object()
        self.assertEqual(module.core.digest(image['/SMask'].get_object().get_data()),expected)

    def test_font_audit_checks_form_xobjects_as_well_as_page_content(self):
        from pypdf import PdfWriter
        from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject, ArrayObject, NumberObject
        writer = PdfWriter()
        page = writer.add_blank_page(width=300,height=200)
        form = DecodedStreamObject()
        form.set_data(b'BT /undefined 12 Tf (missing form font) Tj ET')
        form.update({NameObject('/Type'):NameObject('/XObject'),NameObject('/Subtype'):NameObject('/Form'),
            NameObject('/BBox'):ArrayObject([NumberObject(n) for n in [0,0,300,200]]),NameObject('/Resources'):DictionaryObject()})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/XObject'):DictionaryObject({NameObject('/Form1'):writer._add_object(form)})})
        content = DecodedStreamObject()
        content.set_data(b'q /Form1 Do Q')
        page[NameObject('/Contents')] = writer._add_object(content)
        out = io.BytesIO()
        writer.write(out)
        audit = module.pdf_font_audit(out.getvalue())
        self.assertFalse(audit['passed'])
        self.assertEqual(audit['missingFontSelectionCount'],1)
        self.assertIn('/Form1',audit['issues'][0]['location'])


if __name__ == '__main__':
    unittest.main()
