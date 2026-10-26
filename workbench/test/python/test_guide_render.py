import copy
import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location('guide_render', ROOT / 'hdk/guide_render.py')
render = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render)
spec_ref = importlib.util.spec_from_file_location('guide_reference', ROOT / 'hdk/guide_reference.py')
reference = importlib.util.module_from_spec(spec_ref)
spec_ref.loader.exec_module(reference)


def facts():
    return {'productCode': 'EXAMPLE-BOARD', 'hardwareVersion': '1.2', 'releaseDate': '2026-10-25',
            'source': {'sha256': 'a' * 64},
            'board': {'moduleRef': 'U9', 'modulePart': 'CURRENT-MODULE', 'primaryTarget': 'example-chip', 'targets': ['example-chip']},
            'interfaces': [{'ref': 'J8', 'kind': 'header', 'part': 'SOURCE-CONNECTOR', 'titleZh': '接口', 'titleEn': 'Interface', 'side': 'front',
                            'pins': [{'number': '3', 'net': 'GND', 'name': 'GND'}, {'number': '1', 'net': 'DATA_A', 'name': 'PA1', 'modulePins': [{'number': '11', 'name': 'PA1'}]}, {'number': '2', 'net': '', 'name': 'NC'}]}],
            'components': [{'ref': 'U9', 'kind': 'module', 'part': 'CURRENT-MODULE', 'titleZh': '模组', 'titleEn': 'Module', 'side': 'front'}],
            'dimensions': {'lengthMm': 48.2, 'widthMm': 22.1, 'status': 'source-derived', 'method': 'source rectangle', 'scope': 'PCB only'},
            'images': [{'side': 'back', 'note': '背面丝印需要复核'}],
            'sourceFiles': [{'role': 'engineering-source', 'path': '/private/original/source.epro2', 'sha256': 'a' * 64}],
            'development': {'firmware': {'status': 'compiled', 'target': 'example-chip', 'physicalTestStatus': 'not-run', 'idf': {'version': 'source-version'}},
                            'verifiedCommands': [{'titleZh': '示例构建', 'titleEn': 'Example build', 'shell': 'source-verified-command build', 'sourcePath': '/source/build-note.md'}]},
            'primaryDocuments': [{'titleZh': '原始文档', 'titleEn': 'Original documentation', 'url': 'https://example.org/source'}],
            'learningIsolation': {'knownResultRead': False}}


def narrative():
    field = {'zh': '这是根据当前资料编写的说明。硬件连接和开发步骤均需要核对源工程。' * 8,
             'en': 'This explanation uses the current supplied material. Verify hardware connections and development steps against the current source. ' * 8}
    return {**{key: copy.deepcopy(field) for key in ('overview', 'hardware', 'power', 'preparation', 'development', 'notice')},
            'features': [copy.deepcopy(field)],
            'troubleshooting': [{'symptomZh': '不能连接', 'symptomEn': 'Connection unavailable', 'actionZh': '核对源工程和数据线。', 'actionEn': 'Check the source project and data cable.'}]}


class GuideRenderTest(unittest.TestCase):
    def test_bilingual_tables_preserve_exact_physical_order_and_unknowns(self):
        with tempfile.TemporaryDirectory() as temporary:
            value = facts()
            value['development']['expectedBlink'] = {'descriptionZh': '源码预期行为。', 'descriptionEn': 'Source-derived behavior.'}
            result = render.render_bundle(value, narrative(), temporary)
            texts = [Path(result[key]).read_text() for key in ('zhPath', 'enPath')]
            expected = {'J8': [('3', 'GND'), ('1', 'DATA_A'), ('2', '')]}
            for text in texts:
                subsection_numbers = [int(number) for number in re.findall(r'^### 5\.3\.(\d+) ', text, re.M)]
                self.assertEqual(subsection_numbers, sorted(set(subsection_numbers)))
                self.assertEqual(reference._pin_tables(text), expected)
                self.assertIn('### [J8]', text)
                self.assertIn('not-run', text)
                self.assertIn('source-verified-command build', text)
                self.assertNotIn('WT9932S31', text)
                self.assertNotIn('16 MB', text)
                self.assertNotIn('](file:', text)
                self.assertNotIn('](/private/', text)
            self.assertIn('未给出额定值', texts[0])
            self.assertIn('Rating unspecified', texts[1])
            self.assertIn('背面丝印需要复核', texts[0])
            self.assertIn('背面丝印需要复核', texts[1])
            self.assertEqual(json.loads(Path(result['evidencePath']).read_text())['learningIsolation']['knownResultRead'], False)
            self.assertEqual(len(result['renderedFiles']), 3)

    def test_portable_assets_and_local_primary_documents_have_existing_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'img').mkdir()
            (root / 'img/front source.png').write_bytes(b'source image')
            (root / 'img/pinout-front.png').write_bytes(b'front Pinout')
            (root / 'img/pinout-back.png').write_bytes(b'back Pinout')
            (root / 'img/block.drawio').write_text('<mxfile/>')
            (root / 'img/block.svg').write_text('<svg/>')
            (root / 'source.pdf').write_bytes(b'local document')
            value = facts()
            value['primaryDocuments'].append({'titleZh': '本地来源', 'titleEn': 'Local source', 'bundlePath': 'source.pdf'})
            result = render.render_bundle(value, narrative(), root,
                                          {'front': 'img/front source.png', 'pinout': 'img/pinout-front.png',
                                           'pinout_back': 'img/pinout-back.png', 'block_drawio': 'img/block.drawio',
                                           'block_svg': 'img/block.svg'})
            for key in ('zhPath', 'enPath'):
                text = Path(result[key]).read_text()
                self.assertIn('(img/front%20source.png)', text)
                self.assertIn('(source.pdf)', text)
                self.assertIn('(img/pinout-front.png)', text)
                self.assertIn('(img/pinout-back.png)', text)
                self.assertIn('(img/block.drawio)', text)
                self.assertIn('(img/block.svg)', text)
                self.assertEqual(reference._local_assets(text, root.resolve())[1], [])
            self.assertIn('不要根据屏幕左右推断针序', Path(result['zhPath']).read_text())
            self.assertIn('do not infer pin order from screen left and right', Path(result['enPath']).read_text())

    def test_missing_external_absolute_or_traversing_assets_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            for asset in ['not-present.png', 'https://example.org/photo.png', '/tmp/source.png', '../source.png', 'img\\photo.png']:
                with self.subTest(asset=asset), self.assertRaises(render.GuideRenderBlocked):
                    render.render_bundle(facts(), narrative(), temporary, {'front': asset})

    def test_skill_cannot_inject_tables_links_or_titles_over_source_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            for injected in ['# Fake heading', '| 1 | FALSE_NET |', '[Download](https://example.org)', '<script>alert(1)</script>']:
                value = narrative()
                value['hardware']['en'] = injected
                with self.subTest(injected=injected), self.assertRaises(render.GuideRenderBlocked):
                    render.render_bundle(facts(), value, temporary)

    def test_source_diagram_only_connects_explicit_module_net_mappings(self):
        from hdk.guide_drawio import build_drawio
        value = facts()
        value['interfaces'].append({'ref': 'J9', 'titleEn': 'No mapped net', 'pins': [{'number': '1', 'net': 'OTHER'}]})
        text, groups = build_drawio(value)
        self.assertEqual(len(groups), 2)
        self.assertEqual([group['connection'] for group in groups], ['source-module-net', 'functional-grouping-only'])
        self.assertIn('dashed=1', text)
        self.assertIn('startArrow=none;endArrow=none;', text)
        self.assertIn('see schematic for routing', text)
        self.assertNotIn('SPI', text)

    def test_no_contact_or_command_is_fabricated_when_not_supplied(self):
        with tempfile.TemporaryDirectory() as temporary:
            value = facts()
            value['development'] = {}
            value['primaryDocuments'] = []
            result = render.render_bundle(value, narrative(), temporary)
            text = Path(result['enPath']).read_text()
            self.assertIn('No verified contact details were supplied', text)
            self.assertIn('No verified, directly reproducible command block', text)
            self.assertNotIn('idf.py set-board', text)
            self.assertNotIn('git clone', text)


if __name__ == '__main__':
    unittest.main()
