"""SDK enrichment contracts using real, isolated Git fixture repositories."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from hdk import guide_sdk as sdk


def git(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, check=True)
    return result.stdout.decode().strip()


class GuideSdkTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.sdk_root = self.root / 'sdk'
        self.bsp_root = self.root / 'bsp'
        files = {
            sdk.UNIX_SETUP: 'Python 3.10\n./install.sh {IDF_TARGET_PATH_NAME}\n. $HOME/esp/esp-idf/export.sh',
            sdk.WINDOWS_SETUP: 'install.bat\nexport.bat',
            sdk.WINDOWS_CURRENT: 'EIM is the default and recommended route',
            sdk.PROJECT_GUIDE: 'To exit IDF monitor use the shortcut ``Ctrl+]``.',
            'README.md': 'git submodule update --init --recursive\nActivate in every shell environment.',
            'install.sh': '# extract targets\n# install-python-env',
            'install.bat': ':: CMD.EXE shell only\n:: extract targets\n:: install-python-env',
            'export.sh': '# sourced activation script',
            'export.bat': ':: CMD activation script',
            'tools/install_util.py': '# comma-separated targets',
            'tools/tools.json': json.dumps({'tools': [{'supported_targets': ['esp32s31', 'esp32p4', 'esp32c61']}]}),
        }
        blink = ('r = esp_random() % 255;\ng = esp_random() % 255;\nb = esp_random() % 255;\n'
                 'example_set_led_color(r, g, b);\nwt_bsp_rgb_set_pixel();\nwt_bsp_rgb_refresh();\n'
                 'vTaskDelay(1000 / portTICK_PERIOD_MS);\n')
        self.sdk_commit = self.make_repo(self.sdk_root, sdk.SDK_REPOSITORY, files)
        self.bsp_commit = self.make_repo(self.bsp_root, sdk.BSP_REPOSITORY, {
            sdk.BLINK_SOURCE: blink,
            sdk.P4_BOARD_DEFAULTS: 'CONFIG_WT_BSP_BOARD_WT9932P4C61_TINY=y\n# CONFIG_ESP32P4_SELECTS_REV_LESS_V3 is not set\nCONFIG_ESP32P4_REV_MIN_301=y\n',
            sdk.P4_TARGET_DEFAULTS: 'CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y\nCONFIG_ESPTOOLPY_FLASHSIZE="16MB"\nCONFIG_SPIRAM=y\nCONFIG_SPIRAM_MODE_HEX=y\nCONFIG_SPIRAM_SPEED_200M=y\n'})
        for name, value in [('SDK_COMMIT', self.sdk_commit), ('BSP_COMMIT', self.bsp_commit)]:
            patcher = patch.object(sdk, name, value); patcher.start(); self.addCleanup(patcher.stop)
        patcher = patch.object(sdk, 'EVIDENCE_CACHE', self.root / 'evidence')
        patcher.start(); self.addCleanup(patcher.stop)
        self.request = {'sdkRepository': {'path': str(self.sdk_root), 'remote': sdk.SDK_REPOSITORY, 'commit': self.sdk_commit},
                        'bspRepository': {'path': str(self.bsp_root), 'remote': sdk.BSP_REPOSITORY, 'commit': self.bsp_commit}}
        self.facts = {'productCode': 'TEST-BOARD', 'board': {'primaryTarget': 'esp32s31'},
                      'features': {'rgb': {'designator': 'LED1', 'gpio': 19}}, 'sourceFiles': [], 'primaryDocuments': [],
                      'development': {'manualDownload': {'scope': {'appliesToCompanionUart': False}, 'stepsZh': ['主处理器步骤']},
                                      'companionProtocol': {'transport': 'external UART', 'unchanged': True}}}

    def make_repo(self, root, remote, files):
        root.mkdir()
        git(root, 'init', '-q')
        git(root, 'config', 'user.name', 'Guide fixture')
        git(root, 'config', 'user.email', 'guide-tests@example.invalid')
        git(root, 'config', 'commit.gpgsign', 'false')
        git(root, 'remote', 'add', 'origin', remote)
        for name, text in files.items():
            target = root / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_text(text)
        git(root, 'add', '.')
        git(root, 'commit', '-qm', 'Independent SDK source fixture')
        return git(root, 'rev-parse', 'HEAD')

    def test_result_is_detached_and_preserves_manual_companion_scope(self):
        before = copy.deepcopy(self.facts)
        value = sdk.enrich_guide_development(self.facts, self.request)
        self.assertEqual(self.facts, before)
        self.assertEqual(value['development']['manualDownload'], before['development']['manualDownload'])
        self.assertEqual(value['development']['companionProtocol'], before['development']['companionProtocol'])
        self.assertFalse(value['development']['sdkSetup']['executed'])
        value['development']['manualDownload']['stepsZh'].append('new')
        self.assertEqual(self.facts, before)

    def test_installers_run_in_sdk_root_then_handoff_to_bsp_parent(self):
        value = sdk.enrich_guide_development(self.facts, self.request)['development']['sdkSetup']
        self.assertEqual(value['minimumPython'], '3.10')
        unix = value['platforms']['unix']['installShell']
        windows = value['platforms']['windowsCmd']['installShell']
        self.assertLess(unix.index('cd "$HOME/esp/esp-idf-v6.1"'), unix.index('./install.sh esp32s31'))
        self.assertTrue(unix.endswith('cd "$HOME/esp"'))
        self.assertIn('git checkout ' + self.sdk_commit, unix)
        self.assertIn('. ./export.sh', unix)
        self.assertIn('call install.bat esp32s31', windows)
        self.assertLess(windows.index('cd /d "%USERPROFILE%\\esp\\esp-idf-v6.1"'), windows.index('call install.bat'))
        self.assertTrue(windows.endswith('cd /d "%USERPROFILE%\\esp"'))
        self.assertEqual(value['platforms']['windowsCmd']['shell'], 'cmd.exe')
        self.assertIn('not PowerShell', value['platforms']['windowsCmd']['noteEn'])

    def test_p4_first_blink_installs_only_primary_target(self):
        facts = copy.deepcopy(self.facts); facts['board']['primaryTarget'] = 'esp32p4'
        value = sdk.enrich_guide_development(facts, self.request)['development']['sdkSetup']
        for platform in value['platforms'].values():
            self.assertIn('esp32p4', platform['installShell'])
            self.assertNotIn('esp32c61', platform['installShell'])
        self.assertEqual(value['target'], 'esp32p4')

    def test_p4_defaults_are_checked_cached_and_do_not_assert_physical_compatibility(self):
        facts = copy.deepcopy(self.facts); facts['board']['primaryTarget'] = 'esp32p4'
        # Simulate the actual sparse checkout: verified Git blobs remain available.
        for relative in (sdk.P4_BOARD_DEFAULTS, sdk.P4_TARGET_DEFAULTS):
            (self.bsp_root / relative).unlink()
        value = sdk.enrich_guide_development(facts, self.request)
        constraints = value['development']['defaultBuildConstraints']
        self.assertEqual(constraints['supportsCurrentHardware'], 'unconfirmed')
        self.assertEqual(constraints['minimumChipRevision'], '3.1')
        self.assertEqual(constraints['flashSizeMB'], 16)
        self.assertEqual(constraints['psram'], {'enabled': True, 'mode': 'HEX', 'speedMHz': 200})
        self.assertIn('separate legacy configuration', constraints['descriptionEn'])
        for proof in constraints['sourceProofs']:
            path = Path(proof['path'])
            self.assertTrue(path.is_file())
            self.assertFalse(path.is_symlink())
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), proof['sha256'])
            self.assertEqual(proof['gitBlob'], git(self.bsp_root, 'rev-parse', self.bsp_commit + ':' + proof['relativePath']))
            self.assertIn('/blob/' + self.bsp_commit + '/', proof['url'])
            self.assertTrue(any(item['path'] == str(path) for item in value['sourceFiles']))
            self.assertTrue(any(item['url'] == proof['url'] for item in value['primaryDocuments']))
        self.assertEqual(value, sdk.enrich_guide_development(value, self.request))

    def test_p4_configuration_drift_requires_fresh_review(self):
        facts = copy.deepcopy(self.facts); facts['board']['primaryTarget'] = 'esp32p4'
        path = self.bsp_root / sdk.P4_TARGET_DEFAULTS
        path.write_text(path.read_text().replace('CONFIG_SPIRAM_SPEED_200M=y', 'CONFIG_SPIRAM_SPEED_200M=n'))
        git(self.bsp_root, 'add', '.'); git(self.bsp_root, 'commit', '-qm', 'Different P4 memory defaults')
        commit = git(self.bsp_root, 'rev-parse', 'HEAD')
        request = copy.deepcopy(self.request); request['bspRepository']['commit'] = commit
        with patch.object(sdk, 'BSP_COMMIT', commit), self.assertRaisesRegex(sdk.GuideSdkBlocked, 'revision or memory defaults'):
            sdk.enrich_guide_development(facts, request)
        self.assertFalse(sdk.EVIDENCE_CACHE.exists())

    def test_cached_p4_evidence_tampering_is_rejected_without_overwrite(self):
        facts = copy.deepcopy(self.facts); facts['board']['primaryTarget'] = 'esp32p4'
        value = sdk.enrich_guide_development(facts, self.request)
        path = Path(value['development']['defaultBuildConstraints']['sourceProofs'][0]['path'])
        path.write_bytes(b'changed evidence')
        with self.assertRaisesRegex(sdk.GuideSdkBlocked, 'Cached BSP evidence differs'):
            sdk.enrich_guide_development(facts, self.request)
        self.assertEqual(path.read_bytes(), b'changed evidence')

    def test_s31_enrichment_is_independent_of_p4_defaults_and_cache(self):
        before = sdk.enrich_guide_development(self.facts, self.request)
        with patch.object(sdk, '_p4_build_constraints', side_effect=AssertionError('P4 evidence must not affect S31')):
            after = sdk.enrich_guide_development(self.facts, self.request)
        self.assertEqual(json.dumps(before, sort_keys=True), json.dumps(after, sort_keys=True))
        self.assertNotIn('defaultBuildConstraints', after['development'])
        self.assertFalse(sdk.EVIDENCE_CACHE.exists())

    def test_monitor_and_random_color_expectations_are_source_bound_not_test_claims(self):
        value = sdk.enrich_guide_development(self.facts, self.request)
        development = value['development']
        self.assertEqual(development['monitorExit']['keys'], 'Ctrl+]')
        blink = development['expectedBlink']
        self.assertEqual(blink['periodMs'], 1000)
        self.assertEqual(blink['physicalTestStatus'], 'not-run')
        self.assertIn('not a fixed on/off sequence', blink['descriptionEn'])
        self.assertEqual(blink['source']['sha256'], hashlib.sha256((self.bsp_root / sdk.BLINK_SOURCE).read_bytes()).hexdigest())
        self.assertEqual(blink['source']['gitBlob'], git(self.bsp_root, 'rev-parse', self.bsp_commit + ':' + sdk.BLINK_SOURCE))
        self.assertIn(self.bsp_commit, blink['source']['url'])
        for source in value['sourceFiles']:
            self.assertEqual(hashlib.sha256(Path(source['path']).read_bytes()).hexdigest(), source['sha256'])
        self.assertTrue(all(self.sdk_commit in d['url'] for d in value['primaryDocuments']))

    def test_enrichment_is_idempotent_for_source_indexes(self):
        once = sdk.enrich_guide_development(self.facts, self.request)
        twice = sdk.enrich_guide_development(once, self.request)
        self.assertEqual(once, twice)

    def test_changed_working_document_is_rejected_without_executing_installer(self):
        source = self.sdk_root / sdk.UNIX_SETUP
        source.write_text(source.read_text() + '\nlocal edit')
        with patch.object(sdk.subprocess, 'run', wraps=subprocess.run) as command:
            with self.assertRaisesRegex(sdk.GuideSdkBlocked, 'differs from its pinned Git object'):
                sdk.enrich_guide_development(self.facts, self.request)
        self.assertTrue(all(call.args[0][0] == 'git' for call in command.call_args_list))

    def test_changed_head_or_wrong_official_remote_is_rejected(self):
        request = copy.deepcopy(self.request); request['sdkRepository']['remote'] = 'https://github.com/unknown/sdk.git'
        with self.assertRaises(sdk.GuideSdkBlocked): sdk.enrich_guide_development(self.facts, request)
        git(self.sdk_root, 'commit', '--allow-empty', '-qm', 'Source version changed')
        with self.assertRaisesRegex(sdk.GuideSdkBlocked, 'HEAD or remote changed'):
            sdk.enrich_guide_development(self.facts, self.request)

    def test_blink_behavior_change_requires_fresh_review(self):
        path = self.bsp_root / sdk.BLINK_SOURCE
        path.write_text(path.read_text().replace('vTaskDelay(1000', 'vTaskDelay(2000'))
        git(self.bsp_root, 'add', '.'); git(self.bsp_root, 'commit', '-qm', 'Different behavior')
        commit = git(self.bsp_root, 'rev-parse', 'HEAD')
        request = copy.deepcopy(self.request); request['bspRepository']['commit'] = commit
        with patch.object(sdk, 'BSP_COMMIT', commit), self.assertRaisesRegex(sdk.GuideSdkBlocked, 'example RGB behavior'):
            sdk.enrich_guide_development(self.facts, request)

    def test_invalid_shapes_targets_and_missing_rgb_do_not_create_plausible_guidance(self):
        cases = [(None, self.request), ({}, self.request), (dict(self.facts, board={'primaryTarget': 'esp32c61'}), self.request),
                 (dict(self.facts, features={'rgb': None}), self.request)]
        for facts, request in cases:
            with self.subTest(facts=facts), self.assertRaises(sdk.GuideSdkBlocked):
                sdk.enrich_guide_development(facts, request)


if __name__ == '__main__':
    unittest.main()
