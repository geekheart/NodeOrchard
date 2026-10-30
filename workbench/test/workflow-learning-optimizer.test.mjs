import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createNode, connectNodes, updateNode } from '../shared/workflow/workflow-model.mjs';
import { optimizeWorkflowCandidate } from '../src/workflows/workflow-learning-optimizer.mjs';

function graph(scope = 'tools') {
  let document = createDocument({ schemaVersion: 2, title: '工具学习 fixture' });
  document.nodes = [createNode('input', {}, { id: 'input', config: { outputType: 'text', defaultValue: 'HELLO' } }),
    createNode('tool', {}, { id: 'worker', config: { executionMode: 'code', language: 'javascript', code: 'return input;', inputType: 'text', outputType: 'text' } }),
    createNode('output', {}, { id: 'output' }),
    createNode('evaluation', {}, { id: 'evaluation', config: { comparison: 'exact' } }),
    createNode('improvement', {}, { id: 'improvement', config: { scope, targetNodeIds: scope === 'tools' ? ['worker'] : [] } })];
  for (const [sourceNode,sourcePort,targetNode,targetPort] of [['input','out','worker','in'],['worker','out','output','in'],['output','learning','evaluation','in'],['evaluation','out','improvement','in']]) document=connectNodes(document,{sourceNode,sourcePort,targetNode,targetPort});
  return document;
}
const training = () => ({ id: 'train-one', name: '训练一', role: 'train', input: 'HELLO', expected: 'hello', output: 'HELLO', status: 'complete', score: 0, feedback: '需要小写', nodeInputs: { worker: 'HELLO' } });
const validation = () => ({ id: 'validation-secret', name: 'PRIVATE_VALIDATION_NAME', role: 'validation', input: 'PRIVATE_VALIDATION_INPUT', expected: 'PRIVATE_VALIDATION_EXPECTED', output: 'PRIVATE_VALIDATION_OUTPUT', feedback: 'PRIVATE_VALIDATION_FEEDBACK', status: 'complete', score: 0 });
function options(document=graph()) {
  const bestRound={ index:0, document, cases:[training(),validation()], changes:[], metrics:{train:{minScore:0}} };
  return { baseDocument:document,bestRound,latestRound:bestRound,scope:document.nodes.find(n=>n.id==='improvement').config.scope,trainableNodeIds:['worker'],rubric:'只返回原始输入的小写，不硬编码答案',targetScore:100,
    comparisonSource:{nodeId:'output',port:'learning',valuePath:''} };
}

test('a tool candidate changes selected business code using every training attempt without exposing validation evidence', async()=>{
  const request=options(), before=structuredClone(request), prompts=[], contexts=[];
  const result=await optimizeWorkflowCandidate({...request,generate:async prompt=>{prompts.push(prompt);return {operations:[{op:'update-node',nodeId:'worker',config:{code:'return input.toLowerCase();'}}],summary:'规范输入为小写'};},onContext:context=>contexts.push(context)});
  assert.equal(result.document.nodes.find(n=>n.id==='worker').config.code,'return input.toLowerCase();');
  assert.equal(result.changes[0].kind,'tool');assert.equal(result.changes[0].nodeId,'worker');
  assert.equal(result.changes[0].before.node.config.code,'return input;');assert.equal(result.changes[0].after.node.config.code,'return input.toLowerCase();');
  assert.match(prompts[0],/HELLO/);assert.match(prompts[0],/nodeInputs/);assert.match(prompts[0],/async-function-body/);
  assert(!prompts[0].includes('PRIVATE_VALIDATION'));assert(!prompts[0].includes('validation-secret'));
  assert.deepEqual(contexts[0],{mode:'full',phase:'optimizing'});assert.deepEqual(request,before);
});

test('whole-workflow learning can insert a business processing step while preserving fixed boundaries and provenance', async()=>{
  const request=options(graph('workflow')), before=structuredClone(request.baseDocument);
  const edge=request.baseDocument.edges.find(item=>item.sourceNode==='worker'&&item.targetNode==='output');
  const operations=[{op:'remove-edge',edgeId:edge.id},{op:'add-node',ref:'normalize',type:'transform',title:'去除空白',config:{language:'javascript',code:'return input.trim();',inputType:'text',outputType:'text'}},
    {op:'connect',sourceNode:'worker',sourcePort:'out',targetNode:'normalize',targetPort:'in'},{op:'connect',sourceNode:'normalize',sourcePort:'out',targetNode:'output',targetPort:'in'}];
  const result=await optimizeWorkflowCandidate({...request,generate:async()=>({operations,summary:'增加通用文本清理步骤'})});
  assert.equal(result.document.nodes.length,before.nodes.length+1);assert.equal(result.changes[0].kind,'workflow');
  assert.deepEqual(result.changes[0].before.document,before);assert.deepEqual(result.changes[0].after.document,result.document);
  for(const id of ['input','output','evaluation','improvement']) assert.deepEqual(result.document.nodes.find(node=>node.id===id),before.nodes.find(node=>node.id===id));
  assert.deepEqual(request.baseDocument,before);
});

test('selected-tool learning rejects foreign nodes, topology, interface changes and forged response envelopes', async()=>{
  const invalid=[
    {operations:[{op:'update-node',nodeId:'input',config:{defaultValue:'forged'}}],summary:'修改输入'},
    {operations:[{op:'update-node',nodeId:'worker',config:{timeoutSeconds:900}}],summary:'修改时限'},
    {operations:[{op:'update-node',nodeId:'worker',config:{inputType:'any'}}],summary:'改变接口'},
    {operations:[{op:'add-node',ref:'extra',type:'tool'}],summary:'增加节点'},
    {operations:[],summary:'伪造整图',document:graph()},
    {operations:[],summary:'\0无效'},
  ];
  for(const proposal of invalid){const request=options(),before=structuredClone(request.baseDocument);await assert.rejects(optimizeWorkflowCandidate({...request,generate:async()=>proposal}));assert.deepEqual(request.baseDocument,before);}
  let reads=0;await assert.rejects(optimizeWorkflowCandidate({...options(),generate:async()=>({get operations(){reads++;return [];},summary:'不应读取访问器'})}));assert.equal(reads,0);
});

test('cosmetic-only whole-flow edits and a repeated recent candidate do not become another execution round', async()=>{
  const request=options(graph('workflow'));
  assert.equal(await optimizeWorkflowCandidate({...request,generate:async()=>({operations:[{op:'update-node',nodeId:'worker',title:'只改名字',x:500}],summary:'仅更改外观'})}),null);
  assert.equal(await optimizeWorkflowCandidate({...request,generate:async()=>({operations:[],summary:'无必要修改'})}),null);
  const repeated=updateNode(request.baseDocument,'worker',{config:{code:'return input.toLowerCase();'}});
  const latestRound={...request.latestRound,document:repeated};
  assert.equal(await optimizeWorkflowCandidate({...request,latestRound,generate:async()=>({operations:[{op:'update-node',nodeId:'worker',config:{code:'return input.toLowerCase();'}}],summary:'重复上次代码'})}),null);
});

test('every training case supplies its own latest confirmed error and legacy Skill inputs remain usable', async()=>{
  const request=options();request.bestRound.cases=[training(),{...training(),id:'train-two',name:'训练二',input:'WORLD',expected:'world',output:'WORLD',nodeInputs:undefined,skillInputs:{worker:'WORLD'}},validation()];
  request.latestRound={...request.bestRound,index:1,cases:request.bestRound.cases.map(item=>item.role==='train'?{...item,status:'error',score:0,output:undefined,error:'CODE_FAILED_'+item.id,recoverable:true}:item)};
  let source;
  await optimizeWorkflowCandidate({...request,generate:async prompt=>{source=JSON.parse(prompt.split('OPTIMIZER_SOURCE_JSON=')[1]);return {operations:[],summary:'无修改'};}});
  assert.deepEqual(source.trainingCases.map(item=>item.id),['train-one','train-two']);assert.equal(source.trainingCases[1].best.nodeInputs.worker,'WORLD');
  assert.equal(source.trainingCases[0].latest.error,'CODE_FAILED_train-one');assert.equal(source.trainingCases[0].latest.recoverable,true);
  assert(!JSON.stringify(source).includes('PRIVATE_VALIDATION'));
});

test('optimizer contracts expose real generic tools without repeating node runtimes', async()=>{
  let source;
  await optimizeWorkflowCandidate({...options(),generate:async prompt=>{source=JSON.parse(prompt.split('OPTIMIZER_SOURCE_JSON=')[1]);return {operations:[],summary:'检查通用契约，无修改'};}});
  assert.deepEqual(source.tools.map(tool=>tool.id),['text.trim','text.uppercase','json.parse','json.stringify','json.keys']);
  assert.equal(source.catalogSelection.tools.omitted,0);assert(source.nodes.every(node=>!Object.hasOwn(node,'runtime')));
  assert.equal(source.runtime.javascript.sourceFormat,'async-function-body');
  assert(source.tools.every(tool=>tool.reviewRequired===false));
});

test('oversized training context is diagnosed without truncating samples or leaking validation evidence', async()=>{
  const request=options(),diagnoses=[],contexts=[],prompts=[];
  const samples=[0,1].map(index=>({...training(),id:'train-'+index,input:'I'.repeat(50000)+index,expected:'E'.repeat(50000)+index,output:'O'.repeat(50000)+index,nodeInputs:{worker:'N'.repeat(50000)+index}}));
  request.bestRound.cases=[...samples,validation()];request.latestRound={...request.bestRound,index:1,cases:samples.map(item=>({...item,output:'L'.repeat(50000)})).concat(validation())};
  const result=await optimizeWorkflowCandidate({...request,diagnose:async evidence=>{diagnoses.push(structuredClone(evidence));return {diagnosis:'提炼适用于任意输入的规则'};},onContext:value=>contexts.push(value),generate:async prompt=>{prompts.push(prompt);return {operations:[{op:'update-node',nodeId:'worker',config:{code:'return input.toLowerCase();'}}],summary:'按完整训练诊断修正代码'};}});
  assert(result);assert.equal(diagnoses.length,6);assert.equal(diagnoses[0].expected.length,50001);assert.equal(diagnoses[2].input.length,50001);
  assert.deepEqual(diagnoses.filter(item=>Object.hasOwn(item,'input')).map(item=>item.id),['train-0','train-1']);
  assert(prompts[0].length<=190000);assert(!JSON.stringify([diagnoses,prompts,contexts]).includes('PRIVATE_VALIDATION'));
  const source=JSON.parse(prompts[0].split('OPTIMIZER_SOURCE_JSON=')[1]);assert.deepEqual(source.trainingCases.map(item=>item.id),['train-0','train-1']);
  assert.deepEqual(contexts.at(-1).phase,'optimizing');assert.equal(contexts.at(-1).diagnostics.length,2);assert.equal(contexts.at(-1).diagnostics[1].summary.diagnosis,'提炼适用于任意输入的规则');
});

test('missing or invalid diagnostics stop an oversized candidate instead of silently discarding evidence', async()=>{
  const request=options();request.bestRound.cases=[{...training(),input:'I'.repeat(60000),expected:'E'.repeat(60000),output:'O'.repeat(60000),nodeInputs:{worker:'N'.repeat(60000)}}];request.latestRound=request.bestRound;
  let generated=0;
  await assert.rejects(optimizeWorkflowCandidate({...request,generate:async()=>{generated++;return {operations:[],summary:'不应生成'};}}),/诊断/);
  await assert.rejects(optimizeWorkflowCandidate({...request,diagnose:async()=>({diagnosis:'x'.repeat(2048)}),generate:async()=>{generated++;return {operations:[],summary:'不应生成'};}}),/2048/);
  assert.equal(generated,0);
});
