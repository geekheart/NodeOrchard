import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AssistantModelDiagnostics } from '../src/assistant-model-diagnostics.mjs';

const start = '2026-10-27T07:07:56.000Z';
const output = '2026-10-27T07:10:55.350Z';
const end = '2026-10-27T07:10:56.000Z';
const turn = () => ({ id: 'turn-failed', workflowId: 'workflow-one', status: 'error', createdAt: start, updatedAt: end,
  user: { text: 'PRIVATE_TASK' }, modelSessionId: 'session-three', modelSessionIds: ['session-three'],
  assistant: { text: '应用助手调用累计等待 180 秒超时，停止在「接收模型输出」阶段。', progress: { modelCalls: 1, toolCalls: 7 },
    checkpoint: { steps: [
      { stage: 'create-session', startedAt: start, completedAt: start, modelCall: 1, status: 'complete' },
      { stage: 'model-response', startedAt: start, completedAt: output, elapsedMs: 179350, modelCall: 1, status: 'complete' },
      { stage: 'model-output', startedAt: output, completedAt: end, elapsedMs: 650, modelCall: 1, status: 'error', error: 'PRIVATE_ERROR' },
    ] } } });

function fixture(t, { metadata } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, stored_session_id TEXT, model TEXT, provider TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,session_id TEXT,status TEXT,started_at TEXT,completed_at TEXT);
    CREATE TABLE application_model_sessions(id TEXT PRIMARY KEY);
    CREATE TABLE application_logs(id INTEGER PRIMARY KEY,at TEXT,level TEXT,component TEXT,event TEXT,context TEXT);
    CREATE TABLE session_usage(session_id TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE run_usage(run_id TEXT PRIMARY KEY,session_id TEXT,value TEXT);
    CREATE TABLE application_model_calls(session_id TEXT PRIMARY KEY,value TEXT);`);
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('session-three','stored-three','fixture-model','fixture');
  db.prepare('INSERT INTO application_model_sessions VALUES(?)').run('session-three');
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('run-three','session-three','interrupted',start,end);
  const reads = [];
  const diagnostics = new AssistantModelDiagnostics(db, { readSessionMetadata: metadata && (async sessionId => { reads.push(sessionId); return metadata; }) });
  return { db, reads, diagnostics };
}

test('late first output is diagnosed from the real turn checkpoint instead of the last 650ms phase', async t => {
  const { diagnostics, db } = fixture(t);
  const before = db.prepare('SELECT * FROM runs').all();
  const result = await diagnostics.inspect({ workflowId: 'workflow-one', turn: turn() });
  assert.equal(result.calls[0].waitMs, 179350);
  assert.equal(result.calls[0].outputMs, 650);
  assert.equal(result.calls[0].durationMs, 180000);
  assert.equal(result.calls[0].complete, false);
  assert.equal(result.calls[0].timeoutKind, 'legacy-timeout');
  assert.equal(result.calls[0].timeoutPolicy, null);
  assert(result.findings.some(row => row.code === 'LATE_FIRST_OUTPUT'));
  assert.deepEqual(db.prepare('SELECT * FROM runs').all(), before);
});

test('persistent model records carry authoritative timeouts, character counts and usage without private content', async t => {
  const { diagnostics, db } = fixture(t);
  db.prepare('INSERT INTO application_model_calls VALUES(?,?)').run('session-three', JSON.stringify({ version: 1, status: 'complete',
    startedAt: start, submittedAt: start, firstOutputAt: output, lastOutputAt: end, completedAt: end,
    promptCharacters: 48262, outputCharacters: 136, timeoutKind: null, errorCode: null,
    requestedReasoningEffort: 'medium', reasoningEffort: 'medium', reasoningEffortWire: 'medium',
    timeoutPolicy: { firstResponseTimeoutMs: 180000, outputIdleTimeoutMs: 30000, maxDurationMs: 240000, deadlineAt: '2026-10-27T07:11:56.000Z' },
    prompt: 'PRIVATE_PROMPT', body: 'PRIVATE_BODY', token: 'PRIVATE_CREDENTIAL' }));
  db.prepare('INSERT INTO run_usage VALUES(?,?,?)').run('run-three','session-three', JSON.stringify({ status:'measured',final:true,source:'message.complete',usage:{input:14000,output:500,total:14500,context_used:14000},path:'PRIVATE_PATH' }));
  const result = await diagnostics.inspect({ workflowId:'workflow-one',turn:turn() });
  const call = result.calls[0];
  assert.equal(call.status,'complete'); assert.equal(call.complete,true); assert.equal(call.promptCharacters,48262);
  assert.equal(call.outputCharacters,136); assert.equal(call.usage.inputTokens,14000); assert.equal(call.usage.outputTokens,500);
  assert.equal(call.usage.totalTokens,14500); assert.equal(call.timeoutPolicy.firstResponseTimeoutMs,180000);
  assert.equal(call.requestedReasoningEffort, 'medium'); assert.equal(call.reasoningEffort, 'medium'); assert.equal(call.reasoningEffortWire, 'medium');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
});

test('legacy control sessions can expose only fixed metadata through an owned-session reader', async t => {
  const { diagnostics, reads } = fixture(t, { metadata: { source:'hermes.history', promptCharacters:48262, outputCharacters:136,
    assistantMessageCount:1,userMessageCount:1,partial:true,finishReason:null,
    usage:{input:0,output:0,total:0},messages:[{text:'PRIVATE_TEXT'}],prompt:'PRIVATE_PROMPT',storedSessionId:'PRIVATE_STORED' } });
  const result = await diagnostics.inspect({workflowId:'workflow-one',turn:turn()});
  assert.deepEqual(reads,['session-three']); assert.equal(result.calls[0].promptCharacters,48262);
  assert.equal(result.calls[0].outputCharacters,136); assert.equal(result.calls[0].partial,true);
  assert.equal(result.calls[0].usage.status,'missing'); assert.equal(result.calls[0].usage.inputTokens,null);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
});

test('fixed log aggregation recovers stages evicted from a checkpoint and does not mix another turn', async t => {
  const { diagnostics, db } = fixture(t);
  const value=turn(); value.assistant.checkpoint.steps=[];
  const insert=db.prepare('INSERT INTO application_logs VALUES(?,?,?,?,?,?)');
  for(const [index,at,stage,status] of [[1,start,'model-response','thinking'],[2,output,'model-output','thinking'],[3,end,'model-output','error']]) {
    insert.run(index,at,'info','assistant','assistant.turn.state',JSON.stringify({workflowId:'workflow-one',turnId:'turn-failed',sessionId:'session-three',modelCalls:1,toolCalls:7,stage,status,prompt:'PRIVATE_LOG'}));
  }
  insert.run(4,'2026-10-27T07:07:57.000Z','info','assistant','assistant.turn.state',JSON.stringify({turnId:'another-turn',sessionId:'session-three',stage:'model-output',modelCalls:1}));
  const result=await diagnostics.inspect({workflowId:'workflow-one',turn:value});
  assert.equal(result.calls[0].waitMs,179350); assert.equal(result.calls[0].outputMs,650);
  assert.deepEqual(result.logEvidence.ids,[1,2,3]); assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
});

test('unknown fields, cross-object targets and arbitrary sessions are rejected before reading metadata', async t => {
  const {diagnostics,reads,db}=fixture(t,{metadata:{promptCharacters:1}});
  await assert.rejects(diagnostics.inspect({workflowId:'workflow-two',turn:turn()}),{httpStatus:403});
  for(const args of [{workflowId:'workflow-one',turn:turn(),path:'/private'}, {workflowId:'workflow-one',turn:turn(),sessionId:'session-other'},
    {turn:turn()}, {workflowId:'../private',turn:turn()}, {workflowId:'workflow-one',turn:{...turn(),id:'invalid/id'}}]) {
    await assert.rejects(diagnostics.inspect(args),{httpStatus:400});
  }
  db.exec('DELETE FROM application_model_sessions');
  await assert.rejects(diagnostics.inspect({workflowId:'workflow-one',turn:turn()}),{httpStatus:403});
  assert.deepEqual(reads,[]);
});

test('missing data and failed optional metadata reads remain unknown without exposing exceptions', async t => {
  const {diagnostics,db}=fixture(t); diagnostics.readSessionMetadata=async()=>{throw Error('PRIVATE_SECRET')};
  db.exec('DROP TABLE application_logs;DROP TABLE run_usage;DROP TABLE session_usage;DROP TABLE application_model_calls');
  const value=turn();value.assistant.checkpoint.steps=[];value.assistant.text='';
  const result=await diagnostics.inspect({workflowId:'workflow-one',turn:value});
  assert.equal(result.calls[0].waitMs,null); assert.equal(result.calls[0].promptCharacters,null);
  assert.equal(result.calls[0].usage.status,'missing');assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
  assert(result.missingEvidence.includes('model-call-records')); assert(result.missingEvidence.includes('session-metadata'));
});

test('diagnostic output is bounded and never claims truncated calls were inspected', async t => {
  const {diagnostics,db}=fixture(t);const value=turn();value.modelSessionIds=[];
  for(let i=0;i<14;i++) {
    const id='session-'+i; value.modelSessionIds.push(id);
    db.prepare('INSERT INTO application_model_sessions VALUES(?)').run(id);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(id,'stored-'+i,'fixture','fixture');
  }
  value.modelSessionId=value.modelSessionIds.at(-1); value.assistant.progress.modelCalls=14;
  const result=await diagnostics.inspect({workflowId:'workflow-one',turn:value});
  assert.equal(result.calls.length,12);assert.equal(result.truncated,true);assert.equal(result.totalModelCalls,14);
  assert(Buffer.byteLength(JSON.stringify(result))<=16384);
});

test('new timeout records distinguish first response, idle output and absolute deadlines', async t => {
  const {diagnostics,db}=fixture(t);
  for(const kind of ['first-response','output-idle','absolute']) {
    db.prepare('INSERT OR REPLACE INTO application_model_calls VALUES(?,?)').run('session-three',JSON.stringify({version:1,status:'timeout',
      startedAt:start,submittedAt:start,firstOutputAt:kind==='first-response'?null:output,completedAt:end,
      promptCharacters:48262,outputCharacters:kind==='first-response'?0:136,errorCode:'MODEL_TIMEOUT',timeoutKind:kind,
      timeoutPolicy:{firstResponseTimeoutMs:180000,outputIdleTimeoutMs:30000,maxDurationMs:240000,deadlineAt:'2026-10-27T07:11:56.000Z'}}));
    const value=turn();value.assistant.checkpoint.steps=[];
    const result=await diagnostics.inspect({workflowId:'workflow-one',turn:value});
    assert.equal(result.calls[0].status,'timeout');assert.equal(result.calls[0].timeoutKind,kind);
    assert.equal(result.calls[0].errorCode,'MODEL_TIMEOUT');assert.equal(result.calls[0].complete,false);
  }
});

test('session snapshots supplement missing run usage without treating zero tickers as consumed tokens',async t=>{
  const {diagnostics,db}=fixture(t);
  db.prepare('INSERT INTO session_usage VALUES(?,?)').run('session-three',JSON.stringify({source:'session.usage',usage:{input:0,output:0,total:0}}));
  let result=await diagnostics.inspect({workflowId:'workflow-one',turn:turn()});
  assert.equal(result.calls[0].usage.status,'missing');assert.equal(result.calls[0].usage.inputTokens,null);
  db.prepare('UPDATE session_usage SET value=? WHERE session_id=?').run(JSON.stringify({source:'session.usage',usage:{input:12000,output:300,total:12300}}),'session-three');
  result=await diagnostics.inspect({workflowId:'workflow-one',turn:turn()});
  assert.equal(result.calls[0].usage.status,'partial');assert.equal(result.calls[0].usage.inputTokens,12000);
  assert.equal(result.calls[0].usage.source,'session.snapshot');assert.equal(result.calls[0].usage.final,false);
});

test('an interrupted terminal frame carrying only zero counters cannot prove zero model cost',async t=>{
  const {diagnostics,db}=fixture(t);
  db.prepare('INSERT INTO run_usage VALUES(?,?,?)').run('run-three','session-three',JSON.stringify({status:'measured',final:true,source:'message.complete',usage:{input:0,output:0,total:0,calls:0}}));
  const result=await diagnostics.inspect({workflowId:'workflow-one',turn:turn()});
  assert.equal(result.calls[0].usage.status,'missing');assert.equal(result.calls[0].usage.final,false);
  assert.equal(result.calls[0].usage.totalTokens,null);assert(result.missingEvidence.includes('token-usage'));
});

test('a running snapshot left by an interrupted owner is not reported as a live model after restart', async t => {
  const {diagnostics,db}=fixture(t);
  const snapshot={version:1,status:'running',startedAt:start,submittedAt:start,firstOutputAt:output,lastOutputAt:output,completedAt:null,
    promptCharacters:48262,outputCharacters:136,timeoutKind:null,errorCode:null};
  db.prepare('INSERT INTO application_model_calls VALUES(?,?)').run('session-three',JSON.stringify(snapshot));
  db.prepare('UPDATE runs SET status=?,completed_at=? WHERE id=?').run('unknown',end,'run-three');
  const value=turn();value.status='interrupted';value.assistant.text='';value.assistant.checkpoint.steps=[];
  const result=await diagnostics.inspect({workflowId:'workflow-one',turn:value});
  const call=result.calls[0];
  assert.equal(call.status,'interrupted');assert.equal(call.ownerStatus,'interrupted');
  assert.equal(call.persistedSnapshotStatus,'running');assert.equal(call.runningSnapshot,true);
  assert.equal(call.statusSource,'owner-turn');assert.equal(call.completedAt,null);
  assert.equal(call.durationMs,null);assert.equal(call.modelTerminalConfirmed,false);
  assert.equal(call.ownerUpdatedAt,end);assert.equal(call.complete,false);
  assert(result.findings.some(row=>row.code==='STALE_RUNNING_SNAPSHOT'));
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM application_model_calls WHERE session_id=?').get('session-three').value),snapshot);
});

test('an ended successful owner does not fabricate completion of its stale running model snapshot', async t => {
  const {diagnostics,db}=fixture(t);
  db.prepare('INSERT INTO application_model_calls VALUES(?,?)').run('session-three',JSON.stringify({version:1,status:'running',startedAt:start,
    submittedAt:start,firstOutputAt:null,completedAt:null,promptCharacters:10,outputCharacters:0}));
  const value=turn();value.status='complete';value.assistant.checkpoint.steps=[];
  const call=(await diagnostics.inspect({workflowId:'workflow-one',turn:value})).calls[0];
  assert.equal(call.status,'unknown');assert.equal(call.ownerStatus,'complete');assert.equal(call.statusSource,'owner-turn');
  assert.equal(call.complete,false);assert.equal(call.completedAt,null);assert.equal(call.modelTerminalConfirmed,false);
  value.status='thinking';
  const active=(await diagnostics.inspect({workflowId:'workflow-one',turn:value})).calls[0];
  assert.equal(active.status,'running');assert.equal(active.statusSource,'model-call-record');assert.equal(active.runningSnapshot,true);
});
