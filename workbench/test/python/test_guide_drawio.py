import copy
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from urllib.parse import quote
import xml.etree.ElementTree as ET
import zlib

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from hdk import guide_drawio as drawio


def facts():
    return {'productCode': 'CURRENT-BOARD', 'source': {'sha256': 'a' * 64},
            'board': {'moduleRef': 'U1', 'modulePart': 'CURRENT-MODULE', 'targets': ['current-chip']},
            'interfaces': [{'ref': 'H1', 'kind': 'header', 'pins': [{'number': '1', 'net': 'DATA', 'modulePins': [{'number': '7'}]}]},
                           {'ref': 'H2', 'kind': 'header', 'pins': [{'number': '1', 'net': 'GND'}]},
                           {'ref': 'J9', 'kind': 'usb', 'pins': [{'number': 'A6', 'net': 'USB_A'}]},
                           {'ref': 'J10', 'kind': 'usb', 'pins': [{'number': 'A6', 'net': 'USB_B'}]},
                           {'ref': 'SW1', 'kind': 'reset', 'pins': [{'number': '1', 'net': 'EN', 'modulePins': [{'number': '8'}]}]}]}


def fixture_bundle(root, value):
    """Synthetic PNG fixture exercises the verifier; this is not an app export."""
    xml, groups = drawio.build_drawio(value)
    drawio_path, svg_path, png_path = (root / ('block.' + suffix) for suffix in ('drawio', 'svg', 'png'))
    drawio_path.write_text(xml)
    svg = ET.Element('svg', {'xmlns': 'http://www.w3.org/2000/svg', 'content': xml})
    svg_path.write_text(ET.tostring(svg, encoding='unicode'))
    def chunk(kind, payload):
        return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff)
    png_path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0)) +
                         chunk(b'zTXt', b'mxGraphModel\0\0' + zlib.compress(quote(xml).encode())) +
                         chunk(b'IDAT', zlib.compress(b'\0\xff\xff\xff')) + chunk(b'IEND', b''))
    clean_groups = [{key: item for key, item in group.items() if key != 'members'} for group in groups]
    manifest = {'schemaVersion': 1, 'rendererVersion': drawio.RENDERER_VERSION,
                'format': 'source-bound-drawio-functional-diagram', 'tool': {'name': 'draw.io'},
                'sourceFactsSha256': drawio.source_digest(value), 'sourceSha256': value['source']['sha256'],
                'groups': clean_groups, 'exports': [{'format': 'svg'}, {'format': 'png'}], 'pngDimensions': [1, 1],
                'artifacts': {kind: {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                              for kind, path in [('drawio', drawio_path), ('svg', svg_path), ('png', png_path)]}}
    path = root / 'block.drawio-manifest.json'
    path.write_text(json.dumps(manifest))
    return path, manifest


class GuideDrawioTest(unittest.TestCase):
    def test_current_source_does_not_copy_s31_hardware_or_unverified_frequency(self):
        xml, groups = drawio.build_drawio(facts())
        values = [cell.get('value', '') for cell in ET.fromstring(xml).iter('mxCell')]
        text = '\n'.join(values)
        self.assertIn('CURRENT-MODULE', text)
        self.assertIn('CURRENT-CHIP', text)
        for forbidden in ['ESP32S31', '320MHz', '2x21', 'Flash', 'PSRAM', 'BOOT']:
            self.assertNotIn(forbidden, text)
        self.assertEqual([group['refs'] for group in groups], [['H1', 'H2'], ['J9'], ['J10'], ['SW1']])

    def test_unmapped_interfaces_use_function_grouping_without_signal_arrows(self):
        xml, groups = drawio.build_drawio(facts())
        cells = {cell.get('id'): cell for cell in ET.fromstring(xml).iter('mxCell')}
        self.assertEqual(groups[0]['moduleNets'], ['DATA'])
        self.assertNotIn('dashed=1', cells['connection-1'].get('style'))
        self.assertIn('dashed=1', cells['connection-2'].get('style'))
        self.assertIn('startArrow=none;endArrow=none;', cells['connection-2'].get('style'))

    def test_source_digest_ignores_prose_and_tracks_net_mapping_changes(self):
        value = facts()
        changed = copy.deepcopy(value)
        changed['primaryDocuments'] = [{'bundlePath': 'sources/file.pdf'}]
        changed['warnings'] = ['narrative change']
        self.assertEqual(drawio.source_digest(value), drawio.source_digest(changed))
        changed['interfaces'][0]['pins'][0]['modulePins'] = []
        self.assertNotEqual(drawio.source_digest(value), drawio.source_digest(changed))

    def test_actual_files_and_both_embedded_graphs_are_required(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, value = Path(temporary), facts()
            path, _ = fixture_bundle(root, value)
            self.assertTrue(drawio.verify_source_diagram(path, value)['passed'])
            (root / 'block.png').write_bytes(b'wrong image')
            with self.assertRaisesRegex(ValueError, 'hash/path'):
                drawio.verify_source_diagram(path, value)

    def test_tampered_embedded_source_fails_even_when_receipt_hash_is_updated(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, value = Path(temporary), facts()
            path, manifest = fixture_bundle(root, value)
            svg = root / 'block.svg'
            svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" content="&lt;mxfile/&gt;"/>')
            manifest['artifacts']['svg']['sha256'] = hashlib.sha256(svg.read_bytes()).hexdigest()
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'SVG embedded graph'):
                drawio.verify_source_diagram(path, value)

    def test_changed_current_facts_or_external_artifact_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, value = Path(temporary), facts()
            path, manifest = fixture_bundle(root, value)
            changed = copy.deepcopy(value)
            changed['board']['modulePart'] = 'OTHER-MODULE'
            with self.assertRaisesRegex(ValueError, 'source binding'):
                drawio.verify_source_diagram(path, changed)
            manifest['artifacts']['png']['path'] = '/tmp/unrelated.png'
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'hash/path'):
                drawio.verify_source_diagram(path, value)


if __name__ == '__main__':
    unittest.main()
