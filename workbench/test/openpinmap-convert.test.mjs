import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePinoutOptions, validateBoundProject, inspectPinoutPng, measurePinoutLabelMetrics, resolvePreparedAlignment } from '../scripts/openpinmap-convert.mjs';

test('Pinout converter requires explicit safe local project, output and name', () => {
  assert.throws(() => validatePinoutOptions({}), /projectPath/);
  assert.throws(() => validatePinoutOptions({ projectPath: 'x.step', outputDir: '/tmp', basename: 'board' }), /projectPath/);
  assert.throws(() => validatePinoutOptions({ projectPath: 'x.json', outputDir: '/tmp', basename: '../board' }), /basename/);
  assert.throws(() => validatePinoutOptions({ projectPath: 'x.json', outputDir: '/tmp', basename: 'board', timeoutMs: 999 }), /timeoutMs/);
  assert.equal(validatePinoutOptions({ projectPath: 'x.json', outputDir: '/tmp', basename: 'board' }).basename, 'board');
});

test('Pinout rejects wrong project type, no pins and validator changes to geometry', () => {
  const state = { width: 400, height: 400, imageData: 'data:image/png;base64,AAAA', groups: [{ pins: [{ name: 'GND', color: '#00ff00' }] }] };
  const raw = { format: 'openpinmap', version: 2, state };
  const model = 'globalThis.OpenPinMapModel={validateProject:raw=>JSON.parse(JSON.stringify(raw.state))};';
  assert.throws(() => validateBoundProject({ ...raw, version: 1 }, model), /version 2/);
  assert.throws(() => validateBoundProject({ ...raw, state: { ...state, groups: [{ pins: [] }] } }, model), /actual pins/);
  assert.deepEqual(validateBoundProject(raw, model), raw);
  assert.throws(() => validateBoundProject(raw, 'globalThis.OpenPinMapModel={validateProject:raw=>({...raw.state,width:8000})};'), /width/);
});

test('Pinout export verification checks PNG signature and dimensions', () => {
  assert.throws(() => inspectPinoutPng(Buffer.from('not a png')), /not a PNG/);
  const png = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.write('IHDR',12); png.writeUInt32BE(2480,16); png.writeUInt32BE(3508,20); png[25] = 6;
  assert.deepEqual(inspectPinoutPng(png), { width: 2480, height: 3508, colorType: 6 });
});

function prepared() {
  return { project: { format: 'openpinmap', version: 2, state: { width: 1000, height: 800, imageX: 250, imageY: 250, imageScale: 100, groups: [{ connector: 'J3', layout: 'vertical', labelRotation: 0, scale: 1, rotation: 0, mirrorX: false, mirrorY: false, gap: 50, pins: [{ name: 'GND' }, { name: 'IO1' }] }] } }, alignment: { version: 1, image: { width: 400, height: 300 }, anchors: [{ connector: 'J3', side: 'left', firstPadPixel: [300,350] }] } };
}

test('Prepared labels align their centers using actual renderer font metrics', () => {
  const { project, alignment } = prepared();
  const result = resolvePreparedAlignment(project, alignment, [{ width: 100, height: 32 }]);
  assert.deepEqual(result.project.state.groups[0].start, [120,334]);
  assert.equal(result.verification.connectors[0].maxAlignmentErrorPx, 0);
  assert.equal(project.state.groups[0].start, undefined);
});

test('Prepared labels reject wrong connector, overlap and out-of-canvas labels', () => {
  const { project, alignment } = prepared();
  assert.throws(() => resolvePreparedAlignment(project, { ...alignment, anchors: [{ ...alignment.anchors[0], connector: 'J4' }] }, [{ width: 100, height: 32 }]), /mismatch/);
  assert.throws(() => resolvePreparedAlignment(project, alignment, [{ width: 100, height: 60 }]), /overlap/);
  assert.throws(() => resolvePreparedAlignment(project, alignment, [{ width: 400, height: 32 }]), /exceed/);
});

test('Photo source and transparent-only crop binding survive the isolated renderer alignment', () => {
  const { project, alignment } = prepared();
  alignment.photograph = { side: 'back', kind: 'actual-photograph', original: { sha256: 'original' }, cropBox: [118,79,400,604], pixelsUnchanged: true };
  const result = resolvePreparedAlignment(project, alignment, [{ width: 100, height: 32 }]);
  assert.deepEqual(result.verification.photograph, alignment.photograph);
  result.verification.photograph.cropBox[0] = 0;
  assert.equal(alignment.photograph.cropBox[0], 118);
});

function compactPrepared() {
  const { project, alignment } = prepared();
  Object.assign(project.state, { imageScale:100, imageRotation:0, background:'transparent',guides:false,fontSize:12,palette:{gpio:'#3498db',power:'#ff0000',ground:'#2ecc71'} });
  alignment.image={width:274,height:545};
  alignment.anchors[0].firstPadImagePixel=[20,16];
  alignment.anchors[0].padImagePixels=[[20,16],[20.2,66.2]];
  alignment.displayPlan={format:'workbench-pinout-display-plan',version:1,style:{preset:'reference-compact',background:'transparent',guides:false,fontSize:12,labelGapPx:3,palette:project.state.palette},displayAliases:[]};
  alignment.aliasMapping=[];
  return {project,alignment};
}

test('Skill compact layout uses native photo pixels and real label metrics in a portrait canvas', () => {
  const {project,alignment}=compactPrepared();
  const result=resolvePreparedAlignment(project,alignment,[{width:76,height:17}]);
  assert.equal(result.project.state.imageScale,100);
  assert.ok(result.project.state.height>result.project.state.width);
  assert.equal(result.project.state.background,'transparent');
  assert.equal(result.project.state.guides,false);
  const check=result.verification.connectors[0];
  assert.equal(check.edgeGapPx,3);
  assert.ok(Math.abs(check.maxAlignmentErrorPx-.2)<.001);
  assert.equal(check.labelStart[0]+check.labelSize[0],result.project.state.imageX-3);
  assert.equal(result.verification.displayPlan.style.preset,'reference-compact');
});

test('Skill style is applied without silently correcting bad choices or changing calibrated pins', () => {
  const {project,alignment}=compactPrepared();
  assert.throws(()=>resolvePreparedAlignment({...project,state:{...project.state,guides:true}},alignment,[{width:76,height:17}]),/Skill display plan/);
  assert.throws(()=>resolvePreparedAlignment({...project,state:{...project.state,imageScale:150}},alignment,[{width:76,height:17}]),/native-scale/);
  alignment.anchors[0].padImagePixels[1][1]+=3;
  assert.throws(()=>resolvePreparedAlignment(project,alignment,[{width:76,height:17}]),/actual calibrated pad/);
});

test('Renderer overlap diagnostic identifies actual maximum-height labels and explains horizontal gap', () => {
  const {project,alignment}=compactPrepared();
  Object.assign(project.state.groups[0], {connector:'J4',textDirection:'horizontal',gap:19.12,pins:[{name:'IO42'},{name:'LDO_VO4'}]});
  alignment.anchors[0].connector='J4';
  const previousDocument=globalThis.document;
  try {
    // Reproduce the actual font-metric distinction: an underscore can extend
    // below the baseline even when a simple capital label fits the pin pitch.
    globalThis.document={createElement:()=>({getContext:()=>({measureText:name=>({width:60,actualBoundingBoxAscent:9,actualBoundingBoxDescent:name==='LDO_VO4'?3:0})})})};
    const metrics=measurePinoutLabelMetrics(project.state);
    assert.deepEqual(metrics[0].heightDrivers,['LDO_VO4']);
    assert.equal(metrics[0].height,20);
    assert.throws(()=>resolvePreparedAlignment(project,alignment,metrics),error=>{
      assert.match(error.message,/maximum glyph-height label\(s\) \["LDO_VO4"\]/);
      assert.match(error.message,/fontSize 12 px; capsule height 20 px \/ pin pitch 19\.12 px/);
      assert.match(error.message,/labelGapPx controls horizontal spacing and cannot reduce row height/);
      assert.match(error.message,/semantic-preserving display alias from the allowedLabels candidates/);
      assert.doesNotMatch(error.message,/\bLDO4\b/);
      return true;
    });
    assert.equal(project.state.groups[0].pins[1].name,'LDO_VO4');
  } finally {
    if(previousDocument===undefined)delete globalThis.document;else globalThis.document=previousDocument;
  }
});
