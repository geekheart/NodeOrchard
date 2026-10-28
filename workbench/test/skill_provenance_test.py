"""Provenance and archival checks use only synthetic temporary Skill trees."""
import errno
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
import skill_provenance
from skill_provenance import SkillProvenance, read_skill_bundle


def _delete_worker(root, request, output):
    try:
        result = SkillProvenance(Path(root), builtin_guard=lambda *_: False).delete(request)
        output.put(('complete', result))
    except Exception as error:
        output.put(('error', str(error)))


class SkillProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()
        self.root = self.directory / 'skills'
        self.root.mkdir()
        self.service = SkillProvenance(self.root, builtin_guard=lambda *_: False)

    def skill(self, name='poster', content='---\nname: poster\n---\nGenerate an image.\n'):
        target = self.root / name
        target.mkdir()
        (target / 'SKILL.md').write_text(content, encoding='utf-8')
        return target

    def created(self, name='poster', operation='create-one'):
        path = self.skill(name)
        return path, self.service.record_create(name, operation)

    def request(self, metadata, name='poster', operation='delete-one'):
        return {'name': name, 'creation_id': metadata['creationId'], 'expected_revision': metadata['revision'],
                'expected_bundle_revision': metadata['bundleRevision'], 'operation_id': operation}

    def test_bundle_fingerprint_covers_auxiliary_files_empty_directories_and_modes(self):
        target = self.skill(); (target / 'empty').mkdir(); (target / 'scripts').mkdir()
        (target / 'scripts' / 'render.py').write_text('print("image")')
        first = read_skill_bundle(target)
        self.assertEqual(first, read_skill_bundle(target))
        self.assertEqual(first['revision'], 'sha256:' + hashlib.sha256((target / 'SKILL.md').read_bytes()).hexdigest())
        self.assertEqual(first['directoryIdentity'], {'dev': target.stat().st_dev, 'ino': target.stat().st_ino})
        self.assertTrue(any(row['path'] == 'empty' and row['kind'] == 'directory' for row in first['files']))
        (target / 'scripts' / 'render.py').write_text('print("changed")')
        second = read_skill_bundle(target)
        self.assertEqual(first['revision'], second['revision']); self.assertNotEqual(first['bundleRevision'], second['bundleRevision'])
        (target / 'scripts' / 'render.py').chmod(0o700)
        self.assertNotEqual(second['bundleRevision'], read_skill_bundle(target)['bundleRevision'])

    def test_bundle_rejects_symbolic_and_hard_links_special_files_and_linked_parents(self):
        target = self.skill(); outside = self.directory / 'outside.txt'; outside.write_text('private')
        linked = target / 'linked'; linked.symlink_to(outside)
        with self.assertRaises(ValueError): read_skill_bundle(target)
        linked.unlink(); os.link(outside, linked)
        with self.assertRaises(ValueError): read_skill_bundle(target)
        linked.unlink(); os.mkfifo(linked)
        with self.assertRaises(ValueError): read_skill_bundle(target)
        linked.unlink(); alias = self.directory / 'alias'; alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError): read_skill_bundle(alias / target.name)
        with self.assertRaises(ValueError): SkillProvenance(alias, builtin_guard=lambda *_: False)

    def test_bundle_limits_and_missing_main_file_fail_closed(self):
        target = self.skill()
        with mock.patch.object(skill_provenance, 'MAX_FILE_BYTES', 4):
            with self.assertRaises(ValueError): read_skill_bundle(target)
        (target / 'extra').write_text('x' * 50)
        with mock.patch.object(skill_provenance, 'MAX_BUNDLE_BYTES', 60):
            with self.assertRaises(ValueError): read_skill_bundle(target)
        with mock.patch.object(skill_provenance, 'MAX_BUNDLE_ENTRIES', 1):
            with self.assertRaises(ValueError): read_skill_bundle(target)
        (target / 'SKILL.md').unlink()
        with self.assertRaises(ValueError): read_skill_bundle(target)

    def test_inspection_is_read_only_and_never_adopts_legacy_skills(self):
        target = self.skill(); bundle = read_skill_bundle(target)
        self.assertIsNone(self.service.inspect_owned('poster', target, bundle))
        self.assertFalse(self.service.ledger.exists())
        self.service.ledger.mkdir(mode=0o700)
        self.assertIsNone(self.service.inspect_owned('poster', target, bundle))
        self.assertEqual(list(self.service.ledger.iterdir()), [])

    def test_creation_is_idempotent_private_and_outside_the_skill_bundle(self):
        target = self.skill(); before = read_skill_bundle(target)
        metadata = self.service.record_create('poster', 'create-one')
        self.assertEqual(metadata, self.service.record_create('poster', 'create-one'))
        self.assertEqual(metadata['origin'], {'kind': 'generated', 'label': '生成', 'canDelete': True})
        self.assertEqual(metadata, self.service.inspect_owned('poster', target, before))
        self.assertEqual(before, read_skill_bundle(target))
        self.assertEqual(self.service.ledger.parent, self.root.parent)
        self.assertNotIn(str(self.directory), json.dumps(metadata))
        for path in [self.service.ledger, *self.service.ledger.rglob('*')]:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)
        with self.assertRaises(ValueError): self.service.record_create('poster', 'different-creation')
        self.skill('another')
        with self.assertRaises(ValueError): self.service.record_create('another', 'create-one')

    def test_creation_needs_safe_identifiers_and_a_confirmed_native_guard(self):
        target = self.skill()
        for name, operation in [('../poster', 'valid'), ('poster', ''), ('poster', '../bad'), ('poster', 'x' * 129)]:
            with self.subTest(name=name, operation=operation):
                with self.assertRaises(ValueError): self.service.record_create(name, operation)
        for guard in [lambda *_: True, lambda *_: None, mock.Mock(side_effect=RuntimeError('private native path'))]:
            service = SkillProvenance(self.root, builtin_guard=guard)
            with self.assertRaises(ValueError): service.record_create('poster', 'protected-create')
            self.assertIsNone(service.inspect_owned('poster', target, read_skill_bundle(target)))
        self.assertTrue(target.exists())

    def test_delete_archives_once_and_returns_a_path_free_receipt(self):
        target, metadata = self.created(); request = self.request(metadata)
        receipt = self.service.delete(request)
        self.assertTrue(receipt['deleted']); self.assertTrue(receipt['archived']); self.assertFalse(target.exists())
        archived = list((self.root / '.archive').iterdir()); self.assertEqual(len(archived), 1)
        self.assertEqual(read_skill_bundle(archived[0])['bundleRevision'], metadata['bundleRevision'])
        self.assertNotIn(str(self.directory), json.dumps(receipt))
        with mock.patch.object(skill_provenance, '_rename_noreplace', side_effect=AssertionError('must not rename twice')):
            self.assertEqual(self.service.delete(request), receipt)
        with self.assertRaises(ValueError): self.service.delete(request | {'expected_revision': 'sha256:' + '0' * 64})
        self.assertIsNone(self.service.inspect_owned('poster', target, {}))

    def test_delete_rejects_unknown_extra_and_mismatched_generation_or_revision(self):
        target, metadata = self.created(); request = self.request(metadata)
        changes = [{'unknown': True}, {'creation_id': str(__import__('uuid').uuid4())}, {'expected_revision': 'sha256:' + '0' * 64},
                   {'expected_bundle_revision': 'sha256:' + '0' * 64}, {'operation_id': '../bad'}, {'name': 'legacy'}]
        self.skill('legacy')
        for change in changes:
            with self.subTest(change=change):
                with self.assertRaises(ValueError): self.service.delete(request | change)
                self.assertTrue(target.exists())
        self.assertFalse((self.root / '.archive').exists())

    def test_complete_bundle_change_or_directory_replacement_revokes_generated_classification(self):
        target, metadata = self.created(); (target / 'extra.txt').write_text('new material')
        self.assertIsNone(self.service.inspect_owned('poster', target, read_skill_bundle(target)))
        with self.assertRaises(ValueError): self.service.delete(self.request(metadata))
        (target / 'extra.txt').unlink(); target.rename(self.root / 'old-poster'); self.skill()
        self.assertIsNone(self.service.inspect_owned('poster', target, read_skill_bundle(target)))
        with self.assertRaises(ValueError): self.service.delete(self.request(metadata))
        self.assertTrue(target.exists())

    def test_root_replacement_cannot_reuse_the_old_ledger_generation(self):
        target, metadata = self.created(); self.root.rename(self.directory / 'old-skills'); self.root.mkdir(); self.skill()
        with self.assertRaises(ValueError): self.service.delete(self.request(metadata))
        self.assertTrue(target.exists())

    def test_recreated_name_gets_a_new_generation_and_old_receipts_cannot_delete_it(self):
        _, metadata = self.created(); request = self.request(metadata); receipt = self.service.delete(request)
        target = self.skill(); fresh = self.service.record_create('poster', 'create-two')
        self.assertNotEqual(fresh['creationId'], metadata['creationId'])
        with self.assertRaises(ValueError): self.service.delete(request | {'operation_id': 'old-generation-new-operation'})
        self.assertEqual(self.service.delete(request), receipt); self.assertTrue(target.exists())
        self.assertEqual(fresh, self.service.inspect_owned('poster', target, read_skill_bundle(target)))

    def test_native_protection_is_rechecked_immediately_before_archival(self):
        target, metadata = self.created(); calls = []
        def guard(*_):
            calls.append(True)
            return len(calls) == 2
        self.service.builtin_guard = guard
        with self.assertRaises(ValueError): self.service.delete(self.request(metadata))
        self.assertEqual(len(calls), 2); self.assertTrue(target.exists())
        self.service.builtin_guard = lambda *_: False
        with mock.patch.object(skill_provenance, '_rename_noreplace', side_effect=AssertionError('must not replay pending')):
            with self.assertRaises(ValueError): self.service.delete(self.request(metadata))
            with self.assertRaises(ValueError): self.service.delete(self.request(metadata, operation='another-delete'))

    def test_a_replacement_or_content_change_during_the_final_guard_is_not_archived(self):
        for replacement in (False, True):
            with self.subTest(replacement=replacement):
                name = 'replacement' if replacement else 'changed-content'; target = self.skill(name)
                metadata = self.service.record_create(name, 'create-' + name); calls = []
                def guard(*_):
                    calls.append(True)
                    if len(calls) == 2:
                        if replacement:
                            target.rename(self.root / 'retained-original'); self.skill(name)
                        else:
                            (target / 'extra.txt').write_text('concurrent material')
                    return False
                self.service.builtin_guard = guard
                with mock.patch.object(skill_provenance, '_rename_noreplace', side_effect=AssertionError('must not archive changed target')):
                    with self.assertRaises(ValueError): self.service.delete(self.request(metadata, name=name, operation='delete-' + name))
                self.assertTrue(target.exists())
                self.service.builtin_guard = lambda *_: False

    def test_pending_rename_failure_is_not_replayed_with_the_same_or_a_new_operation(self):
        target, metadata = self.created(); request = self.request(metadata)
        with mock.patch.object(skill_provenance, '_rename_noreplace', side_effect=OSError(errno.EPERM, 'synthetic denied')) as rename:
            with self.assertRaises(ValueError): self.service.delete(request)
            self.assertEqual(rename.call_count, 1)
        with mock.patch.object(skill_provenance, '_rename_noreplace', side_effect=AssertionError('must not replay')):
            with self.assertRaises(ValueError): self.service.delete(request)
            with self.assertRaises(ValueError): self.service.delete(request | {'operation_id': 'new-delete'})
        self.assertTrue(target.exists()); self.assertIsNone(self.service.inspect_owned('poster', target, read_skill_bundle(target)))

    def test_post_rename_journal_failure_recovers_only_from_the_archived_matching_generation(self):
        target, metadata = self.created(); request = self.request(metadata); write = self.service._write_journal
        def fail_completion(ledger, journal):
            if journal['kind'] == 'delete' and journal['status'] == 'complete':
                raise OSError(errno.EIO, 'synthetic journal failure')
            return write(ledger, journal)
        with mock.patch.object(self.service, '_write_journal', side_effect=fail_completion):
            with self.assertRaises(ValueError): self.service.delete(request)
        self.assertFalse(target.exists())
        with mock.patch.object(skill_provenance, '_rename_noreplace', side_effect=AssertionError('must not replay rename')):
            receipt = self.service.delete(request)
        self.assertTrue(receipt['deleted']); self.assertEqual(self.service.delete(request), receipt)

    def test_changed_archive_cannot_complete_an_unknown_deletion(self):
        _, metadata = self.created(); request = self.request(metadata); write = self.service._write_journal
        def fail_completion(ledger, journal):
            if journal['kind'] == 'delete' and journal['status'] == 'complete': raise OSError(errno.EIO, 'synthetic journal failure')
            return write(ledger, journal)
        with mock.patch.object(self.service, '_write_journal', side_effect=fail_completion):
            with self.assertRaises(ValueError): self.service.delete(request)
        archive = next((self.root / '.archive').iterdir()); (archive / 'SKILL.md').write_text('replaced archive')
        with self.assertRaises(ValueError): self.service.delete(request)
        self.assertEqual((archive / 'SKILL.md').read_text(), 'replaced archive')

    def test_archive_collision_and_symlink_never_replace_existing_data(self):
        target, metadata = self.created(); request = self.request(metadata); archive = self.root / '.archive'; archive.mkdir()
        destination = archive / ('nodeorchard-' + hashlib.sha256(request['operation_id'].encode()).hexdigest()); destination.mkdir()
        (destination / 'keep.txt').write_text('retain')
        with self.assertRaises(ValueError): self.service.delete(request)
        self.assertTrue(target.exists()); self.assertEqual((destination / 'keep.txt').read_text(), 'retain')
        (destination / 'keep.txt').unlink(); destination.rmdir(); archive.rmdir(); archive.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(ValueError): self.service.delete(request)
        self.assertTrue(target.exists())

    def test_ledger_links_or_insecure_permissions_are_not_repaired_or_trusted(self):
        target, metadata = self.created(); request = self.request(metadata)
        index = next((self.service.ledger / 'names').iterdir()); index.chmod(0o644)
        self.assertIsNone(self.service.inspect_owned('poster', target, read_skill_bundle(target)))
        with self.assertRaises(ValueError): self.service.delete(request)
        self.assertEqual(stat.S_IMODE(index.stat().st_mode), 0o644)
        index.chmod(0o600); os.link(index, self.directory / 'linked-record')
        with self.assertRaises(ValueError): self.service.delete(request)
        self.assertTrue(target.exists())

    def test_creation_metadata_failure_can_retry_without_changing_its_generation(self):
        target = self.skill(); write = self.service._write_index; seen = []
        def fail_index(ledger, name, creation_id):
            seen.append(creation_id)
            raise OSError(errno.EIO, 'synthetic index failure')
        with mock.patch.object(self.service, '_write_index', side_effect=fail_index):
            with self.assertRaises(ValueError): self.service.record_create('poster', 'create-one')
        metadata = self.service.record_create('poster', 'create-one')
        self.assertEqual(metadata['creationId'], seen[0]); self.assertTrue(target.exists())
        self.assertEqual(self.service.inspect_owned('poster', target, read_skill_bundle(target)), metadata)

    def test_mutation_fails_closed_without_cross_process_locking(self):
        target = self.skill()
        with mock.patch.object(skill_provenance, 'fcntl', None):
            with self.assertRaises(ValueError): self.service.record_create('poster', 'create-one')
        self.assertFalse(self.service.ledger.exists()); self.assertTrue(target.exists())

    def test_two_processes_repeat_one_delete_receipt_without_a_second_move(self):
        _, metadata = self.created(); request = self.request(metadata); context = multiprocessing.get_context('spawn'); output = context.Queue()
        processes = [context.Process(target=_delete_worker, args=(str(self.root), request, output)) for _ in range(2)]
        for process in processes: process.start()
        try:
            for process in processes: process.join(10)
            self.assertTrue(all(not process.is_alive() and process.exitcode == 0 for process in processes))
            results = [output.get(timeout=2) for _ in processes]
            self.assertEqual([row[0] for row in results], ['complete', 'complete']); self.assertEqual(results[0][1], results[1][1])
            self.assertEqual(len(list((self.root / '.archive').iterdir())), 1)
        finally:
            for process in processes:
                if process.is_alive(): process.terminate(); process.join(2)
            output.close()


if __name__ == '__main__':
    unittest.main()
