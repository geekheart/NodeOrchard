"""SOP-only readiness correction on tiny real, SHA-bound build inventories.

No build, model, renderer or hardware is run. Only the independent build
validator is stubbed; inventory, manifest refresh, JSON writes and copy/source
hash checks use the real private HDK core.
"""
import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from hdk import full_sop_runtime as runtime
from hdk import full_dag as shared_core


class SOPRuntimeBoundaries(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='full-sop-runtime-boundaries-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.out = self.root / 'current-attempt'
        self.package = self.out / 'package'
        self.area = self.package / 'firmware'
        self.core = runtime.private_core()
        self.core._validate_build = Mock(return_value={'status': 'complete', 'checks': {'actualFixtureBoundary': True}, 'errors': []})
        self.reports = {}
        self.paths = {'legacy': self.area / 'firmware-manifest.json', 'v3': self.area / 'variants/p4-v3/firmware-manifest.json',
                      'c61': self.area / 'C61/firmware-manifest.json'}
        self.guide = self.put(self.area / 'C61/C61烧录说明.md', '# C61 application\n\n' + runtime.OLD_PARAGRAPH + '\n\nKeep all other text unchanged.\n')
        self.protected = {}
        for name in ('c61', 'v3', 'legacy'):
            area = self.paths[name].parent
            files = []
            for filename, role, content in [('source/main.c', 'source', 'void app_main(void) { /* unchanged compiled source */ }\n'),
                ('app.bin', 'applicationBin', b'compiled application\0' + name.encode()), ('app.elf', 'elf', b'ELF fixture\0' + name.encode()),
                ('flasher_args.json', 'flashArgs', json.dumps({'flash_files': {'0x10000': 'app.bin'}, 'before': 'default_reset'}))]:
                path = self.put(area / filename, content)
                self.protected[str(path)] = path.read_bytes()
                files.append(self.entry(path, area, role))
            if name == 'c61': files.append(self.entry(self.guide, area, 'companionFlashGuide'))
            if name == 'legacy':
                for child in ('c61', 'v3'):
                    files.append(self.entry(self.paths[child], area, 'companionManifest' if child == 'c61' else 'revisionManifest'))
                    files.extend(dict(item, relativePath=Path(item['path']).relative_to(area).as_posix()) for item in self.reports[child]['artifacts'])
            report = {'status': 'compiled', 'target': 'esp32c61' if name == 'c61' else 'esp32p4',
                'boardSourceSha256': 'a' * 64, 'physicalTestStatus': 'not-run', 'manifestPath': str(self.paths[name]),
                'artifactRoot': str(area), 'packagePath': str(self.package), 'artifacts': files,
                'tests': [{'id': name + '-' + str(index), 'operatorSteps': ['Keep fixture isolated.', runtime.OLD_STEP],
                           'fixtureDesign': {'pins': [[3, 4], [4, 5]], 'gpioMode': 'source-defined', 'physicalTestStatus': 'not-run'}}
                          for index in range(1 if name == 'c61' else 2)],
                'flashOffsets': {'app': '0x10000'}, 'buildCommand': ['idf.py', 'build'], 'warning': 'not physically tested'}
            if name == 'legacy':
                report['companion'] = {'manifestPath': str(self.paths['c61']), 'protocol': 'hello-then-fixture'}
                report['revisionVariants'] = [{'family': 'v3', 'manifestPath': str(self.paths['v3'])}]
            self.reports[name] = report
            self.core.replace_json(self.paths[name], report)
        self.report = self.reports['legacy']
        self.before = {item['path']: copy.deepcopy(item) for item in self.core.inventory(self.package)}
        self.source = self.root / 'compiled-source'
        shutil.copytree(self.package, self.source)
        self.copies = [{'path': path, 'source': str(self.source / Path(path).relative_to(self.package)),
                        'sha256': item['sha256'], 'deliveredSha256': item['sha256'], 'metadataRelocated': path in map(str, self.paths.values())}
                       for path, item in self.before.items()]

    @staticmethod
    def put(path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode())
        return path

    @staticmethod
    def entry(path, area, role):
        return {'path': str(path), 'relativePath': path.relative_to(area).as_posix(), 'role': role,
                'sha256': runtime.sha(path), 'bytes': path.stat().st_size}

    def normalize(self):
        return runtime.normalize_aggregate(self.report, self.package, self.copies, self.core)

    def save_report(self, name='legacy'):
        self.core.replace_json(self.paths[name], self.reports[name])

    def receipt_fixture(self):
        report, checked, copies, evidence, protected = self.normalize()
        markdown = self.package / 'SOP.md'
        self.put(markdown, '# SOP\n\n[C61 guide](' + self.core.sop._link(str(self.guide), markdown.parent) + ')\n')
        data = {'build': report, 'rendered': {'markdownPath': str(markdown)}, 'reviewFiles': [], 'proofFiles': []}
        implementation = {'path': str(Path(runtime.__file__).resolve()), 'sha256': runtime.sha(runtime.__file__)}
        original = SimpleNamespace(bound=Mock(return_value=('bound',)), load=Mock(return_value=('loaded',)),
            assets=lambda files: files, receipt=Mock(return_value={'status': 'complete'}))
        state = {'normalization': evidence, 'protected': protected, 'package': self.package, 'copies': copies,
                 'sourceReceipt': {'kind': 'hdk-node-receipt', 'runId': 'run', 'nodeId': 'aggregate'}}
        return runtime._ReceiptAPI(original, self.core, state, implementation), original, data

    def test_only_exact_readiness_instructions_and_four_owned_files_change(self):
        original_reports = copy.deepcopy(self.reports)
        result, checked, copies, evidence, protected = self.normalize()
        self.assertEqual(checked['status'], 'complete')
        self.assertEqual(len(evidence['changes']), 4)
        self.assertEqual({item['path'] for item in evidence['changes']},
                         {path.relative_to(self.package).as_posix() for path in [self.guide, *self.paths.values()]})
        self.assertEqual({key: len(value) for key, value in evidence['operatorStepFields'].items()}, {'legacy': 2, 'v3': 2, 'c61': 1})
        self.assertEqual(self.guide.read_text(), '# C61 application\n\n' + runtime.NEW_PARAGRAPH + '\n\nKeep all other text unchanged.\n')
        for name, path in self.paths.items():
            updated = self.core.read(path)
            self.assertNotIn(runtime.OLD_STEP, json.dumps(updated, ensure_ascii=False))
            self.assertEqual(sum(step == runtime.NEW_STEP for test in updated['tests'] for step in test['operatorSteps']), 1 if name == 'c61' else 2)
            restored = copy.deepcopy(updated)
            restored['tests'] = original_reports[name]['tests']; restored['artifacts'] = original_reports[name]['artifacts']
            self.assertEqual(restored, original_reports[name])
        self.assertEqual(self.core._validate_build.call_count, 3)
        self.assertTrue(all(item['documentationCorrected'] for item in copies if item['path'] in {str(self.guide), *map(str, self.paths.values())}))
        self.assertEqual(evidence['physicalTestStatus'], 'not-run')

    def test_child_and_master_inventory_hashes_refresh_but_every_binary_source_and_flash_byte_stays(self):
        result, _, _, evidence, protected = self.normalize()
        for path, body in self.protected.items(): self.assertEqual(Path(path).read_bytes(), body)
        for name, path in self.paths.items():
            for row in self.core.read(path)['artifacts']:
                self.assertEqual(row['sha256'], runtime.sha(row['path']))
                self.assertEqual(row['bytes'], Path(row['path']).stat().st_size)
        child_rows = [row for row in result['artifacts'] if row['path'] in {str(self.paths['c61']), str(self.paths['v3'])}]
        self.assertEqual(len(child_rows), 2)
        for row in child_rows: self.assertNotEqual(row['sha256'], self.before[row['path']]['sha256'])
        self.assertEqual({item['path'] for item in evidence['compiledImageEvidence']},
                         {Path(path).relative_to(self.package).as_posix() for path in self.protected if not path.endswith('.c')})

    def test_normalization_is_idempotent_and_keeps_original_compiled_copies_untouched(self):
        first, _, copies, _, _ = self.normalize()
        after = {item['path']: item['sha256'] for item in self.core.inventory(self.package)}
        _, _, _, evidence, _ = runtime.normalize_aggregate(first, self.package, copies, self.core)
        self.assertEqual(evidence['changes'], [])
        self.assertEqual(after, {item['path']: item['sha256'] for item in self.core.inventory(self.package)})
        for row in copies: self.assertEqual(runtime.sha(row['source']), row['sha256'])

    def test_missing_extra_and_variant_operator_steps_are_rejected(self):
        original = copy.deepcopy(self.report)
        for kind in ('missing', 'extra', 'variant'):
            self.report = copy.deepcopy(original); self.reports['legacy'] = self.report
            if kind == 'missing': self.report['tests'].pop()
            elif kind == 'extra': self.report['tests'].append(copy.deepcopy(self.report['tests'][0]))
            else: self.report['tests'][0]['operatorSteps'][1] = runtime.OLD_STEP + ' Extra unsupported claim.'
            self.save_report()
            with self.subTest(kind=kind), self.assertRaises(ValueError): self.normalize()

    def test_guide_requires_one_exact_paragraph_and_rejects_variant_ready_claims(self):
        for text in ('# Missing paragraph', runtime.OLD_PARAGRAPH + '\n' + runtime.OLD_PARAGRAPH,
                     runtime.OLD_PARAGRAPH.replace('两芯片应用READY', '两芯片应用READY(variant)')):
            self.guide.write_text(text)
            with self.subTest(text=text), self.assertRaises(ValueError): self.normalize()

    def test_paragraph_replacement_preserves_every_other_crlf_byte(self):
        before = ('# C61\r\n\r\n' + runtime.OLD_PARAGRAPH + '\r\n\r\nKeep two spaces  here.\r\n').encode()
        self.guide.write_bytes(before)
        self.normalize()
        self.assertEqual(self.guide.read_bytes(), before.replace(runtime.OLD_PARAGRAPH.encode(), runtime.NEW_PARAGRAPH.encode()))

    def test_current_manifest_topology_and_owned_paths_cannot_change(self):
        self.report['revisionVariants'].append(copy.deepcopy(self.report['revisionVariants'][0])); self.save_report()
        with self.assertRaisesRegex(ValueError, '唯一'): self.normalize()

    def test_symlink_and_foreign_output_directories_are_rejected(self):
        alias = self.root / 'package-link'; alias.symlink_to(self.package, target_is_directory=True)
        with self.assertRaises(ValueError): runtime.normalize_aggregate(self.report, alias, self.copies, self.core)
        foreign = self.put(self.root / 'foreign.json', '{}')
        self.report['companion']['manifestPath'] = str(foreign); self.save_report()
        with self.assertRaises(ValueError): self.normalize()

    def test_changed_source_copy_cannot_be_relabelled_as_documentation_correction(self):
        Path(self.copies[0]['source']).write_bytes(b'tampered original compiled source')
        with self.assertRaisesRegex(ValueError, '原始compiled'): self.normalize()

    def test_protected_topology_or_code_changes_during_refresh_are_rejected(self):
        original = self.core._refresh_report
        def alter(report):
            report['flashOffsets']['app'] = '0x20000'
            return original(report)
        self.core._refresh_report = alter
        with self.assertRaisesRegex(ValueError, '工程/烧录事实'): self.normalize()

    def test_protected_source_changed_during_refresh_is_rejected(self):
        original = self.core._refresh_report
        source = next(path for path in self.protected if path.endswith('.c'))
        def alter(report):
            Path(source).write_text('unauthorized source change')
            return original(report)
        self.core._refresh_report = alter
        with self.assertRaisesRegex(ValueError, '受保护'): self.normalize()

    def test_inventory_entries_cannot_be_added_even_when_the_added_file_is_already_present(self):
        original = self.core._refresh_report
        def alter(report):
            report['artifacts'].append(copy.deepcopy(report['artifacts'][0]))
            return original(report)
        self.core._refresh_report = alter
        with self.assertRaisesRegex(ValueError, '拓扑|增删'): self.normalize()

    def test_hardware_pass_claims_cannot_be_inherited(self):
        self.report['physicalTestStatus'] = 'passed'; self.save_report()
        with self.assertRaisesRegex(ValueError, '硬件实测'): self.normalize()

    def test_receipt_adds_real_md_review_and_implementation_proofs_without_intercepting_load_or_bound(self):
        api, original, data = self.receipt_fixture()
        self.assertEqual(api.bound('unchanged-bound'), ('bound',)); original.bound.assert_called_once_with('unchanged-bound')
        self.assertEqual(api.load('unchanged-load'), ('loaded',)); original.load.assert_called_once_with('unchanged-load')
        api.receipt(runtime.OPERATION, data, {'id': 'run'}, self.out, [{'path': 'already-rendered'}], extra={'status': 'complete'})
        args, kwargs = original.receipt.call_args
        delivered = args[1]
        self.assertEqual(data['reviewFiles'], [], 'The original caller data must remain untouched')
        self.assertEqual(delivered['reviewFiles'][0]['path'], str(self.guide))
        self.assertEqual(delivered['reviewFiles'][0]['sha256'], runtime.sha(self.guide))
        self.assertEqual(delivered['reviewFiles'][0]['kind'], 'companion-flash-guide')
        self.assertIn(str(Path(runtime.__file__).resolve()), [row['path'] for row in delivered['proofFiles']])
        proof = self.out / 'C61附录文档规范化.json'
        self.assertTrue(proof.is_file()); self.assertEqual(delivered['documentationNormalization']['reportPath'], str(proof))
        self.assertEqual(kwargs['extra']['physicalTestStatus'], 'not-run')
        self.assertTrue(any(item.get('path') == str(self.guide) for item in args[4]))

    def test_receipt_rechecks_compiled_bytes_original_sources_and_required_link(self):
        api, original, data = self.receipt_fixture()
        compiled = next(iter(self.protected)); Path(compiled).write_bytes(b'changed after SOP rendering')
        with self.assertRaisesRegex(ValueError, 'compiled文件'): api.receipt(runtime.OPERATION, data, {'id': 'run'}, self.out)
        original.receipt.assert_not_called()

    def test_receipt_refuses_missing_link_to_corrected_c61_guide(self):
        api, original, data = self.receipt_fixture(); Path(data['rendered']['markdownPath']).write_text('# SOP without the actual C61 link')
        with self.assertRaisesRegex(ValueError, '可点击链接'): api.receipt(runtime.OPERATION, data, {'id': 'run'}, self.out)
        original.receipt.assert_not_called()

    def test_receipt_rechecks_original_source_bytes_after_rendering(self):
        api, original, data = self.receipt_fixture()
        Path(self.copies[0]['source']).write_bytes(b'original source changed during rendering')
        with self.assertRaisesRegex(ValueError, '原始compiled来源'): api.receipt(runtime.OPERATION, data, {'id': 'run'}, self.out)
        original.receipt.assert_not_called()

    def test_receipt_rejects_further_changes_to_normalized_c61_document(self):
        api, original, data = self.receipt_fixture()
        self.guide.write_bytes(self.guide.read_bytes() + b'unauthorized late document text')
        with self.assertRaisesRegex(ValueError, 'compiled文件'): api.receipt(runtime.OPERATION, data, {'id': 'run'}, self.out)
        original.receipt.assert_not_called()

    def test_non_sop_operation_is_rejected_before_loading_or_mutating_shared_module(self):
        original = shared_core.relocate_aggregate
        with patch.object(runtime, 'private_core') as private:
            with self.assertRaises(ValueError): runtime.full('hdk.full.build-c61', {}, {}, SimpleNamespace())
            private.assert_not_called()
        self.assertIs(shared_core.relocate_aggregate, original)

    def test_runtime_uses_private_relocation_and_preserves_original_authentication_calls(self):
        original_global = shared_core.relocate_aggregate
        bound, loaded = Mock(return_value='bound'), Mock(return_value='loaded')
        api = SimpleNamespace(bound=bound, load=loaded)
        def delegated(operation, value, context, wrapped):
            self.assertEqual(wrapped.bound(operation, value, context), 'bound')
            self.assertEqual(wrapped.load(value['firmware'], {'id': 'run'}), 'loaded')
            return {'private': True}
        self.core.full = delegated
        original_private = self.core.relocate_aggregate
        value = {'firmware': {'kind': 'hdk-node-receipt', 'runId': 'run'}}
        with patch.object(runtime, 'private_core', return_value=self.core):
            result = runtime.full(runtime.OPERATION, value, {'outputDirectory': str(self.out)}, api)
        self.assertEqual(result, {'private': True}); self.assertIsNot(self.core.relocate_aggregate, original_private)
        self.assertIs(shared_core.relocate_aggregate, original_global)
        bound.assert_called_once(); loaded.assert_called_once()

    def test_runtime_relocation_rejects_a_package_outside_current_attempt_before_copy(self):
        relocate = Mock(); self.core.relocate_aggregate = relocate
        def delegated(operation, value, context, wrapped):
            return self.core.relocate_aggregate(self.report, self.root / 'foreign-package')
        self.core.full = delegated
        with patch.object(runtime, 'private_core', return_value=self.core):
            with self.assertRaisesRegex(ValueError, '能力目录之外'):
                runtime.full(runtime.OPERATION, {}, {'outputDirectory': str(self.out)}, SimpleNamespace())
        relocate.assert_not_called()


if __name__ == '__main__':
    unittest.main()
