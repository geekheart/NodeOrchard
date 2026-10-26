"""Template adapter tests; all export subprocesses are mocked, never app exports."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote
import xml.etree.ElementTree as ET
import zlib

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from hdk import guide_drawio_template_v2 as adapter


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def make_template(path):
    """Small artificial structural fixture; never used as a production template."""
    root = ET.Element('mxfile', {'host': 'fixture', 'version': 'test'})
    page = ET.SubElement(root, 'diagram', {'id': 'original-page', 'name': '原始页面'})
    model = ET.SubElement(page, 'mxGraphModel', {'pageWidth': '1654', 'pageHeight': '1169', 'grid': '0'})
    cells = ET.SubElement(model, 'root')
    ET.SubElement(cells, 'mxCell', {'id': '0'})
    ET.SubElement(cells, 'mxCell', {'id': '1', 'parent': '0'})
    entries = [('core', '<font style="font-size:26px">ESP32S31</font><br><font style="font-size:13px">320MHz&nbsp;RISC-V</font>', 476, 433, 130, 130),
               ('controls', 'Reset and Boot Button', 337, 503, 85, 60),
               ('rgb', 'RGB-LED', 337, 433, 83, 60),
               ('usb-a', 'Full Speed USB', 656, 433, 83, 60),
               ('usb-b', 'High Speed USB', 656, 503, 83, 60),
               ('camera-a', '2x9 DVP Header', 449, 331, 83, 60),
               ('camera-b', 'DVP Camera', 550, 331, 83, 60),
               ('header', '2x21 Pin<br>Header', 449, 605, 83, 60),
               ('sd', 'TF Card', 550, 605, 83, 60)]
    for identifier, value, x, y, width, height in entries:
        cell = ET.SubElement(cells, 'mxCell', {'id': identifier, 'value': value, 'vertex': '1', 'parent': '1',
                                             'style': 'rounded=1;whiteSpace=wrap;html=1;fontSize=12;strokeColor=#101010;'})
        ET.SubElement(cell, 'mxGeometry', {'x': str(x), 'y': str(y), 'width': str(width), 'height': str(height), 'as': 'geometry'})
        if identifier != 'core':
            edge = ET.SubElement(cells, 'mxCell', {'id': 'edge-' + identifier, 'edge': '1', 'parent': '1',
                                                 'source': 'core', 'target': identifier, 'style': 'rounded=0;endArrow=classic;exitX=0.5;'})
            ET.SubElement(edge, 'mxGeometry', {'relative': '1', 'as': 'geometry'})
    logo = ET.SubElement(cells, 'mxCell', {'id': 'logo', 'vertex': '1', 'parent': '1', 'style': 'shape=image;image=data:image/png,fixture;'})
    ET.SubElement(logo, 'mxGeometry', {'x': '507', 'y': '436', 'width': '48', 'height': '48', 'as': 'geometry'})
    # Another page and its layout must remain untouched by first-page adaptation.
    second = ET.SubElement(root, 'diagram', {'id': 'notes', 'name': '原始备注'})
    other = ET.SubElement(ET.SubElement(second, 'mxGraphModel', {'pageWidth': '640'}), 'root')
    ET.SubElement(other, 'mxCell', {'id': '0'})
    ET.SubElement(other, 'mxCell', {'id': '1', 'parent': '0', 'value': 'Original notes'})
    path.write_text(ET.tostring(root, encoding='unicode'))
    return path


def make_facts(root):
    source = root / 'board.epro2'
    source.write_bytes(b'unit-test-source-bound-project')
    def item(ref, kind, net=None, count=1):
        return {'ref': ref, 'kind': kind, 'pins': [{'number': str(i + 1), 'net': net or 'GND',
                                                  'modulePins': [{'number': '1'}] if net else []} for i in range(count)]}
    return {'productCode': 'WT9932P4C61-TINY', 'source': {'path': str(source), 'sha256': sha(source)},
            'board': {'moduleRef': 'J5', 'modulePart': 'WT01P461-S1', 'primaryTarget': 'esp32p4',
                      'targets': ['esp32p4', 'esp32c61'], 'targetEvidence': 'fixture source mapping'},
            'interfaces': [item('J1', 'mipi-dsi', 'DSI_D0_N'), item('J2', 'mipi-csi', 'CSI_D0_P'),
                           item('J3', 'header', 'IO47', 27), item('J4', 'header', 'LDO_VO4', 27),
                           item('J6', 'rgb', 'IO51'), item('J7', 'reset', 'P4_EN'), item('J8', 'boot', 'IO35_BOOT'),
                           item('J9', 'usb'), item('J10', 'usb'), item('J11', 'sd', 'IO40')]}


def graph_cells(xml):
    return {cell.get('id'): cell for cell in ET.fromstring(xml).find('diagram/mxGraphModel').iter('mxCell')}


def geometry_value(cell):
    def canonical(element):
        return None if element is None else (element.tag, dict(element.attrib), [canonical(child) for child in element])
    return canonical(cell.find('mxGeometry'))


def write_export_fixture(command, **kwargs):
    """Simulates CLI outputs only so export/verification boundaries are testable."""
    output = Path(command[command.index('--output') + 1])
    kind = command[command.index('--format') + 1]
    xml = Path(command[-1]).read_text()
    if kind == 'svg':
        output.write_text(ET.tostring(ET.Element('svg', {'xmlns': 'http://www.w3.org/2000/svg', 'content': xml}), encoding='unicode'))
    else:
        def chunk(tag, content):
            return struct.pack('>I', len(content)) + tag + content + struct.pack('>I', zlib.crc32(tag + content) & 0xffffffff)
        output.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) +
                           chunk(b'zTXt', b'mxGraphModel\0\0' + zlib.compress(quote(xml).encode())) +
                           chunk(b'IDAT', zlib.compress(b'\0\xff\xff\xff')) + chunk(b'IEND', b''))
    return subprocess.CompletedProcess(command, 0, stdout='fixture export', stderr='')


class DrawioTemplateAdapterTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.template = make_template(self.root / 'source.drawio')
        self.facts = make_facts(self.root)

    def render_fixture(self, *, review_feedback='', language=None, show_designators=True):
        executable = self.root / 'mock-drawio-cli'
        executable.write_text('not executed')
        with patch.dict('os.environ', {'WORKBENCH_DRAWIO': str(executable)}), patch.object(adapter.subprocess, 'run', side_effect=write_export_fixture) as run:
            result = adapter.render_source_diagram(self.facts, self.root / 'output' / 'block.drawio', template_path=self.template, review_feedback=review_feedback, language=language, show_designators=show_designators)
        return result, run

    def test_explicit_languages_change_only_current_labels_preserving_layout_logo_and_routes(self):
        legacy, old_audit = adapter.build_drawio_from_template(self.facts, self.template)
        english, english_audit = adapter.build_drawio_from_template(self.facts, self.template, language='en')
        chinese, chinese_audit = adapter.build_drawio_from_template(self.facts, self.template, language='zh')
        self.assertEqual(legacy, english)
        self.assertNotIn('language', old_audit)
        self.assertEqual(english_audit['language'], 'en'); self.assertEqual(chinese_audit['language'], 'zh')
        en, zh = graph_cells(english), graph_cells(chinese)
        self.assertEqual(set(en), set(zh))
        for identifier in en:
            self.assertEqual(en[identifier].get('style'), zh[identifier].get('style'), identifier)
            self.assertEqual(geometry_value(en[identifier]), geometry_value(zh[identifier]), identifier)
            self.assertEqual(en[identifier].get('source'), zh[identifier].get('source'), identifier)
            self.assertEqual(en[identifier].get('target'), zh[identifier].get('target'), identifier)
        self.assertEqual(en['logo'].attrib, zh['logo'].attrib)
        labels = '\n'.join(cell.get('value', '') for cell in zh.values())
        for word in ('显示接口', '摄像头接口', '扩展排针', 'TF 卡座', '按键', 'J3, J4', 'ESP32-P4', 'ESP32-C61'):
            self.assertIn(word, labels)
        self.assertEqual(chinese_audit['edgeRouting'], english_audit['edgeRouting'])

    def test_bilingual_exports_have_separate_language_bound_source_and_cli_png_svg(self):
        executable = self.root / 'mock-drawio-cli'; executable.write_text('not executed')
        with patch.dict('os.environ', {'WORKBENCH_DRAWIO': str(executable)}), patch.object(adapter.subprocess, 'run', side_effect=write_export_fixture) as run:
            result = adapter.render_bilingual_source_diagrams(self.facts, self.root / 'output/block.png', template_path=self.template)
        self.assertEqual(set(result), {'zh', 'en'}); self.assertEqual(run.call_count, 4)
        for language in ('zh', 'en'):
            receipt = result[language]
            self.assertEqual(receipt['language'], language)
            self.assertEqual(Path(receipt['pngPath']).name, f'block.{language}.png')
            manifest = json.loads(Path(receipt['manifestPath']).read_text())
            self.assertEqual(manifest['language'], language)
            checked = adapter.verify_source_diagram(receipt['manifestPath'], self.facts, template_path=self.template, language=language)
            self.assertEqual(checked['language'], language)
            self.assertTrue(adapter.verify_source_diagram(receipt['manifestPath'], self.facts, template_path=self.template)['passed'])
        self.assertNotEqual(Path(result['zh']['pngPath']).read_bytes(), Path(result['en']['pngPath']).read_bytes())

    def test_manifest_cannot_be_relabelled_as_another_language_or_used_in_wrong_guide(self):
        result, _ = self.render_fixture(language='zh')
        with self.assertRaisesRegex(ValueError, '指定指南语言'):
            adapter.verify_source_diagram(result['manifestPath'], self.facts, template_path=self.template, language='en')
        manifest_path = Path(result['manifestPath']); manifest = json.loads(manifest_path.read_text())
        manifest['language'] = 'en'; manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, '逐单元格审计'):
            adapter.verify_source_diagram(manifest_path, self.facts, template_path=self.template, language='en')

    def test_invalid_language_is_rejected_before_export_and_legacy_has_no_language_claim(self):
        with patch.object(adapter.subprocess, 'run') as run:
            for invalid in ('auto', 'zh-CN', '', {}, ['en']):
                with self.subTest(language=invalid), self.assertRaisesRegex(ValueError, '语言'):
                    adapter.render_source_diagram(self.facts, self.root/'bad.png', template_path=self.template, language=invalid)
            run.assert_not_called()
        result, _ = self.render_fixture()
        self.assertNotIn('language', result)
        self.assertNotIn('language', json.loads(Path(result['manifestPath']).read_text()))
        self.assertTrue(adapter.verify_source_diagram(result['manifestPath'], self.facts, template_path=self.template)['passed'])

    def test_bilingual_preflight_refuses_existing_other_language_before_creating_first(self):
        target = self.root/'block.png'; existing = self.root/'block.en.png'; existing.write_bytes(b'prior version')
        with patch.object(adapter.subprocess, 'run') as run:
            with self.assertRaises(FileExistsError):
                adapter.render_bilingual_source_diagrams(self.facts, target, template_path=self.template)
        run.assert_not_called()
        self.assertFalse((self.root/'block.zh.drawio').exists())
        self.assertEqual(existing.read_bytes(), b'prior version')

    def test_hidden_designators_keep_exact_source_relationship_audit_geometry_and_styles(self):
        shown, shown_audit = adapter.build_drawio_from_template(self.facts, self.template, language='zh')
        hidden, audit = adapter.build_drawio_from_template(self.facts, self.template, language='zh', show_designators=False)
        self.assertIs(audit['showDesignators'], False)
        self.assertIn('audit-only', audit['labelPolicy'])
        self.assertEqual(audit['edgeRouting'], shown_audit['edgeRouting'])
        old, new = graph_cells(shown), graph_cells(hidden)
        self.assertEqual(set(old), set(new))
        for identifier, cell in new.items():
            if cell.get('vertex') == '1': self.assertNotRegex(adapter._plain(cell.get('value')), r'\bJ\d+\b')
            self.assertEqual(cell.get('style'), old[identifier].get('style'))
            self.assertEqual(geometry_value(cell), geometry_value(old[identifier]))
        for original,current in zip(shown_audit['cells'],audit['cells']):
            self.assertEqual(original['sourceRefs'],current['sourceRefs'])
            self.assertEqual(original['sourceNets'],current['sourceNets'])
        self.assertEqual(next(c['sourceRefs'] for c in audit['cells'] if c['id']=='header'),['J3','J4'])
        self.assertEqual(new['logo'].attrib,old['logo'].attrib)

    def test_hidden_bilingual_exports_bind_boolean_policy_and_hide_refs_in_both_embedded_graphs(self):
        executable = self.root/'mock-drawio-cli'; executable.write_text('not executed')
        with patch.dict('os.environ', {'WORKBENCH_DRAWIO':str(executable)}), patch.object(adapter.subprocess,'run',side_effect=write_export_fixture) as run:
            result = adapter.render_bilingual_source_diagrams(self.facts,self.root/'output/block.png',template_path=self.template,show_designators=False)
        self.assertEqual(run.call_count,4)
        for language,receipt in result.items():
            self.assertIs(receipt['showDesignators'],False)
            manifest=json.loads(Path(receipt['manifestPath']).read_text()); audit=json.loads(Path(receipt['auditPath']).read_text())
            self.assertIs(manifest['showDesignators'],False); self.assertIs(audit['showDesignators'],False)
            self.assertEqual(manifest['language'],language)
            self.assertTrue(adapter.verify_source_diagram(receipt['manifestPath'],self.facts,template_path=self.template,language=language,show_designators=False)['passed'])
            for cell in graph_cells(Path(receipt['drawioPath']).read_text()).values():
                if cell.get('vertex')=='1': self.assertNotRegex(adapter._plain(cell.get('value')),r'\bJ\d+\b')

    def test_display_policy_tamper_or_different_requested_policy_cannot_reuse_hidden_export(self):
        result,_=self.render_fixture(language='en',show_designators=False)
        with self.assertRaisesRegex(ValueError,'位号显示策略'):
            adapter.verify_source_diagram(result['manifestPath'],self.facts,template_path=self.template,language='en')
        manifest_path=Path(result['manifestPath']); manifest=json.loads(manifest_path.read_text()); manifest['showDesignators']=True
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError,'逐单元格审计'):
            adapter.verify_source_diagram(manifest_path,self.facts,template_path=self.template,language='en',show_designators=True)

    def test_pre_policy_language_manifests_remain_exactly_verifiable_without_rewriting(self):
        result,_=self.render_fixture(language='en')
        manifest_path=Path(result['manifestPath']); manifest=json.loads(manifest_path.read_text()); manifest.pop('showDesignators')
        audit_path=Path(result['auditPath']); audit=json.loads(audit_path.read_text()); audit.pop('showDesignators'); audit_path.write_text(json.dumps(audit))
        manifest['audit']['sha256']=sha(audit_path); manifest_path.write_text(json.dumps(manifest))
        before={p:p.read_bytes() for p in (manifest_path,audit_path,Path(result['drawioPath']),Path(result['pngPath']),Path(result['svgPath']))}
        checked=adapter.verify_source_diagram(manifest_path,self.facts,template_path=self.template,language='en')
        self.assertTrue(checked['passed']); self.assertIs(checked['showDesignators'],True)
        self.assertEqual(before,{p:p.read_bytes() for p in before})

    def test_hidden_policy_rejects_unmapped_visible_template_designators_instead_of_silently_erasing_them(self):
        tree=ET.parse(self.template); tree.find("diagram/mxGraphModel/root/mxCell[@id='logo']").set('value','J999 extra template label')
        tree.write(self.template,encoding='unicode')
        with self.assertRaisesRegex(ValueError,'仍含可见 Jx'):
            adapter.build_drawio_from_template(self.facts,self.template,language='zh',show_designators=False)

    def test_designator_policy_rejects_non_boolean_values_before_export(self):
        with patch.object(adapter.subprocess,'run') as run:
            for invalid in (None,0,1,'false',{},[]):
                with self.subTest(policy=invalid),self.assertRaisesRegex(ValueError,'布尔值'):
                    adapter.render_source_diagram(self.facts,self.root/'bad.png',template_path=self.template,show_designators=invalid)
            run.assert_not_called()

    def test_inspect_is_generic_and_reads_real_compressed_pages_without_export(self):
        xml = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>'
        compressor = zlib.compressobj(wbits=-15)
        encoded = base64.b64encode(compressor.compress(quote(xml).encode()) + compressor.flush()).decode()
        compressed = self.root / 'generic.drawio'
        compressed.write_text('<mxfile><diagram id="generic" name="任意页面">' + encoded + '</diagram></mxfile>')
        with patch.object(adapter.subprocess, 'run') as run:
            info = adapter.inspect_template(compressed)
        self.assertEqual(info['sha256'], sha(compressed))
        self.assertEqual(info['pages'], [{'id': 'generic', 'name': '任意页面', 'cellCount': 2, 'vertexCount': 0, 'edgeCount': 0}])
        run.assert_not_called()

    def test_inspect_rejects_entities_broken_xml_duplicate_cells_and_invalid_compression(self):
        for raw in ['<!DOCTYPE mxfile [<!ENTITY x SYSTEM "file:///etc/passwd">]><mxfile/>', '<mxfile>',
                    '<mxfile><diagram><mxGraphModel><root><mxCell id="a"/><mxCell id="a"/></root></mxGraphModel></diagram></mxfile>',
                    '<mxfile><diagram>broken compression</diagram></mxfile>']:
            with self.subTest(raw=raw[:50]):
                file = self.root / 'invalid.drawio'; file.write_text(raw)
                with self.assertRaises(ValueError): adapter.inspect_template(file)

    def assert_layout_preserved(self, template):
        source_bytes = template.read_bytes()
        xml, audit = adapter.build_drawio_from_template(self.facts, template)
        original, changed = graph_cells(source_bytes), graph_cells(xml)
        self.assertEqual(set(original), set(changed))
        for identifier, before in original.items():
            after = changed[identifier]
            self.assertEqual(before.get('parent'), after.get('parent'), identifier)
            if before.get('edge') != '1': self.assertEqual(geometry_value(before), geometry_value(after), identifier)
            if before.get('vertex') == '1': self.assertEqual(before.get('style'), after.get('style'), identifier)
        old_root, new_root = ET.fromstring(source_bytes), ET.fromstring(xml)
        self.assertEqual(old_root.attrib, new_root.attrib)
        self.assertEqual([page.attrib for page in old_root.findall('diagram')], [page.attrib for page in new_root.findall('diagram')])
        self.assertEqual([page.find('mxGraphModel').attrib for page in old_root.findall('diagram')],
                         [page.find('mxGraphModel').attrib for page in new_root.findall('diagram')])
        text = '\n'.join(cell.get('value', '') for cell in changed.values())
        for label in ['ESP32-P4', 'ESP32-C61', 'MIPI DSI', 'MIPI CSI', '2×27 Pin', 'J3, J4', 'J9', 'J10']:
            self.assertIn(label, text)
        for label in ['ESP32S31', '320MHz', 'DVP', '2x21', 'Speed USB']:
            self.assertNotIn(label, text)
        for cell in changed.values():
            if cell.get('edge') == '1':
                self.assertIn(cell.get('source'), changed)
                self.assertIn(cell.get('target'), changed)
                self.assertIn('startArrow=none;', cell.get('style'))
                self.assertIn('endArrow=none;', cell.get('style'))
                if 'usb' in adapter._plain(changed[cell.get('target')].get('value')).lower() or 'usb' in adapter._plain(changed[cell.get('source')].get('value')).lower():
                    self.assertIn('dashed=1;', cell.get('style'))
        self.assertEqual(audit['template']['sha256'], hashlib.sha256(source_bytes).hexdigest())
        self.assertEqual(len(audit['cells']), len(original))
        self.assertEqual(audit['groupCount'], 8)
        self.assertEqual(audit['edgeRoutingVersion'], 2)
        self.assertEqual(len(audit['edgeRouting']), 8)
        for route in audit['edgeRouting']:
            self.assertEqual(route['bendCount'], 0)
            self.assertEqual(len(route['points']), 2)
            first, second = route['points']
            self.assertTrue(first[0] == second[0] or first[1] == second[1], route)
            edge = changed[route['id']]
            self.assertEqual([edge.get('source'), edge.get('target')], [route['source'], route['target']])
            self.assertIsNone(edge.find("mxGeometry/mxPoint[@as='sourcePoint']"))
            self.assertIsNone(edge.find("mxGeometry/mxPoint[@as='targetPoint']"))
            self.assertIsNone(edge.find('mxGeometry/Array'))
            style = dict(part.split('=', 1) for part in edge.get('style').split(';') if '=' in part)
            for key in ('exitX', 'exitY', 'entryX', 'entryY'):
                self.assertGreaterEqual(float(style[key]), 0); self.assertLessEqual(float(style[key]), 1)
            self.assertEqual(style['noEdgeStyle'], '1')
            for identifier in {row['id'] for row in audit['cells'] if row.get('role')} - {route['source'], route['target']}:
                self.assertFalse(adapter._segment_hits_box(first, second, adapter._box(changed[identifier], changed)), route)
        self.assertEqual(template.read_bytes(), source_bytes)
        return xml, audit

    def test_template_layout_pages_styles_and_logo_are_retained_with_per_cell_source_audit(self):
        xml, audit = self.assert_layout_preserved(self.template)
        self.assertEqual(graph_cells(xml)['logo'].get('style'), graph_cells(self.template.read_text())['logo'].get('style'))
        self.assertEqual(ET.fromstring(xml).findall('diagram')[1].find('.//mxCell[@id="1"]').get('value'), 'Original notes')
        self.assertEqual(next(item['sourceRefs'] for item in audit['cells'] if item['id'] == 'header'), ['J3', 'J4'])
        self.assertIn('LDO_VO4', next(item['sourceNets'] for item in audit['cells'] if item['id'] == 'header'))

    def test_synthetic_free_edges_retain_all_cells_pages_styles_and_bind_current_blocks(self):
        tree = ET.parse(self.template)
        cells = {cell.get('id'): cell for cell in tree.find('diagram/mxGraphModel').iter('mxCell')}
        for edge in list(cells.values()):
            if edge.get('edge') != '1': continue
            geometry = edge.find('mxGeometry')
            for endpoint in ('source', 'target'):
                box = adapter._box(cells[edge.attrib.pop(endpoint)], cells)
                ET.SubElement(geometry, 'mxPoint', {'x': str((box[0] + box[2]) / 2),
                                                  'y': str((box[1] + box[3]) / 2), 'as': endpoint + 'Point'})
        tree.write(self.template, encoding='unicode')
        expected_count = len(cells)
        expected_sha = sha(self.template)
        xml, audit = self.assert_layout_preserved(self.template)
        self.assertEqual(len(graph_cells(xml)), expected_count)
        self.assertEqual(audit['template']['sha256'], expected_sha)
        for language in ('zh', 'en'):
            localized, localized_audit = adapter.build_drawio_from_template(self.facts, self.template, language=language)
            cells = graph_cells(localized)
            self.assertEqual(len(cells), expected_count)
            self.assertEqual(localized_audit['edgeRouting'], audit['edgeRouting'])
            for identifier, cell in graph_cells(xml).items():
                self.assertEqual(cell.get('style'), cells[identifier].get('style'))
                self.assertEqual(geometry_value(cell), geometry_value(cells[identifier]))

    def test_review_feedback_is_bound_as_plain_audit_text_and_cannot_change_edges_or_run_commands(self):
        feedback = '连线水平垂直对齐；不要穿过文字。 $(touch /tmp/never-executed) <script>wrong relationship</script>'
        without, _ = adapter.build_drawio_from_template(self.facts, self.template)
        with_feedback, audit = adapter.build_drawio_from_template(self.facts, self.template, review_feedback=feedback)
        self.assertEqual(without, with_feedback)
        self.assertEqual(audit['reviewFeedback'], feedback)
        result, process = self.render_fixture(review_feedback=feedback)
        self.assertTrue(adapter.verify_source_diagram(result['manifestPath'], self.facts, template_path=self.template, review_feedback=feedback)['passed'])
        self.assertNotIn(feedback, repr(process.call_args_list))
        with self.assertRaisesRegex(ValueError, '逐单元格审计'):
            adapter.verify_source_diagram(result['manifestPath'], self.facts, template_path=self.template, review_feedback='different feedback')
        for invalid in (None, {}, 'x' * 8001):
            with self.subTest(invalid=type(invalid).__name__), self.assertRaisesRegex(ValueError, '最多 8000'):
                adapter.build_drawio_from_template(self.facts, self.template, review_feedback=invalid)

    def test_offset_routes_use_only_two_orthogonal_bends_and_block_intersections_fail_closed(self):
        tree = ET.parse(self.template)
        rgb = tree.find("diagram/mxGraphModel/root/mxCell[@id='rgb']/mxGeometry")
        rgb.set('y', '230'); tree.write(self.template, encoding='unicode')
        _, audit = adapter.build_drawio_from_template(self.facts, self.template)
        route = next(row for row in audit['edgeRouting'] if row['id'] == 'edge-rgb')
        self.assertEqual(route['bendCount'], 2)
        for first, second in zip(route['points'], route['points'][1:]):
            self.assertTrue(first[0] == second[0] or first[1] == second[1])
        # This different position would put the existing controls box across
        # the only proposed connector gap. Never silently draw through it.
        rgb.set('x', '100'); rgb.set('y', '503'); tree.write(self.template, encoding='unicode')
        with self.assertRaisesRegex(ValueError, '穿过其它功能块'):
            adapter.build_drawio_from_template(self.facts, self.template)

    def test_old_source_template_manifests_still_verify_original_routing_without_rewriting(self):
        xml, audit = adapter.build_drawio_from_template(self.facts, self.template, _routing_version=1)
        audit.pop('showDesignators')  # Actual historical audits predate this policy.
        self.assertNotIn('edgeRoutingVersion', audit); self.assertNotIn('reviewFeedback', audit)
        target = self.root / 'historical.drawio'; target.write_text(xml)
        paths = {kind: target.with_suffix('.' + kind) for kind in ('drawio', 'svg', 'png')}
        for kind in ('svg', 'png'): write_export_fixture(['fixture', '--output', str(paths[kind]), '--format', kind, str(target)])
        audit_path = self.root / 'historical.drawio-template-audit.json'; audit_path.write_text(json.dumps(audit))
        manifest = {'format': adapter.FORMAT, 'rendererVersion': 2, 'template': audit['template'],
                    'sourceSha256': self.facts['source']['sha256'], 'sourceFactsSha256': audit['sourceFactsSha256'],
                    'tool': {'name': 'draw.io'}, 'exports': [{'format': 'svg'}, {'format': 'png'}], 'pngDimensions': [1, 1],
                    'audit': {'path': str(audit_path), 'sha256': sha(audit_path)},
                    'artifacts': {kind: {'path': str(path), 'sha256': sha(path)} for kind, path in paths.items()}}
        manifest_path = self.root / 'historical.drawio-manifest.json'; manifest_path.write_text(json.dumps(manifest))
        before = {path: path.read_bytes() for path in [*paths.values(), manifest_path, audit_path]}
        self.assertTrue(adapter.verify_source_diagram(manifest_path, self.facts, template_path=self.template)['passed'])
        self.assertEqual(before, {path: path.read_bytes() for path in before})
        with self.assertRaisesRegex(ValueError, '历史路由版本'):
            adapter.verify_source_diagram(manifest_path, self.facts, template_path=self.template, review_feedback='new request')

    def test_absent_current_peripheral_removes_stale_slot_and_its_edge(self):
        self.facts['interfaces'] = [item for item in self.facts['interfaces'] if item['kind'] != 'sd']
        xml, audit = adapter.build_drawio_from_template(self.facts, self.template)
        self.assertNotIn('sd', graph_cells(xml))
        self.assertNotIn('edge-sd', graph_cells(xml))
        self.assertNotIn('TF Card', xml)
        self.assertEqual({item['id'] for item in audit['cells'] if item['action'] == 'removed-unmapped-template-slot'}, {'sd', 'edge-sd'})

    def test_source_hash_unsupported_groups_and_unproven_chip_targets_fail(self):
        modified = copy.deepcopy(self.facts); modified['source']['sha256'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, '实际 SHA'): adapter.build_drawio_from_template(modified, self.template)
        modified = copy.deepcopy(self.facts); modified['interfaces'].append({'ref': 'OTHER', 'kind': 'unverified', 'pins': []})
        with self.assertRaisesRegex(ValueError, '无明确映射'): adapter.build_drawio_from_template(modified, self.template)
        modified = copy.deepcopy(self.facts); modified['board']['primaryTarget'] = 'esp32s31'
        with self.assertRaisesRegex(ValueError, '明确的主控'): adapter.build_drawio_from_template(modified, self.template)

    def test_render_uses_both_real_cli_export_paths_and_verifies_all_bound_outputs_without_overwrite(self):
        result, run = self.render_fixture()
        self.assertEqual(run.call_count, 2)
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual([command[command.index('--format') + 1] for command in commands], ['svg', 'png'])
        for command in commands:
            self.assertIn('--embed-diagram', command)
            self.assertEqual(command[command.index('--scale') + 1], '3')
            self.assertEqual(Path(command[-1]), Path(result['drawioPath']))
        verification = adapter.verify_source_diagram(result['manifestPath'], self.facts, template_path=self.template)
        self.assertTrue(verification['passed'])
        self.assertEqual(verification['templateSha256'], sha(self.template))
        with patch.dict('os.environ', {'WORKBENCH_DRAWIO': str(self.root / 'mock-drawio-cli')}), patch.object(adapter.subprocess, 'run') as rerender:
            with self.assertRaises(FileExistsError): adapter.render_source_diagram(self.facts, result['drawioPath'], template_path=self.template)
            rerender.assert_not_called()

    def test_export_graph_tamper_is_rejected_even_when_artifact_hash_is_updated(self):
        result, _ = self.render_fixture()
        manifest_path = Path(result['manifestPath']); manifest = json.loads(manifest_path.read_text())
        svg = Path(result['svgPath']); svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile/&gt;"/>')
        manifest['artifacts']['svg']['sha256'] = sha(svg); manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'SVG'): adapter.verify_source_diagram(manifest_path, self.facts, template_path=self.template)

    def test_template_source_and_cell_audit_changes_cannot_reuse_prior_export(self):
        result, _ = self.render_fixture()
        manifest_path = Path(result['manifestPath']); manifest = json.loads(manifest_path.read_text())
        before = self.template.read_text(); self.template.write_text(before.replace('原始页面', '修改页面'))
        with self.assertRaisesRegex(ValueError, '模板或当前工程'): adapter.verify_source_diagram(manifest_path, self.facts, template_path=self.template)
        self.template.write_text(before)
        source = Path(self.facts['source']['path']); source.write_bytes(b'different project')
        with self.assertRaisesRegex(ValueError, '实际 SHA'): adapter.verify_source_diagram(manifest_path, self.facts, template_path=self.template)
        source.write_bytes(b'unit-test-source-bound-project')
        audit_path = Path(result['auditPath']); audit = json.loads(audit_path.read_text()); audit['cells'][0]['action'] = 'altered'
        audit_path.write_text(json.dumps(audit)); manifest['audit']['sha256'] = sha(audit_path); manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, '逐单元格审计'): adapter.verify_source_diagram(manifest_path, self.facts, template_path=self.template)


if __name__ == '__main__':
    unittest.main()
