"""Guide facts input/provenance contracts, independent of private board files."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from hdk import guide_facts as facts


class GuideFactsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'source.epro2'
        self.source.write_bytes(b'synthetic source bound through mocked native parsers')
        self.digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.pcb = {'head': {'uuid': 'pcb-uuid', 'docType': 'PCB'}, 'records': [
            ({'type': 'COMPONENT', 'id': 'module'}, {'x': 10, 'y': 20, 'angle': 0, 'layerId': 1}),
            ({'type': 'COMPONENT', 'id': 'connector'}, {'x': 30, 'y': 20, 'angle': 0, 'layerId': 1})]}
        board = {'board': {'moduleRef': 'U1', 'modulePart': 'EXAMPLE-MODULE', 'targets': ['example'], 'primaryTarget': 'example', 'componentCount': 2,
                           'components': [{'designator': 'U1', 'componentUuid': 'module', 'part': 'EXAMPLE-MODULE', 'pins': [{'pad': '1', 'name': 'IO1', 'net': 'IO1'}]},
                                          {'designator': 'J1', 'componentUuid': 'connector', 'part': 'X6511', 'pins': [{'pad': '1', 'name': '1', 'net': 'IO1'}, {'pad': '2', 'name': '2', 'net': 'GND'}]}]},
                 'peripherals': {'buttons': [], 'headers': [], 'rgb': None, 'sd': None, 'camera': None, 'display': None}}
        mock = patch.object(facts.pinout_facts, '_source', return_value=(self.source, self.source.read_bytes(), {'pcb-uuid': self.pcb}, self.pcb))
        mock.start(); self.addCleanup(mock.stop)
        mock = patch.object(facts.test_firmware, 'inspect_board', return_value=board)
        mock.start(); self.addCleanup(mock.stop)
        images = []
        for side in ('front', 'back'):
            image = self.root / (side + '.png')
            Image.new('RGB', (100, 200), 'white').save(image)
            images.append({'path': str(image), 'side': side, 'sha256': hashlib.sha256(image.read_bytes()).hexdigest(),
                           'reviewStatus': 'visually-reviewed', 'regions': [{'id': side + '-j1', 'refs': ['J1'], 'titleZh': '接口', 'titleEn': 'Connector', 'x': 10, 'y': 20, 'w': 20, 'h': 30}]})
        self.request = {'sourcePath': str(self.source), 'productCode': 'TEST-BOARD', 'hardwareVersion': '1.0', 'releaseDate': '2026-10-25', 'images': images}
        self.preview = self.root / 'schematic.png'
        Image.new('RGB', (200, 100), 'white').save(self.preview)
        self.report = self.root / 'report.json'
        self.proof = {'status': 'complete', 'sourceSha256': self.digest, 'files': [{'path': str(self.preview), 'sha256': hashlib.sha256(self.preview.read_bytes()).hexdigest()}]}
        self.report.write_text(json.dumps(self.proof))

    def test_positive_facts_preserve_source_pins_and_compact_provenance(self):
        result = facts.prepare_guide_facts(self.request)
        self.assertEqual(result['source']['sha256'], self.digest)
        self.assertEqual(result['interfaces'][0]['pins'][0]['net'], 'IO1')
        self.assertEqual(result['interfaces'][0]['pins'][0]['modulePins'], [{'number': '1', 'name': 'IO1'}])
        self.assertFalse(result['learningIsolation']['knownResultRead'])
        self.assertEqual(len(result['images']), 2)
        self.assertLess(len(json.dumps(facts.compact_skill_facts(result)).encode()), 40_000)

    def test_invalid_request_identity_version_and_calendar_fail_before_native_read(self):
        bad = [None, [], 'board', {}, dict(self.request, unknown=True)]
        bad += [dict(self.request, productCode=value) for value in ('../outside', '/tmp/out', 'x/../y', 'BOARD;echo', '', 'A' * 81, None)]
        bad += [dict(self.request, hardwareVersion=value) for value in ('../1.0', 'v1.0', '1', True, None)]
        bad += [dict(self.request, releaseDate=value) for value in ('2026-02-30', '2026-1-1', '2026-10-25T00:00:00', None, True)]
        with patch.object(facts.pinout_facts, '_source') as native:
            for request in bad:
                with self.subTest(request=request), self.assertRaises(facts.GuideFactsBlocked):
                    facts.prepare_guide_facts(request)
            native.assert_not_called()

    def test_photo_region_identity_is_unique_across_sides(self):
        request = copy.deepcopy(self.request)
        request['images'][1]['regions'][0]['id'] = request['images'][0]['regions'][0]['id']
        with self.assertRaisesRegex(facts.GuideFactsBlocked, 'across both sides'):
            facts.prepare_guide_facts(request)

    def test_unreviewed_missing_moved_or_unbound_regions_are_rejected(self):
        changes = [lambda i:i.update(regions=[]), lambda i:i.update(reviewStatus='unreviewed'),
                   lambda i:i.update(sha256='0' * 64), lambda i:i['regions'][0].update(x=95),
                   lambda i:i['regions'][0].update(w=float('nan')), lambda i:i['regions'][0].update(refs=['unknown']),
                   lambda i:i['regions'][0].update(refs='J1'), lambda i:i['regions'][0].update(coordinateSpace='guess')]
        for mutate in changes:
            request = copy.deepcopy(self.request); mutate(request['images'][0])
            with self.subTest(request=request), self.assertRaises(facts.GuideFactsBlocked):
                facts.prepare_guide_facts(request)

    def test_derived_assets_require_real_source_and_artifact_hash_binding(self):
        document = {'path': str(self.preview), 'role': 'schematic-preview', 'bindingReportPath': str(self.report)}
        request = dict(self.request, technicalDocuments=[document])
        result = facts.prepare_guide_facts(request)
        self.assertTrue(next(s for s in result['sourceFiles'] if s.get('role') == 'schematic-preview')['binding']['artifactHashVerified'])
        for changes in ({'sourceSha256': '0' * 64}, {'status': 'failed'}, {'files': []}):
            self.report.write_text(json.dumps(dict(self.proof, **changes)))
            with self.subTest(changes=changes), self.assertRaises(facts.GuideFactsBlocked):
                facts.prepare_guide_facts(request)
        with self.assertRaises(facts.GuideFactsBlocked):
            facts.prepare_guide_facts(dict(self.request, technicalDocuments=[{'path': str(self.preview), 'role': 'schematic-preview'}]))

    def test_document_target_or_false_hash_is_not_technical_input(self):
        target = self.root / 'OTHER_UserGuide.md'; target.write_text('known answer')
        documents = [{'path': str(target), 'role': 'technical-source'}, {'path': str(self.preview), 'role': 'target-guide'},
                     {'path': str(self.preview), 'role': 'technical-source', 'sha256': '0' * 64}]
        for document in documents:
            with self.subTest(document=document), self.assertRaises(facts.GuideFactsBlocked):
                facts.prepare_guide_facts(dict(self.request, technicalDocuments=[document]))

    def test_bsp_evidence_rejects_nonexact_commit_and_nonhttps_remote_before_git(self):
        requests = [False, {}, {'path': str(self.root), 'commit': 'main', 'remote': 'https://github.com/o/r.git'},
                    {'path': str(self.root), 'commit': '0' * 40, 'remote': 'file:///tmp/arbitrary'}]
        with patch.object(facts.subprocess, 'run') as git:
            for value in requests:
                with self.subTest(value=value), self.assertRaises(facts.GuideFactsBlocked):
                    facts.prepare_guide_facts(dict(self.request, bspRepository=value))
            git.assert_not_called()

    def test_onboarding_cautions_do_not_carry_p4_revision_advice_into_s31(self):
        config = {'path': str(self.root), 'commit': 'a' * 40, 'remote': 'https://github.com/vendor/board.git'}
        for target in ('esp32s31', 'esp32p4'):
            def git(command, **kwargs):
                if command[-2:] == ['rev-parse', 'HEAD']: text = config['commit']
                elif command[-3:] == ['remote', 'get-url', 'origin']: text = config['remote']
                elif command[-1].endswith('/Kconfig.projbuild'): text = 'depends on IDF_TARGET_' + target.upper()
                elif command[-1].endswith('wt_bsp_project.cmake'): text = 'WT_BSP_BOARD'
                else: text = 'include(wt_bsp_project.cmake)'
                return SimpleNamespace(returncode=0, stdout=text, stderr='')
            with patch.object(facts.subprocess, 'run', side_effect=git):
                value = facts._onboarding(config, 'TEST-BOARD', target)
            if target == 'esp32s31':
                self.assertNotIn('P4', value['cautionZh'] + value['cautionEn'])
                self.assertIn('esp32s31', value['cautionEn'])
                self.assertIn('--preview', value['commands'][0]['shell'])
            else:
                self.assertIn('legacy and newer P4', value['cautionEn'])

    def test_manual_download_uses_pinned_sdk_sequence_for_fusb_main_cpu_only(self):
        document = self.root / 'docs/en/get-started/establish-serial-connection.rst'
        document.parent.mkdir(parents=True)
        document.write_text('press and hold the ``BOOT`` button and then press the ``RESET`` button once. After that release the ``BOOT`` button.')
        config = {'path': str(self.root), 'commit': 'b' * 40, 'remote': 'https://github.com/espressif/esp-idf.git'}
        def git(command, **kwargs):
            if command[-2:] == ['rev-parse', 'HEAD']: text = config['commit']
            elif command[-3:] == ['remote', 'get-url', 'origin']: text = config['remote']
            else: text = 'matching-blob-id'
            return SimpleNamespace(returncode=0, stdout=text, stderr='')
        images = [{'regions': [{'titleZh': 'FUSB', 'refs': ['J2']}]}]
        interfaces = [{'ref': 'J2', 'kind': 'usb'}]
        peripherals = {'buttons': [{'function': 'boot', 'designator': 'SW2'}, {'function': 'reset', 'designator': 'SW1'}]}
        with patch.object(facts.subprocess, 'run', side_effect=git):
            value, source, primary = facts._manual_download(config, images, interfaces, peripherals, 'esp32s31')
        self.assertEqual(value['scope']['connectorRef'], 'J2')
        self.assertEqual(value['scope']['processor'], 'esp32s31')
        self.assertFalse(value['scope']['appliesToCompanionUart'])
        self.assertEqual(value['stepsEn'][1], 'Press and hold BOOT (SW2).')
        self.assertEqual(value['sourceSha256'], hashlib.sha256(document.read_bytes()).hexdigest())
        self.assertIn(config['commit'], primary['url'])
        self.assertNotIn('C61', value['whenEn'])


if __name__ == '__main__':
    unittest.main()
