import copy
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from hdk.pinout_facts import extract_pinout_facts, prepare_pinout, prepare_photo_pinouts, validate_alignment, _native_mapping, display_options, validate_display_plan, PinoutBlocked


class PinoutFactsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root/'board.epro2'
        rows = []
        def record(kind, body, ident=None):
            head = {'type': kind}
            if ident is not None: head['id'] = ident
            rows.append(json.dumps(head)+'||'+json.dumps(body)+'|')
        record('DOCHEAD', {'uuid': 'pcb', 'docType': 'PCB'})
        for ref, uid, y in [('J3', 'c3', 100), ('J4', 'c4', 300)]:
            record('COMPONENT', {'x': 100, 'y': y, 'angle': 0, 'layerId': 1}, uid)
            for key, value in [('Designator', ref), ('Footprint', 'fp')]: record('ATTR', {'parentId': uid, 'key': key, 'value': value}, uid+key)
            for number, net in [('1', 'GND'), ('2', 'IO1' if ref == 'J3' else 'C61_IO8')]: record('PAD_NET', {'padNet': net}, json.dumps(['PAD_NET', uid, number]))
        record('DOCHEAD', {'uuid': 'fp', 'docType': 'FOOTPRINT'})
        for number, x in [('1', -50), ('2', 50)]: record('PAD', {'num': number, 'centerX': x, 'centerY': 0, 'plated': True, 'hole': {'width': 35}}, 'pad'+number)
        with zipfile.ZipFile(self.source, 'w') as archive: archive.writestr('board.epru', '\n'.join(rows))
        self.image = self.root/'pcb.png'
        def chunk(kind, body): return struct.pack('>I',len(body))+kind+body+struct.pack('>I', zlib.crc32(kind+body))
        self.image.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',400,400,8,6,0,0,0))+chunk(b'IDAT',zlib.compress((b'\x00'+b'\xff\xff\xff\xff'*400)*400))+chunk(b'IEND',b''))
        self.facts = extract_pinout_facts(self.source)
        self.info = {'sha256': hashlib.sha256(self.image.read_bytes()).hexdigest(), 'width': 400, 'height': 400}
        self.evidence = {'sourceSha256': self.facts['source']['sha256'], 'pcbUuid': 'pcb', 'view': 'top', 'coordinateFrame': 'pcb-data-mil', 'image': self.info, 'worldToPixel': [1,0,0,1,0,0], 'calibration': {'passed': True, 'maxErrorPx': 0.2}, 'controlPoints': [{'world': [0,0], 'pixel': [0,0]}, {'world': [399,0], 'pixel': [399,0]}, {'world': [0,399], 'pixel': [0,399]}], 'componentPads': [{'componentId': uid, 'designator': ref, 'pads': [{'parentComponentId': uid, 'number': number, 'x': x, 'y': y, 'net': net} for number,x,net in [('1',50,'GND'), ('2',150,'IO1' if ref == 'J3' else 'C61_IO8')]]} for ref,uid,y in [('J3','c3',100),('J4','c4',300)]]}
        self.meta = self.root/'native.json'
        self.meta.write_text(json.dumps({'pinoutEvidence': self.evidence}))

    def tearDown(self): self.temp.cleanup()

    def test_source_uses_real_pad_net_not_p4_example(self):
        self.assertEqual(self.facts['pinCount'], 4)
        self.assertEqual([connector['designator'] for connector in self.facts['connectors']], ['J3','J4'])
        self.assertEqual(self.facts['connectors'][1]['pins'][1]['name'], 'C61_IO8')
        self.assertEqual(len(extract_pinout_facts(self.source, ['J3'])['connectors']), 1)

    def test_prepare_requires_calibrated_mapping_and_saves_blocked_facts(self):
        result = prepare_pinout({'sourcePath':str(self.source),'outputDir':str(self.root/'out'),'productCode':'TEST','hardwareVersion':'V1.0'})
        self.assertFalse(result['validated'])
        self.assertEqual(result['status'],'blocked')
        self.assertTrue(Path(result['factsPath']).is_file())
        self.assertIsNone(result['projectPath'])

    def test_valid_native_mapping_produces_editable_bound_project(self):
        result = prepare_pinout(sourcePath=self.source, boardImagePath=self.image, outputDir=self.root/'out', productCode='TEST', nativeMetaPath=self.meta)
        self.assertTrue(result['validated'], result.get('reason'))
        project = json.loads(Path(result['projectPath']).read_text())
        self.assertEqual(project['version'],2)
        self.assertEqual(project['state']['groups'][1]['pins'][1]['_net'],'C61_IO8')
        self.assertEqual(project['state']['groups'][0]['gap'],100)
        with self.assertRaisesRegex(PinoutBlocked,'overwrite'):
            prepare_pinout(sourcePath=self.source, boardImagePath=self.image, outputDir=self.root/'out', productCode='TEST', nativeMetaPath=self.meta)

    def test_projection_rejects_source_hash_image_hash_and_collinear_controls(self):
        for mutate in [lambda e:e.update(sourceSha256='bad'), lambda e:e['image'].update(sha256='bad'), lambda e:e.update(controlPoints=[{'world':[0,0],'pixel':[0,0]},{'world':[1,0],'pixel':[1,0]},{'world':[2,0],'pixel':[2,0]}]), lambda e:e['calibration'].update(maxErrorPx=2)]:
            evidence = copy.deepcopy(self.evidence); mutate(evidence)
            with self.assertRaises(PinoutBlocked): validate_alignment(copy.deepcopy(self.facts), self.info, evidence)

    def test_native_numbered_net_mismatch_and_bottom_ambiguity_are_blocked(self):
        evidence = copy.deepcopy(self.evidence); evidence['componentPads'][0]['pads'][0]['net']='IO99'
        with self.assertRaisesRegex(PinoutBlocked,'net differs'): validate_alignment(copy.deepcopy(self.facts),self.info,evidence)
        connector = copy.deepcopy(self.facts['connectors'][0]);connector['placement']['layerId']=2
        native = copy.deepcopy(self.evidence['componentPads'][0])
        for pad in native['pads']:pad.pop('number')
        with self.assertRaisesRegex(PinoutBlocked,'possible native pad-number mappings'): _native_mapping(connector,native)

    def photo_request(self):
        from PIL import Image
        # Add a center pin to both real native headers, giving two controls
        # that were not used to fit the four-corner photograph transform.
        with zipfile.ZipFile(self.source) as archive: rows = archive.read('board.epru').decode().splitlines()
        additions = []
        for uid in ('c3', 'c4'):
            additions.append(json.dumps({'type':'PAD_NET','id':json.dumps(['PAD_NET',uid,'3'])})+'||'+json.dumps({'padNet':'IO2'})+'|')
        boundary = next(index for index,row in enumerate(rows) if '"uuid": "fp"' in row)
        rows[boundary:boundary] = additions
        rows.append(json.dumps({'type':'PAD','id':'pad3'})+'||'+json.dumps({'num':'3','centerX':150,'centerY':0,'plated':True,'hole':{'width':35}})+'|')
        with zipfile.ZipFile(self.source,'w') as archive:archive.writestr('board.epru','\n'.join(rows))
        facts = extract_pinout_facts(self.source)
        evidence = copy.deepcopy(self.evidence); evidence['sourceSha256']=facts['source']['sha256']
        for native in evidence['componentPads']:
            native['pads'].append({'parentComponentId':native['componentId'],'number':'3','x':250,'y':native['pads'][0]['y'],'net':'IO2'})
        self.meta.write_text(json.dumps({'pinoutEvidence':evidence}))
        photos,views=[],[]
        for side,sign in [('front',-1),('back',1)]:
            path=self.root/f'{side}.png';Image.new('RGBA',(400,400),(40 if side=='front' else 60,80,90,255)).save(path)
            info={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'width':400,'height':400}
            photos.append({'side':side,'path':str(path),'sha256':info['sha256']})
            controls=[]
            for connector in facts['connectors']:
                for pin in connector['pins']:
                    x=100+pin['localMil'][0];y=connector['placement']['y']
                    controls.append({'connector':connector['designator'],'pad':pin['pad'],'net':pin['net'],'pixel':[x,400-y if side=='front' else y],'use':'check' if pin['pad']=='2' else 'fit'})
            views.append({'side':side,'reviewStatus':'visually-reviewed','orientationReviewed':True,'expectedDeterminantSign':sign,'image':info,'cropBox':[0,0,400,400],'controlPoints':controls})
        profile=self.root/'photo-profile.json'
        profile.write_text(json.dumps({'format':'workbench-pinout-photo-calibration','version':1,'sourceSha256':facts['source']['sha256'],'pcbUuid':'pcb','views':views}))
        return {'sourcePath':str(self.source),'images':photos,'photoProfilePath':str(profile),'nativeMetaPath':str(self.meta),'outputDir':str(self.root/'photos'),'productCode':'TEST','hardwareVersion':'V1.0'}

    def test_photo_pinout_preserves_real_photographs_and_independent_side_mapping(self):
        from PIL import Image,ImageChops
        request=self.photo_request();originals={item['path']:Path(item['path']).read_bytes() for item in request['images']}
        result=prepare_photo_pinouts(request)
        self.assertEqual([view['side'] for view in result['views']],['front','back'])
        self.assertTrue(result['validated']);self.assertEqual(result['pinCount'],6)
        for view in result['views']:
            self.assertTrue(view['alignment']['calibration']['passed'])
            self.assertEqual(view['alignment']['calibration']['independentCheckCount'],2)
            facts=json.loads(Path(view['factsPath']).read_text());project=json.loads(Path(view['projectPath']).read_text())
            self.assertEqual(facts['preparation']['status'],'ready')
            self.assertEqual(project['workbenchAlignment']['photograph']['original']['sha256'],facts['photoOriginal']['sha256'])
            self.assertIn('J3.',project['state']['groups'][0]['pins'][0]['name'])
            self.assertTrue(ImageChops.difference(Image.open(facts['photoOriginal']['path']).convert('RGBA'),Image.open(facts['image']['path']).convert('RGBA')).getbbox() is None)
        self.assertNotEqual(result['views'][0]['alignment']['worldToPixel'],result['views'][1]['alignment']['worldToPixel'])
        for path,data in originals.items():self.assertEqual(Path(path).read_bytes(),data)

    def test_photo_pinout_refuses_swapped_images_bad_side_and_failed_independent_checks(self):
        request=self.photo_request();profile=Path(request['photoProfilePath']);baseline=json.loads(profile.read_text())
        for index,mutate in enumerate([
            lambda value:value['views'][0]['image'].update(sha256='0'*64),
            lambda value:value['views'][0].update(expectedDeterminantSign=1),
            lambda value:value['views'][0]['controlPoints'][-2].update(pixel=[20,20]),
            lambda value:value['views'][0]['controlPoints'][-2].update(net='IO99'),
            lambda value:value['views'][0].update(cropBox=[1,1,400,400]),
        ]):
            value=copy.deepcopy(baseline);mutate(value);profile.write_text(json.dumps(value))
            with self.subTest(index=index),self.assertRaises(PinoutBlocked):
                prepare_photo_pinouts({**request,'outputDir':str(self.root/f'bad-{index}')})

    def plan(self, facts):
        return {'format':'workbench-pinout-display-plan','version':1,
            'style': {'preset':'reference-compact','background':'transparent','guides':False,'fontSize':12,'labelGapPx':3,
                'palette': {'gpio':'#3498db','power':'#ff0000','ground':'#2ecc71'}},
            'displayAliases': [{key:item[key] for key in ('connector','pad','net')} | {'label':item['allowedLabels'][-2]} for item in display_options(facts)['pins']]}

    def test_display_aliases_are_choices_from_exact_source_and_keep_companion_namespace(self):
        options=display_options(self.facts)
        companion=next(item for item in options['pins'] if item['net']=='C61_IO8')
        self.assertEqual(companion['allowedLabels'],['C61_IO8','C61 IO8','J4.2 · C61_IO8'])
        plan=self.plan(self.facts)
        self.assertEqual(validate_display_plan(plan,self.facts),plan)
        for mutate in [lambda value:value['displayAliases'].pop(), lambda value:value['displayAliases'][0].update(net='IO99'),
                       lambda value:value['displayAliases'][0].update(label='3.3V'), lambda value:value['style'].update(imageScale=200),
                       lambda value:value['style']['palette'].update(power='red'), lambda value:value['style'].update(guides='false')]:
            value=copy.deepcopy(plan);mutate(value)
            with self.assertRaises(PinoutBlocked):validate_display_plan(value,self.facts)

    def test_photo_skill_plan_changes_only_display_and_preserves_source_photo_and_trace(self):
        request=self.photo_request();facts=extract_pinout_facts(self.source)
        plan=self.plan(facts)
        result=prepare_photo_pinouts({**request,'displayPlan':plan})
        for view in result['views']:
            prepared=json.loads(Path(view['projectPath']).read_text())
            state=prepared['state']
            self.assertEqual(state['background'],'transparent')
            self.assertFalse(state['guides'])
            self.assertEqual(state['imageScale'],100)
            self.assertGreater(state['height'],state['width'])
            for group in state['groups']:
                for pin in group['pins']:
                    self.assertNotIn(' · ',pin['name'])
                    self.assertIn(pin['name'],next(item['allowedLabels'] for item in display_options(facts)['pins'] if item['connector']==group['connector'] and item['pad']==pin['_pin']))
                    self.assertEqual(pin['_net'],next(item['net'] for item in display_options(facts)['pins'] if item['connector']==group['connector'] and item['pad']==pin['_pin']))
            self.assertEqual(prepared['workbenchAlignment']['displayPlan'],plan)

    def test_ldo_unknown_voltage_alias_is_source_safe_and_guessed_voltage_is_rejected(self):
        facts=copy.deepcopy(self.facts)
        facts['connectors'][0]['pins'][0].update(net='LDO_VO12',name='LDO_VO12')
        options=display_options(facts)
        ldo=next(item for item in options['pins'] if item['net']=='LDO_VO12')
        self.assertIn('LDO12?',ldo['allowedLabels'])
        self.assertIn('LDO12',ldo['allowedLabels'])
        self.assertIn('voltage unverified',options['namespaceNote'])
        plan=self.plan(facts)
        alias=next(item for item in plan['displayAliases'] if item['net']=='LDO_VO12')
        alias['label']='LDO12?'
        self.assertEqual(validate_display_plan(plan,facts)['displayAliases'],plan['displayAliases'])
        for guessed in ('3.3V','LDO12 3.3V','LDO4?'):
            bad=copy.deepcopy(plan)
            next(item for item in bad['displayAliases'] if item['net']=='LDO_VO12')['label']=guessed
            with self.assertRaises(PinoutBlocked):validate_display_plan(bad,facts)


if __name__ == '__main__': unittest.main()
