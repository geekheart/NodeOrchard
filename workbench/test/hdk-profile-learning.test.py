import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('profile_harness', ROOT / 'hdk/profile_learning.py')
harness = importlib.util.module_from_spec(spec); spec.loader.exec_module(harness)


class ProfileLearningTests(unittest.TestCase):
    def setUp(self):
        self.firmware = harness._firmware()
        self.facts = {'source': {'sha256': '0' * 64}, 'board': {'primaryTarget': 'esp32p4', 'targets': ['esp32p4', 'esp32c61']},
            'peripherals': {'rgb': None, 'buttons': [], 'sd': None, 'usb': [], 'headers': [],
                'camera': {'interface': 'mipi-csi', 'pins': {'sda': 7, 'scl': 8}},
                'display': {'interface': 'mipi-dsi'}}}
        self.case = {'skillInput': {'testRequirements': {'cameraSensor': 'sc2336', 'displayPanel': 'st7102-480x640'}}}
        self.profile = {'schemaVersion': 1, 'target': 'esp32p4', 'tests': ['chip-info', 'reset', 'usb-console',
            'mipi-csi', 'mipi-dsi', 'companion-link', 'wifi'], 'cameraSensor': 'sc2336', 'displayPanel': 'st7102-480x640', 'fixturePairs': []}

    def evaluate(self, profile):
        with patch.object(harness, 'check_case', return_value=(self.firmware, self.facts)), \
            patch.object(self.firmware, 'generate', side_effect=AssertionError('must not generate')), \
            patch.object(self.firmware, 'compile', side_effect=AssertionError('must not compile')):
            return harness.evaluate_case(self.case, profile)

    def test_legal_interface_profile_returns_only_constraint_validity(self):
        self.assertEqual(self.evaluate(self.profile), {'valid': True})

    def test_real_fixed_validator_rejects_dvp_test_on_sc2336_mipi(self):
        candidate = dict(self.profile, tests=self.profile['tests'] + ['camera-sccb'])
        result = self.evaluate(candidate)
        self.assertFalse(result['valid'])
        self.assertEqual(result['candidateProfile'], candidate)
        self.assertIn('DVP', result['diagnostics'][0]['message'])
        self.assertNotIn('expectedProfile', result)

    def test_missing_board_feature_and_model_claimed_valid_cannot_pass(self):
        result = self.evaluate(dict(self.profile, tests=['chip-info', 'reset', 'usb-console']))
        self.assertFalse(result['valid']); self.assertIn('mipi-csi', result['coverage']['missingTests'])
        self.assertFalse(self.evaluate({'valid': True})['valid'])

    def test_changed_source_is_infrastructure_error_not_optimizable_feedback(self):
        with patch.object(harness, 'check_case', side_effect=RuntimeError('Board source changed')):
            with self.assertRaisesRegex(RuntimeError, 'source changed'):
                harness.evaluate_case(self.case, self.profile)


if __name__ == '__main__': unittest.main()
