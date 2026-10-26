"""Real small-file delivery protocol tests; no model, EDA, or compiler runs.

Reuse the established tiny full-DAG source/build fixtures. Only the external
native/workbook/compiler business validators are substituted; approvals use
the real current-human guard, and copies, SOP rendering, Markdown parsing,
relative verifier processes and ZIP member/hash checks all run on real files.
These fixtures do not establish professional hardware or workbook acceptance.
"""
from pathlib import Path
import copy
import importlib.util
import json
import hashlib
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from hdk import full_dag as core
from hdk import full_delivery as delivery
from hdk import dag_capabilities as actual_api

spec = importlib.util.spec_from_file_location('existing_full_fixture', ROOT / 'test/hdk-full-dag.test.py')
fixtures = importlib.util.module_from_spec(spec); spec.loader.exec_module(fixtures)


class API(fixtures.API):
    def __init__(self, root):
        super().__init__(root)
        self.run.update({'nodes': {}, 'document': {'nodes': [], 'edges': []}})

    def row(self, table, ident):
        if table != 'workflow_runs' or ident != self.run['id']: raise ValueError('wrong current run')
        return copy.deepcopy(self.run)

    def receipt(self, operation, data, run, out, artifacts=(), extra=None):
        result = super().receipt(operation, data, run, out, artifacts, extra)
        self.run['nodes'][result['nodeId']] = {'status': 'complete', 'attempt': 1, 'output': result,
                                              'outputDirectory': str(out)}
        return result

    def load(self, token, run, operation):
        record = self.run['nodes'].get(token.get('nodeId'), {})
        if record.get('status') != 'complete' or record.get('output') != token:
            raise ValueError('stale current attempt')
        return super().load(token, run, operation)

    def reviewed_artifacts(self, run, context, value, files, port='images'):
        return actual_api.reviewed_artifacts(run, context, value, files, port)

    def approve(self, name, token, files):
        ident = 'human-' + name
        artifacts = [dict(x, id=name + '-artifact-' + str(i)) for i, x in enumerate(files)]
        self.run['nodes'][ident] = {'status': 'complete', 'output': token, 'artifacts': artifacts,
            'review': {'decision': 'approved', 'reviewedAt': 'fixture-current-review',
                       'artifactHashes': [{'id': x['id'], 'sha256': x['sha256']} for x in artifacts]}}
        self.run['document']['nodes'].append({'id': ident, 'type': 'human'})

    def call(self, phase, value):
        self.serial += 1; ident = phase + '-' + str(self.serial)
        out = self.root / ident / '版本-1'; out.mkdir(parents=True)
        self.run['document']['nodes'].append({'id': ident, 'type': 'tool'})
        self.run['nodes'][ident] = {'status': 'running', 'attempt': 1, 'outputDirectory': str(out)}
        if phase == 'assemble':
            self.run['document']['edges'] += [{'sourceNode': 'human-' + name, 'targetNode': ident,
                'sourcePort': 'out', 'targetPort': name} for name in ('native', 'process', 'sop')]
        return delivery.full('hdk.full.' + phase, value, {'nodeId': ident, 'outputDirectory': str(out)}, self)


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.base = fixtures.FullDAGTests('test_three_build_relocation_keeps_upstream_immutable_and_supports_actual_sop_contract')
        self.base.setUp(); self.addCleanup(self.base.doCleanups)
        self.root = self.base.root; self.api = API(self.base.output); self.base.api = self.api
        self.facts = self.base.facts
        for name, replacement in [('_validate_build', self.base.compiled),
            ('validate_full_process', lambda *a, **kw: {'passed': True, 'unresolved': core._process_unresolved()})]:
            mocked = patch.object(core, name, side_effect=replacement); mocked.start(); self.addCleanup(mocked.stop)
        mocked = patch.object(core.datasheets, 'verify', return_value={'status': 'complete', 'checks': {'externalFixture': True}})
        mocked.start(); self.addCleanup(mocked.stop)
        fact_token = self.base.facts_receipt()
        reports = {'legacy': self.base.report('legacy'), 'modern': self.base.report('modern', family='v3'),
                   'c61': self.base.report('c61', target='esp32c61')}
        for report in reports.values():
            area = Path(report['artifactRoot']); replay = area / '构建重放.md'
            replay.write_text('```sh\nidf.py -C source build\n```\n', encoding='utf-8')
            report['artifacts'].append(dict(core.file_ref(replay), role='buildReplayGuide', relativePath=replay.name))
            core.replace_json(report['manifestPath'], report)
        build, checked, _ = core.aggregate_builds(self.facts, reports, self.root / 'aggregate')
        firmware = self.base.emit('firmware-aggregate', core._common(self.facts) | {'build': build, 'verification': checked})
        # Production SOP renderer, producing actual SVG/PNG and immutable MD.
        self.api.serial += 1; sop_out = self.api.root / ('sop-source-' + str(self.api.serial)) / '版本-1'; sop_out.mkdir(parents=True)
        os.environ['HDK_NODE_ID'] = sop_out.parent.name
        sop = core.full('hdk.full.sop', {'facts': fact_token, 'firmware': firmware,
            'plan': core.sop.default_plan(core._sop_request(self.facts, build, self.root / 'aggregate'))},
            {'nodeId': sop_out.parent.name, 'outputDirectory': str(sop_out)}, self.api)
        native_root = self.root / 'native'; native_root.mkdir()
        exported = native_root / '项目工程/BOARD.epro2'; exported.parent.mkdir(); exported.write_bytes(self.base.source.read_bytes())
        preview = native_root / 'review.png'; preview.write_bytes(b'fixture native review, not a generated board image')
        native_report = native_root / 'native.json'; core.write(native_report, {'externalEDA': 'not executed'})
        native = self.base.emit('native', core._common(self.facts) | {'native': {'reportPath': str(native_report)},
            'plan': {'paths': {'project': '项目工程/BOARD.epro2'}}, 'packagePath': str(native_root),
            'reviewFiles': [core.file_ref(preview)], 'proofFiles': core.inventory(native_root)})
        native_check = {'coreStatus': 'complete', 'errors': [], 'artifacts': [
            {'kind': 'project', 'path': '项目工程/BOARD.epro2', 'sha256': core.sha(exported)}]}
        mocked = patch.object(core, 'verify_full_native', return_value=native_check); mocked.start(); self.addCleanup(mocked.stop)
        process_root = self.root / 'process'; workbook = process_root / '生产资料/06_工艺要求/BOARD.xlsx'
        workbook.parent.mkdir(parents=True); workbook.write_bytes(b'fixture native workbook; business validator replaced')
        proc = self.base.emit('process', core._common(self.facts) | {'result': {'workbookPath': str(workbook)},
            'plan': {}, 'packagePath': str(process_root), 'reviewFiles': [core.file_ref(workbook)], 'proofFiles': core.inventory(process_root)})
        manual_root = self.root / 'manuals'; area = manual_root / '重要器件手册'; area.mkdir(parents=True)
        (area / 'fixture.pdf').write_bytes(b'%PDF-fixture only; not professional acceptance')
        (area / '资料说明.md').write_text('[manual](fixture.pdf)\n', encoding='utf-8')
        core.write(area / '资料来源索引.json', {'documents': []})
        manuals = self.base.emit('datasheets', core._common(self.facts) | {'packagePath': str(manual_root), 'proofFiles': core.inventory(manual_root)})
        self.tokens = {'facts': fact_token, 'native': native, 'process': proc, 'firmware': firmware, 'sop': sop, 'datasheets': manuals}
        for name in ('native', 'process', 'sop'):
            parent = self.api.load(self.tokens[name], self.api.run, 'hdk.full.' + delivery.PARENTS[name])
            self.api.approve(name, self.tokens[name], parent['reviewFiles'])

    def assemble(self): return self.api.call('assemble', self.tokens)
    def verify(self, assembled=None): return self.api.call('verify-delivery', assembled or self.assemble())

    def test_assemble_requires_all_current_real_approvals_before_creating_package(self):
        self.api.run['nodes']['human-process']['review']['decision'] = None
        with self.assertRaisesRegex(ValueError, '人工审核'): self.assemble()
        self.assertFalse(list(self.api.root.rglob('BOARD_HDK_V1.0')))
        self.assertFalse(list(self.api.root.rglob('*.zip')))

    def test_assemble_is_not_qualified_and_has_no_zip(self):
        token = self.assemble(); data = core.read(token['receiptPath'])
        self.assertEqual(token['status'], 'assembled'); self.assertFalse(token['qualified'])
        self.assertEqual(data['sourceTokens'], self.tokens)
        self.assertFalse(list(Path(token['packagePath']).parent.glob('*.zip')))
        delivery.check_inventory(token['packagePath'], core.read(data['assemblyManifestPath'])['files'])
        self.assertLess(len(json.dumps(token).encode()), 60000)

    def test_verify_has_independent_kit_and_never_changes_assembled_directory(self):
        assembled = self.assemble(); before = delivery.relative_inventory(assembled['packagePath'])
        verified = self.verify(assembled)
        self.assertEqual(verified['status'], 'verified'); self.assertTrue(verified['qualified'])
        self.assertFalse(verified['releaseQualified'])
        self.assertEqual(before, delivery.relative_inventory(assembled['packagePath']))
        kit = Path(verified['verificationKitPath']); self.assertEqual({p.name for p in kit.iterdir()}, set(delivery.KIT_FILES))
        self.assertFalse(list(self.api.root.rglob('*.zip')))
        data = core.read(verified['receiptPath']); self.assertIn('learningComparison', data)
        self.assertEqual(set(verified['learningComparison']['plans']), {'export', 'process', 'firmware', 'sop'})

    def test_verify_refuses_revoked_approval_and_superseded_current_parent(self):
        assembled = self.assemble()
        self.api.run['nodes']['human-sop']['review']['decision'] = 'revision_requested'
        with self.assertRaisesRegex(ValueError, '人工审核'): self.verify(assembled)
        self.api.run['nodes']['human-sop']['review']['decision'] = 'approved'
        producer = self.tokens['native']['nodeId']; self.api.run['nodes'][producer]['output'] = {'newAttempt': True}
        with self.assertRaisesRegex(ValueError, 'stale'): self.verify(assembled)

    def test_changed_approved_file_is_rejected(self):
        proc = core.read(self.tokens['process']['receiptPath']); Path(proc['result']['workbookPath']).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'changed'): self.assemble()

    def test_review_revoked_during_verification_cannot_commit_verified_receipt(self):
        assembled = self.assemble(); original = delivery.document_closure
        def revoke(*args, **kwargs):
            result = original(*args, **kwargs)
            self.api.run['nodes']['human-sop']['review']['decision'] = 'revision_requested'
            return result
        with patch.object(delivery, 'document_closure', side_effect=revoke):
            with self.assertRaisesRegex(ValueError, '人工审核'): self.verify(assembled)
        self.assertFalse(any(x.get('operation') == 'hdk.full.verify-delivery' for x in self.api.outputs.values()))

    def test_untracked_extra_or_changed_delivery_file_blocks_verification(self):
        assembled = self.assemble(); root = Path(assembled['packagePath'])
        (root / 'untracked.txt').write_text('not in frozen assembly inventory')
        with self.assertRaisesRegex(ValueError, '库存'): self.verify(assembled)
        (root / 'untracked.txt').unlink()
        target = next(x for x in root.rglob('*.bin')); target.write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'changed'): self.verify(assembled)

    def test_real_relative_verifier_survives_directory_move_and_detects_tampering(self):
        verified = self.verify(); moved = self.root / 'different-folder-name'
        shutil.copytree(verified['packagePath'], moved); shutil.copytree(verified['verificationKitPath'], moved / delivery.KIT)
        script = moved / delivery.KIT / 'verify_delivery.py'
        reply = subprocess.run([sys.executable, '-B', str(script)], capture_output=True, text=True)
        self.assertEqual(reply.returncode, 0, reply.stdout + reply.stderr)
        self.assertEqual(json.loads(reply.stdout)['physicalTestStatus'], 'not-run')
        (moved / '项目工程/BOARD.epro2').write_bytes(b'changed after move')
        reply = subprocess.run([sys.executable, '-B', str(script), str(moved)], capture_output=True, text=True)
        self.assertEqual(reply.returncode, 1); self.assertIn('Changed/missing', reply.stdout)

    def test_script_rejects_modified_inventory_and_symlink(self):
        verified = self.verify(); kit = Path(verified['verificationKitPath'])
        inventory = kit / 'relative-inventory.json'; original = inventory.read_bytes(); inventory.write_bytes(original + b' ')
        reply = subprocess.run([sys.executable, '-B', str(kit / 'verify_delivery.py'), verified['packagePath']], capture_output=True, text=True)
        self.assertEqual(reply.returncode, 1); self.assertIn('manifest SHA', reply.stdout)
        inventory.write_bytes(original)
        (Path(verified['packagePath']) / 'unexpected-link').symlink_to(self.base.source)
        reply = subprocess.run([sys.executable, '-B', str(kit / 'verify_delivery.py'), verified['packagePath']], capture_output=True, text=True)
        self.assertEqual(reply.returncode, 1); self.assertIn('Symlink', reply.stdout)

    def test_relative_verifier_pins_the_actual_engineering_and_review_report(self):
        verified = self.verify(); kit = Path(verified['verificationKitPath'])
        report = kit / 'verification.json'; original = report.read_bytes()
        for replacement in (b'{"qualified":true,"inventedApproval":true}', None):
            if replacement is None: report.unlink()
            else: report.write_bytes(replacement)
            reply = subprocess.run([sys.executable, '-B', str(kit / 'verify_delivery.py'), verified['packagePath']], capture_output=True, text=True)
            self.assertEqual(reply.returncode, 1); self.assertIn('report SHA', reply.stdout)
            report.write_bytes(original)

    def test_actual_operation_document_broken_link_is_hard_error(self):
        assembled = self.assemble(); data = core.read(assembled['receiptPath']); parent = core.read(self.tokens['sop']['receiptPath'])
        main = Path(data['assembly']['sop']['markdownPath']); main.write_text(main.read_text() + '\n[missing](missing.bin)\n')
        with self.assertRaisesRegex(ValueError, '断链'): delivery.document_closure(Path(data['packagePath']), data['assembly'], parent)

    def test_vendor_limitation_requires_frozen_identical_readme_and_missing_source_target(self):
        assembled = self.assemble(); data = core.read(assembled['receiptPath']); parent = core.read(self.tokens['sop']['receiptPath'])
        package = Path(data['packagePath']); source = Path(parent['packagePath']) / '生产资料/07_测试说明/测试固件/source/components/wt_bsp/README.md'
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text('[old missing](../../examples/missing.md)\n```sh\nidf.py -C examples/from-original-whole-repository build\n```\n')
        delivered = package / source.relative_to(Path(parent['packagePath'])); delivered.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(source, delivered)
        main = Path(data['assembly']['sop']['markdownPath']); main.write_text(main.read_text() + '\n[readme](测试固件/source/components/wt_bsp/README.md)\n')
        parent['proofFiles'].append(core.file_ref(source)); data['assembly']['assemblyCopies'].append({'source': str(source), 'path': str(delivered), 'sha256': core.sha(source)})
        closure = delivery.document_closure(package, data['assembly'], parent)
        self.assertEqual(len(closure['sourceDocumentationLimitations']), 1)
        self.assertEqual(len(closure['archivedSourceCommandExamples']), 1)
        self.assertFalse(closure['archivedSourceCommandExamples'][0]['executed'])
        parent['proofFiles'].pop()
        with self.assertRaisesRegex(ValueError, '断链'): delivery.document_closure(package, data['assembly'], parent)

    def test_archive_requires_real_verified_phase_and_keeps_kit_in_root(self):
        assembled = self.assemble()
        with self.assertRaises(ValueError): self.api.call('archive-delivery', assembled)
        verified = self.verify(assembled); token = self.api.call('archive-delivery', {'in': verified})
        self.assertEqual(token['status'], 'complete'); self.assertFalse(token['releaseQualified'])
        path = Path(token['archivePath'])
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist(); self.assertEqual(len(names), len(set(names)))
            self.assertIn('BOARD_HDK_V1.0/校验/verify_delivery.py', names)
            dest = self.root / 'unzipped'; archive.extractall(dest)
        script = dest / 'BOARD_HDK_V1.0/校验/verify_delivery.py'
        reply = subprocess.run([sys.executable, '-B', str(script)], capture_output=True, text=True)
        self.assertEqual(reply.returncode, 0, reply.stdout + reply.stderr)

    def test_archive_refuses_approval_revoke_and_verified_file_drift(self):
        verified = self.verify(); self.api.run['nodes']['human-native']['review']['decision'] = None
        with self.assertRaisesRegex(ValueError, '人工审核'): self.api.call('archive-delivery', verified)
        self.api.run['nodes']['human-native']['review']['decision'] = 'approved'
        kit = Path(verified['verificationKitPath']); (kit / 'verification.json').write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'changed'): self.api.call('archive-delivery', verified)

    def test_zip_member_hash_duplicate_escape_and_symlink_are_not_trusted(self):
        source = self.root / 'a.txt'; source.write_text('actual bytes'); entries = {'a.txt': {'path': str(source), 'bytes': source.stat().st_size, 'sha256': core.sha(source)}}
        variants = [('different', b'changed'), ('extra', b'actual bytes'), ('escape', b'actual bytes'), ('symlink', b'actual bytes'), ('fifo', b'actual bytes'), ('duplicate', b'actual bytes')]
        for variant, content in variants:
            path = self.root / (variant + '.zip')
            with zipfile.ZipFile(path, 'w') as archive:
                info = zipfile.ZipInfo('BOARD/a.txt')
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                if variant == 'symlink': info.external_attr = (stat.S_IFLNK | 0o777) << 16
                if variant == 'fifo': info.external_attr = (stat.S_IFIFO | 0o644) << 16
                archive.writestr(info, content)
                if variant == 'extra': archive.writestr('BOARD/extra', 'x')
                if variant == 'escape': archive.writestr('../escape', 'x')
                if variant == 'duplicate': archive.writestr('BOARD/a.txt', content)
            with self.subTest(variant=variant), self.assertRaises(ValueError): delivery._validate_archive(path, entries, 'BOARD')

    def test_zip_failure_can_retry_only_archive_without_reassembling(self):
        verified = self.verify(); original = delivery._validate_archive
        def corrupt(path, entries, prefix):
            with zipfile.ZipFile(path, 'a') as archive: archive.writestr(prefix + '/injected', 'unexpected')
            return original(path, entries, prefix)
        with patch.object(delivery, '_validate_archive', side_effect=corrupt):
            with self.assertRaisesRegex(ValueError, 'ZIP成员'): self.api.call('archive-delivery', verified)
        again = self.api.call('archive-delivery', verified)
        self.assertEqual(again['status'], 'complete'); self.assertEqual(core.read(again['receiptPath'])['sourceVerifiedReceipt'], verified)

    def test_learning_uses_verified_comparison_and_skips_zip(self):
        verified = self.verify(); self.api.run['learningId'] = 'fixture-learning'
        result = self.api.call('archive-delivery', verified)
        self.assertEqual(result['status'], 'skipped'); self.assertFalse(result['qualified'])
        self.assertFalse(list(self.api.root.rglob('*.zip')))

    def test_unsafe_and_duplicate_relative_inventory_and_unknown_phase_rejected(self):
        assembled = self.assemble(); package = Path(assembled['packagePath']); rows = delivery.relative_inventory(package)
        for changed in [rows + [rows[0]], [dict(rows[0], path='../outside')], [dict(rows[0], path='/absolute')]]:
            with self.assertRaises(ValueError): delivery.check_inventory(package, changed)
        with self.assertRaisesRegex(ValueError, '未知'): delivery.full('hdk.full.not-registered', {}, {}, self.api)


class ReplayCommandClosureTests(unittest.TestCase):
    """Tiny source-only fixtures; no compiler, shell or production receipt."""
    RECIPE = ('replay_dir=$(mktemp -d /tmp/hdk-replay-XXXXXX)\n'
              'cp -R source "$replay_dir/source"\n'
              'python "$IDF_PATH/tools/idf.py" --preview -B "$replay_dir/build" '
              '-C "$replay_dir/source" -DIDF_TARGET=esp32p4 build\n')

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve(); self.package = self.root / 'package'; self.package.mkdir()
        self.source = self.package / '固件/source'; self.source.mkdir(parents=True)
        self.file = self.source / 'main.c'; self.file.write_text('source-only closure fixture')
        self.document = self.source.parent / '构建重放.md'
        self.assembly = {'sop': {'markdownPath': str(self.document)}, 'assemblyCopies': []}
        self.parent = {'packagePath': str(self.package), 'proofFiles': []}
        self.write_recipe(self.RECIPE)

    def write_recipe(self, recipe): self.document.write_text('```sh\n' + recipe + '```\n')

    def closure(self): return delivery.document_closure(self.package, self.assembly, self.parent)

    def test_controlled_temporary_copy_binds_actual_source_inventory_without_executing_shell(self):
        execute = subprocess.run
        def only_markdown_parser(command, *args, **kwargs):
            self.assertEqual(Path(command[0]).name, 'node')
            self.assertIn('--input-type=module', command)
            self.assertFalse(kwargs.get('shell'))
            return execute(command, *args, **kwargs)
        with patch.object(subprocess, 'run', side_effect=only_markdown_parser):
            closure = self.closure()
        record = closure['temporaryReplayCopies'][0]
        expected = [{'path': 'main.c', 'bytes': self.file.stat().st_size, 'sha256': hashlib.sha256(self.file.read_bytes()).hexdigest()}]
        expected_sha = hashlib.sha256(json.dumps(expected, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(record['sourceInventorySha256'], expected_sha)
        self.assertEqual(record['sourceFileCount'], 1); self.assertFalse(record['executed'])
        self.assertEqual(record['source'], '固件/source')
        operand = closure['relativeCommandOperands'][0]
        self.assertEqual(operand['operand'], '$replay_dir/source'); self.assertEqual(operand['target'], '固件/source')
        self.assertEqual(operand['resolvedThrough'], 'controlled-temporary-copy')
        self.file.write_text('changed source fixture')
        self.assertNotEqual(self.closure()['temporaryReplayCopies'][0]['sourceInventorySha256'], expected_sha)

    def test_unknown_variables_different_copy_recipe_or_shell_chaining_are_never_whitelisted(self):
        recipes = [self.RECIPE.replace('replay_dir=$(mktemp -d /tmp/hdk-replay-XXXXXX)\n', ''),
            self.RECIPE.replace('/tmp/hdk-replay-XXXXXX', '/tmp/arbitrary-XXXXXX'),
            self.RECIPE.replace('cp -R source', 'cp -R ../outside'),
            self.RECIPE.replace('-C "$replay_dir/source"', '-C "$other/source"'),
            self.RECIPE.replace('build\n', 'build; echo extra\n'),
            self.RECIPE + 'replay_dir=/outside\n',
            'idf.py -C "$unbound/source" build\n', 'esptool write-flash 0 "$file.bin"\n']
        for recipe in recipes:
            with self.subTest(recipe=recipe):
                self.write_recipe(recipe)
                with self.assertRaisesRegex(ValueError, '动态文件引用'): self.closure()

    def test_missing_empty_symlink_or_escaped_source_is_rejected(self):
        self.file.unlink()
        with self.assertRaisesRegex(ValueError, '为空'): self.closure()
        self.source.rmdir()
        with self.assertRaises(ValueError): self.closure()
        outside = self.root / 'outside'; outside.mkdir(); (outside / 'private.c').write_text('not a package source')
        self.source.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError): self.closure()
        self.source.unlink(); self.source.mkdir()
        (self.source / 'private.c').symlink_to(outside / 'private.c')
        with self.assertRaisesRegex(ValueError, '符号链接'): self.closure()
        self.write_recipe(self.RECIPE.replace('cp -R source', 'cp -R ../../outside'))
        with self.assertRaisesRegex(ValueError, '动态文件引用'): self.closure()

    def test_literal_missing_files_still_report_the_precise_document_and_operand(self):
        self.write_recipe('python -m esptool write-flash 0 "missing.bin"\n')
        with self.assertRaisesRegex(ValueError, '构建重放.md：missing.bin'): self.closure()


if __name__ == '__main__': unittest.main()
