"""Finite V2 display choices; no model, image generation, EDA or gate changes."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from hdk import pinout_facts
from hdk.pinout_display_v2 import display_v2_scope
from hdk.pinout_pipeline import prepare_plan_input


class PinoutDisplayV2Tests(unittest.TestCase):
    def setUp(self):
        self.original = pinout_facts._label_candidates
        self.source_file = Path(pinout_facts.__file__)
        self.source_sha = hashlib.sha256(self.source_file.read_bytes()).hexdigest()
        self.facts = {'source': {'sha256': 'a' * 64}, 'pinCount': 3,
                      'connectors': [{'designator': 'J4', 'placement': {'x': 120, 'y': 80, 'angle': 0},
                                      'pins': [{'pad': '1', 'net': 'LDO_VO4', 'imagePixel': [10, 20], 'worldMil': [120, 80]},
                                               {'pad': '2', 'net': 'IO47', 'imagePixel': [10, 40], 'worldMil': [120, 180]},
                                               {'pad': '3', 'net': 'GND', 'imagePixel': [10, 60], 'worldMil': [120, 280]}]}]}
        self.before = copy.deepcopy(self.facts)

    def tearDown(self):
        self.assertIs(pinout_facts._label_candidates, self.original)
        self.assertEqual(hashlib.sha256(self.source_file.read_bytes()).hexdigest(), self.source_sha)
        self.assertEqual(self.facts, self.before)

    def plan(self, label='VO4'):
        return {'format': 'workbench-pinout-display-plan', 'version': 1,
                'style': {'preset': 'reference-compact', 'background': 'transparent', 'guides': False,
                          'fontSize': 12, 'labelGapPx': 3,
                          'palette': {'gpio': '#3498db', 'power': '#ff0000', 'ground': '#2ecc71'}},
                'displayAliases': [{'connector': 'J4', 'pad': pin['pad'], 'net': pin['net'],
                                    'label': label if pin['pad'] == '1' else pin['net']}
                                   for pin in self.facts['connectors'][0]['pins']]}

    def test_scope_only_adds_exact_source_identifier_without_removing_legacy_choices(self):
        baseline = pinout_facts.display_options(self.facts)
        old = baseline['pins'][0]['allowedLabels']
        self.assertNotIn('VO4', old)
        with display_v2_scope():
            extended = pinout_facts.display_options(self.facts)
            self.assertEqual(set(extended['pins'][0]['allowedLabels']) - set(old), {'VO4'})
            self.assertTrue(set(old) <= set(extended['pins'][0]['allowedLabels']))
            self.assertEqual(extended['pins'][1:], baseline['pins'][1:])
            self.assertEqual(extended['sourceSha256'], baseline['sourceSha256'])
            self.assertEqual(extended['style'], baseline['style'])
            self.assertEqual(pinout_facts._color('LDO_VO4'), '#e74c3c')
        self.assertEqual(pinout_facts.display_options(self.facts), baseline)

    def test_real_plan_validator_accepts_vo4_but_retains_raw_net_pad_style_and_geometry(self):
        plan = self.plan()
        with display_v2_scope():
            accepted = pinout_facts.validate_display_plan(plan, self.facts)
            self.assertEqual(accepted, plan)
            self.assertEqual(accepted['displayAliases'][0], {'connector': 'J4', 'pad': '1', 'net': 'LDO_VO4', 'label': 'VO4'})
            self.assertEqual(accepted['style']['palette']['power'], '#ff0000')
        with self.assertRaises(pinout_facts.PinoutBlocked):
            pinout_facts.validate_display_plan(plan, self.facts)

    def test_vo4_never_grants_gpio47_4v_or_changed_electrical_identity(self):
        with display_v2_scope():
            for invented in ('IO47', 'MAIN IO47', '4V', '4.0V', 'VO4?', 'VO5'):
                with self.subTest(label=invented), self.assertRaises(pinout_facts.PinoutBlocked):
                    pinout_facts.validate_display_plan(self.plan(invented), self.facts)
            for mutate in [lambda plan: plan['displayAliases'][0].update(net='IO47'),
                           lambda plan: plan['displayAliases'][0].update(pad='2'),
                           lambda plan: plan['style'].update(imageScale=150)]:
                plan = self.plan(); mutate(plan)
                with self.subTest(plan=plan), self.assertRaises(pinout_facts.PinoutBlocked):
                    pinout_facts.validate_display_plan(plan, self.facts)

    def test_exact_source_pattern_does_not_infer_values_from_similar_net_names(self):
        names = ('LDO_VO4_EXTRA', 'LDO_VO4?', 'ldo_vo4', 'LDO4', 'LDO_V04', 'IO47', '4V')
        baseline = {name: self.original(name) for name in names}
        with display_v2_scope():
            for name in names:
                with self.subTest(net=name): self.assertEqual(pinout_facts._label_candidates(name), baseline[name])
            self.assertIn('VO12', pinout_facts._label_candidates('LDO_VO12'))
            self.assertIn('VO04', pinout_facts._label_candidates('LDO_VO04'))
            self.assertNotIn('4V', pinout_facts._label_candidates('LDO_VO4'))

    def test_prepare_plan_input_imports_the_scoped_options_and_restores_original_afterwards(self):
        with tempfile.TemporaryDirectory() as directory:
            facts_path = Path(directory) / 'facts.json'; facts_path.write_text(json.dumps(self.facts))
            views = [{'side': side, 'factsPath': str(facts_path), 'image': {'width': 120, 'height': 200},
                      'photoOriginal': {'sha256': ('b' if side == 'front' else 'c') * 64}} for side in ('front', 'back')]
            request = {'productCode': 'TEST', 'hardwareVersion': '1.0'}
            outside = prepare_plan_input(views, request)
            self.assertNotIn('VO4', outside['displayOptions']['pins'][0]['allowedLabels'])
            with display_v2_scope():
                inside = prepare_plan_input(views, request)
                self.assertIn('VO4', inside['displayOptions']['pins'][0]['allowedLabels'])
                self.assertEqual(inside['views'], outside['views'])
                self.assertEqual(inside['immutability'], outside['immutability'])
            self.assertEqual(prepare_plan_input(views, request), outside)

    def test_exception_and_nested_scopes_always_restore_the_exact_previous_helper(self):
        with self.assertRaisesRegex(RuntimeError, 'intentional'):
            with display_v2_scope():
                outer = pinout_facts._label_candidates
                with display_v2_scope():
                    self.assertEqual(pinout_facts._label_candidates('LDO_VO4').count('VO4'), 1)
                self.assertIs(pinout_facts._label_candidates, outer)
                raise RuntimeError('intentional')
        self.assertIs(pinout_facts._label_candidates, self.original)
        self.assertNotIn('VO4', self.original('LDO_VO4'))


if __name__ == '__main__': unittest.main()
