import importlib.util
import json
import hashlib
import struct
import shutil
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT=Path(__file__).resolve().parents[1]
s=importlib.util.spec_from_file_location('hdk_firmware_test',ROOT/'hdk/test_firmware.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class FirmwareTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.source=self.root/'board.epro2';records=[]
        def rec(kind,body,uid='x'):records.append(json.dumps({'type':kind,'id':uid})+'||'+json.dumps(body)+'|')
        def doc(uid,kind):rec('DOCHEAD',{'uuid':uid,'docType':kind})
        def attr(parent,key,value):rec('ATTR',{'parentId':parent,'key':key,'value':value})
        doc('dev-main','DEVICE');rec('META',{'title':'WT0132S31-S1','attributes':{'Symbol':'sym-main'}})
        doc('sym-main','SYMBOL');attr('p1','Pin Number','1');attr('p1','Pin Name','IO19')
        doc('dev-rgb','DEVICE');rec('META',{'title':'XL-5050RGBC-WS2812B','attributes':{'Symbol':'wrong','Manufacturer Part':'default-2812'}})
        doc('sym-rgb','SYMBOL');attr('din','Pin Number','4');attr('din','Pin Name','DIN')
        doc('sch','SCH_PAGE');attr('led','Designator','LED1');attr('led','Device','dev-rgb');attr('led','Symbol','sym-rgb');attr('led','Manufacturer Part','instance-2812')
        doc('pcb','PCB')
        for uid,ref,device in [('module','U1','dev-main'),('led','LED1','dev-rgb')]:
            rec('COMPONENT',{},uid);attr(uid,'Designator',ref);attr(uid,'Device',device)
        rec('PAD_NET',{'padNet':'LED_SIGNAL'},json.dumps(['PAD_NET','module','1','p1']))
        rec('PAD_NET',{'padNet':'LED_SIGNAL'},json.dumps(['PAD_NET','led','4','p4']))
        with zipfile.ZipFile(self.source,'w') as z:z.writestr('board.epru','\n'.join(records))
        self.facts=m.inspect_board(self.source)
        self.profile={'schemaVersion':1,'target':'esp32s31','tests':['chip-info','rgb'],'cameraSensor':None,'fixturePairs':[]}
    def test_native_instance_symbol_and_part_overrides_drive_pin_output(self):
        self.assertEqual(self.facts['peripherals']['rgb']['gpio'],19)
        self.assertEqual(self.facts['peripherals']['rgb']['part'],'instance-2812')
        self.assertEqual(self.facts['board']['primaryTarget'],'esp32s31')
        out=m.generate(self.facts,self.profile,self.root)
        self.assertIn('#define HDK_RGB_PIN 19',(Path(out['sourceDir'])/'main/hdk_board_config.h').read_text())
        self.assertEqual(out['physicalTestStatus'],'not-run')
        self.assertTrue(all(m.sha(f['path'])==f['sha256'] for f in out['sourceFiles']))
        with self.assertRaisesRegex(ValueError,'覆盖'):m.generate(self.facts,self.profile,self.root)
    def test_target_or_missing_peripheral_is_never_filled_from_case(self):
        with self.assertRaisesRegex(ValueError,'target'):m.validate_profile(self.facts,dict(self.profile,target='esp32s3'))
        with self.assertRaisesRegex(ValueError,'真实外设'):m.validate_profile(self.facts,dict(self.profile,tests=['camera-sccb'],cameraSensor='gc2145'))
        self.facts['peripherals']['rgb']['gpio']=None
        with self.assertRaisesRegex(ValueError,'GPIO'):m.validate_profile(self.facts,self.profile)
    def test_mutated_source_does_not_generate_from_old_facts(self):
        self.source.write_bytes(self.source.read_bytes()+b'modified')
        with self.assertRaisesRegex(ValueError,'变化'):m.generate(self.facts,self.profile,self.root)
    def test_unconfirmed_fixture_never_means_pass_and_reserved_gpio_is_rejected(self):
        profile=dict(self.profile,tests=['gpio-loopback'])
        items=m.tests_manifest(self.facts,profile)
        self.assertTrue(items[0]['unsupported']);self.assertIn('SKIP',items[0]['expectedLog'])
        with self.assertRaisesRegex(ValueError,'治具GPIO'):m.validate_profile(self.facts,dict(profile,fixturePairs=[{'output':19,'input':18}]))
    def test_compile_rejects_changed_sources_before_running_toolchain(self):
        generated=m.generate(self.facts,self.profile,self.root)
        Path(generated['sourceFiles'][0]['path']).write_text('changed')
        with patch.object(m.subprocess,'check_output') as run:
            with self.assertRaisesRegex(ValueError,'源码已变化'):m.compile(generated)
            run.assert_not_called()
    def staged_build(self, *, exit_code=0, mutate_source=False):
        package=self.root/'Application Support 资料';package.mkdir()
        generated=m.generate(self.facts,self.profile,package)
        source=Path(generated['sourceDir']);before=(source/'main/hdk_board_config.h').read_bytes()
        scratch=self.root/'ascii-scratch';scratch.mkdir()
        calls=[]
        def run(command,env,cwd,log,timeout=1200):
            calls.append(command)
            Path(log).write_text('synthetic compiler boundary\n')
            if '-m' in command:
                Path(command[command.index('-o')+1]).write_bytes(b'synthetic merged image')
                return 0
            staged=Path(command[command.index('-C')+1]);build=Path(command[command.index('-B')+1])
            self.assertEqual(Path(cwd),staged)
            self.assertTrue(str(staged).isascii())
            self.assertNotRegex(str(staged),r'\s')
            # Reproduce the upstream IPA generator's input.split() behavior.
            sensor=staged/'managed_components/fixture/camera.json';sensor.parent.mkdir(parents=True)
            sensor.write_text('{"version":1}')
            inputs=str(sensor).split()
            self.assertEqual(len(inputs),1)
            self.assertEqual(json.loads(Path(inputs[0]).read_text()),{'version':1})
            (staged/'dependencies.lock').write_text('fixed synthetic dependency lock')
            (staged/'sdkconfig').write_text('CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y\n')
            if mutate_source:(staged/'main/hdk_board_config.h').write_text('compiler changed authored input')
            build.mkdir()
            if exit_code==0:
                for relative in ['hdk_factory.elf','hdk_factory.map','hdk_factory.bin','bootloader/bootloader.bin','partition_table/partition-table.bin']:
                    file=build/relative;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes(b'synthetic build artifact')
                (build/'flash_args').write_text('original native flash args')
                (build/'flasher_args.json').write_text(json.dumps({'write_flash_args':['--flash_mode','dio'],
                    'flash_files':{'0x0':'bootloader/bootloader.bin','0x8000':'partition_table/partition-table.bin','0x10000':'hdk_factory.bin'}}))
            return exit_code
        with patch.object(m.subprocess,'check_output',return_value=m.SDK_COMMIT+'\n'),patch.object(m.tempfile,'mkdtemp',return_value=str(scratch)),patch.object(m,'_run',side_effect=run):
            result=m._compile_one(generated,{'idfPath':str(self.root/'mock-sdk'),'python':'mock-python'})
        return result,source,before,scratch,calls
    def test_build_stages_sources_outside_spaced_unicode_deliveries_and_retains_dependency_evidence(self):
        result,source,before,scratch,calls=self.staged_build()
        self.assertEqual(result['status'],'compiled')
        self.assertEqual(Path(result['sourceDir']),source)
        self.assertEqual((source/'main/hdk_board_config.h').read_bytes(),before)
        self.assertEqual(json.loads((source/'managed_components/fixture/camera.json').read_text()),{'version':1})
        index=json.loads((source/'dependency-source-index.json').read_text())
        self.assertTrue(m._dependency_sources_match(source,index))
        self.assertTrue(all(Path(item['path']).is_relative_to(Path(result['packagePath'])) for item in result['artifacts']))
        self.assertEqual(len(calls),2)
        self.assertFalse(scratch.exists(),'successful scratch builds are removed after canonical publication')
        replay=Path(result['artifactRoot'])/'构建重放.md'
        self.assertIn('cp -R source "$replay_dir/source"',replay.read_text())
    def test_failed_staged_build_retains_generated_sources_log_and_private_scratch_for_diagnosis(self):
        result,source,before,scratch,calls=self.staged_build(exit_code=1)
        self.assertEqual(result['status'],'failed');self.assertEqual(result['exitCode'],1)
        self.assertEqual((source/'main/hdk_board_config.h').read_bytes(),before)
        self.assertTrue((source/'dependencies.lock').is_file())
        self.assertTrue((source/'managed_components/fixture/camera.json').is_file())
        self.assertTrue((scratch/'source').is_dir())
        self.assertEqual(len(calls),1)
        self.assertTrue(any(item['role']=='buildLog' for item in result['artifacts']))
    def test_compiler_cannot_replace_fixed_authored_sources_during_staged_publication(self):
        with self.assertRaisesRegex(ValueError,'固定源码发生变化'):
            self.staged_build(mutate_source=True)
        source=self.root/'Application Support 资料/生产资料/07_测试说明/测试固件/source'
        self.assertIn('#pragma once',(source/'main/hdk_board_config.h').read_text())
        self.assertFalse((source/'dependencies.lock').exists(),'no build-generated files publish before input integrity passes')
    def test_empty_fixture_cannot_satisfy_complete_board_coverage(self):
        facts=json.loads(json.dumps(self.facts))
        facts['peripherals']['headers']=[{'designator':'H1','pins':[{'pad':'1','net':'IO2','gpio':2},{'pad':'2','net':'IO3','gpio':3}]}]
        missing=m.coverage(facts,dict(self.profile,tests=['chip-info','rgb','reset','usb-console','gpio-loopback']))
        self.assertFalse(missing['complete'])
        self.assertTrue(any(test.startswith('gpio-loopback') for test in missing['missingTests']))
    def test_real_esp_image_revision_and_corruption_are_checked(self):
        header=bytearray(24);header[0]=0xe9;header[1]=1;header[23]=1
        struct.pack_into('<H',header,12,18);struct.pack_into('<HH',header,15,300,399)
        segment=b'actual compiled segment bytes';data=header+struct.pack('<II',0x40000000,len(segment))+segment
        checksum=0xef
        for byte in segment:checksum^=byte
        data+=bytes((-(len(data)+1))%16)+bytes([checksum]);data+=hashlib.sha256(data).digest()
        image=m._esp_image(data);self.assertEqual((image['chipId'],image['minRevision'],image['maxRevision']),(18,300,399))
        corrupt=bytearray(data);corrupt[33]^=1
        with self.assertRaisesRegex(ValueError,'checksum'):m._esp_image(corrupt)
        corrupt=bytearray(data);corrupt[-1]^=1
        with self.assertRaisesRegex(ValueError,'SHA256'):m._esp_image(corrupt)
    def test_companion_gpio_coverage_is_visible_without_changing_planned_test_ids(self):
        profile=dict(self.profile,tests=['chip-info','companion-link','wifi'])
        items=m.tests_manifest(self.facts,profile)
        self.assertEqual([item['id'] for item in items],profile['tests'])
        link=next(item for item in items if item['id']=='companion-link')
        self.assertEqual(link['subtests'][0]['id'],'companion-gpio-loopback')
        self.assertTrue(any('c61-fixture' in step for step in link['operatorSteps']))
    def test_generated_sources_exclude_only_known_os_metadata(self):
        assets=self.root/'assets';assets.mkdir()
        shutil.copyfile(m.ASSETS/'CMakeLists.txt',assets/'CMakeLists.txt')
        shutil.copytree(m.ASSETS/'main',assets/'main')
        for relative in ['.DS_Store','._main.c','__MACOSX/nested.txt','.hidden.c','.DS_Store.txt']:
            path=assets/'main'/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('finder or business')
        with patch.object(m,'ASSETS',assets):generated=m.generate(self.facts,self.profile,self.root)
        paths={item['relativePath'] for item in generated['sourceFiles']}
        self.assertIn('source/main/.hidden.c',paths);self.assertIn('source/main/.DS_Store.txt',paths)
        self.assertFalse(any(m.is_os_metadata(path) for path in paths))
        self.assertTrue((Path(generated['sourceDir'])/'main/.DS_Store').is_file())
    def test_dependency_metadata_changes_do_not_hide_business_source_changes(self):
        source=self.root/'dependency-source';managed=source/'managed_components';managed.mkdir(parents=True)
        (source/'dependencies.lock').write_text('fixed lock')
        driver=managed/'driver.c';driver.write_text('real driver')
        metadata=managed/'.DS_Store';metadata.write_text('old metadata')
        index={'files':[m.artifact(driver,source,'dependencySource'),m.artifact(metadata,source,'dependencySource')],
            'lockSha256':m.sha(source/'dependencies.lock')}
        metadata.unlink();(managed/'._driver.c').write_text('new Finder metadata')
        (managed/'__MACOSX').mkdir();(managed/'__MACOSX/notes').write_text('Finder payload')
        self.assertTrue(m._dependency_sources_match(source,index))
        driver.write_text('changed driver');self.assertFalse(m._dependency_sources_match(source,index))
        driver.write_text('real driver');extra=managed/'.hidden.c';extra.write_text('extra business source')
        self.assertFalse(m._dependency_sources_match(source,index));extra.unlink()
        driver.unlink();self.assertFalse(m._dependency_sources_match(source,index))
    def test_historical_metadata_artifacts_are_ignored_but_source_aliases_and_hashes_are_strict(self):
        driver=self.root/'driver.c';driver.write_text('real source')
        metadata=self.root/'.DS_Store';metadata.write_text('old Finder data')
        entries=[m.artifact(driver,self.root,'source'),m.artifact(metadata,self.root,'source')]
        metadata.unlink()
        manifest=self.root/'firmware-manifest.json'
        report={'artifactRoot':str(self.root),'target':'esp32s31','artifacts':entries,'exitCode':0,'idf':{'commit':m.SDK_COMMIT}}
        m.write_json(manifest,report)
        self.assertTrue(m.validate_build(manifest)['checks']['artifactHashes'])
        driver.write_text('changed source')
        self.assertFalse(m.validate_build(manifest)['checks']['artifactHashes'])
        driver.write_text('real source');report['artifacts'][0]['relativePath']='.DS_Store';m.write_json(manifest,report)
        self.assertFalse(m.validate_build(manifest)['checks']['artifactHashes'])

if __name__=='__main__':unittest.main()
