from pathlib import Path
import copy
import importlib.util
import json
import tempfile
import shutil
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('hdk_companion',Path(__file__).resolve().parents[1]/'hdk/companion_firmware.py')
comp=importlib.util.module_from_spec(spec);spec.loader.exec_module(comp)


def facts():
    pins=[]
    for signal,p4 in [('C61_U0RXD',54),('C61_U0TXD',53),('C61_EN',52),('C61_IO9',2)]:
        pins += [{'name':signal,'net':signal},{'name':'IO'+str(p4),'net':signal}]
    for gpio in [0,1,4,5,6,7,8]: pins.append({'name':'C61_IO'+str(gpio),'net':'C61_IO'+str(gpio)})
    return {'source':{'path':'/not-read-by-pure-unit-tests.epro2','sha256':'a'*64},
        'board':{'modulePart':'WT01P461-S1','moduleRef':'J5','targets':['esp32p4','esp32c61'],
            'components':[{'designator':'J5','pins':pins}]},
        'peripherals':{'headers':[{'designator':'J3','pins':[
            {'pad':'6','net':'C61_U0TXD'},{'pad':'7','net':'C61_U0RXD'},{'pad':'1','net':'GND'},
            *[{'pad':str(10+i),'net':'C61_IO'+str(gpio)} for i,gpio in enumerate([0,1,4,5,6,7,8])]]}]}}


class CompanionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()

    def test_binding_uses_real_signal_direction_not_module_pad_numbers(self):
        b=comp.binding(facts())
        self.assertEqual(b['p4'],{'tx':54,'rx':53,'reset':52,'boot':2})
        self.assertEqual(b['c61'],{'tx':11,'rx':10,'boot':9,'reset':'EN'})
        wrong=facts();wrong['board']['targets']=['esp32p4','esp32c6']
        with self.assertRaises(ValueError):comp.binding(wrong)
        wrong=facts();wrong['board']['components'][0]['pins'][1]['name']='IO53'
        with self.assertRaises(ValueError):comp.binding(wrong)

    def test_current_source_is_reread_before_writing(self):
        class Changed:
            @staticmethod
            def inspect_board(path):
                value=facts();value['source']['sha256']='b'*64;return value
        with patch.object(comp,'_fw',return_value=Changed()):
            with self.assertRaisesRegex(ValueError,'发生变化'):comp.generate(facts(),self.root)
        self.assertEqual(list(self.root.iterdir()),[])

    def test_generates_replayable_separate_target_and_source_hash(self):
        with patch.object(comp,'_current',side_effect=lambda f:f):result=comp.generate(facts(),self.root)
        self.assertEqual(result['target'],'esp32c61')
        self.assertEqual(result['physicalTestStatus'],'not-run')
        source=Path(result['sourceDir'])
        self.assertIn('CONFIG_IDF_TARGET="esp32c61"',(source/'sdkconfig.defaults').read_text())
        self.assertIn('a'*64,(source/'main/companion_config.h').read_text())
        self.assertTrue((source/'components/hdk_cjson/LICENSE').is_file())
        for entry in result['sourceFiles']:
            self.assertEqual(comp.sha(entry['path']),entry['sha256'])
        with patch.object(comp,'_current',side_effect=lambda f:f):
            with self.assertRaisesRegex(ValueError,'覆盖'):comp.generate(facts(),self.root)

    def test_install_bridge_has_pinned_dependency_and_does_not_overwrite(self):
        main=self.root/'source/main';main.mkdir(parents=True)
        with patch.object(comp,'_current',side_effect=lambda f:f):
            paths=comp.install_bridge(facts(),main)
            self.assertTrue((main/'bridge.c').is_file())
            self.assertTrue((main.parent/'components/hdk_cjson/cJSON.c').is_file())
            self.assertTrue(all(Path(p).is_file() for p in paths))
            with self.assertRaisesRegex(ValueError,'覆盖'):comp.install_bridge(facts(),main)

    def test_fixture_covers_only_ordinary_exposed_signals_and_excludes_all_strapping(self):
        design=comp.fixture_design(facts())
        self.assertEqual(design['coveredGpios'],[0,1,5,6])
        self.assertEqual([(p['outputPin'],p['inputPin']) for p in design['connections']],[('J3.10','J3.11'),('J3.13','J3.14')])
        self.assertTrue({3,4,7,8,9,10,11}.issubset({p['gpio'] for p in design['excludedGpios']}))
        self.assertTrue(any(t['id']=='companion-gpio-loopback' for t in comp.tests_manifest()))
        changed=facts();changed['peripherals']['headers'][0]['pins'].append({'pad':'25','net':'C61_NEW_IO'})
        changed['board']['components'][0]['pins'].append({'name':'C61_IO2','net':'C61_NEW_IO'})
        with self.assertRaisesRegex(ValueError,'不能遗漏'):comp.fixture_design(changed)

    def test_c61_guide_uses_current_header_and_actual_offsets(self):
        area=self.root/'C61';area.mkdir();binary=area/'current.bin';binary.write_bytes(b'actual')
        report={'artifactRoot':str(area),'boardFacts':facts(),'boardSourceSha256':'a'*64,
            'flash':{'offsets':[{'offset':'0x10000','path':str(binary),'sha256':comp.sha(binary)}]}}
        text=comp.write_flashing_guide(report).read_text()
        self.assertIn('J3.7',text);self.assertIn('J3.6',text)
        self.assertIn('0x10000',text);self.assertIn('--chip esp32c61',text)
        self.assertIn('不接适配器VCC',text);self.assertIn('未连接或烧录任何实物',text)
    def test_c61_source_manifest_excludes_finder_metadata_without_dropping_hidden_source(self):
        assets=self.root/'assets';shutil.copytree(comp.ASSETS,assets)
        for relative in ['main/.DS_Store','main/._main.c','components/hdk_cjson/__MACOSX/readme','main/.hidden.c']:
            path=assets/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('metadata or source')
        with patch.object(comp,'ASSETS',assets),patch.object(comp,'_current',side_effect=lambda f:f):
            result=comp.generate(facts(),self.root)
        paths={item['relativePath'] for item in result['sourceFiles']}
        self.assertIn('source/main/.hidden.c',paths)
        self.assertFalse(any(comp._fw().is_os_metadata(path) for path in paths))
    def test_c61_historical_metadata_is_ignored_while_business_hashes_stay_strict(self):
        helper=comp._fw();driver=self.root/'driver.c';driver.write_text('real source')
        metadata=self.root/'.DS_Store';metadata.write_text('old metadata')
        entries=[helper.artifact(driver,self.root,'source'),helper.artifact(metadata,self.root,'source')]
        metadata.unlink();manifest=self.root/'firmware-manifest.json'
        report={'artifactRoot':str(self.root),'artifacts':entries,'exitCode':0,'status':'compiled','idf':{'commit':comp.SDK_COMMIT}}
        helper.write_json(manifest,report)
        self.assertTrue(comp.validate_build(manifest)['checks']['artifactHashes'])
        driver.write_text('changed business source')
        self.assertFalse(comp.validate_build(manifest)['checks']['artifactHashes'])


if __name__=='__main__':unittest.main()
