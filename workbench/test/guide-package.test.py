"""Portable-guide packaging boundaries with tiny real, hash-bound files.

Only the upstream guide-quality evaluator is stubbed: its scientific/content
checks belong to the guide tests. Paths, Markdown parsing, source inventories,
copies, previews, dependency closure and approval hashes are exercised here.
No model, compiler, EDA, physical hardware or production source is invoked.
"""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from PIL import Image

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
from hdk import guide_package as package


class PortableGuideBoundaries(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='guide-package-boundaries-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.original = self.root / 'verified-guide'
        self.materials = self.root / 'old-HDK' / 'test'
        self.firmware = self.materials / 'firmware'
        self.dependencies = self.firmware / 'source'
        self.out = self.root / 'current-run' / 'packager' / '版本-1'
        self.out.mkdir(parents=True)
        self.source_sha = 'c' * 64
        self.run = {'id': 'current-run', 'nodes': {}}
        self.context = {'runId': self.run['id'], 'nodeId': 'packager'}
        self.token = {'kind': 'hdk-node-receipt', 'runId': self.run['id'], 'nodeId': 'verify',
                      'receiptPath': str(self.root / 'verify' / 'receipt.json'), 'receiptSha256': 'd' * 64}
        self.master_path = self.firmware / 'manifest.json'
        self.sop = self.put(self.materials / 'SOP.md', '# SOP\n\n[Build](firmware/BUILD.md)\n'
                            '[Flash](flash.md)\n![Fixture](firmware/fixture.svg)\n'
                            '[Source](firmware/source/components/wt_bsp/README.md)\n')
        self.build = self.put(self.firmware / 'BUILD.md', '# Replay\n\n[Code](source/board.c)\n')
        self.flash = self.put(self.materials / 'flash.md', '# Flash\n\n[Binary](firmware/app.bin)\n')
        self.binary = self.put(self.firmware / 'app.bin', b'actual tiny firmware fixture\0')
        self.fixture = self.put(self.firmware / 'fixture.svg', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0H10"/></svg>')
        self.lock = self.put(self.dependencies / 'dependencies.lock', 'pinned-fixture-lock\n')
        self.code = self.put(self.dependencies / 'board.c', 'int main(void) { return 0; }\n')
        self.vendor = self.put(self.dependencies / 'components/wt_bsp/README.md', '# Frozen dependency\n\n'
                               '[Existing source](../../board.c)\n[Original unavailable page](docs/missing.md)\n')
        self.unlinked = self.put(self.dependencies / 'unlinked/internal.h', '#define REAL_DEPENDENCY 1\n')
        self.index_path = self.dependencies / 'dependency-source-index.json'
        self.index = {'lockSha256': package.digest(self.lock), 'files': [
            self.row(path, self.dependencies) for path in (self.lock, self.code, self.vendor, self.unlinked)]}
        self.save(self.index_path, self.index)
        self.master = {'status': 'compiled', 'boardSourceSha256': self.source_sha,
                       'artifactRoot': str(self.firmware), 'packagePath': str(self.materials.parent),
                       'artifacts': [self.row(path, self.firmware, 'dependencySourceIndex' if path == self.index_path else 'artifact')
                                     for path in (self.build, self.binary, self.fixture, self.index_path)]}
        self.save(self.master_path, self.master)
        self.sop_report = self.materials / 'SOP验收.json'
        self.report = {'status': 'complete', 'errors': [], 'checks': {'sourceBound': True},
                       'references': [{'path': self.master_path.relative_to(self.materials.parent).as_posix(),
                                       'sha256': package.digest(self.master_path)}],
                       'artifacts': [{'path': self.sop.relative_to(self.materials.parent).as_posix(), 'sha256': package.digest(self.sop)}]}
        self.save(self.sop_report, self.report)
        self.facts = {'productCode': 'TEST-TINY', 'hardwareVersion': 'V1.0', 'source': {'sha256': self.source_sha},
                      'sourceFiles': [self.source_row(path, role) for path, role in (
                          (self.sop, 'test-sop'), (self.build, 'build-replay'), (self.flash, 'flash-instructions'),
                          (self.master_path, 'firmware-manifest'))],
                      'primaryDocuments': [{'role': role, 'path': str(path), 'bundlePath': 'sources/' + role + '.md',
                                            'sha256': package.digest(path), 'title': role + ' original title',
                                            'sourceEvidence': {'physicalTestStatus': 'not-run'}}
                                           for path, role in ((self.sop, 'test-sop'), (self.build, 'build-replay'),
                                                              (self.flash, 'flash-instructions'))] + [
                          {'role': 'untouched-source-document', 'path': str(self.fixture),
                           'bundlePath': 'img/unchanged-fixture.svg', 'caption': 'Keep this independent metadata'}],
                      'annotationEvidence': {'reviewedRefs': ['J1', 'J8'], 'originalNames': {'zh': '接口', 'en': 'Connector'}}}
        self.facts_path = self.original / 'sources/board-facts.json'
        self.save(self.facts_path, self.facts)
        self.images = []
        for index, name in enumerate(package.IMAGE_NAMES):
            path = self.original / 'img' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.new('RGB', (2, 2), (index * 30, 80, 150)).save(path)
            self.images.append(path)
        self.guides = []
        for name in ('TEST-TINY_User_Guide.md', 'TEST-TINY_User_Guide_en.md'):
            text = '# Author’s frozen guide\n\nKeep punctuation, whitespace  and `code` unchanged.\n\n'
            text += '\n'.join('[%s](sources/%s.md)' % (role, role) for role in package.ROLES) + '\n\n'
            text += '\n'.join('![approved image](img/%s)' % name for name in package.IMAGE_NAMES) + '\n'
            self.guides.append(self.put(self.original / name, text))
        for role in package.ROLES:
            self.put(self.original / ('sources/' + role + '.md'), 'obsolete flat attachment\n')
        self.put(self.original / 'preview.zh.html', '<p>old preview</p>')
        self.put(self.original / 'preview.en.html', '<p>old preview</p>')
        self.verified = {'status': 'complete', 'qualified': True, 'productCode': 'TEST-TINY',
                         'sourceSha256': self.source_sha, 'outputPath': str(self.original),
                         'physicalTestStatus': 'not-run', 'sourceFiles': [],
                         'proofFiles': [self.source_row(path) for path in sorted(self.original.rglob('*')) if path.is_file()],
                         'qualitySummary': {'checks': {key: True for key in package.REQUIRED_CHECKS}},
                         'humanReview': {'annotations': {'artifactHashes': [self.source_row(path) for path in self.images[:4]]},
                                         'diagram': {'artifactHashes': [self.source_row(path) for path in self.images[4:]]}}}
        self.saved_data = None
        self.api = SimpleNamespace(bound=Mock(return_value=(self.run, self.out.parent.parent, self.out)),
            load=Mock(side_effect=lambda *_: copy.deepcopy(self.verified)),
            foreign_receipt=Mock(side_effect=lambda *_: copy.deepcopy(self.verified) | {'importedReceipt': {'runId': 'old-complete-run'}}),
            write=self.save, assets=lambda items: items, receipt=self.capture)

    @staticmethod
    def put(path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode())
        return path

    @classmethod
    def save(cls, path, value):
        return cls.put(Path(path), json.dumps(value, ensure_ascii=False, indent=2))

    @staticmethod
    def source_row(path, role=None):
        row = {'path': str(path), 'sha256': package.digest(path), 'bytes': path.stat().st_size}
        if role is not None: row['role'] = role
        return row

    @classmethod
    def row(cls, path, base, role=None):
        return cls.source_row(path, role) | {'relativePath': path.relative_to(base).as_posix()}

    def capture(self, operation, data, run, out, artifacts, extra):
        self.saved_data = data
        return {'operation': operation, **extra}

    def execute(self, value=None):
        checks = [{'id': key, 'passed': True} for key in package.REQUIRED_CHECKS]
        with patch.object(package.guide_reference, 'evaluate_guide_bundle', return_value={'passed': True, 'checks': checks}):
            return package.package(self.token if value is None else value, self.context, self.api)

    def test_commonmark_links_include_reference_and_html_but_ignore_code(self):
        text = ('[inline](one.md) ![image](img/a.png) [reference][target]\n\n'
                '[target]: <reference%20file.md> "title"\n\n'
                '`[fake](inline-code.md)`\n\n```md\n[fake](fenced.md)\n```\n\n'
                '<a href="html.md">HTML</a><img src="html.png"/>\n')
        self.assertEqual(set(package.markdown_urls(text)), {'one.md', 'img/a.png', 'reference%20file.md', 'html.md', 'html.png'})

    def test_href_rewrite_changes_only_the_three_destinations(self):
        original = self.guides[0].read_text()
        replacements = {'sources/' + role + '.md': 'sources/test-materials/' + role + '.md' for role in package.ROLES}
        changed, counts = package.rewrite_attachment_links(original, replacements)
        self.assertEqual(set(counts.values()), {1})
        restored = changed
        for old, new in replacements.items(): restored = restored.replace('](' + new + ')', '](' + old + ')')
        self.assertEqual(restored, original)
        self.assertEqual(changed.count('Keep punctuation, whitespace  and `code` unchanged.'), 1)
        with self.assertRaises(ValueError): package.rewrite_attachment_links(original + '\n[duplicate](sources/test-sop.md)', replacements)

    def test_href_rewrite_keeps_old_and_new_links_inside_code_byte_for_byte(self):
        replacements = {'sources/' + role + '.md': 'sources/test-materials/' + role + '.md' for role in package.ROLES}
        prose = self.guides[0].read_text()
        code = '\n\n```markdown\n' + '\n'.join('[example](' + url + ')' for url in [*replacements, *replacements.values()]) + '\n```\n'
        code += '\n'.join('`[inline example](' + url + ')`' for url in [*replacements, *replacements.values()]) + '\n'
        changed, counts = package.rewrite_attachment_links(prose + code, replacements)
        expected_prose = prose
        for old, new in replacements.items(): expected_prose = expected_prose.replace('](' + old + ')', '](' + new + ')')
        self.assertEqual(changed, expected_prose + code)
        self.assertEqual(counts, {old: 1 for old in replacements})

    def test_full_package_preserves_approved_six_images_authors_and_dependency_inventory(self):
        old_approval = copy.deepcopy(self.verified['humanReview'])
        result = self.execute()
        destination = Path(result['packagePath'])
        manifest = json.loads((destination / 'package-manifest.json').read_text())
        inventory = {row['path']: row for row in manifest['files']}
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(self.verified['humanReview'], old_approval)
        self.assertEqual(self.saved_data['physicalTestStatus'], 'not-run')
        for image in self.images:
            self.assertEqual(package.digest(destination / 'img' / image.name), package.digest(image))
        self.assertEqual(len(self.saved_data['imageEvidence']), 6)
        for path in (self.code, self.lock, self.vendor, self.unlinked, self.index_path, self.master_path, self.sop_report):
            target = 'sources/test-materials/' + path.relative_to(self.materials).as_posix()
            self.assertIn(target, inventory)
            self.assertEqual(package.digest(destination / target), package.digest(path))
        for role in package.ROLES: self.assertNotIn('sources/' + role + '.md', inventory)
        for before in self.guides:
            after = (destination / before.name).read_text()
            replacements = {item['to']: item['from'] for edit in manifest['authorContent'] if edit['path'] == before.name for item in edit['replacements']}
            for new, old in replacements.items(): after = after.replace('](' + new + ')', '](' + old + ')')
            self.assertEqual(after, before.read_text())
        self.assertNotEqual((destination / 'preview.zh.html').read_text(), '<p>old preview</p>')
        limitations = manifest['localLinkClosure']['sourceDocumentationLimitations']
        self.assertEqual(len(limitations), 1)
        self.assertTrue(limitations[0]['originalTargetMissing'])
        self.assertEqual(limitations[0]['sourceDocumentSha256'], package.digest(self.vendor))
        self.assertEqual(manifest['testMaterials']['dependencyEntries'], 4)
        original_facts = json.loads(self.facts_path.read_text())
        delivered_facts = json.loads((destination / 'sources/board-facts.json').read_text())
        restored_facts = copy.deepcopy(delivered_facts)
        changes = manifest['factsMetadataRelocation']
        self.assertTrue(changes['onlyThreeBundlePathsChanged'])
        self.assertEqual(changes['originalSha256'], package.digest(self.facts_path))
        self.assertEqual(changes['deliveredSha256'], package.digest(destination / 'sources/board-facts.json'))
        self.assertEqual({row['role'] for row in changes['fields']}, set(package.ROLES))
        self.assertEqual(len(changes['fields']), 3)
        for before, delivered, restored in zip(original_facts['primaryDocuments'], delivered_facts['primaryDocuments'], restored_facts['primaryDocuments']):
            if before['role'] in package.ROLES:
                self.assertNotEqual(delivered['bundlePath'], before['bundlePath'])
                expected = 'sources/test-materials/' + Path(before['path']).relative_to(self.materials).as_posix()
                self.assertEqual(delivered['bundlePath'], expected)
                self.assertTrue((destination / delivered['bundlePath']).is_file())
                restored['bundlePath'] = before['bundlePath']
            else:
                self.assertEqual(delivered, before)
        self.assertEqual(restored_facts, original_facts, 'Only the three attachment bundlePath values may change; all other machine facts are frozen')
        self.assertEqual(json.loads(self.facts_path.read_text()), original_facts)

    def test_attachment_machine_metadata_requires_unique_matching_original_sources(self):
        original = copy.deepcopy(self.facts)
        mutations = (
            lambda facts: facts['primaryDocuments'].append(copy.deepcopy(facts['primaryDocuments'][0])),
            lambda facts: facts['primaryDocuments'][0].update(path=str(self.flash)),
            lambda facts: facts['primaryDocuments'][0].update(bundlePath='sources/unbound-flat-copy.md'),
            lambda facts: facts['primaryDocuments'].pop(0),
        )
        for mutate in mutations:
            self.facts = copy.deepcopy(original)
            mutate(self.facts)
            self.save(self.facts_path, self.facts)
            self.verified['proofFiles'] = [self.source_row(self.facts_path) if item['path'] == str(self.facts_path) else item
                                          for item in self.verified['proofFiles']]
            with self.subTest(documents=self.facts['primaryDocuments']), self.assertRaisesRegex(ValueError, '机器元数据'):
                self.execute()

    def test_current_and_compact_receipt_selection_calls_the_original_loader(self):
        for kind in ('hdk-node-receipt', 'hdk-node-receipt-ref'):
            value = self.token | {'kind': kind}
            data, source = package._source_selection(value, self.run, self.api)
            self.assertEqual(data['status'], 'complete')
            self.api.load.assert_called_with(value, self.run, package.SOURCE_OPERATION)
            self.assertEqual(source['receiptSha256'], self.token['receiptSha256'])

    def test_foreign_selection_is_explicit_and_calls_foreign_receipt_verifier(self):
        value = {'receiptPath': str(self.root / 'old-run/receipt.json')}
        _, source = package._source_selection(value, self.run, self.api)
        self.api.foreign_receipt.assert_called_once_with(value['receiptPath'], package.SOURCE_OPERATION)
        self.assertEqual(source, {'runId': 'old-complete-run'})
        for invalid in (str(value['receiptPath']), value | {'runId': 'forged'}, {'kind': 'ordinary-json'}):
            with self.subTest(value=invalid), self.assertRaises(ValueError): package._source_selection(invalid, self.run, self.api)

    def test_incomplete_unqualified_or_false_original_checks_are_rejected(self):
        for mutation in ({'status': 'candidate'}, {'qualified': False}, {'sourceSha256': 'invalid'},
                         {'qualitySummary': {'checks': {}}}, {'qualitySummary': {'checks': {key: key != 'source-unchanged' for key in package.REQUIRED_CHECKS}}}):
            current = copy.deepcopy(self.verified) | mutation
            self.api.load.side_effect = lambda *_, current=current: current
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): package._source_selection(self.token, self.run, self.api)

    def test_loader_rejections_are_never_replaced_by_unverified_disk_reads(self):
        for method, value in ((self.api.load, self.token), (self.api.foreign_receipt, {'receiptPath': '/untrusted/receipt.json'})):
            method.side_effect = ValueError('source identity is not current and verified')
            with self.assertRaisesRegex(ValueError, 'source identity'): package._source_selection(value, self.run, self.api)

    def test_current_source_is_revalidated_before_receipt_publication(self):
        changed = copy.deepcopy(self.verified) | {'sourceRevisionMarker': 'changed during packaging'}
        for index, second in enumerate((ValueError('source receipt expired during packaging'), changed)):
            attempt = self.out / ('final-source-check-' + str(index))
            attempt.mkdir()
            self.api.bound.return_value = (self.run, self.out.parent.parent, attempt)
            self.api.load.reset_mock()
            self.api.load.side_effect = [copy.deepcopy(self.verified), second]
            self.saved_data = None
            with self.subTest(second=type(second).__name__), self.assertRaisesRegex(ValueError, 'expired|发生变化'):
                self.execute()
            self.assertEqual(self.api.load.call_count, 2)
            self.assertIsNone(self.saved_data, 'A package whose source expired or changed must not publish a capability receipt')

    def test_foreign_source_identity_is_revalidated_before_receipt_publication(self):
        first = copy.deepcopy(self.verified) | {'importedReceipt': {'runId': 'old-complete-run', 'receiptSha256': '1' * 64}}
        second = copy.deepcopy(first)
        second['importedReceipt']['receiptSha256'] = '2' * 64
        self.api.foreign_receipt.side_effect = [first, second]
        with self.assertRaisesRegex(ValueError, '发生变化'):
            self.execute({'receiptPath': str(self.root / 'old-run/receipt.json')})
        self.assertEqual(self.api.foreign_receipt.call_count, 2)
        self.assertIsNone(self.saved_data, 'A changed foreign receipt identity cannot be published as the originally selected guide')

    def test_learning_run_cannot_be_promoted_to_an_execution_package(self):
        self.run['learningId'] = 'candidate'
        with self.assertRaisesRegex(ValueError, '普通执行'): self.execute()
        self.api.load.assert_not_called()

    def test_missing_or_changed_image_approval_fails(self):
        self.verified['humanReview']['diagram']['artifactHashes'][0]['sha256'] = 'f' * 64
        with self.assertRaisesRegex(ValueError, '人工批准'): self.execute()

    def test_changed_source_hash_and_unlisted_dependency_cannot_be_copied(self):
        self.unlinked.write_text('changed after the index was frozen')
        with self.assertRaisesRegex(ValueError, 'SHA|字节数'): self.execute()

    def test_changed_dependency_index_and_lock_are_rejected(self):
        self.lock.write_text('different pinned dependency\n')
        with self.assertRaisesRegex(ValueError, 'lock'): self.execute()

    def test_manifest_rows_require_exact_paths_bytes_and_sha(self):
        row = self.row(self.code, self.dependencies)
        for patch_row in ({'relativePath': '../board.c'}, {'bytes': True}, {'bytes': row['bytes'] + 1},
                          {'sha256': 'not-sha'}, {'path': str(self.sop)}):
            with self.subTest(patch=patch_row), self.assertRaises(ValueError): package._bound_row(row | patch_row, self.dependencies)

    def test_source_files_and_relative_targets_reject_escape_and_symlinks(self):
        link = self.root / 'symlink.c'; link.symlink_to(self.code)
        directory_link = self.root / 'linked-source'; directory_link.symlink_to(self.dependencies, target_is_directory=True)
        for path in (link, directory_link / 'board.c', Path(str(self.dependencies) + '/../source/board.c')):
            with self.subTest(path=path), self.assertRaises(ValueError): package._file(path)
        for target in ('../escape', '/absolute', 'a/../b', './file', 'a\\b', '.'):
            with self.subTest(target=target), self.assertRaises(ValueError): package._relative(target)

    def test_markdown_paths_cannot_escape_or_use_local_schemes(self):
        parent = self.out / 'bundle'
        for url in ('../../outside.md', '%2e%2e/%2e%2e/outside.md', '/absolute.md', 'file:///etc/passwd', 'javascript:alert(1)', 'a%5Cb.md'):
            with self.subTest(url=url), self.assertRaises(ValueError): package._local(url, parent, parent)
        self.assertIsNone(package._local('https://example.test/remote', parent, parent))
        self.assertIsNone(package._local('#same-page', parent, parent))

    def test_copy_conflicting_destinations_and_source_hashes_are_rejected(self):
        plan = package.CopyPlan(self.out / 'bundle')
        plan.add(self.code, 'code.c', package.digest(self.code))
        plan.add(self.code, 'code.c', package.digest(self.code))
        self.assertEqual(len(plan.entries), 1)
        with self.assertRaisesRegex(ValueError, '冲突'): plan.add(self.lock, 'code.c', package.digest(self.lock))
        with self.assertRaisesRegex(ValueError, '冲突'): plan.add(self.code, 'other.c', 'e' * 64)

    def test_copy_budget_is_enforced_before_writing(self):
        with patch.object(package, 'MAX_FILES', 1):
            plan = package.CopyPlan(self.out / 'file-budget')
            plan.add(self.code, 'one.c', package.digest(self.code))
            with self.assertRaisesRegex(ValueError, '预算'): plan.add(self.lock, 'two.lock', package.digest(self.lock))
            self.assertFalse(plan.root.exists())
        with patch.object(package, 'MAX_BYTES', self.code.stat().st_size - 1):
            with self.assertRaisesRegex(ValueError, '预算'):
                package.CopyPlan(self.out / 'byte-budget').add(self.code, 'one.c', package.digest(self.code))

    def test_copy_rechecks_hash_after_planning_and_never_overwrites_existing_root(self):
        plan = package.CopyPlan(self.out / 'bundle')
        plan.add(self.code, 'code.c', package.digest(self.code))
        self.code.write_text('tampered after planning')
        with self.assertRaisesRegex(ValueError, '来源SHA'): plan.copy()
        existing = package.CopyPlan(self.out / 'existing'); existing.root.mkdir()
        self.put(existing.root / 'untouched.txt', 'keep')
        with self.assertRaisesRegex(ValueError, '禁止覆盖'): existing.copy()
        self.assertEqual((existing.root / 'untouched.txt').read_text(), 'keep')

    def closure_plan(self, source, text):
        self.put(source, text)
        plan = package.CopyPlan(self.out / 'closure')
        relative = 'sources/test-materials/' + source.relative_to(self.materials).as_posix()
        plan.add(source, relative, package.digest(source))
        return plan, relative

    def test_preexisting_vendor_missing_links_are_audited_not_claimed_as_pass(self):
        plan, relative = self.closure_plan(self.vendor, '# Vendor\n\n[Unavailable](docs/missing.md)\n')
        closure = package._closure(plan, [relative], self.materials, {})
        self.assertEqual(closure['links'], [])
        self.assertEqual(len(closure['sourceDocumentationLimitations']), 1)
        self.assertIn('not an operational', closure['sourceDocumentationLimitations'][0]['scope'])

    def test_new_missing_operational_link_is_rejected_even_under_materials(self):
        plan, relative = self.closure_plan(self.sop, '# SOP\n\n[New missing](missing.md)\n')
        with self.assertRaisesRegex(ValueError, '可信SHA'): package._closure(plan, [relative], self.materials, {})

    def test_existing_but_uninventoried_vendor_link_is_rejected(self):
        self.put(self.vendor.parent / 'docs/exists.md', '# Not frozen\n')
        plan, relative = self.closure_plan(self.vendor, '# Vendor\n\n[Unbound](docs/exists.md)\n')
        with self.assertRaisesRegex(ValueError, '可信SHA'): package._closure(plan, [relative], self.materials, {})

    def test_dependency_index_must_be_present_and_lock_cross_bound(self):
        self.master['artifacts'] = [row for row in self.master['artifacts'] if row['role'] != 'dependencySourceIndex']
        self.save(self.master_path, self.master)
        self.facts['sourceFiles'][-1] = self.source_row(self.master_path, 'firmware-manifest')
        with self.assertRaisesRegex(ValueError, '依赖源码索引'):
            package._materials(self.facts, package.CopyPlan(self.out / 'bundle'))

    def test_new_sop_report_must_bind_both_previously_frozen_anchors(self):
        self.report['artifacts'][0]['sha256'] = 'a' * 64
        self.save(self.sop_report, self.report)
        with self.assertRaisesRegex(ValueError, '相互绑定'):
            package._materials(self.facts, package.CopyPlan(self.out / 'bundle'))


if __name__ == '__main__':
    unittest.main()
