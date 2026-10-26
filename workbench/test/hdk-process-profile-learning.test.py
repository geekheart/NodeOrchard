"""Protocol legality checks use source nets, never a generated workbook or score."""
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[1]
def module(name):
    spec=importlib.util.spec_from_file_location('test_'+name,ROOT/'hdk'/(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
helper=module('process_profile_learning');process=module('process_requirements')


class SourceProtocolConstraints(unittest.TestCase):
    def setUp(self):
        self.facts={'signalNets':['EXT_P','EXT_N','ALIAS_P','ALIAS_N','MCLK_P','MCLK_N','DATA_A','DATA_B','POWER'],
            'nativeDifferentialPairs':{'external':['EXT_P','EXT_N'],'internal':['ALIAS_P','ALIAS_N'],'mipi':['MCLK_P','MCLK_N']}}
        self.interfaces={'usb':[{'pins':[{'name':'Dp1','net':'EXT_P'},{'name':'Dn1','net':'EXT_N'}]}],
            'usbSignalPathComponents':[{'designator':'Lx','part':'source-part','pins':[{'net':n}for n in('EXT_P','EXT_N','ALIAS_P','ALIAS_N','POWER')]}],
            'camera':{'interface':'mipi-csi','connector':'CAM'},'sd':{'signalNets':['DATA_A','DATA_B']}}
        self.board={'board':{'components':[{'designator':'CAM','pins':[{'net':'MCLK_P'},{'net':'MCLK_N'},{'net':'POWER'}]}]}}
        self.requirements=helper.source_requirements(self.facts,self.board,self.interfaces)
        self.records=[({'type':'LINE'},{'netName':n})for n in self.facts['signalNets']]

    def target(self,name,pattern,kind,ohms):
        return {'name':name,'netPattern':pattern,'kind':kind,'targetOhms':ohms,'tolerancePercent':10}

    def profile(self,usb='^EXT_|^ALIAS_',sd='^DATA_'):
        return process._profile({'schemaVersion':1,'impedanceTargets':[
            self.target('USB',usb,'differential',90),self.target('MIPI','^MCLK_','differential',100),
            self.target('SDIO',sd,'single-ended',50)]})

    def test_source_pairs_cross_common_mode_aliases_but_power_is_not_swept_in(self):
        usb=next(r for r in self.requirements if r['family']=='USB')
        self.assertEqual(set(usb['nets']),{'EXT_P','EXT_N','ALIAS_P','ALIAS_N'})
        self.assertNotIn('POWER',set().union(*(set(r['nets'])for r in self.requirements)))

    def test_all_actual_source_protocol_nets_can_pass_without_board_pin_constants(self):
        self.assertEqual(helper.profile_diagnostics(process,self.facts,self.records,self.profile(),self.requirements),[])

    def test_external_usb_only_regex_does_not_hide_missing_internal_segments(self):
        diagnostics=helper.profile_diagnostics(process,self.facts,self.records,self.profile(usb='^EXT_'),self.requirements)
        missing=next(d for d in diagnostics if d.get('family')=='USB')
        self.assertEqual(missing['missingNets'],['ALIAS_N','ALIAS_P'])

    def test_sdio_does_not_depend_on_the_letters_sd_in_its_net_names(self):
        diagnostics=helper.profile_diagnostics(process,self.facts,self.records,self.profile(sd='^SD_'),self.requirements)
        self.assertEqual(next(d for d in diagnostics if d.get('family')=='SDIO')['missingNets'],['DATA_A','DATA_B'])

    def test_broad_usb_regex_cannot_silently_assign_usb_impedance_to_other_protocols(self):
        diagnostics=helper.profile_diagnostics(process,self.facts,self.records,self.profile(usb='.*'),self.requirements)
        conflicts={d['family']for d in diagnostics if d['kind']=='conflictingProtocolTargets'}
        self.assertEqual(conflicts,{'MIPI','SDIO'})


if __name__=='__main__':unittest.main()
