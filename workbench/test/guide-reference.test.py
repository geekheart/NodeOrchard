import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('guide_reference', ROOT / 'hdk/guide_reference.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GuideReferenceTests(unittest.TestCase):
    def setUp(self):
        policy = patch.object(MODULE, 'DEFAULT_CONTRACT', ROOT / 'test/fixtures/guide-editorial-contract.json')
        policy.start(); self.addCleanup(policy.stop)

    def test_execution_guidance_omits_reference_identities_paths_and_answers(self):
        text = json.dumps(MODULE.execution_editorial_contract(), ensure_ascii=False)
        self.assertNotIn('WT9932S31', text)
        self.assertNotIn('/Users/', text)
        self.assertNotIn('sha256', text)
        self.assertNotIn('pairedTrainingSource', text)

    def test_real_alphanumeric_physical_contacts_are_not_dropped(self):
        text = '### [J1] USB Type-C\n\n| Pin | Net |\n| --- | --- |\n| A1 | GND |\n| B12 | GND |\n| SH1 | GND |\n| CD | DETECT |\n'
        self.assertEqual(MODULE._pin_tables(text), {'J1': [('A1', 'GND'), ('B12', 'GND'), ('SH1', 'GND'), ('CD', 'DETECT')]})

    def test_evaluator_only_reference_target_is_bounded_and_omits_tables_logs_and_templates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            references = []
            for language in ('zh', 'en'):
                text = ('---\npage-background: "WTBackground.pdf"\n...\n'
                        '## 1.1 Overview\nSource product overview.\n## 1.2 Features\n- Source features.\n'
                        '## 5.1 Preparation\nPrepare tools.\n## 5.2 Wiring\nUse verified power.\n'
                        '## 5.3 Development\nFollow source BSP instructions.\n'
                        '```shell\nI (27) boot: measured log\n```\n'
                        '| Pin | Net |\n| --- | --- |\n| 21 | GND |\n'
                        '> Tip: Hold BOOT and use RESET as documented.\n')
                path = root / (language + '.md'); path.write_text(text)
                references.append({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'language': language})
            contract = root / 'contract.json'; contract.write_text(json.dumps({'references': references}))
            expected = MODULE.build_learning_expected(contract_path=contract)
        self.assertLess(len(json.dumps(expected, ensure_ascii=False).encode()), 60 * 1024)
        self.assertEqual(len(expected['qualitySummary']['checks']), 24)
        self.assertTrue(expected['qualitySummary']['checks']['drawio-block-diagram'])
        self.assertEqual({example['language'] for example in expected['referenceExamples']}, {'zh', 'en'})
        for example in expected['referenceExamples']:
            self.assertEqual(set(example['excerpts']), {'overview', 'features', 'preparation', 'wiring', 'development', 'troubleshooting'})
            text = '\n'.join(example['excerpts'].values())
            self.assertIn('BOOT', text)
            self.assertNotIn('WTBackground', text)
            self.assertNotIn('I (27) boot:', text)
            self.assertNotIn('| 21', text)
            self.assertNotIn('```', text)

    def fixture(self, path):
        contract = json.loads(MODULE.DEFAULT_CONTRACT.read_text())
        image_names = ['DEMO-TINY.png', 'DEMO-TINY_interface.png', 'DEMO-TINY_interface_back.png',
                       'DEMO-TINY_HWDesc.svg', 'DEMO-TINY_SCH.png', 'DEMO-TINY_size.svg']
        (path / 'img').mkdir()
        for name in image_names:
            (path / 'img' / name).write_bytes(b'image fixture')
        for language, suffix in [('zh', ''), ('en', '_en')]:
            headings = ['# ' + item['patterns'][language][0] for item in contract['sections']]
            if language == 'zh':
                headings[0] = '# 开发板简介'
            text = '# DEMO-TINY\n\n' + '\n\n'.join(headings)
            text += '\n\n' + ('Source-bound development instructions. ' * 60)
            text += '\n\n' + '\n'.join(f'![figure](./img/{name})' for name in image_names)
            text += '\n\n### [J3] Pin Header\n\n| No. | Pin | Description |\n| --- | --- | --- |\n| 1 | GND | Ground |\n| 2 | IO1 | I/O |\n'
            text += '\n```sh\ngit clone https://example.test/bsp\nidf.py set-board\nidf.py build\nidf.py flash\n```\n'
            text += '\n[SDK](https://docs.example.test/' + ('zh_CN' if language == 'zh' else 'en') + '/sdk.html)\n'
            (path / f'DEMO-TINY_User_Guide{suffix}.md').write_text(text)
        facts = {'productCode': 'DEMO-TINY', 'interfaces': [{'ref': 'J3', 'pins': [{'number': 1, 'net': 'GND'}, {'number': 2, 'net': 'IO1'}]}]}
        (path / 'facts.json').write_text(json.dumps(facts))
        return facts

    def test_complete_source_bound_bilingual_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            self.fixture(path)
            result = MODULE.evaluate_guide_bundle(path, facts_path=path / 'facts.json')
            self.assertTrue(result['passed'], result['issues'])
            self.assertEqual(result['passRate'], 1)

    def test_mismatched_pin_and_missing_asset_are_not_hidden_by_good_prose(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            self.fixture(path)
            en = path / 'DEMO-TINY_User_Guide_en.md'
            en.write_text(en.read_text().replace('| 2 | IO1 |', '| 2 | IO2 |'))
            (path / 'img/DEMO-TINY_interface_back.png').unlink()
            result = MODULE.evaluate_guide_bundle(path, facts_path=path / 'facts.json')
            checks = {item['id']: item for item in result['checks']}
            self.assertFalse(result['passed'])
            self.assertFalse(checks['source-pin-tables-en']['passed'])
            self.assertFalse(checks['bilingual-pin-consistency']['passed'])
            self.assertFalse(checks['local-assets-zh']['passed'])

    def test_asset_path_escape_and_missing_pdf_template(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            self.fixture(path)
            zh = path / 'DEMO-TINY_User_Guide.md'
            zh.write_text('---\npage-background: "not-provided.pdf"\n...\n' + zh.read_text() + '\n![escape](../outside.png)\n')
            result = MODULE.evaluate_guide_bundle(path, facts_path=path / 'facts.json')
            checks = {item['id']: item for item in result['checks']}
            self.assertFalse(checks['portable-markdown-zh']['passed'])
            self.assertFalse(checks['local-assets-zh']['passed'])

    def test_shell_comments_are_not_document_headings(self):
        markdown = '---\nheader-includes: |\n  ```{=latex}\n  \\usepackage{float}\n  ```\n...\n# Real heading\n\n```shell\n# False heading\n```\n'
        self.assertEqual(MODULE._outside_fences(markdown).strip(), '# Real heading')

    def test_headers_alone_do_not_satisfy_guide(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            self.fixture(path)
            for file in path.glob('*.md'):
                file.write_text(file.read_text().replace('Source-bound development instructions. ' * 60, ''))
            result = MODULE.evaluate_guide_bundle(path, facts_path=path / 'facts.json')
            checks = {item['id']: item for item in result['checks']}
            self.assertFalse(checks['narrative-coverage-zh']['passed'])
            self.assertFalse(checks['narrative-coverage-en']['passed'])

    def test_current_bsp_board_command_wins_over_reference_example(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            facts = self.fixture(path)
            facts['requiredCommands'] = ['git clone', 'idf.py set-target demo', 'idf.py build', 'idf.py flash']
            (path / 'facts.json').write_text(json.dumps(facts))
            for file in path.glob('*.md'):
                file.write_text(file.read_text().replace('idf.py set-board', 'idf.py set-target demo'))
            self.assertTrue(MODULE.evaluate_guide_bundle(path, facts_path=path / 'facts.json')['passed'])
            en = path / 'DEMO-TINY_User_Guide_en.md'
            en.write_text(en.read_text().replace('idf.py set-target demo', 'idf.py set-target wrong'))
            checks = {item['id']: item for item in MODULE.evaluate_guide_bundle(path, facts_path=path / 'facts.json')['checks']}
            self.assertFalse(checks['getting-started-commands-en']['passed'])

    def test_verified_bsp_command_modifiers_and_multiline_blocks_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            facts = self.fixture(path)
            shell = 'export BSP_ROOT="$HOME/work/WT_BSP"\nWT_BSP_BOARD=DEMO-TINY idf.py --preview -C examples/get-started/blink build\nidf.py -p PORT flash monitor'
            facts['requiredCommands'] = [shell]
            (path / 'facts.json').write_text(json.dumps(facts))
            for file in path.glob('*.md'):
                file.write_text(file.read_text().replace('idf.py build', shell))
            self.assertTrue(MODULE.evaluate_guide_bundle(path, facts_path=path / 'facts.json')['passed'])
            en = path / 'DEMO-TINY_User_Guide_en.md'
            en.write_text(en.read_text().replace('-C examples/get-started/blink', '-C examples/wrong'))
            checks = {item['id']: item for item in MODULE.evaluate_guide_bundle(path, facts_path=path / 'facts.json')['checks']}
            self.assertFalse(checks['getting-started-commands-en']['passed'])

    def test_pin_order_and_non_equivalent_source_urls_are_reviewed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            self.fixture(path)
            en = path / 'DEMO-TINY_User_Guide_en.md'
            en.write_text(en.read_text().replace('| 1 | GND | Ground |\n| 2 | IO1 | I/O |', '| 2 | IO1 | I/O |\n| 1 | GND | Ground |').replace('/en/sdk.html', '/en/another-product.html'))
            checks = {item['id']: item for item in MODULE.evaluate_guide_bundle(path, facts_path=path / 'facts.json')['checks']}
            self.assertFalse(checks['source-pin-tables-en']['passed'])
            self.assertFalse(checks['bilingual-source-links']['passed'])


if __name__ == '__main__':
    unittest.main()
