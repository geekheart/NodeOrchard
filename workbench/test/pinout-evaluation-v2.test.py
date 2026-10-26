"""V2 namespaces over actual PNG/SVG fixtures; old files and gates stay intact."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from hdk import pinout_learning as legacy
from hdk.pinout_evaluation_v2 import evaluate_pinout_views, CHECK_ID

SPEC = importlib.util.spec_from_file_location('pinout_evaluation_fixture', ROOT / 'test/pinout-learning.test.py')
FIXTURES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIXTURES)
NS = '{http://www.w3.org/2000/svg}'


class PinoutEvaluationV2Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.old_path = Path(legacy.__file__)
        self.old_sha = hashlib.sha256(self.old_path.read_bytes()).hexdigest()

    def tearDown(self):
        self.assertEqual(hashlib.sha256(self.old_path.read_bytes()).hexdigest(), self.old_sha)

    def fixture(self, name='front', side='front'):
        view = FIXTURES.PinoutLearningTests().fixture(self.root / name, side)
        self.pin(view, 'J1', '1', label='IO1')
        self.pin(view, 'J1', '2', label='IO2')
        return view

    def pin(self, view, connector, pad, *, source=None, trace=None, label=None, color=None):
        project_path, facts_path, svg_path = [Path(view[key]) for key in ('projectPath', 'factsPath', 'svgPath')]
        project, facts = json.loads(project_path.read_text()), json.loads(facts_path.read_text())
        group = next(item for item in project['state']['groups'] if item['connector'] == connector)
        index = next(index for index, item in enumerate(group['pins']) if item['_pin'] == pad)
        pin = group['pins'][index]
        fact = next(item for item in next(item for item in facts['connectors'] if item['designator'] == connector)['pins'] if item['pad'] == pad)
        if source is not None: fact['net'] = source; pin['_net'] = source
        if trace is not None: pin['_net'] = trace
        if label is not None: pin['name'] = label
        if color is not None: pin['color'] = color
        tree = ET.parse(svg_path); root = tree.getroot()
        full_index = sum(len(item['pins']) for item in project['state']['groups'][:project['state']['groups'].index(group)]) + index
        root.findall('.//' + NS + 'text')[full_index].text = pin['name']
        rect = root.findall('.//' + NS + 'rect')[full_index]
        rect.set('fill', pin['color'])
        x, y = float(rect.get('x')), float(rect.get('y'))
        raster = Image.open(view['pngPath']).convert('RGBA'); drawing = ImageDraw.Draw(raster)
        drawing.rectangle([x, y, x + 69, y + 15], fill=(0, 0, 0, 0))
        drawing.rounded_rectangle([x, y, x + 69, y + 15], radius=8, fill=pin['color'])
        drawing.text((x + 6, y + 1), pin['name'], fill='white'); raster.save(view['pngPath'])
        tree.write(svg_path, encoding='unicode')
        project_path.write_text(json.dumps(project)); facts_path.write_text(json.dumps(facts))

    def evaluate(self, views):
        return evaluate_pinout_views(views, reference_contract=legacy.build_reference_contract(views[0]['pngPath']))

    def assert_other_checks_preserved(self, result):
        old = result['legacyReference']
        for key, passed in old['qualitySummary']['checks'].items():
            if key != CHECK_ID:
                self.assertEqual(result['qualitySummary']['checks'][key], passed, key)
                self.assertEqual(next(row for row in result['checks'] if row['id'] == key), next(row for row in old['checks'] if row['id'] == key))
        self.assertEqual(result['metrics'], old['metrics']); self.assertEqual(result['labelInventory'], old['labelInventory'])
        self.assertEqual(result['learningComparison']['qualitySummary'], result['qualitySummary'])

    def test_unprefixed_primary_and_numbered_secondary_pass_with_raw_legacy_failure_preserved(self):
        front, back = self.fixture(), self.fixture('back', 'back')
        result = self.evaluate([front, back])
        self.assertTrue(result['passed'], result['diagnostics'])
        self.assertFalse(result['legacyReference']['qualitySummary']['checks'][CHECK_ID])
        self.assertTrue(any('explicit main-chip' in row['message'] for row in result['legacyReference']['diagnostics']))
        self.assertEqual(result['namespacePolicy']['version'], 2)
        self.assertFalse(result['learningComparison']['legacyReference']['namespacePassed'])
        self.assert_other_checks_preserved(result)

    def test_secondary_namespace_and_io_number_cannot_disappear_or_change(self):
        for label in ('IO8', 'C61 IO7', 'C61 IO8 IO7', 'C61 EN'):
            with self.subTest(label=label):
                view = self.fixture(label.replace(' ', '-'))
                self.pin(view, 'J2', '1', source='C61_IO8', label=label)
                result = self.evaluate([view])
                self.assertFalse(result['qualitySummary']['checks'][CHECK_ID]); self.assertFalse(result['passed'])
                self.assert_other_checks_preserved(result)
        view = self.fixture('valid-secondary'); self.pin(view, 'J2', '1', source='C61_IO8', label='C61 IO8')
        self.assertTrue(self.evaluate([view])['passed'])

    def test_primary_must_keep_its_exact_io_number_and_must_not_claim_c61(self):
        for label in ('IO7', 'C61 IO1', 'RX0', 'IO1 IO7'):
            view = self.fixture('primary-' + label.replace(' ', '-')); self.pin(view, 'J1', '1', label=label)
            result = self.evaluate([view]); self.assertFalse(result['qualitySummary']['checks'][CHECK_ID])
            self.assert_other_checks_preserved(result)

    def test_source_net_trace_mismatch_still_fails_both_trace_and_namespace(self):
        view = self.fixture(); self.pin(view, 'J1', '1', trace='IO99')
        result = self.evaluate([view])
        self.assertFalse(result['qualitySummary']['checks']['source-pin-trace'])
        self.assertFalse(result['qualitySummary']['checks'][CHECK_ID]); self.assertFalse(result['passed'])
        self.assert_other_checks_preserved(result)

    def test_boot_uart_and_enable_roles_remain_source_bound(self):
        cases = [('J1', '2', 'IO2_BOOT', 'IO2 BOOT', 'IO2'),
                 ('J1', '2', 'IO2_U0RXD', 'IO2 RX0', 'IO2'),
                 ('J1', '2', 'IO2_U0TXD', 'IO2 TX0', 'IO2 TX1'),
                 ('J2', '2', 'C61_EN', 'C61 EN', 'C61 IO2')]
        for index, (connector, pad, source, good, bad) in enumerate(cases):
            view = self.fixture('role-' + str(index)); self.pin(view, connector, pad, source=source, label=good)
            self.assertTrue(self.evaluate([view])['passed'])
            self.pin(view, connector, pad, label=bad)
            result = self.evaluate([view]); self.assertFalse(result['qualitySummary']['checks'][CHECK_ID]); self.assertFalse(result['passed'])
            self.assert_other_checks_preserved(result)

    def test_vo4_abbreviation_does_not_invent_gpio_or_voltage(self):
        view = self.fixture(); self.pin(view, 'J1', '1', source='LDO_VO4', label='VO4', color='#ff0000')
        result = self.evaluate([view]); self.assertTrue(result['passed'], result['diagnostics'])
        self.assertEqual(result['labelInventory'][0]['sourceNet'], 'LDO_VO4')
        for label in ('IO47', '4V', 'LDO4', 'VO5'):
            self.pin(view, 'J1', '1', label=label)
            failed = self.evaluate([view]); self.assertFalse(failed['qualitySummary']['checks'][CHECK_ID]); self.assertFalse(failed['passed'])
            self.assert_other_checks_preserved(failed)

    def test_all_other_twelve_real_artifact_checks_keep_every_legacy_failure(self):
        checks = [key for key in legacy.CHECK_IDS if key != CHECK_ID]
        for index, check in enumerate(checks):
            with self.subTest(check=check):
                view = self.fixture('check-' + str(index)); views = [view]
                svg = Path(view['svgPath']); project_path = Path(view['projectPath'])
                if check == 'actual-export-readable': Path(view['pngPath']).unlink()
                elif check == 'transparent-portrait':
                    image = Image.open(view['pngPath']).convert('RGBA'); white = Image.new('RGBA', image.size, 'white'); white.alpha_composite(image); white.save(view['pngPath'])
                elif check == 'source-photo-preserved':
                    image = Image.open(view['pngPath']).convert('RGBA'); ImageDraw.Draw(image).rectangle([90, 40, 289, 439], fill='white'); image.save(view['pngPath'])
                elif check == 'native-photo-resolution': svg.write_text(svg.read_text().replace('width="200" height="400"', 'width="400" height="800"'))
                elif check == 'source-pin-trace': self.pin(view, 'J1', '1', trace='IO99')
                elif check == 'visible-labels-match-project':
                    project = json.loads(project_path.read_text()); project['state']['groups'][0]['pins'][0]['name'] = 'IO99'; project_path.write_text(json.dumps(project))
                elif check == 'concise-main-labels': self.pin(view, 'J1', '1', label='IO1 verbose engineering trace')
                elif check == 'reference-palette': self.pin(view, 'J1', '1', color='#123456')
                elif check == 'compact-readable-capsules': svg.write_text(svg.read_text().replace('font-size="12"', 'font-size="4"'))
                elif check == 'pad-row-or-guide-alignment': svg.write_text(svg.read_text().replace('font-size="12"', 'transform="translate(0 7)" font-size="12"', 1))
                elif check == 'no-label-overlap-or-crop': svg.write_text(svg.read_text().replace('font-size="12"', 'transform="translate(-30 0)" font-size="12"', 1))
                elif check == 'two-view-electrical-consistency':
                    back = self.fixture('check-back', 'back'); self.pin(back, 'J1', '1', source='IO7', label='IO7'); views.append(back)
                # Keep the reference available even when this candidate PNG is missing.
                reference = self.fixture('reference-' + str(index))
                result = evaluate_pinout_views(views, reference_contract=legacy.build_reference_contract(reference['pngPath']))
                self.assertFalse(result['legacyReference']['qualitySummary']['checks'][check], result['legacyReference']['diagnostics'])
                self.assertFalse(result['qualitySummary']['checks'][check]); self.assertFalse(result['passed'])
                self.assert_other_checks_preserved(result)


if __name__ == '__main__': unittest.main()
