from pathlib import Path
import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('hdk_test_sop', Path(__file__).resolve().parents[1] / 'hdk/test_sop.py')
sop = importlib.util.module_from_spec(spec); spec.loader.exec_module(sop)


class SopTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve(); firmware = self.root / '生产资料/07_测试说明/测试固件'
        firmware.mkdir(parents=True)
        artifact = firmware / 'actual-target app.bin'; artifact.write_bytes(b'real-build-fixture')
        sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
        self.request = {'productCode': 'WT9932S31-TINY', 'hardwareVersion': '1.0', 'releaseDate': '2026-10-24',
            'packagePath': str(self.root),
            'boardFacts': {'source': {'sha256': 'a' * 64}, 'board': {'targets': ['esp32s31']},
                'power': {'input': '5V USB', 'logic': '3.3V'},
                'peripherals': {'rgb': {'gpio': 51}, 'buttons': {'boot': 35}, 'sd': {'clk': 43}}},
            'firmware': {'status': 'complete', 'target': 'esp32s31', 'physicalTestStatus': 'not-run',
                'artifactRoot': str(firmware), 'boardSourceSha256': 'a' * 64,
                'idf': {'version': 'fixture-version'},
                'artifacts': [{'role': 'application', 'path': str(artifact), 'sha256': sha, 'bytes': artifact.stat().st_size}],
                'flash': {'offsets': [{'offset': '0x10000', 'path': str(artifact), 'sha256': sha}]},
                'tests': [{'id': 'rgb', 'scope': 'RGB实际颜色测试', 'hardwareRequired': ['当前板和数据线'],
                    'operatorSteps': ['上电后观察红绿蓝依次点亮。'], 'expectedLog': 'RGB cycle',
                    'passCriteria': '灯色与实际日志一致。'},
                    {'id': 'boot', 'scope': 'BOOT按键', 'operatorSteps': ['按下并松开BOOT。'],
                    'command': 'button', 'expectedLog': 'BOOT level=0', 'hardwareRequired': []}]}}
        self.output = self.root / '生产资料/07_测试说明'

    def p4_request(self):
        request=copy.deepcopy(self.request);request['productCode']='WT9932P4C61-TINY'
        request['boardFacts']['board']['targets']=['esp32p4','esp32c61']
        area=self.output/'测试固件';main_manifest=area/'firmware-manifest.json'
        def artifact(path,role):return {'role':role,'path':str(path),'relativePath':path.relative_to(area).as_posix(),
            'bytes':path.stat().st_size,'sha256':sop.digest(path)}
        def variant(folder,target,size):
            folder.mkdir(parents=True,exist_ok=True)
            app=folder/'actual.bin';app.write_bytes((target+str(folder)).encode())
            merged=folder/'merged.bin';merged.write_bytes(app.read_bytes())
            args=folder/'flasher_args.json'
            args.write_text(json.dumps({'write_flash_args':['--flash-mode','dio','--flash-size',size,'--flash-freq','80m'],
                'flash_settings':{'flash_mode':'dio','flash_size':size,'flash_freq':'80m'},
                'flash_files':{'0x10000':'actual.bin'},'extra_esptool_args':{'chip':target}}))
            report={'target':target,'status':'compiled','boardSourceSha256':'a'*64,'physicalTestStatus':'not-run',
                'artifactRoot':str(folder),'manifestPath':str(folder/'firmware-manifest.json'),
                'artifacts':[artifact(app,'applicationBin'),artifact(merged,'mergedBin'),artifact(args,'flashArgs')],
                'flash':{'offsets':[{'offset':'0x10000','path':str(app),'sha256':sop.digest(app)}],
                    'flashArgsPath':str(args),'mergedPath':str(merged),'mergedOffset':'0x0'},'tests':[]}
            Path(report['manifestPath']).write_text(json.dumps(report))
            return report
        legacy=variant(area,'esp32p4','4MB');modern=variant(area/'variants/p4-v3','esp32p4','4MB')
        c61=variant(area/'C61','esp32c61','2MB')
        selection=area/'P4芯片版本与烧录选择.md';selection.write_text('read real chip-id; board version is separate')
        guide=area/'C61/C61烧录说明.md';guide.write_text('actual external-UART wiring and download procedure')
        child_files=[artifact(Path(r['manifestPath']),'childFirmwareManifest') for r in [modern,c61]]
        legacy.update(hardwareSelectionRequired=True,minimumFlashBytes=4194304,
            revisionVariants=[{'family':'legacy','minRevision':0,'maxRevision':199,'manifestPath':str(main_manifest)},
                {'family':'v3','minRevision':300,'maxRevision':399,'manifestPath':modern['manifestPath']}],
            companion={'target':'esp32c61','status':'compiled','manifestPath':c61['manifestPath']})
        legacy['artifacts']+=modern['artifacts']+c61['artifacts']+child_files+[
            artifact(selection,'revisionSelectionGuide'),artifact(guide,'companionFlashGuide')]
        legacy['tests']=copy.deepcopy(request['firmware']['tests'])+[{
            'id':'companion-link','scope':'C61 link','command':'link','expectedLog':'HDK companion-link PASS',
            'operatorSteps':['flash this C61 then send link'],'passCriteria':'matching reply',
            'subtests':[{'id':'companion-gpio-loopback','scope':'C61 ordinary GPIO loopback',
                'command':'c61-fixture','expectedLog':'HDK companion-gpio-loopback PASS pairs=2 gpios=4 checks=8',
                'operatorSteps':['connect the current two pairs after READY'],'passCriteria':'eight actual reads'}]}]
        main_manifest.write_text(json.dumps(legacy));request['firmware']=legacy
        return request

    def test_real_layout_links_hashes_and_operator_steps_are_rendered(self):
        result = sop.render(self.request, self.output, sop.default_plan(self.request))
        self.assertEqual(result['status'], 'complete')
        self.assertTrue(all(result['checks'].values()))
        text = Path(result['markdownPath']).read_text()
        self.assertIn('0x10000', text); self.assertNotIn('0x0 |', text)
        self.assertIn('actual-target%20app.bin', text)
        self.assertIn('RGB cycle', text); self.assertIn('按下并松开BOOT', text)
        self.assertIn('--chip esp32s31', text); self.assertIn('GPIO', text)
        self.assertIn('硬件实测未进行', text)
        svg = (self.output / 'images/wiring.svg').read_text()
        self.assertIn('51', svg); self.assertIn('35', svg)
        self.assertNotIn('image_008', text); self.assertNotIn('flash_download_tool.zip', text)
        self.assertEqual(sop.verify(result['markdownPath'], self.root)['status'], 'complete')

    def test_hardware_boolean_marks_physical_test_without_becoming_equipment(self):
        request=copy.deepcopy(self.request)
        request['firmware']['tests'][0]['hardwareRequired']=True
        request['firmware']['tests'][1]['hardwareRequired']=False
        result=sop.render(request,self.output)
        text=Path(result['markdownPath']).read_text()
        preparation=text.split('## 资料准备',1)[1].split('## 接线与供电',1)[0]
        self.assertNotIn('- 是',preparation);self.assertNotIn('- 否',preparation)
        self.assertNotIn('器材：是',text);self.assertNotIn('器材：否',text)
        self.assertEqual(text.count('本项需要在实物上执行'),1)
        boot=text.split('(`boot`)',1)[1].split('## 故障排查',1)[0]
        self.assertNotIn('器材：',boot);self.assertNotIn('本项需要在实物上执行',boot)
        self.assertEqual(result['status'],'complete')

    def test_explicit_string_and_list_equipment_names_are_preserved_and_deduplicated(self):
        request=copy.deepcopy(self.request)
        request['firmware']['tests'][0]['hardwareRequired']=['本板专用治具','已确认型号的摄像头']
        request['firmware']['tests'][1]['hardwareRequired']='本板专用治具'
        result=sop.render(request,self.output);text=Path(result['markdownPath']).read_text()
        preparation=text.split('## 资料准备',1)[1].split('## 接线与供电',1)[0]
        self.assertEqual(preparation.count('- 本板专用治具'),1)
        self.assertIn('- 已确认型号的摄像头',preparation)
        self.assertIn('器材：本板专用治具、已确认型号的摄像头',text)
        self.assertIn('器材：本板专用治具',text)
        self.assertNotIn('本项需要在实物上执行',text)

    def test_another_board_build_and_tampered_binary_are_rejected(self):
        request = copy.deepcopy(self.request)
        request['firmware']['boardSourceSha256'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, '另一板'): sop.render(request, self.output)
        request = copy.deepcopy(self.request)
        request['firmware']['target'] = 'esp32s3'
        with self.assertRaisesRegex(ValueError, '芯片'): sop.render(request, self.output)
        request = copy.deepcopy(self.request)
        request['firmware']['artifacts'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, '哈希'): sop.render(request, self.output)
        self.assertFalse((self.output / (self.request['productCode']+'测试说明.md')).exists())

    def test_incomplete_learning_plan_cannot_pass_content_coverage(self):
        for key, value in [('testIds', ['rgb']), ('sections', ['tests']), ('includeUntestedNotice', False),
                           ('documentName', 'OTHER测试说明.md'), ('referencePolicy', 'copy-case')]:
            with self.subTest(key=key):
                plan = sop.default_plan(self.request); plan[key] = value
                with self.assertRaises(ValueError): sop.render(self.request, self.output, plan)

    def test_unimplemented_or_uncompiled_is_pending_not_hardware_pass(self):
        request = copy.deepcopy(self.request)
        request['firmware'].update(status='failed', artifacts=[], flash={})
        request['firmware']['tests'][0].update(operatorSteps=[], unsupported=True)
        result = sop.render(request, self.output)
        text = Path(result['markdownPath']).read_text()
        self.assertIn('暂停烧录', text); self.assertNotIn('write-flash', text)
        self.assertTrue(any('尚未实现' in p for p in result['pending']))
        self.assertTrue(any('触发步骤' in p for p in result['pending']))
        self.assertEqual(result['physicalTestStatus'], 'not-run')

    def test_rechecking_catches_removed_references_and_changed_firmware(self):
        result = sop.render(self.request, self.output)
        binary = Path(self.request['firmware']['artifacts'][0]['path'])
        binary.write_bytes(b'tampered')
        self.assertEqual(sop.verify(result['markdownPath'], self.root)['status'], 'failed')
        (self.output / 'images/wiring.svg').unlink()
        checked = sop.verify(result['markdownPath'], self.root)
        self.assertFalse(checked['checks']['localReferencesExist'])
        self.assertGreaterEqual(len(checked['errors']), 2)

    def test_rechecking_reads_actual_sections_and_reference_coverage(self):
        result = sop.render(self.request, self.output)
        path = Path(result['markdownPath']); text = path.read_text()
        path.write_text(text.replace('## 烧录步骤', '烧录省略').replace('![本板当前网表的自绘接线索引](images/wiring.svg)', ''))
        checked = sop.verify(path, self.root)
        self.assertEqual(checked['status'], 'failed')
        self.assertFalse(checked['checks']['requiredSectionsPresent'])
        self.assertTrue(any('必需附件' in e for e in checked['errors']))

    def test_no_escaping_or_overwrite(self):
        request = copy.deepcopy(self.request)
        request['firmware']['artifactRoot'] = '/tmp'
        with self.assertRaises(ValueError): sop.render(request, self.output)
        sop.render(self.request, self.output)
        with self.assertRaisesRegex(ValueError, '覆盖'): sop.render(self.request, self.output)

    def test_image_directory_symlink_cannot_escape_package(self):
        external = self.root.parent / ('outside-' + self.root.name)
        external.mkdir(); self.addCleanup(external.rmdir)
        (self.output / 'images').symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, '符号链接'): sop.render(self.request, self.output)
        self.assertEqual(list(external.iterdir()), [])

    def test_p4_requires_silicon_selection_before_separate_variant_and_c61_commands(self):
        request=self.p4_request();result=sop.render(request,self.output)
        self.assertEqual(result['status'],'complete');self.assertTrue(all(result['checks'].values()))
        text=Path(result['markdownPath']).read_text()
        self.assertLess(text.index('--port P4_PORT chip-id'),text.index('write-flash'))
        self.assertLess(text.index('--port P4_PORT flash-id'),text.index('write-flash'))
        self.assertIn('### P4分支 `legacy`',text);self.assertIn('### P4分支 `v3`',text)
        self.assertIn('variants/p4-v3/actual.bin',text);self.assertIn('C61/actual.bin',text)
        self.assertIn('--chip esp32c61 --port C61_UART_PORT',text)
        self.assertIn('--before no-reset --after no-reset write-flash',text)
        self.assertIn('v2.x或未知版本',text);self.assertIn('4194304',text);self.assertIn('2097152',text)
        self.assertIn('PCB硬件版本/目录V1.0不是芯片',text)
        self.assertIn('#### 3.1.',text);self.assertIn('(`companion-gpio-loopback`)',text)
        self.assertIn('| companion-gpio-loopback | 未测 |',text)
        self.assertEqual(sop.verify(result['markdownPath'],self.root)['status'],'complete')

    def test_p4_missing_variant_manifest_or_companion_hash_is_rejected_before_output(self):
        request=self.p4_request()
        changed=copy.deepcopy(request);changed['firmware']['hardwareSelectionRequired']=False
        with self.assertRaisesRegex(ValueError,'revision'):sop.render(changed,self.output)
        child=Path(request['firmware']['companion']['manifestPath']);original=child.read_bytes();child.unlink()
        with self.assertRaises(ValueError):sop.render(request,self.output)
        child.write_bytes(original)
        app=next(a for a in request['firmware']['artifacts'] if a['role']=='applicationBin' and '/C61/' in a['path'])
        Path(app['path']).write_bytes(b'changed C61 build')
        with self.assertRaisesRegex(ValueError,'哈希'):sop.render(request,self.output)
        self.assertFalse((self.output/'WT9932P4C61-TINY测试说明.md').exists())

    def test_recheck_detects_deleted_subtest_or_changed_root_selection_evidence(self):
        request=self.p4_request();result=sop.render(request,self.output)
        path=Path(result['markdownPath']);original=path.read_text()
        path.write_text(original.replace('(`companion-gpio-loopback`)','(child hidden)'))
        self.assertFalse(sop.verify(path,self.root)['checks']['testIdsMatchManifest'])
        path.write_text(original)
        manifest=Path(request['firmware']['manifestPath']);manifest.write_text(manifest.read_text()+'\n')
        self.assertEqual(sop.verify(path,self.root)['status'],'failed')


if __name__ == '__main__': unittest.main()
