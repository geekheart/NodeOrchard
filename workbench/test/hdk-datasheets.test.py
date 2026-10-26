from pathlib import Path
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('hdk_datasheets', Path(__file__).resolve().parents[1] / 'hdk/datasheets.py')
docs = importlib.util.module_from_spec(spec); spec.loader.exec_module(docs)


class DocumentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); self.cache = self.root / 'cache'; self.cache.mkdir()
        self.package = self.root / 'package'; self.package.mkdir()
        self.catalog = self.root / 'catalog.json'
        self.entries = []
        for id, kind, match in [('module-a', 'module-datasheet', {'moduleParts': ['WT-A']}),
                                ('module-b', 'module-datasheet', {'moduleParts': ['WT-B']}),
                                ('chip-a', 'chip-datasheet', {'targets': ['esp32p4']}),
                                ('supply', 'component-datasheet', {'supplierParts': ['C1234']})]:
            path = self.cache / (id + '.pdf'); path.write_bytes(b'%PDF-1.7\n' + id.encode() * 40)
            self.entries.append({'id': id, 'fileName': path.name, 'title': id, 'kind': kind,
                'match': match, 'scope': 'specific scope', 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        self.catalog.write_text(json.dumps({'resources': self.entries}))
        self.facts = {'source': {'sha256': 'a' * 64}, 'board': {'modulePart': 'WT-A', 'targets': ['esp32p4'],
            'components': [{'part': 'SOME-PART', 'supplierPart': 'C1234'}]}}

    def collect(self, **kwargs):
        return docs.collect(self.facts, self.package, catalog_path=self.catalog, cache_path=self.cache, allow_download=False, **kwargs)

    def test_selects_same_module_target_and_sku_not_other_board(self):
        result = self.collect()
        self.assertEqual(result['status'], 'complete')
        self.assertEqual({d['id'] for d in result['documents']}, {'module-a', 'chip-a', 'supply'})
        self.assertFalse((self.package / '重要器件手册/module-b.pdf').exists())
        self.assertTrue(all(result['checks'].values()))
        self.assertEqual(docs.verify(result['indexPath'], self.package)['status'], 'complete')

    def test_missing_or_wrong_hash_cannot_be_claimed_as_manual(self):
        (self.cache / 'module-a.pdf').write_bytes(b'%PDF-1.7\nwrong document' * 5)
        result = self.collect()
        self.assertEqual(result['status'], 'partial')
        self.assertFalse(result['checks']['moduleDocumentPresent'])
        self.assertTrue(any(x['id'] == 'module-a' for x in result['pending']))
        self.assertNotIn('module-a', {d['id'] for d in result['documents']})

    def test_reopen_audit_detects_tamper(self):
        result = self.collect()
        path = self.package / result['documents'][0]['path']; path.write_bytes(b'%PDF-1.7\ntamper' * 5)
        checked = docs.verify(result['indexPath'], self.package)
        self.assertEqual(checked['status'], 'failed'); self.assertEqual(len(checked['errors']), 1)

    def test_no_overwrite_or_destination_symlink(self):
        self.collect()
        with self.assertRaisesRegex(ValueError, '覆盖'): self.collect()
        other = self.root / 'other'; other.mkdir()
        target = self.root / 'symlink-package'; target.mkdir()
        (target / '重要器件手册').symlink_to(other, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, '符号链接'):
            docs.collect(self.facts, target, catalog_path=self.catalog, cache_path=self.cache, allow_download=False)

    def test_private_overlay_supplies_hash_checked_local_pdf_without_changing_public_catalog(self):
        source = self.root / 'private/manual.pdf'; source.parent.mkdir()
        (self.cache / 'module-a.pdf').replace(source)
        original = self.catalog.read_bytes()
        overlay = self.root / 'resources.local.json'
        overlay.write_text(json.dumps({'schemaVersion': 1, 'resources': {
            'module-a': {'sourcePath': str(source), 'downloadEvidencePath': str(self.root / 'private/download.json')}}}))
        result = self.collect(overlay_path=overlay)
        self.assertEqual(result['status'], 'complete')
        module = next(value for value in result['documents'] if value['id'] == 'module-a')
        self.assertEqual(module['sourcePath'], str(source))
        self.assertEqual((self.cache / 'module-a.pdf').read_bytes(), source.read_bytes())
        self.assertEqual(self.catalog.read_bytes(), original)

    def test_overlay_cannot_override_hash_identity_url_matching_or_unknown_resource(self):
        overlay = self.root / 'resources.local.json'
        for resource_id, fields in [
            ('module-a', {'sha256': 'f' * 64}), ('module-a', {'url': 'https://example.invalid/manual.pdf'}),
            ('module-a', {'match': {'targets': ['other-target']}}), ('missing-id', {'sourcePath': str(self.root / 'manual.pdf')}),
            ('module-a', {'sourcePath': 'relative/manual.pdf'}),
        ]:
            with self.subTest(resource_id=resource_id, fields=list(fields)):
                overlay.write_text(json.dumps({'schemaVersion': 1, 'resources': {resource_id: fields}}))
                with self.assertRaises(ValueError): docs.load_catalog(self.catalog, overlay_path=overlay)
        self.assertFalse((self.package / '重要器件手册').exists())

    def test_custom_catalog_does_not_inherit_an_unrelated_machine_overlay(self):
        overlay = self.root / 'resources.local.json'
        overlay.write_text(json.dumps({'schemaVersion': 1, 'resources': {'not-in-custom-catalog': {'sourcePath': str(self.root / 'manual.pdf')}}}))
        with patch.dict(os.environ, {'WORKBENCH_HDK_RESOURCE_OVERLAY': str(overlay)}):
            self.assertEqual(self.collect()['status'], 'complete')

    def test_bundled_catalog_uses_workspace_overlay_and_explicit_override(self):
        workspace = self.root / 'workspace'
        overlay = workspace / 'config/hdk-resources.local.json'; overlay.parent.mkdir(parents=True)
        source = self.root / 'private.pdf'
        overlay.write_text(json.dumps({'schemaVersion': 1, 'resources': {'module-a': {'sourcePath': str(source)}}}))
        with patch.object(docs, 'CATALOG', self.catalog), patch.dict(os.environ, {'WORKBENCH_WORKSPACE_ROOT': str(workspace)}, clear=True):
            catalog = docs.load_catalog(self.catalog)
            self.assertEqual(catalog['resources'][0]['sourcePath'], str(source))
            other = self.root / 'other.local.json'
            other.write_text(json.dumps({'schemaVersion': 1, 'resources': {}}))
            with patch.dict(os.environ, {'WORKBENCH_HDK_RESOURCE_OVERLAY': str(other)}):
                self.assertNotIn('sourcePath', docs.load_catalog(self.catalog)['resources'][0])

    def test_wrong_local_pdf_hash_remains_pending(self):
        (self.cache / 'module-a.pdf').unlink()
        source = self.root / 'wrong.pdf'; source.write_bytes(b'%PDF-1.7\nwrong local PDF' * 10)
        overlay = self.root / 'resources.local.json'
        overlay.write_text(json.dumps({'schemaVersion': 1, 'resources': {'module-a': {'sourcePath': str(source)}}}))
        result = self.collect(overlay_path=overlay)
        self.assertEqual(result['status'], 'partial')
        self.assertTrue(any(value['id'] == 'module-a' for value in result['pending']))
        self.assertNotIn('module-a', {value['id'] for value in result['documents']})


if __name__ == '__main__': unittest.main()
