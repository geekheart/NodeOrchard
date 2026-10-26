"""Focused native-template checks; no EDA/model calls and no golden-file writes."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

MODULE=Path(__file__).resolve().parents[1]/'hdk/process_requirements.py'
spec=importlib.util.spec_from_file_location('process_requirements',MODULE)
process=importlib.util.module_from_spec(spec);spec.loader.exec_module(process)

def make_source(path, *, width=50, height=30, component_count=6):
    """Artificial native records exercise geometry/stack parsing without user data."""
    rows = []
    def record(kind, data, ident=None):
        rows.append(({'type': kind, 'id': ident or str(len(rows)), 'ticket': 1}, data))
    record('DOCHEAD', {'docType': 'PCB', 'uuid': 'fixture-pcb'})
    layers = [(1, 'TOP'), (3, 'SIGNAL'), (4, 'PLANE'), (2, 'BOTTOM')]
    for layer, kind in layers:
        record('LAYER', {'layerId': layer, 'layerType': kind, 'layerName': kind, 'use': True})
    for index, (layer, mm) in enumerate([(1, .035), (3, .0175), (99, 1.495), (4, .0175), (2, .035)]):
        record('LAYER_PHYS', {'zIndex': index, 'thickness': mm / .0254,
                             'material': 'FR-4' if layer == 99 else 'Copper'}, json.dumps(['layer', layer]))
    points = [(0, 0), (width / .0254, 0), (width / .0254, height / .0254), (0, height / .0254), (0, 0)]
    for start, end in zip(points, points[1:]):
        record('LINE', {'layerId': 11, 'startX': start[0], 'startY': start[1], 'endX': end[0], 'endY': end[1]})
    record('LINE', {'layerId': 1, 'startX': 100, 'startY': 100, 'endX': 500, 'endY': 100,
                    'width': 6, 'netName': 'USB_DP'})
    for _ in range(component_count): record('COMPONENT', {'layerId': 1})
    record('DOCHEAD', {'docType': 'SCH_PAGE', 'uuid': 'fixture-sch'})
    record('ATTR', {'key': 'Version', 'value': 'V1.0'})
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('project2.json', json.dumps({'title': 'Synthetic manufacturing test', 'editorVersion': 'test'}))
        archive.writestr('fixture.epru', '\n'.join(json.dumps(a) + '||' + json.dumps(b) + '|' for a, b in rows))
    return path


def make_template(path):
    """Original OOXML fixture with 45 bound controls, VML and stale fallback text.

    These generated structures test preservation and independent rereads. They
    are deliberately minimal and never serve as a production form/template.
    """
    from xml.sax.saxutils import escape
    choices = {
        1029: ['单面', '4层', '双面'], 1031: ['0.5 oz', '1 oz', '2 oz'],
        1032: ['0.5 oz', '1 oz', '2 oz'], 1033: ['双面'], 1034: ['绿色', '哑光黑色'],
        1035: ['双面'], 1036: ['白色'], 1047: ['Gerber 文件'], 1049: ['FR-4'],
        1051: [''], 1052: ['按文件中说明要求'], 1059: ['年周', '周年'],
        1060: ['', '档案号', '防静电标'], 1069: ['Normal TG(130度以上'],
    }
    labels = {1042: '无铅喷锡', 1043: '电镀金', 1044: '化学沉金', 1045: '防氧化', 1046: '其他'}
    controls, relationships, vml, drawing, props, options = [], [], [], [], {}, []
    for index, shape in enumerate(number for number in range(1025, 1074) if number not in (1028, 1030, 1050, 1061)):
        anchor = '<anchor><from><col>2</col><colOff>0</colOff><row>{0}</row><rowOff>0</rowOff></from><to><col>8</col><colOff>0</colOff><row>{1}</row><rowOff>0</rowOff></to></anchor>'.format(index, index + 1)
        controls.append(f'<control shapeId="{shape}" r:id="rId{shape}"><controlPr>{anchor}</controlPr></control>')
        relationships.append(f'<Relationship Id="rId{shape}" Target="../ctrlProps/ctrlProp{shape}.xml" Type="http://schemas.microsoft.com/office/2006/relationships/ctrlProp"/>')
        label = escape(labels.get(shape, 'Fixture option ' + str(shape)))
        kind = 'Drop' if shape in choices else 'CheckBox'
        state, formula = '', ''
        if shape in choices:
            first = len(options) + 1
            options.extend(choices[shape])
            formula = f'<x:FmlaRange>Options!$A${first}:$A${len(options)}</x:FmlaRange>'
            state = '<x:Sel>1</x:Sel>'
        props[f'xl/ctrlProps/ctrlProp{shape}.xml'] = f'<formControlPr xmlns="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" objectType="{kind}"' + (' sel="1"' if shape in choices else '') + '/>'
        vml.append(f'<v:shape id="_x0000_s{shape}"><v:textbox><div>{label}</div></v:textbox><x:ClientData ObjectType="{kind}">{formula}{state}</x:ClientData></v:shape>')
        drawing.append(f'<mc:AlternateContent><mc:Choice Requires="xdr"><xdr:twoCellAnchor><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="{shape}" name="Stale fallback {shape}"/></xdr:nvSpPr></xdr:sp></xdr:twoCellAnchor></mc:Choice></mc:AlternateContent>')
    option_rows = ''.join(f'<row r="{i}"><c r="A{i}" t="inlineStr"><is><t>{escape(value)}</t></is></c></row>' for i, value in enumerate(options, 1))
    sheet_rows = ''.join(f'<row r="{i}"></row>' for i in range(1, 40))
    package = {
        'xl/workbook.xml': f'<workbook xmlns="{process.MAIN}" xmlns:r="{process.REL}"><sheets><sheet name="Manufacturing fixture" sheetId="1" r:id="rId1"/><sheet name="Options" sheetId="2" r:id="rId2"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{process.MAIN}" xmlns:r="{process.REL}"><sheetData>{sheet_rows}</sheetData><legacyDrawing r:id="vml"/><controls>{"".join(controls)}</controls></worksheet>',
        'xl/worksheets/sheet2.xml': f'<worksheet xmlns="{process.MAIN}"><sheetData>{option_rows}</sheetData></worksheet>',
        'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join(relationships) + '</Relationships>',
        'xl/drawings/vmlDrawing1.vml': '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel">' + ''.join(vml) + '</xml>',
        'xl/drawings/drawing1.xml': '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' + ''.join(drawing) + '</xdr:wsDr>',
        'xl/styles.xml': f'<styleSheet xmlns="{process.MAIN}"/>',
        'xl/media/image1.png': b'synthetic stale diagram; never current-source output',
        **props,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, 'w') as archive:
        for member, value in package.items(): archive.writestr(member, value)
    return path


class NativeRecordTests(unittest.TestCase):
    def test_empty_payload_is_a_ticketed_tombstone(self):
        with tempfile.TemporaryDirectory()as tmp:
            source=Path(tmp)/'t.epro2'
            lines=[({'type':'DOCHEAD','ticket':1},{'docType':'PCB','uuid':'p'}),
                   ({'type':'COMPONENT','id':'c','ticket':2},{'layerId':1}),
                   ({'type':'COMPONENT','id':'c','ticket':3},None)]
            with zipfile.ZipFile(source,'w')as z:
                z.writestr('project2.json','{"title":"test"}')
                z.writestr('p.epru','\n'.join(json.dumps(a)+'||'+(json.dumps(b)if b is not None else'')+'|'for a,b in lines))
            _,docs=process._records(source)
            self.assertFalse(any(a['type']=='COMPONENT'for a,b in docs[0]['records']))

    def test_profile_cannot_override_geometry_or_supply_invalid_dates(self):
        with self.assertRaises(ValueError):process._profile({'layerCount':2})
        with self.assertRaises(ValueError):process._profile({'deliveryDate':'2026-99-99'})
        with self.assertRaises(ValueError):process._profile({'electricalTest':'yes'})


class ProcessTemplateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory(prefix='hdk-process-test-')
        root=Path(cls.tmp.name)
        cls.source=make_source(root/'source.epro2')
        cls.case=root/'reference'
        cls.template=make_template(cls.case/'template.xlsx')
        cls.params={'sourcePath':str(cls.source),'templatePath':str(cls.template),'packagePath':str(root/'output'),'productCode':'FIXTURE-BOARD',
                    'hardwareVersion':'V1.0','releaseDate':'2026-10-24','render':False,
                    'profile':{'schemaVersion':1,'impedanceTargets':[{'name':'USB','netPattern':'USB','kind':'differential','targetOhms':90,'tolerancePercent':10}]}}
        # Artifact Tool authoring is an external boundary; keep all native XML,
        # image, geometry, selector and independent validation paths real.
        cls.author=patch.object(process,'_author_cells',side_effect=lambda template,values,qa,params:dict(values))
        cls.author.start()
        try:cls.result=process.generate_process_requirements(cls.params)
        except Exception:
            cls.author.stop();cls.tmp.cleanup();raise
        cls.workbook=Path(cls.result['workbookPath'])
        cls.base=cls.workbook.read_bytes()

    @classmethod
    def tearDownClass(cls):cls.author.stop();cls.tmp.cleanup()

    def validation(self,data):
        target=Path(self.tmp.name)/'changed.xlsx';target.write_bytes(data)
        return process.validate_process_requirements({**self.params,'workbookPath':str(target)})

    def modified(self,member,fn):
        out=io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(self.base))as source,zipfile.ZipFile(out,'w')as target:
            for n in source.namelist():target.writestr(n,fn(source.read(n))if n==member else source.read(n))
        return out.getvalue()

    def test_synthetic_source_has_six_components_and_four_layers(self):
        facts=process.prepare_process_request(self.params)['facts']
        self.assertEqual((facts['componentCount'],facts['layerCount'],facts['versions']),(6,4,['V1.0']))
        self.assertAlmostEqual(facts['widthMm'],50,places=6)
        self.assertAlmostEqual(facts['heightMm'],30,places=5)

    def test_all_native_bindings_survive_and_image_is_current(self):
        result=self.validation(self.base)
        self.assertTrue(result['passed'],result['checks'])
        z,sheets=process._xlsx_read(self.base);controls,_=process._template_controls(z,sheets)
        self.assertEqual(len(controls),45)
        self.assertEqual([s['name']for s in sheets],['Manufacturing fixture','Options'])
        self.assertEqual(sheets[0]['values']['E13'],50)

    def test_print_snapshot_reads_all_current_controls_without_mutating_native_xlsx(self):
        before=self.workbook.read_bytes()
        preview,manifest=process._control_snapshot_workbook(before)
        self.assertEqual(self.workbook.read_bytes(),before)
        self.assertEqual(manifest['controlCount'],45)
        self.assertEqual(manifest['sourceWorkbookSha256'],process._sha(before))
        entries={c['shapeId']:c for c in manifest['controls']}
        self.assertEqual(entries['1029']['display'],'4层')
        self.assertEqual(entries['1034']['display'],'哑光黑色')
        self.assertEqual(entries['1042']['display'],'[x] 无铅喷锡')
        self.assertEqual(entries['1044']['display'],'[ ] 化学沉金')
        self.assertTrue(all(c['display'] and c['from'] and c['to'] for c in manifest['controls']))
        z,sheets=process._xlsx_read(preview)
        self.assertEqual(len(sheets),2)
        self.assertNotIn(b'<legacyDrawing',z.read(sheets[0]['member']))
        self.assertNotIn(b'<controls>',z.read(sheets[0]['member']))
        book=process.ET.fromstring(z.read('xl/workbook.xml'))
        source_sheet=book.findall('s:sheets/s:sheet',process.NS)[1]
        self.assertEqual(source_sheet.attrib['state'],'hidden')
        self.assertIn('原生控件发布快照',z.read('xl/drawings/drawing1.xml').decode())
        formal,formal_sheets=process._xlsx_read(before)
        self.assertEqual(len(process._template_controls(formal,formal_sheets)[0]),45)

    def test_snapshot_uses_current_ctrlprops_instead_of_stale_fallback_or_profile(self):
        z,sheets=process._xlsx_read(self.base);controls,_=process._template_controls(z,sheets)
        changed=self.modified(controls['1029']['member'],lambda b:process._attr(b.decode(),'sel',3).encode())
        _,manifest=process._control_snapshot_workbook(changed)
        layer=next(c for c in manifest['controls'] if c['shapeId']=='1029')
        self.assertEqual(layer['display'],'双面')
        self.assertEqual(layer['value'],'双面')

    def test_geometry_tampering_fails_independent_reread(self):
        changed=self.modified('xl/worksheets/sheet1.xml',lambda b:process._replace_cell(b.decode(),'E13',999).encode())
        result=self.validation(changed)
        self.assertFalse(result['passed'])
        self.assertFalse(next(c for c in result['checks']if c['name']=='actual-outline-width')['passed'])

    def test_layer_control_tampering_fails_even_with_valid_choices(self):
        z,sheets=process._xlsx_read(self.base);controls,_=process._template_controls(z,sheets)
        member=controls['1029']['member']
        changed=self.modified(member,lambda b:process._attr(b.decode(),'sel',3).encode())
        result=self.validation(changed)
        self.assertFalse(result['passed'])
        self.assertFalse(next(c for c in result['checks']if c['name']=='layer-control-matches-source')['passed'])

    def test_reusing_golden_picture_is_detected(self):
        with zipfile.ZipFile(self.template)as z:golden=z.read('xl/media/image1.png')
        result=self.validation(self.modified('xl/media/image1.png',lambda _:golden))
        self.assertFalse(result['passed'])
        self.assertFalse(next(c for c in result['checks']if c['name']=='case-picture-not-reused')['passed'])

    def test_profile_copper_conflict_is_rejected(self):
        facts,records,outlines=process._source_data(self.source)
        z,sheets=process._xlsx_read(self.template.read_bytes());controls,_=process._template_controls(z,sheets)
        p=process._profile({'outerCopperOz':2})
        with self.assertRaises(ValueError):process._edit_plan(facts,p,'FIXTURE-BOARD','V1.0','2026-10-24',controls,[])

    def test_golden_package_cannot_be_output_even_with_overwrite(self):
        with self.assertRaisesRegex(ValueError,'read-only'):
            process.generate_process_requirements({**self.params,'packagePath':str(self.case),'overwrite':True})

    def test_second_source_prepare_reads_distinct_facts_without_creating_package(self):
        output=Path(self.tmp.name)/'second-not-executed'
        source=make_source(Path(self.tmp.name)/'second.epro2',width=72.5,height=34.25,component_count=8)
        result=process.prepare_process_request({**self.params,'sourcePath':str(source),'productCode':'SECOND-BOARD','packagePath':str(output)})
        facts=result['facts']
        self.assertEqual((facts['componentCount'],facts['layerCount'],facts['versions']),(8,4,['V1.0']))
        self.assertAlmostEqual(facts['widthMm'],72.5,places=5)
        self.assertAlmostEqual(facts['heightMm'],34.25,places=5)
        self.assertFalse(output.exists())


if __name__=='__main__':unittest.main()
