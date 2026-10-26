"""Standalone Pinout receipts over real temporary SQLite, PNG, SVG and JSON.

The conversion manifests below are explicit test fixtures, not claimed real EDA
or browser executions. These tests verify delivery boundaries and re-evaluation.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import unittest
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from hdk.pinout_dag import pinout, _evaluate_pinout_views
from hdk.four_files_pipeline import COMMITS, _artifact
from hdk import pinout_learning


def import_fixture(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


DAG = import_fixture('standalone_pinout_dag_fixtures', 'hdk-dag-capabilities.test.py')
V2 = import_fixture('standalone_pinout_image_fixtures', 'pinout-evaluation-v2.test.py')
api = DAG.capability


class PinoutDAGTests(unittest.TestCase):
    setUp = DAG.DAGCapabilityBoundaries.setUp
    save_row = DAG.DAGCapabilityBoundaries.save_row
    save_run = DAG.DAGCapabilityBoundaries.save_run
    save_profile = DAG.DAGCapabilityBoundaries.save_profile

    def build(self, *, style=False, learning=False, bad_geometry=False, shifted_svg=False, labels=()):
        self.helper = V2.PinoutEvaluationV2Tests(); self.helper.root = self.output
        self.views = [self.helper.fixture('render-' + side + '/版本-1', side) for side in ['front', 'back']]
        for view in self.views:
            for connector, pad, values in labels:
                self.helper.pin(view, connector, pad, **values)
        if style:
            for view in self.views: self.helper.pin(view, 'J1', '1', color='#123456')
        if shifted_svg:
            path = Path(self.views[0]['svgPath'])
            path.write_text(path.read_text().replace('font-size="12"', 'transform="translate(0 7)" font-size="12"', 1))
        self.value['images'] = [dict(side=view['side'], path=str(Path(view['factsPath']).parent / 'photo.png'),
                                    sha256=api.sha(Path(view['factsPath']).parent / 'photo.png')) for view in self.views]
        for view in self.profile['views']:
            image = next(image for image in self.value['images'] if image['side'] == view['side'])
            view['image'] = {'sha256': image['sha256'], 'width': 200, 'height': 400}
        self.save_profile()
        archive = self.output / 'sources'; archive.mkdir()
        photo_archives = []
        for image in self.value['images']:
            target = archive / (image['side'] + '-original.png'); shutil.copyfile(image['path'], target)
            photo_archives.append(dict(_artifact(target, 'photoOriginal', self.output), side=image['side']))
        target = archive / 'calibration.json'; shutil.copyfile(self.profile_path, target)
        photo_archives.append(_artifact(target, 'photoCalibration', self.output))
        self.tokens = {}
        for view in self.views:
            side = view['side']; directory = Path(view['pngPath']).parent
            for key, extension in [('pngPath', '.png'), ('svgPath', '.svg'), ('projectPath', '.openpinmap.json')]:
                target = directory / ('TEST_Pinout' + ('_Back' if side == 'back' else '') + extension)
                Path(view[key]).rename(target); view[key] = str(target)
            facts = api.read(view['factsPath']); project = api.read(view['projectPath'])
            facts['source'] = {'path': str(self.source), 'sha256': api.sha(self.source)}
            photograph = dict(facts['photograph'], kind='actual-photograph', transformation='transparent-margin-crop-only',
                              profile={'path': str(self.profile_path), 'sha256': api.sha(self.profile_path)})
            facts.update(photograph=photograph, image={'path': photograph['original']['path'], 'sha256': photograph['original']['sha256']},
                         alignment={'calibration': {'passed': not bad_geometry}, 'worldToPixel': [1, 0, 0, -1 if side == 'front' else 1, 0, 0]})
            project['workbenchAlignment'].update(photograph=photograph, sourceSha256=api.sha(self.source), imageSha256=facts['image']['sha256'])
            Path(view['factsPath']).write_text(json.dumps(facts)); Path(view['projectPath']).write_text(json.dumps(project))
            artifacts = [dict(_artifact(view[key], 'pinoutAsset', self.output), name=Path(view[key]).name) for key in ['pngPath', 'svgPath', 'projectPath']]
            manifest_path = directory / 'converter-manifest.json'
            manifest = {'source': {'path': view['projectPath'], 'sha256': api.sha(view['projectPath'])}, 'artifacts': artifacts,
                        'alignment': {'photograph': photograph}, 'converter': {'name': 'OpenPinMap', 'commit': COMMITS['OpenPinMap']},
                        'verification': dict.fromkeys(['freshContext', 'boundProjectReadbackMatched', 'sourceHashMatched', 'svgEmbeddedImageMatched'], True) | {'defaultExampleUsed': False}}
            manifest_path.write_text(json.dumps(manifest)); view.update(manifestPath=str(manifest_path), artifacts=artifacts, pinCount=6)
            data = {'sourceSha256': api.sha(self.source), 'request': copy.deepcopy(self.value), 'photoArchives': photo_archives,
                    'sourceFiles': [{'path': str(path), 'sha256': api.sha(path)} for path in [self.source, self.profile_path, *[item['path'] for item in self.value['images']]]],
                    'rendered': {'displayPlan': {'version': 2, 'fixture': 'source-bound display plan'}, 'views': [view]},
                    'skill': {'ref': 'fixture-pinout-skill', 'version': 'sha256:' + 'a' * 64}}
            name = 'render-' + side; operation = 'hdk.four.pinout-' + side
            self.run['document']['nodes'].append({'id': name, 'type': 'tool', 'config': {'toolName': operation}})
            os.environ['HDK_NODE_ID'] = name
            token = api.receipt(operation, data, self.run, directory, api.assets(artifacts))
            self.tokens[side] = token; self.run['nodes'][name] = {'status': 'complete', 'output': token, 'attempt': 1, 'outputDirectory': str(directory)}
        self.verify_out = self.output / 'verify' / '版本-1'; self.verify_out.mkdir(parents=True)
        self.input = {'images': copy.deepcopy(self.tokens)}
        self.run['document']['nodes'].extend([{'id': 'review', 'type': 'human', 'config': {}}, {'id': 'verify', 'type': 'tool', 'config': {'toolName': 'hdk.pinout.verify'}}])
        self.run['document']['edges'] = [{'sourceNode': 'review', 'targetNode': 'verify', 'targetPort': 'images', 'sourcePort': 'out'}]
        artifacts = [dict(path=view['pngPath'], sha256=api.sha(view['pngPath']), id='png-' + view['side']) for view in self.views]
        self.run['nodes']['review'] = {'status': 'complete', 'output': copy.deepcopy(self.tokens), 'artifacts': artifacts,
            'review': {'decision': 'approved', 'reviewedAt': '2026-10-25T10:00:00Z', 'artifactHashes': [{'id': item['id'], 'sha256': item['sha256']} for item in artifacts]}}
        self.run['nodes']['verify'] = {'status': 'running', 'input': self.input, 'attempt': 1, 'attemptId': str(uuid.uuid4()), 'outputDirectory': str(self.verify_out)}
        self.verify_context = self.context | {'nodeId': 'verify', 'attemptId': self.run['nodes']['verify']['attemptId'], 'outputDirectory': str(self.verify_out)}
        if learning:
            self.run['learningId'] = 'fixture-learning'; self.verify_context['learningId'] = self.run['learningId']
        self.save_run()
        self.contract = pinout_learning.build_reference_contract(self.views[0]['pngPath'])

    def execute(self):
        with patch('hdk.pinout_pipeline.CONTRACT', self.contract):
            return pinout('hdk.pinout.verify', self.input, self.verify_context, api)

    def prepare_four_verifier(self):
        """Synthetic native/CAD boundaries around the real Pinout verification."""
        def prepared(data):
            data['rendered']['prepared']={'views':[{'side':'front','factsPath':self.views[0]['factsPath']}]}
        self.change_parent('front',prepared)
        parents={}
        for name,operation,suffix,kind in [('native','hdk.four.native','.pdf','schematicPdf'),('cad','hdk.four.cad','.dwg','cad')]:
            directory=self.output/name/'版本-1';directory.mkdir(parents=True)
            file=directory/('synthetic'+suffix);file.write_bytes(b'synthetic external engineering boundary')
            asset=_artifact(file,kind,self.output)
            data={'sourceSha256':api.sha(self.source),'request':copy.deepcopy(self.value),
                  'sourceFiles':[{'path':str(self.source),'sha256':api.sha(self.source)}]}
            if name=='native':data.update(files=[asset],native={'format':'synthetic-native-boundary'})
            else:data['cad']={'artifacts':[asset],'verification':{'freshConversion':True,'independentGeometryPassed':True}}
            os.environ['HDK_NODE_ID']=name
            token=api.receipt(operation,data,self.run,directory,api.assets([asset]))
            self.run['document']['nodes'].append({'id':name,'type':'tool','config':{'toolName':operation}})
            self.run['nodes'][name]={'status':'complete','output':token,'attempt':1,'outputDirectory':str(directory)}
            parents[name]=token
        self.input=parents|{'images':copy.deepcopy(self.tokens)}
        definition=next(node for node in self.run['document']['nodes'] if node['id']=='verify')
        definition['config']['toolName']='hdk.four.verify'
        self.run['nodes']['verify']['input']=copy.deepcopy(self.input)
        self.save_run()
        return {'checks':{'syntheticEngineeringBoundary':True},'stepMetadataWarnings':[],
                'schRendering':{},'limitations':['Synthetic native/CAD boundary; not an actual EDA/CAD acceptance.'],
                'pinoutViews':[]}

    def change_parent(self, side, change):
        token = self.tokens[side]; data = api.read(token['receiptPath']); change(data)
        Path(token['receiptPath']).write_text(json.dumps(data)); token['receiptSha256'] = api.sha(token['receiptPath'])
        self.input['images'][side] = copy.deepcopy(token); self.run['nodes']['render-' + side]['output'] = copy.deepcopy(token)
        self.run['nodes']['review']['output'] = copy.deepcopy(self.input['images']); self.run['nodes']['verify']['input'] = copy.deepcopy(self.input); self.save_run()

    def test_current_approved_pair_is_re_evaluated_and_copied_with_all_hashes_and_no_four_file_claims(self):
        self.build(); token = self.execute(); result = api.read(token['receiptPath'])
        self.assertEqual(token['status'], 'complete'); self.assertTrue(result['passed']); self.assertTrue(all(result['qualitySummary']['checks'].values()))
        self.assertEqual(result['humanReview']['nodeId'], 'review'); self.assertEqual(len(result['files']), 6); self.assertEqual(len(result['sourceFiles']), 4)
        self.assertEqual({view['side'] for view in result['pinoutViews']}, {'front', 'back'})
        self.assertFalse(any('cad' in key.lower() or 'step' in key.lower() or 'sch' in key.lower() for key in result['checks']))
        for file in result['files']:
            self.assertTrue(Path(file['path']).is_relative_to(self.verify_out)); self.assertEqual(api.sha(file['path']), file['sha256']); self.assertEqual(api.sha(file['sourcePath']), file['sha256'])
        self.assertTrue((self.verify_out / 'Pinout验收.json').is_file()); self.assertIn('learningComparison', token)
        self.run['nodes']['verify'].update(status='complete', output=token); self.save_run(); api.load(token, self.run, 'hdk.pinout.verify')
        Path(self.views[0]['svgPath']).write_text('<svg>changed after delivery</svg>')
        with self.assertRaises(ValueError): api.load(token, self.run, 'hdk.pinout.verify')

    def test_source_proven_uart_boot_and_vo4_aliases_complete_without_main_or_changed_source_trace(self):
        self.build(labels=[('J1', '1', {'source': 'IO38_U0RXD', 'label': 'RX0'}),
                           ('J1', '2', {'source': 'IO37_U0TXD', 'label': 'TX0'}),
                           ('J1', '3', {'source': 'IO35_BOOT', 'label': 'BOOT', 'color': '#3498db'}),
                           ('J2', '3', {'source': 'LDO_VO4', 'label': 'VO4'})])
        token = self.execute(); result = api.read(token['receiptPath'])
        self.assertTrue(result['passed']); self.assertEqual(token['status'], 'complete')
        evaluation = api.read(self.verify_out / 'Pinout图片检查.json')
        self.assertFalse(evaluation['v2Reference']['qualitySummary']['checks']['multi-chip-disambiguation'])
        self.assertEqual(evaluation['labelInventory'], evaluation['v2Reference']['labelInventory'])
        self.assertEqual(len(evaluation['namespacePolicy']['functionAliases']['accepted']), 6)
        for key, passed in evaluation['v2Reference']['qualitySummary']['checks'].items():
            if key != 'multi-chip-disambiguation': self.assertEqual(evaluation['qualitySummary']['checks'][key], passed, key)
        self.assertEqual(evaluation['metrics'], evaluation['v2Reference']['metrics'])
        self.assertTrue(all(row['sourceNet'] == row['traceNet'] for row in evaluation['labelInventory']))
        self.assertEqual(result['humanReview']['nodeId'], 'review')

    def test_four_file_verifier_uses_the_same_real_source_alias_policy_and_current_human_review(self):
        self.build(labels=[('J1','1',{'source':'IO38_U0RXD','label':'RX0'}),
                           ('J1','2',{'source':'IO37_U0TXD','label':'TX0'}),
                           ('J1','3',{'source':'IO35_BOOT','label':'BOOT','color':'#3498db'}),
                           ('J2','3',{'source':'LDO_VO4','label':'VO4'})])
        engineering=self.prepare_four_verifier()
        with patch('hdk.pinout_pipeline.CONTRACT',self.contract),patch.object(api,'verify_files',return_value=engineering) as external:
            token=api.four('hdk.four.verify',self.input,self.verify_context)
        result=api.read(token['receiptPath'])
        self.assertEqual(result['status'],'complete');self.assertTrue(result['checks']['pinoutActualImagesPassed'])
        self.assertTrue(result['checks']['humanApprovedCurrentImages'])
        self.assertEqual(result['humanReview']['nodeId'],'review')
        self.assertEqual(result['namespacePolicy']['version'],3)
        self.assertEqual(len(result['namespacePolicy']['functionAliases']['accepted']),6)
        self.assertEqual(result['displayContract']['namespacePolicyVersion'],3)
        policy_path=Path(result['displayContract']['namespaceImplementationPath'])
        self.assertEqual(result['displayContract']['namespaceImplementationSha256'],api.sha(policy_path))
        external.assert_called_once()
        self.assertTrue((self.verify_out/'四文件验收.json').is_file())

    def test_four_file_verifier_rejects_old_main_ldo4_labels_even_with_current_human_approval(self):
        self.build(labels=[('J1','1',{'source':'IO38_U0RXD','label':'MAIN RX0'}),
                           ('J2','3',{'source':'LDO_VO4','label':'LDO4?'})])
        engineering=self.prepare_four_verifier()
        with patch('hdk.pinout_pipeline.CONTRACT',self.contract),patch.object(api,'verify_files',return_value=engineering) as external:
            with self.assertRaisesRegex(ValueError,'multi-chip-disambiguation'):
                api.four('hdk.four.verify',self.input,self.verify_context)
        external.assert_not_called()
        self.assertFalse((self.verify_out/'receipt.json').exists())

    def test_four_file_source_aliases_never_replace_current_exact_image_approval(self):
        self.build(labels=[('J1','1',{'source':'IO38_U0RXD','label':'RX0'})])
        engineering=self.prepare_four_verifier()
        self.run['nodes']['review']['review']['artifactHashes'].pop();self.save_run()
        with patch('hdk.pinout_pipeline.CONTRACT',self.contract),patch.object(api,'verify_files',return_value=engineering) as external:
            with self.assertRaises(ValueError):api.four('hdk.four.verify',self.input,self.verify_context)
        external.assert_not_called()
        self.assertFalse((self.verify_out/'receipt.json').exists())

    def test_private_alias_policy_keeps_wrong_gpio_secondary_identity_and_uart_boot_roles_hard(self):
        cases = [({'source': 'IO38_U0RXD', 'label': 'TX0'}, 'J1', '1'),
                 ({'source': 'IO37_U0TXD', 'label': 'TX1'}, 'J1', '1'),
                 ({'source': 'IO35_BOOT', 'label': 'IO35'}, 'J1', '1'),
                 ({'source': 'IO47', 'label': 'IO46'}, 'J1', '1'),
                 ({'source': 'IO47', 'label': 'RX0'}, 'J1', '1'),
                 ({'source': 'IO38_U0RXD', 'trace': 'IO99_U0RXD', 'label': 'RX0'}, 'J1', '1'),
                 ({'source': 'C61_U0RXD', 'label': 'RX0'}, 'J2', '1'),
                 ({'source': 'C61_IO8', 'label': 'C61 IO7'}, 'J2', '1'),
                 ({'source': 'LDO_VO4', 'label': 'IO47', 'color': '#ff0000'}, 'J1', '1'),
                 ({'source': 'LDO_VO4', 'label': 'LDO4?', 'color': '#ff0000'}, 'J1', '1'),
                 ({'source': 'IO47', 'label': 'MAIN IO47'}, 'J1', '1'),
                 ({'source': 'IO38_U0RXD', 'label': 'MAIN RX0'}, 'J1', '1')]
        self.helper = V2.PinoutEvaluationV2Tests(); self.helper.root = self.output
        for index, (values, connector, pad) in enumerate(cases):
            with self.subTest(values=values):
                view = self.helper.fixture('invalid-alias-' + str(index)); self.helper.pin(view, connector, pad, **values)
                result = _evaluate_pinout_views([view], reference_contract=pinout_learning.build_reference_contract(view['pngPath']))
                self.assertFalse(result['qualitySummary']['checks']['multi-chip-disambiguation']); self.assertFalse(result['passed'])

    def test_function_aliases_never_replace_current_human_approval(self):
        self.build(labels=[('J1', '1', {'source': 'IO38_U0RXD', 'label': 'RX0'})])
        self.run['nodes']['review']['review']['artifactHashes'].pop(); self.save_run()
        with self.assertRaises(ValueError): self.execute()
        self.assertFalse((self.verify_out / 'receipt.json').exists())

    def test_learning_keeps_low_style_as_an_explicit_candidate_but_execution_does_not_claim_pass(self):
        self.build(style=True, learning=True); token = self.execute(); result = api.read(token['receiptPath'])
        self.assertEqual(token['status'], 'learning-candidate'); self.assertFalse(result['passed']); self.assertFalse(result['qualitySummary']['checks']['reference-palette']); self.assertEqual(len(result['files']), 6); self.assertTrue((self.verify_out / 'Pinout学习候选检查.json').is_file())
        self.assertFalse((self.verify_out / 'Pinout验收.json').exists()); self.assertFalse(result['checks']['pinoutActualImagesPassed'])

    def test_execution_rejects_a_real_low_style_pair(self):
        self.build(style=True)
        with self.assertRaisesRegex(ValueError, '样式检查'): self.execute()
        self.assertFalse((self.verify_out / 'receipt.json').exists())

    def test_learning_never_downgrades_actual_calibration_geometry_failure(self):
        self.build(learning=True, bad_geometry=True, labels=[('J1', '1', {'source': 'IO38_U0RXD', 'label': 'RX0'})])
        with self.assertRaisesRegex(ValueError, '校准未通过'): self.execute()
        self.assertFalse((self.verify_out / 'receipt.json').exists())

    def test_learning_rejects_misaligned_actual_svg_geometry_after_real_raster_svg_evaluation(self):
        self.build(learning=True, shifted_svg=True, labels=[('J1', '1', {'source': 'IO38_U0RXD', 'label': 'RX0'})])
        with self.assertRaisesRegex(ValueError, '实际导出几何验收失败'): self.execute()
        self.assertFalse((self.verify_out / 'receipt.json').exists())

    def test_existing_different_delivery_file_is_never_overwritten(self):
        self.build(); target = self.verify_out / Path(self.views[0]['pngPath']).name; target.write_bytes(b'existing different delivery bytes')
        with self.assertRaisesRegex(ValueError, '同名但内容不同'): self.execute()
        self.assertEqual(target.read_bytes(), b'existing different delivery bytes'); self.assertFalse((self.verify_out / 'receipt.json').exists())

    def test_current_human_approval_and_exact_pngs_are_required(self):
        self.build(); original = copy.deepcopy(self.run)
        for change in [lambda r: r['nodes']['review'].update(status='waiting_review'), lambda r: r['nodes']['review']['review'].update(decision='revision_requested'), lambda r: r['nodes']['review']['review']['artifactHashes'].pop(), lambda r: r['document']['nodes'][-2].update(type='merge')]:
            self.run = copy.deepcopy(original); change(self.run); self.save_run()
            with self.subTest(run=self.run), self.assertRaises(ValueError): self.execute()
        self.assertFalse((self.verify_out / 'receipt.json').exists())

    def test_cross_branch_source_skill_plan_or_side_cannot_be_mixed(self):
        self.build(); original = api.read(self.tokens['back']['receiptPath'])
        for change in [lambda data: data.update(sourceSha256='0' * 64), lambda data: data['skill'].update(version='another-version'), lambda data: data['rendered']['displayPlan'].update(fixture='another plan'), lambda data: data['rendered']['views'][0].update(side='front')]:
            self.change_parent('back', lambda data: (data.clear(), data.update(copy.deepcopy(original)), change(data)))
            with self.subTest(change=change), self.assertRaises(ValueError): self.execute()

    def test_stale_parent_and_changed_original_are_hard_failures_even_in_learning(self):
        self.build(learning=True); original = copy.deepcopy(self.run)
        self.run['nodes']['render-front']['output']['receiptSha256'] = '0' * 64; self.save_run()
        with self.assertRaises(ValueError): self.execute()
        self.run = original; self.save_run(); self.source.write_bytes(b'changed original source')
        with self.assertRaises(ValueError): self.execute()

    def test_no_unknown_operation_or_forged_learning_context_can_write_a_delivery(self):
        self.build()
        with self.assertRaises(ValueError): pinout('hdk.four.verify', self.input, self.verify_context, api)
        with self.assertRaisesRegex(ValueError, '学习上下文'): pinout('hdk.pinout.verify', self.input, self.verify_context | {'learningId': 'forged'}, api)
        self.assertFalse((self.verify_out / 'receipt.json').exists())


if __name__ == '__main__': unittest.main()
