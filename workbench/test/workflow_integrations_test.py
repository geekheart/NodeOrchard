"""Controlled integration boundaries; only synthetic native adapters and temp files."""
import base64
from contextlib import nullcontext
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import shutil
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from workflow_integrations import WorkflowIntegrations, validate_toolsets, _check_native_provenance_files


class IntegrationsTests(unittest.TestCase):
    def fixture(self):
        config = {'image_gen': {'provider': 'openai-codex'}, 'mcp_servers': {'figma': {'enabled': True, 'url': 'SECRET_URL'}}, 'secret': 'NEVER_RETURN'}
        definitions = {'image_gen': ['image_generate'], 'browser': [], 'computer_use': [], 'mcp-figma': ['mcp__figma__draw']}
        model = SimpleNamespace(get_tool_definitions=lambda enabled_toolsets=None, **kw: [{'function': {'name': name, 'parameters': {}}} for group in enabled_toolsets or [] for name in definitions.get(group, [])])
        provider = SimpleNamespace(name='openai-codex', label='Codex images', is_available=lambda: True)
        service = WorkflowIntegrations(model, dependencies={'load_config': lambda: json.loads(json.dumps(config)), 'enabled_toolsets': lambda cfg: ['image_gen', 'browser', 'computer_use', 'mcp-figma'], 'providers': lambda: [provider]})
        return service, config

    def skill_fixture(self, temporary):
        service, _ = self.fixture()
        base = Path(temporary).resolve(); root, templates = base/'skills', base/'workbench-skills'
        root.mkdir(); templates.mkdir()
        sources = {'bundled': set(), 'hub': set()}
        service.dependencies.update(skills_root=lambda:root, resolve_skill_dir=lambda name, category:root/name,
            skill_sources=lambda:sources,
            skill_lock=lambda name:nullcontext(),
            skill_entries=lambda:[{'name': path.name, 'description': 'synthetic', 'category': 'general', 'path': str(path)}
                for path in root.iterdir() if path.is_dir() and (path/'SKILL.md').is_file()])
        calls = []
        def create(name, content, category=None):
            calls.append(name); (root/name).mkdir(); (root/name/'SKILL.md').write_text(content)
            return {'success': True}
        service.dependencies['create_skill'] = create
        return service, root, templates, sources, calls

    def test_catalog_only_returns_approved_capabilities_and_readiness(self):
        service, _ = self.fixture()
        catalog = service.catalog()
        self.assertEqual([row['id'] for row in catalog['toolsets']], ['image_gen', 'browser', 'computer_use', 'mcp-figma'])
        self.assertEqual(catalog['selectedImageProvider'], 'openai-codex')
        self.assertTrue(catalog['toolsets'][0]['available'])
        self.assertFalse(catalog['toolsets'][1]['available'])
        self.assertNotIn('SECRET', json.dumps(catalog))
        self.assertEqual(service.required(['image_gen'])[1], ['image_generate'])
        for ids in (['*'], ['terminal'], ['browser'], ['image_gen', 'image_gen']):
            with self.subTest(ids=ids):
                with self.assertRaises(ValueError): service.required(ids)

    def test_generated_image_is_copied_only_from_bounded_native_cache(self):
        service, _ = self.fixture()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); cache = root/'cache'; cache.mkdir()
            workspace = root/'workspace'; workspace.mkdir()
            png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1kAAAAASUVORK5CYII=')
            source = cache/'image.png'; source.write_bytes(png)
            service.dependencies['cache_root'] = lambda: cache
            run = {'workspace': str(workspace), 'run_id': 'attempt-one'}
            artifact = service.import_image(run, json.dumps({'success': True, 'image': str(source)}))
            self.assertEqual(Path(artifact['path']).read_bytes(), png)
            self.assertEqual(artifact['mimeType'], 'image/png')
            self.assertEqual(len(artifact['sha256']), 64)
            self.assertEqual(len(run['artifacts']), 1)
            self.assertIsNone(service.import_image(run, {'success': True, 'image': str(source)}))
            outside = root/'private.png'; outside.write_bytes(png)
            linked = cache/'link.png'; linked.symlink_to(source)
            bad = cache/'invalid.png'; bad.write_text('not an image')
            for value in (str(outside), str(linked), str(bad), 'https://example.test/image.png'):
                with self.subTest(value=value):
                    with self.assertRaises(ValueError): service.import_image(run, {'success': True, 'image': value})

    def test_human_provider_selection_uses_cas_and_changes_only_provider_key(self):
        service, config = self.fixture()
        writes = []
        other = SimpleNamespace(name='fal', is_available=lambda: False)
        service.dependencies['providers'] = lambda: [other]
        service.dependencies['config_lock'] = threading.RLock()
        def save(value, merge_existing=False):
            writes.append((value, merge_existing))
            config['image_gen'].update(value['image_gen'])
        service.dependencies['save_config'] = save
        self.assertFalse(service.image_provider({})['changed'])
        with self.assertRaises(ValueError): service.image_provider({'provider':'fal','expected_provider':'stale'})
        self.assertEqual(writes, [])
        result = service.image_provider({'provider':'fal','expected_provider':'openai-codex'})
        self.assertTrue(result['changed'])
        self.assertEqual(writes, [({'image_gen': {'provider': 'fal'}}, True)])
        self.assertEqual(config['secret'], 'NEVER_RETURN')
        self.assertNotIn('NEVER_RETURN', json.dumps(result))
        with self.assertRaises(ValueError): service.image_provider({'provider':'arbitrary-url'})

    def test_native_skill_create_is_new_slug_only_and_records_dependency_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            service, root, templates, _, calls = self.skill_fixture(temporary)
            templates.rmdir()
            params={'name':'image-poster','description':'图片输出','instructions':'Use image_generate once.','required_toolsets':['image_gen'], 'operation_id':'create-poster'}
            result = service.create_skill(params)
            self.assertEqual(result['skill']['requiredToolsets'], ['image_gen'])
            self.assertIn('required-toolsets: ["image_gen"]', result['skill']['content'])
            self.assertTrue(result['skill']['revision'].startswith('sha256:'))
            self.assertTrue(result['skill']['bundleRevision'].startswith('sha256:'))
            self.assertTrue(result['skill']['origin']['canDelete'])
            self.assertEqual(result['skill']['origin']['kind'], 'generated')
            self.assertTrue(result['skill']['creationId'])
            for change in ({}, {'name':'../outside'}, {'name':'image-poster','required_toolsets':['terminal']}):
                with self.subTest(change=change):
                    with self.assertRaises(ValueError): service.create_skill(params | change)
            self.assertEqual(calls, ['image-poster'])
            for index, name in enumerate(('image--poster-', 'a'*64)):
                self.assertEqual(service.create_skill(params | {'name': name, 'operation_id': 'create-'+str(index)})['skill']['name'], name)
            with self.assertRaises(ValueError): service.create_skill(params | {'name':'a'*65})
            with self.assertRaises(ValueError): service.create_skill(params | {'name':'new-without-id', 'operation_id':None})

    def test_skill_catalog_uses_native_provenance_and_never_promotes_copied_business_templates(self):
        with tempfile.TemporaryDirectory() as temporary:
            service, root, templates, sources, _ = self.skill_fixture(temporary)
            for name in ('native-builtin', 'old-local', 'hub-installed'):
                (root/name).mkdir(); (root/name/'SKILL.md').write_text('---\nname: '+name+'\n---\nExisting instructions.\n')
            sources['bundled'].add('native-builtin'); sources['hub'].add('hub-installed')
            (templates/'fixed-source').mkdir(); (templates/'fixed-source'/'SKILL.md').write_text('---\nname: fixed-source\n---\nBuiltin instructions.\n')
            shutil.copytree(templates/'fixed-source', root/'copied-template')
            before = sorted(path.name for path in root.parent.iterdir())
            rows = {row['name']:row for row in service.skills_catalog()['skills']}
            self.assertEqual(rows['native-builtin']['origin']['kind'], 'hermes-builtin')
            self.assertEqual(rows['copied-template']['origin']['kind'], 'unknown')
            self.assertEqual(rows['old-local']['origin']['kind'], 'unknown')
            self.assertEqual(rows['hub-installed']['source'], 'hub')
            self.assertTrue(all(not row['origin']['canDelete'] for row in rows.values()))
            self.assertEqual(sorted(path.name for path in root.parent.iterdir()), before, 'a readonly scan must not create a ledger')
            self.assertNotIn(str(root), json.dumps(rows))
            new = service.create_skill({'name':'fresh', 'description':'fixture', 'instructions':'new instructions', 'operation_id':'create-fresh'})['skill']
            rows = {row['name']:row for row in service.skills_catalog()['skills']}
            self.assertEqual(rows['fresh']['creationId'], new['creationId'])
            self.assertTrue(rows['fresh']['origin']['canDelete'])
            # A later authoritative manifest classification overrides ownership.
            sources['bundled'].add('fresh')
            self.assertFalse(next(row for row in service.skills_catalog()['skills'] if row['name']=='fresh')['origin']['canDelete'])
            with self.assertRaises(ValueError): service.delete_skill({'name':'fresh', 'creation_id':new['creationId'], 'expected_revision':new['revision'],
                'expected_bundle_revision':new['bundleRevision'], 'operation_id':'delete-protected'})
            self.assertTrue((root/'fresh'/'SKILL.md').is_file())

    def test_only_new_generated_skill_can_be_archived_with_revision_and_idempotent_operation(self):
        with tempfile.TemporaryDirectory() as temporary:
            service, root, _, _, _ = self.skill_fixture(temporary)
            created = service.create_skill({'name':'fresh', 'description':'fixture', 'instructions':'new instructions', 'operation_id':'create-fresh'})['skill']
            params = {'name':'fresh', 'creation_id':created['creationId'], 'expected_revision':created['revision'],
                      'expected_bundle_revision':created['bundleRevision'], 'operation_id':'delete-fresh'}
            with self.assertRaises(ValueError): service.delete_skill(params | {'expected_revision':'sha256:'+'0'*64})
            receipt = service.delete_skill(params)
            self.assertTrue(receipt['deleted']); self.assertTrue(receipt['archived'])
            self.assertFalse((root/'fresh').exists()); self.assertEqual(service.delete_skill(params), receipt)
            self.assertFalse(service.skills_catalog()['skills'])
            self.assertNotIn(str(root), json.dumps(receipt))

    def test_unreadable_or_redirected_native_provenance_is_never_treated_as_an_empty_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()/'skills'; root.mkdir()
            _check_native_provenance_files(root)
            hub = root/'.hub'; hub.mkdir(); (hub/'lock.json').write_text('{bad json')
            with self.assertRaises(ValueError): _check_native_provenance_files(root)
            (hub/'lock.json').write_text('{"installed":{}}')
            _check_native_provenance_files(root)
            manifest = root/'.bundled_manifest'; target = root/'target'; target.write_text('protected:hash\n')
            manifest.symlink_to(target)
            with self.assertRaises(ValueError): _check_native_provenance_files(root)
            manifest.unlink(); os.link(target, manifest)
            with self.assertRaises(ValueError): _check_native_provenance_files(root)
            manifest.unlink(); (hub/'lock.json').unlink(); hub.rmdir(); hub.symlink_to(root/'missing-hub')
            with self.assertRaises(ValueError): _check_native_provenance_files(root)

    def test_native_protected_and_essential_sets_are_combined_without_claiming_builtin_origin(self):
        with tempfile.TemporaryDirectory() as temporary:
            service, root, _, sources, calls = self.skill_fixture(temporary)
            fake_usage = SimpleNamespace(_read_bundled_names=lambda:set(), _read_hub_installed_names=lambda:set(), PROTECTED_BUILTIN_SKILLS={'load-bearing'})
            fake_utils = SimpleNamespace(ESSENTIAL_SKILLS=frozenset({'hermes-agent'}))
            del service.dependencies['skill_sources']
            with patch.dict(sys.modules, {'tools.skill_usage':fake_usage, 'agent.skill_utils':fake_utils}):
                protected = service._native('skill_sources')()['protected']
            self.assertEqual(protected, {'load-bearing', 'hermes-agent'})
            sources['protected'] = protected; service.dependencies['skill_sources'] = lambda:sources
            for name in protected:
                with self.subTest(name=name):
                    with self.assertRaises(ValueError): service.create_skill({'name':name, 'description':'fixture', 'instructions':'new instructions', 'operation_id':'create-'+name})
                    self.assertFalse((root/name).exists())
                    (root/name).mkdir(); (root/name/'SKILL.md').write_text('---\nname: '+name+'\n---\nOld local copy.\n')
            self.assertEqual(calls, [], 'protected names must be rejected before native creation')
            rows = {row['name']:row for row in service.skills_catalog()['skills']}
            self.assertTrue(all(rows[name]['origin']['kind']=='unknown' and not rows[name]['origin']['canDelete'] for name in protected))
            created = service.create_skill({'name':'fresh', 'description':'fixture', 'instructions':'new instructions', 'operation_id':'create-fresh'})['skill']
            sources['protected'].add('fresh')
            row = next(row for row in service.skills_catalog()['skills'] if row['name']=='fresh')
            self.assertEqual(row['origin']['kind'], 'unknown'); self.assertFalse(row['origin']['canDelete'])
            with self.assertRaises(ValueError): service.delete_skill({'name':'fresh', 'creation_id':created['creationId'], 'expected_revision':created['revision'],
                'expected_bundle_revision':created['bundleRevision'], 'operation_id':'delete-now-protected'})
            self.assertTrue((root/'fresh'/'SKILL.md').is_file())

    def test_capability_revision_detects_provider_schema_or_permission_change(self):
        service, cfg = self.fixture(); before = service.catalog()['revision']
        self.assertTrue(before.startswith('sha256:'))
        cfg['image_gen']['provider'] = 'fal'
        self.assertNotEqual(service.catalog()['revision'], before)
        with self.assertRaisesRegex(ValueError, 'revision changed'):
            service.required(['image_gen'], before)

    def test_vault_only_tools_do_not_advertise_a_working_browser(self):
        service, _ = self.fixture()
        original = service.model_tools.get_tool_definitions
        service.model_tools.get_tool_definitions = lambda enabled_toolsets=None, **kw: ([{'function': {'name': 'browser_vault_list'}}]
            if enabled_toolsets == ['browser'] else original(enabled_toolsets=enabled_toolsets, **kw))
        browser = next(row for row in service.catalog()['toolsets'] if row['id'] == 'browser')
        self.assertFalse(browser['available'])
        with self.assertRaises(ValueError): service.required(['browser'])

    def test_shared_mcp_ids_accept_case_dots_and_96_char_server_names(self):
        long_name = 'A.' + 'x'*94
        self.assertEqual(validate_toolsets(['mcp-'+long_name, 'mcp-Figma.Desktop', 'browser']), ['browser', 'mcp-'+long_name, 'mcp-Figma.Desktop'])
        service, cfg = self.fixture()
        cfg['mcp_servers'].update({long_name:{'enabled':True},'Figma.Desktop':{'enabled':False},'bad name':{'enabled':True},'x'*97:{'enabled':True}})
        catalog = service.catalog()
        self.assertIn('mcp-'+long_name, [row['id'] for row in catalog['toolsets']])
        self.assertIn('mcp-Figma.Desktop', [row['id'] for row in catalog['toolsets']])
        self.assertNotIn('mcp-bad name', [row['id'] for row in catalog['toolsets']])
        for ids in (['mcp-'+long_name+'x'],['mcp-bad name'],['mcp-f','mcp-f'],[{}]):
            with self.subTest(ids=ids):
                with self.assertRaises(ValueError): validate_toolsets(ids)


if __name__ == '__main__': unittest.main()
