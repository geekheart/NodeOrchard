import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowPackageUI } from '../public/workflow-package-ui.js';
import { WorkflowEditor } from '../public/workflow-editor.js';
import { createDocument, createNode } from '../shared/workflow/workflow-model.mjs';

const copy = value => structuredClone(value), deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const zip = () => new Blob([new Uint8Array([0x50,0x4b,3,4]), 'fixture zip bytes'], { type: 'application/zip' });
function fixture() {
  const events = [], document = createDocument({ title: '隔离流程', schemaVersion: 2 }), slots = new Map();
  const editor = { doc: document, active: true, documentLoaded: true, propertyDrafts: new Map(), root: { querySelectorAll: () => [] },
    toast: (text, error) => events.push(['toast',text,error]), prepareRun() { events.push(['prepare']); return copy(this.doc); },
    persist() { events.push(['persist']); return true; }, downloadBlob: (blob,name) => events.push(['download',blob,name]),
  };
  const libraryClient = { generation: 0, queue: doc => events.push(['queue',copy(doc)]), flush: async id => { events.push(['flush',id]); slots.set(id,{revision:3}); },
    slot: id => slots.get(id)||{revision:0}, rememberCurrent: () => events.push(['remember']),
    adopt: record => { events.push(['adopt',record.id]); slots.set(record.id,{revision:record.revision}); },
    open: async id => { events.push(['open',id]); editor.doc={...editor.doc,id}; return true; },
  };
  const api = async(path,options) => { events.push(['api',path,options]); return {workflowId:document.id,directory:'/fixture/workflow',opened:true}; };
  const binaryRequest = async(path,options) => { events.push(['binary',path,options]); return new Response(zip(),{headers:{'Content-Type':'application/zip','Content-Disposition':"attachment; filename*=UTF-8''%E6%B5%81%E7%A8%8B.workflow"}}); };
  return {editor,libraryClient,events,ui:new WorkflowPackageUI(editor,{api,binaryRequest,libraryClient,onOpened:id=>events.push(['navigate',id])})};
}
const packageFile = () => Object.assign(zip(),{name:'流程.workflow',lastModified:1});
function fittedPersistence(editor) {
  Object.assign(editor, { settings: { libraryClosed: true, propertiesClosed: true }, canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }) },
    measurePorts() {}, nodeSize: () => ({ width: 224, height: 125 }), panelSettings() { return this.settings; },
    fitGeometry: WorkflowEditor.prototype.fitGeometry, persistenceDocument: WorkflowEditor.prototype.persistenceDocument });
}

test('export flushes current property state and the library before downloading real ZIP bytes as .workflow', async () => {
  const f=fixture(); assert.equal(await f.ui.exportCurrent(),true);
  assert.deepEqual(f.events.slice(0,4).map(row=>row[0]),['prepare','persist','queue','flush']);
  const request=f.events.find(row=>row[0]==='binary'); assert.match(request[1],/\/export\?expectedRevision=3$/);
  const download=f.events.find(row=>row[0]==='download'); assert.equal(download[2],'流程.workflow'); assert.equal(download[1].type,'application/zip');
});

test('failed or stale exports preserve drafts and never fall back to JSON', async () => {
  const f=fixture(); f.libraryClient.flush=async()=>{throw Error('保存失败');};
  assert.equal(await f.ui.exportCurrent(),false); assert(!f.events.some(row=>['binary','download'].includes(row[0])));
  const g=fixture(); g.ui.binaryRequest=async()=>{g.editor.doc={...g.editor.doc,title:'新的草稿'};return new Response(zip());};
  assert.equal(await g.ui.exportCurrent(),false); assert(!g.events.some(row=>row[0]==='download'));
  const h=fixture(); h.ui.binaryRequest=async()=>new Response('{"document":{}}',{headers:{'Content-Type':'application/json'}});
  assert.equal(await h.ui.exportCurrent(),false); assert(!h.events.some(row=>row[0]==='download'));
});

test('export saves a fitted copy and remains valid across pan and zoom while saving and downloading', async () => {
  const f = fixture(); f.editor.doc.nodes = [createNode('tool', { x: 120, y: 80 }, { id: 'export-node' })]; fittedPersistence(f.editor);
  f.editor.doc.viewport = { x: 900, y: -230, zoom: .2 }; const projected = f.editor.persistenceDocument(), flush = f.libraryClient.flush;
  f.libraryClient.flush = async id => { f.editor.doc.viewport = { x: -800, y: 600, zoom: 1.5 }; await flush(id); };
  f.ui.binaryRequest = async path => { f.events.push(['binary', path]); f.editor.doc.viewport = { x: 430, y: -780, zoom: .6 }; return new Response(zip()); };
  assert.equal(await f.ui.exportCurrent(), true); assert.deepEqual(f.events.find(row => row[0] === 'queue')[1], projected);
  assert.deepEqual(f.editor.doc.viewport, { x: 430, y: -780, zoom: .6 }); assert.deepEqual(f.editor.doc.nodes, projected.nodes); assert(f.events.some(row => row[0] === 'download'));
});

test('a node position change while downloading still invalidates export and preserves the new canvas edit', async () => {
  const f = fixture(); f.editor.doc.nodes = [createNode('tool', { x: 120, y: 80 }, { id: 'moving-node' })]; fittedPersistence(f.editor);
  f.ui.binaryRequest = async () => { f.editor.doc.nodes[0].x = 520; return new Response(zip()); };
  assert.equal(await f.ui.exportCurrent(), false); assert.equal(f.editor.doc.nodes[0].x, 520); assert(!f.events.some(row => row[0] === 'download'));
});

test('opening the current folder posts only its identity and refuses unloaded or nested workflows', async () => {
  const f=fixture(); assert.equal(await f.ui.openFolder(),true); const call=f.events.find(row=>row[0]==='api');
  assert.equal(call[1],`/api/workflow-library/${f.editor.doc.id}/folder/open`); assert.deepEqual(call[2],{method:'POST',body:{}});
  f.editor.documentLoaded=false; assert.equal(await f.ui.openFolder(),false);
  f.editor.documentLoaded=true; f.editor.nodeLibrary={nested:true}; assert.equal(await f.ui.openFolder(),false);
  assert.equal(f.events.filter(row=>row[0]==='api').length,1);
});

test('opening the folder warns when input gathering fails without claiming that the folder did not open', async () => {
  const f=fixture();
  f.ui.api=async()=>({workflowId:f.editor.doc.id,opened:true,inputSync:{status:'error'}});
  assert.equal(await f.ui.openFolder(),true);
  const toast=f.events.findLast(row=>row[0]==='toast');
  assert.match(toast[1],/已打开工作流文件夹/); assert.match(toast[1],/输入素材未完全归集/); assert.equal(toast[2],true);
});

test('binary import creates and opens a new workflow while preserving the previous draft and sharing a stable retry identity', async () => {
  const f=fixture(), file=packageFile(), old=f.editor.doc.id, uploaded=[]; let first=true;
  f.ui.binaryRequest=async(path,options)=>{uploaded.push({path,options});if(first){first=false;throw Error('网络中断');}return new Response(JSON.stringify({workflow:{id:'imported-copy',revision:1,document:{...f.editor.doc,id:'imported-copy'}},warnings:[]}));};
  assert.equal(await f.ui.importFile(file),false); assert.equal(f.editor.doc.id,old);
  assert.equal(await f.ui.importFile(file),true); assert.equal(uploaded.length,2);
  assert.equal(uploaded[0].options.body,file); assert.equal(uploaded[0].options.headers['X-Workflow-Import-Id'],uploaded[1].options.headers['X-Workflow-Import-Id']);
  assert(f.events.find(row=>row[0]==='remember')); assert(f.events.find(row=>row[0]==='open'&&row[1]==='imported-copy'));
  assert(!f.events.some(row=>row[0]==='api'&&/workflow-runs|review/.test(row[1])));
});

test('imports reject another suffix, readonly or nested context, and do not switch the canvas after navigation', async () => {
  const f=fixture(); assert.equal(await f.ui.importFile(Object.assign(zip(),{name:'file.zip'})),false);
  f.editor.libraryReadOnly=true; assert.equal(await f.ui.importFile(packageFile()),false); f.editor.libraryReadOnly=false;
  f.editor.nodeLibrary={nested:true}; assert.equal(await f.ui.importFile(packageFile()),false); assert(!f.events.some(row=>row[0]==='binary'));
  const g=fixture(), gate=deferred(); g.ui.binaryRequest=async()=>gate.promise; const importing=g.ui.importFile(packageFile());
  await new Promise(resolve=>setImmediate(resolve)); g.libraryClient.generation++; gate.resolve(new Response(JSON.stringify({workflow:{id:'safe-copy',revision:1,document:{...g.editor.doc,id:'safe-copy'}}})));
  assert.equal(await importing,false); assert(!g.events.some(row=>row[0]==='open'));
});

test('readonly export downloads the acknowledged library version without applying or persisting local property drafts', async () => {
  const f=fixture(), before=copy(f.editor.doc); f.editor.libraryReadOnly=true; f.editor.propertyDrafts.set('pending',{title:'未应用属性'});
  f.ui.api=async()=>({workflow:{id:before.id,document:before,revision:7}});
  assert.equal(await f.ui.exportCurrent(),true); assert.deepEqual(f.editor.doc,before); assert.equal(f.editor.propertyDrafts.size,1);
  assert(!f.events.some(row=>['prepare','persist','queue','flush'].includes(row[0])));
  assert.match(f.events.find(row=>row[0]==='binary')[1],/expectedRevision=7$/);
});

test('an acknowledged import retries only opening its copy after a load failure, and pending clicks cannot import duplicates', async () => {
  const f=fixture(), file=packageFile(), gate=deferred(); let uploads=0, opens=0;
  f.ui.binaryRequest=async()=>{uploads++;await gate.promise;return new Response(JSON.stringify({workflow:{id:'imported-copy',revision:1,document:{...f.editor.doc,id:'imported-copy'}}}));};
  f.libraryClient.open=async id=>{opens++;if(opens===1)return false;f.editor.doc={...f.editor.doc,id};return true;};
  const first=f.ui.importFile(file); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await f.ui.importFile(file),false); assert.equal(uploads,1); gate.resolve(); assert.equal(await first,false);
  assert.equal(await f.ui.importFile(file),true); assert.equal(uploads,1); assert.equal(opens,2);
});

test('an empty editor can import a new copy without persisting an invented workflow or reviving a previous selection', async () => {
  const f=fixture(), file=packageFile(); Object.assign(f.editor,{documentLoaded:false,active:false,libraryReadOnly:true});
  f.ui.binaryRequest=async()=>new Response(JSON.stringify({workflow:{id:'imported-from-empty',revision:1,document:{...f.editor.doc,id:'imported-from-empty'}}}));
  f.libraryClient.open=async id=>{Object.assign(f.editor,{doc:{...f.editor.doc,id},documentLoaded:true,active:true,libraryReadOnly:false});return true;};
  assert.equal(await f.ui.importFile(file),true); assert(!f.events.some(row=>['remember','persist','queue','flush'].includes(row[0])));
  assert.equal(f.editor.doc.id,'imported-from-empty');
});
