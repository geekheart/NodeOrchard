"""Shared execution/learning orchestration; no live EDA or model calls."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value
native = module('hdk_runtime_test_native', ROOT/'hdk/exporter/export_hdk.py')
runtime = module('hdk_runtime_test', ROOT/'hdk/runtime.py')


def worksheet(headers):
    ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    sheet=ET.Element('{'+ns+'}worksheet');data=ET.SubElement(sheet,'{'+ns+'}sheetData');row=ET.SubElement(data,'{'+ns+'}row',{'r':'1'})
    for index, value in enumerate(headers):
        cell=ET.SubElement(row,'{'+ns+'}c',{'r':chr(65+index)+'1','t':'inlineStr'})
        ET.SubElement(ET.SubElement(cell,'{'+ns+'}is'),'{'+ns+'}t').text=value
    return ET.tostring(sheet)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.sources = self.base/'sources'; self.sources.mkdir()
        self.output = self.base/'output'; self.output.mkdir()
        self.data = self.base/'receipts'
        for key, value in [('SOURCE_ROOT',self.sources),('OUTPUT_ROOT',self.output),('DATA',self.data)]:
            p=patch.object(runtime,key,value);p.start();self.addCleanup(p.stop)
        self.source = self.sources/'input.epro2'
        heads=[{'docType':'PCB','uuid':'pcb-native'},{'docType':'SCH_PAGE','uuid':'sch-native'}]
        with zipfile.ZipFile(self.source,'w') as z:
            z.writestr('project2.json',json.dumps({'title':'source fixture'}))
            z.writestr('project.epru','\n'.join(json.dumps({'type':'DOCHEAD'})+'||'+json.dumps(h)+'|' for h in heads))
        self.value={'sourcePath':str(self.source),'productCode':'WT9932S31-TINY','hardwareVersion':'1.0','releaseDate':'2026-10-24'}
        self.run_id=str(uuid.uuid4())
        p=patch.dict(os.environ,{'WORKBENCH_RUN_ID':self.run_id},clear=True);p.start();self.addCleanup(p.stop)
        self.calls=[];self.checked=None
        p=patch.object(runtime,'exporter',lambda:native);p.start();self.addCleanup(p.stop)
        p=patch.object(runtime,'_system_json',self.system_json);p.start();self.addCleanup(p.stop)

    def plan(self, product=None, version=None, date=None):
        product=product or self.value['productCode'];version=version or self.value['hardwareVersion'];date=date or self.value['releaseDate']
        return {'packageName':f'{product}_HDK_V{version}','paths':native.expected_paths(product,version,date),
                'supplementalDirectories':['重要器件手册','生产资料/07_测试说明'],
                'checks':dict.fromkeys(['stencilFromCurrentGerber','checkDocumentReferences','excludeOsMetadata','exportFromInputOnly'],True)}

    def system_json(self, arguments, *, input_value=None, timeout=1800):
        self.calls.append({'arguments':arguments,'timeout':timeout,'input':input_value})
        if arguments[0]=='-c':
            return {kind:{'pageCount':2 if kind=='silkscreenPdf' else 1,
                          'roles':['顶面自动位号图','底面自动位号图'] if kind=='silkscreenPdf' else []}
                    for kind in input_value}
        if '--verify' in arguments:
            return json.loads(json.dumps(self.checked))
        request_path=Path(arguments[arguments.index('--request')+1]);request=json.loads(request_path.read_text())
        self.assertTrue(request_path.is_relative_to(self.data))
        self.assertEqual(request_path.stat().st_mode & 0o777,0o600)
        output=Path(request['outputParent'])/request['plan']['packageName'];output.mkdir()
        for directory in native.DIRECTORIES:(output/directory).mkdir(parents=True,exist_ok=True)
        artifacts=[]
        for kind in ['bom','pickPlace','schematicPdf','silkscreenPdf','topPaste']:
            path=output/request['plan']['paths'][kind]
            if kind in ('bom','pickPlace'):
                with zipfile.ZipFile(path,'w') as z:z.writestr('xl/worksheets/sheet1.xml',worksheet(native.BOM_HEADERS if kind=='bom' else native.PNP_HEADERS))
            else:path.write_bytes(kind.encode())
            artifacts.append({'kind':kind,'path':path.relative_to(output).as_posix(),
                'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                'checks':{'headers':['should not trust these labels'],'passed':True}})
        report_path=Path(request['outputParent'])/'native-report.json'
        report={'reportPath':str(report_path),'outputPath':str(output),'status':'blocked',
                'artifacts':artifacts,'missing':[{'kind':'processXlsx','reason':'unconfirmed'}],
                'checks':{'documentSource':[{'uuid':'pcb-native'}]}}
        report_path.write_text(json.dumps(report))
        self.checked={'coreStatus':'complete','outputPath':str(output),'artifacts':artifacts,
            'pending':[{'kind':'processXlsx'},{'kind':'schematicPdf'}],
            'notApplicable':[{'kind':'bottomPaste'}],'errors':[]}
        return report

    def export_result(self):
        runtime.preflight(self.value)
        return runtime.execute_plan(self.plan())

    def test_source_and_each_run_context_stay_private_and_execution_directories_are_unique(self):
        facts=runtime.preflight(self.value)
        self.assertEqual(set(facts),{'productCode','hardwareVersion','releaseDate','sourceProject'})
        self.assertNotIn('sourcePath',facts);self.assertEqual(facts['sourceProject']['fileName'],'input.epro2')
        receipt=self.data/(self.run_id+'.json');first=receipt.read_bytes()
        first_context=json.loads(first)
        self.assertEqual(first_context['outputParent'],str(self.output/'执行'/self.run_id))
        second_id=str(uuid.uuid4())
        with patch.dict(os.environ,{'WORKBENCH_RUN_ID':second_id}):runtime.preflight(self.value)
        self.assertEqual(receipt.read_bytes(),first)
        self.assertNotEqual(first_context['outputParent'],json.loads((self.data/(second_id+'.json')).read_text())['outputParent'])
        result=runtime.verify(runtime.execute_plan(self.plan()))
        self.assertEqual(result['coreExportStatus'],'complete')
        self.assertEqual(result['packageStatus'],'待补充资料及视觉复核')
        self.assertTrue(Path(result['reportPath']).is_file())
        self.assertEqual(result['sourceSha256'],hashlib.sha256(self.source.read_bytes()).hexdigest())

    def test_learning_replays_same_real_operations_under_learning_and_run_directories(self):
        learning_id=str(uuid.uuid4())
        with patch.dict(os.environ,{'WORKBENCH_LEARNING_ID':learning_id}):
            result=runtime.verify(self.export_result())
            self.assertEqual(Path(result['outputPath']).parent,self.output/'学习'/learning_id/self.run_id)
            self.assertEqual(result['qualitySummary']['validationErrors'],[])
            self.assertEqual(result['qualitySummary']['sourceConsistency'],dict.fromkeys([
                'inputUnchanged','documentRecordsUnchanged','bomMatchesSource','pickPlaceMatchesSource','stencilMatchesGerber','osMetadataExcluded'],True))
        self.assertTrue(any('--execute' in c['arguments'] for c in self.calls))
        self.assertEqual(self.source.name,'input.epro2')

    def test_quality_summary_reads_actual_paths_headers_roles_and_excludes_random_run_evidence(self):
        result=runtime.verify(self.export_result());summary=result['qualitySummary']
        self.assertEqual(summary['packageName'],self.plan()['packageName'])
        self.assertEqual(summary['directories'],sorted(native.DIRECTORIES+['生产资料']))
        self.assertEqual(summary['paths'],{k:self.plan()['paths'][k] for k in sorted(['bom','pickPlace','schematicPdf','silkscreenPdf','topPaste'])})
        self.assertEqual(summary['tableHeaders'],{'bom':native.BOM_HEADERS,'pickPlace':native.PNP_HEADERS})
        self.assertEqual(summary['pdfs']['silkscreenPdf'],{'pageCount':2,'roles':['顶面自动位号图','底面自动位号图']})
        self.assertEqual(summary['externalPending'],['processXlsx']);self.assertEqual(summary['notApplicable'],['bottomPaste'])
        self.assertNotIn(self.run_id,json.dumps(summary));self.assertNotIn(result['sourceSha256'],json.dumps(summary))
        self.assertIn('sha256',result['files'][0]);self.assertNotIn('candidatePlan',summary)

    def test_metadata_is_excluded_from_runtime_receipt_and_boolean_with_recorded_paths(self):
        exported=self.export_result();output=Path(exported['outputPath'])
        metadata=['.DS_Store','source/managed_components/__MACOSX/vendor/source.c','source/._sidecar']
        for relative in metadata:
            path=output/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'OS metadata')
        # Exercise a legacy adapter that still included a metadata record with
        # the same kind as a genuine business file, without trusting its label.
        self.checked['artifacts'].append({'kind':'bom','path':'.DS_Store','bytes':11,'sha256':hashlib.sha256(b'OS metadata').hexdigest()})
        result=runtime.verify(exported);summary=result['qualitySummary']
        self.assertTrue(summary['sourceConsistency']['osMetadataExcluded'])
        self.assertEqual(summary['validationErrors'],[])
        self.assertEqual(len(result['files']),5)
        self.assertEqual(summary['tableHeaders']['bom'],native.BOM_HEADERS)
        self.assertTrue(set(metadata).issubset(result['excludedMetadata']))
        self.assertTrue(all(not native.is_os_metadata_path(a['path'])for a in result['files']))
        report=json.loads(Path(result['reportPath']).read_text())
        self.assertEqual(report['excludedMetadata'],summary['excludedMetadata'])
        self.assertTrue(all(not native.is_os_metadata_path(p)for p in summary['directories']))

    def test_invalid_learning_plan_becomes_comparable_artifact_failure_with_actual_candidate(self):
        with patch.dict(os.environ,{'WORKBENCH_LEARNING_ID':str(uuid.uuid4())}):
            runtime.preflight(self.value)
            plan=self.plan();plan['paths']['project']='../../input.epro2'
            result=runtime.verify(runtime.execute_plan(plan))
            self.assertEqual(result['qualitySummary']['validationErrors'],['invalidPlan'])
            self.assertEqual(result['qualitySummary']['candidatePlan'],plan)
            self.assertIn('命名',result['qualitySummary']['diagnostic'])
            self.assertEqual(result['qualitySummary']['paths'],{})
            self.assertEqual(result['coreExportStatus'],'blocked')
        self.assertEqual(self.calls,[])

    def test_execution_invalid_plan_or_changed_source_never_reaches_native_export(self):
        runtime.preflight(self.value)
        plan=self.plan();plan['paths']['project']='../../input.epro2'
        with self.assertRaises(native.Blocked):runtime.execute_plan(plan)
        self.source.write_bytes(self.source.read_bytes()+b'changed')
        with self.assertRaisesRegex(ValueError,'发生变化'):runtime.execute_plan(self.plan())
        self.assertEqual(self.calls,[])

    def test_contexts_reports_and_output_directories_cannot_be_mixed_between_runs(self):
        runtime.preflight(self.value)
        with self.assertRaisesRegex(ValueError,'当前运行不一致'):runtime.verify({'runId':str(uuid.uuid4())})
        with self.assertRaisesRegex(ValueError,'不属于本次'):runtime.verify({'runId':self.run_id,'reportPath':str(self.base/'outside.json')})
        with patch.dict(os.environ,{'WORKBENCH_LEARNING_ID':str(uuid.uuid4())}):
            with self.assertRaisesRegex(ValueError,'回执'):runtime.execute_plan(self.plan())
        with patch.dict(os.environ,{'WORKBENCH_RUN_ID':'-'*36}):
            with self.assertRaisesRegex(ValueError,'运行上下文'):runtime.context()

    def test_verified_file_changes_become_failed_summary_and_raise_in_execution(self):
        exported=self.export_result();output=Path(exported['outputPath']);(output/self.plan()['paths']['topPaste']).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'真实文件验收未通过'):runtime.verify(exported)
        report=json.loads((output.parent/'验收报告.json').read_text())
        self.assertIn('topPaste:changedAfterVerification',report['qualitySummary']['validationErrors'])
        self.assertFalse(report['qualitySummary']['sourceConsistency']['stencilMatchesGerber'])

    def test_learning_artifact_verification_errors_are_feedback_but_infra_failure_stops(self):
        with patch.dict(os.environ,{'WORKBENCH_LEARNING_ID':str(uuid.uuid4())}):
            exported=self.export_result();self.checked['errors']=['file checksum mismatch'];self.checked['coreStatus']='blocked'
            result=runtime.verify(exported)
            self.assertEqual(result['packageStatus'],'真实文件验收失败')
            self.assertEqual(result['qualitySummary']['validationErrors'],['artifactVerificationFailed'])
            self.assertFalse(result['qualitySummary']['sourceConsistency']['bomMatchesSource'])
            with patch.object(runtime,'_system_json',side_effect=RuntimeError('infra')):
                with self.assertRaisesRegex(RuntimeError,'infra'):runtime.verify(exported)

    def test_parameters_are_generic_and_version_and_dates_are_not_fixed_to_case(self):
        self.value.update(productCode='OTHER-MINI',hardwareVersion='12.10',releaseDate='2028-02-29')
        result=runtime.verify(self.export_result())
        self.assertEqual(result['qualitySummary']['packageName'],'OTHER-MINI_HDK_V12.10')
        self.assertIn('12V10_20280229',result['qualitySummary']['paths']['pickPlace'])


class RealLegacyMetadataTests(unittest.TestCase):
    def test_real_legacy_native_report_with_late_metadata_keeps_full_quality_summary_correct(self):
        # Reuse real on-disk native-format fixtures, then run the actual disk
        # verifier and PDF probe. No live EDA/model call or mocked success flag.
        fixtures=module('hdk_runtime_legacy_export_fixtures',ROOT/'test/hdk-export.test.py')
        fixture=fixtures.ExportSafetyTests();fixture.setUp();self.addCleanup(fixture.tearDown)
        report,output,report_path=fixture.complete_report()
        report.pop('excludedMetadata',None);report_path.write_text(json.dumps(report))
        report_before=report_path.read_bytes();source_before=fixture.source.read_bytes()
        checked=native.verify_report(report_path)
        self.assertEqual(checked['coreStatus'],'complete');self.assertEqual(checked['errors'],[])
        self.assertEqual(checked['excludedMetadata'],[])
        # Finder can write these after the disk verifier returns. The summary
        # must record them now rather than reject otherwise valid business data.
        metadata=['.DS_Store','生产资料/._native','source/managed_components/__MACOSX/vendor/source.c']
        for relative in metadata:
            path=output/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'metadata remains on disk')
        for kind,relative in [('hiddenSource','source/.hidden.c'),('businessBackup','.DS_Store.txt')]:
            path=output/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'genuine business data')
            checked['artifacts'].append({'kind':kind,'path':relative,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
        request={**report['request'],'sourcePath':str(fixture.source),'sourceSha256':report['source']['sha256']}
        summary=runtime.quality_summary(checked,request,report_path)
        self.assertTrue(all(summary['sourceConsistency'].values()))
        self.assertEqual(summary['validationErrors'],[])
        self.assertTrue(set(metadata).issubset(summary['excludedMetadata']))
        self.assertEqual(summary['paths']['hiddenSource'],'source/.hidden.c')
        self.assertEqual(summary['paths']['businessBackup'],'.DS_Store.txt')
        self.assertNotIn('.DS_Store.txt',summary['excludedMetadata'])
        self.assertNotIn('source/.hidden.c',summary['excludedMetadata'])
        self.assertTrue(all(not native.is_os_metadata_path(p)for p in summary['directories']))
        # Exclusion never relaxes checks on a genuine hidden source file.
        (output/'source/.hidden.c').write_bytes(b'changed business data')
        failed=runtime.quality_summary(checked,request,report_path)
        self.assertIn('hiddenSource:changedAfterVerification',failed['validationErrors'])
        self.assertFalse(failed['sourceConsistency']['bomMatchesSource'])
        self.assertEqual(report_path.read_bytes(),report_before)
        self.assertEqual(fixture.source.read_bytes(),source_before)
        for relative in metadata:self.assertEqual((output/relative).read_bytes(),b'metadata remains on disk')


class ProcessTests(unittest.TestCase):
    def process(self, payload, code=2):
        def fake(command, **kwargs):
            self.assertEqual(command[:2],[runtime.SYSTEM_PYTHON,'-I'])
            self.assertFalse(kwargs['check']);self.assertNotIn('shell',kwargs)
            kwargs['stdout'].write(json.dumps(payload).encode())
            return SimpleNamespace(returncode=code)
        return fake

    def test_fixed_isolated_python_accepts_exit_two_as_incomplete_result(self):
        with patch.object(runtime.subprocess,'run',side_effect=self.process({'status':'blocked','missing':['manuals']})):
            self.assertEqual(runtime._system_json(['script.py'])['status'],'blocked')

    def test_timeout_or_infra_error_does_not_become_a_learnable_skill_miss(self):
        with patch.object(runtime.subprocess,'run',side_effect=subprocess.TimeoutExpired('fixed',1)):
            with self.assertRaisesRegex(RuntimeError,'超过'):runtime._system_json(['script.py'],timeout=1)
        with patch.object(runtime.subprocess,'run',side_effect=self.process({'status':'blocked','error':'session unavailable'})):
            with self.assertRaisesRegex(RuntimeError,'基础设施失败'):runtime._system_json(['script.py'])

    def test_large_stdout_is_bounded_before_json_decode(self):
        with patch.object(runtime,'MAX_STDOUT',10),patch.object(runtime.subprocess,'run',side_effect=self.process({'message':'longer than ten characters'})):
            with self.assertRaisesRegex(RuntimeError,'超过安全限额'):runtime._system_json(['script.py'])

if __name__=='__main__':unittest.main()
