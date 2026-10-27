import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { collectWorkbenchStatistics } from '../src/workbench-statistics.mjs';

const now = new Date('2026-10-27T04:00:00.000Z'), at = '2026-10-27T01:00:00.000Z';
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE workflow_documents(id TEXT PRIMARY KEY,revision INTEGER,document TEXT);
    CREATE TABLE workflow_lifecycle(workflow_id TEXT,lifecycle TEXT); CREATE TABLE workflow_library_meta(key TEXT,value TEXT);
    CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE workflow_learning(id TEXT,value TEXT);
    CREATE TABLE workflow_artifacts(id TEXT,value TEXT); CREATE TABLE sessions(id TEXT,model TEXT,provider TEXT,stored_session_id TEXT);
    CREATE TABLE runs(id TEXT,session_id TEXT,started_at TEXT,status TEXT DEFAULT 'complete',completed_at TEXT DEFAULT '2026-10-27T01:01:00.000Z'); CREATE TABLE workflow_conversation_turns(id TEXT,workflow_id TEXT,value TEXT,private_value TEXT);
    CREATE TABLE application_conversation_turns(id TEXT,value TEXT); CREATE TABLE application_conversations(id TEXT);
    CREATE TABLE session_usage(session_id TEXT PRIMARY KEY,value TEXT); CREATE TABLE run_usage(run_id TEXT PRIMARY KEY,session_id TEXT,value TEXT);`);
  const app = { store: { db }, adapter: { request: () => assert.fail('statistics must never call Hermes') },
    workflows: { list: () => assert.fail('statistics must not use the 20-row controller list') } };
  const put = (table, value) => db.prepare(`INSERT INTO ${table}(id,value) VALUES(?,?)`).run(value.id, JSON.stringify(value));
  const document = (id, title = id) => db.prepare('INSERT INTO workflow_documents VALUES(?,?,?)').run(id, 1, JSON.stringify({ id, title, mode: 'execute', nodes: [{config: {code: 'PRIVATE_CODE'}}] }));
  const run = (id, workflowId = 'workflow-a', extra = {}) => put('workflow_runs', {id,workflowId,status:'complete',startedAt:at,completedAt:'2026-10-27T01:01:00.000Z',nodes:{},document:{title:workflowId},...extra});
  const model = (id, sessionId, usage, status = 'measured', startedAt = at) => {
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(sessionId, 'fixture-model', 'fixture-provider', 'stored-' + sessionId);
    db.prepare('INSERT INTO runs(id,session_id,started_at) VALUES(?,?,?)').run(id, sessionId, startedAt);
    if (usage) db.prepare('INSERT INTO run_usage VALUES(?,?,?)').run(id, sessionId, JSON.stringify({runId:id,sessionId,startedAt,status,usage}));
  };
  const turn = (id, workflowId, extra = {}) => {
    const value = {id,status:'complete',createdAt:at,updatedAt:at,user:{text:'PRIVATE_PROMPT'},assistant:{text:'PRIVATE_REPLY'},...extra};
    if (workflowId) db.prepare('INSERT INTO workflow_conversation_turns VALUES(?,?,?,?)').run(id,workflowId,JSON.stringify(value),'PRIVATE_TRAINING');
    else put('application_conversation_turns', value);
  };
  const read = options => collectWorkbenchStatistics(app, {now,...options});
  const snapshot = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
  return {db,app,put,document,run,model,turn,read,snapshot};
}

test('empty metrics distinguish no usage data and no success denominator and respect the client natural day', t => {
  const f = fixture(t), before = f.snapshot(), result = f.read();
  assert.equal(result.schemaVersion,1); assert.equal(result.period.timeZone,'Asia/Shanghai');
  assert.equal(result.period.start,'2026-10-20T16:00:00.000Z'); assert.equal(result.period.end,'2026-10-27T16:00:00.000Z');
  assert.equal(result.daily.length,7); assert.equal(result.daily[0].date,'2026-10-21');
  assert.equal(result.totals.execution.runs,0); assert.equal(result.totals.execution.successRate,null);
  assert.equal(result.totals.usage.total,null); assert.equal(result.totals.usage.input,null); assert.equal(result.totals.workflowCount,0);
  assert.deepEqual(result.workflows,[]); assert.deepEqual(f.snapshot(),before);
  assert.throws(()=>f.read({days:14}),{httpStatus:400}); assert.throws(()=>f.read({timeZone:'Not/AZone'}),{httpStatus:400});
});

test('workflow executions read every stored row, avoid child double counts and include tool-only roots', t => {
  const f=fixture(t); f.document('workflow-a');
  for(let index=0;index<25;index++) f.run('run-'+index);
  f.run('failed','workflow-a',{status:'error'}); f.run('stop','workflow-a',{status:'interrupted'});
  f.run('unknown','workflow-a',{status:'unknown'}); f.run('active','workflow-a',{status:'waiting_review',completedAt:null});
  f.run('child','embedded-child',{parentRunId:'run-0',nodes:{child:{attempt:2,history:[{attempt:1,sessionId:'session-old'}],sessionId:'session-new'}}});
  f.run('learning','workflow-a',{learningId:'learning-one'});
  const result=f.read(), row=result.workflows[0];
  assert.equal(result.workflows.length,1); assert.equal(row.execution.runs,30); assert.equal(row.execution.complete,26);
  assert.equal(row.execution.failed,1); assert.equal(row.execution.active,1); assert.equal(row.execution.learningRuns,1);
  assert.equal(row.execution.successRate,26/29); assert.equal(row.execution.nodeAttempts,2);
  assert.equal(row.recentRuns.length,12); assert.equal(row.execution.averageDurationMs,60000);
  assert.equal(result.daily.at(-1).execution.runs,30); assert.equal(row.daily.at(-1).execution.runs,30);
});

test('usage is the model-run delta, keeps authoritative totals, deduplicates ownership and exposes missing coverage', t => {
  const f=fixture(t); f.document('workflow-a');
  f.run('parent','workflow-a',{sessionId:'session-one',nodes:{one:{attempt:1,sessionId:'session-one'},two:{attempt:2,sessionId:'session-two',history:[{attempt:1,sessionId:'session-old'}]}}});
  f.turn('chat','workflow-a',{modelSessionId:'session-one',modelSessionIds:['session-one','session-three'],assistant:{progress:{modelCalls:2,toolCalls:3,elapsedMs:4000}}});
  f.model('call-one','session-one',{input:100,output:20,reasoning:9,total:150,calls:2});
  f.model('call-two','session-two',{input:40,total:40,calls:1},'partial'); f.model('call-old','session-old',null);
  f.model('call-three','session-three',{input:0,output:0,total:0,calls:0});
  f.db.prepare('INSERT INTO session_usage VALUES(?,?)').run('session-one',JSON.stringify({sessionId:'session-one',capturedAt:at,usage:{input:99999,output:9999,total:999999}}));
  const result=f.read(), row=result.workflows[0];
  assert.equal(row.usage.total,190); assert.equal(row.usage.input,140); assert.equal(row.usage.output,20); assert.equal(row.usage.reasoning,9);
  assert.equal(row.usage.measuredRuns,2); assert.equal(row.usage.partialRuns,1); assert.equal(row.usage.unmeasuredRuns,1);
  assert.equal(result.totals.usage.total,190); assert.equal(row.models[0].runs,4); assert.equal(row.models[0].usage.total,190);
  assert.equal(row.conversations.turns,1); assert.equal(row.conversations.modelCalls,2); assert.equal(row.conversations.toolCalls,3);
  assert.equal(result.daily.at(-1).usage.total,190); assert.equal(row.context,null);
});

test('period boundaries and daily token buckets use model run start rather than a newer cumulative snapshot', t => {
  const f=fixture(t); f.document('workflow-a'); f.run('root','workflow-a',{sessionId:'session-a'});
  f.model('outside','session-a',{input:800,total:800},'measured','2026-10-20T15:59:59.999Z');
  f.model('first','session-a',{input:12,total:12},'measured','2026-10-20T16:00:00.000Z');
  f.model('tomorrow','session-a',{input:900,total:900},'measured','2026-10-27T16:00:00.000Z');
  f.db.prepare('INSERT INTO session_usage VALUES(?,?)').run('session-a',JSON.stringify({capturedAt:at,usage:{total:99999,context_used:100,context_max:1000,context_estimated:true}}));
  const weekly=f.read(), monthly=f.read({days:30});
  assert.equal(weekly.totals.usage.total,12); assert.equal(weekly.daily[0].usage.total,12); assert.equal(weekly.daily.at(-1).usage.total,null);
  assert.equal(monthly.totals.usage.total,812); assert.equal(weekly.workflows[0].context.percent,10); assert.equal(weekly.workflows[0].context.estimated,true);
});

test('recycled, legacy archived and deleted workflow histories remain visible without resurrecting any document', t => {
  const f=fixture(t); f.document('active'); f.document('recycled'); f.document('archived');
  f.db.prepare('INSERT INTO workflow_lifecycle VALUES(?,?)').run('recycled','trashed'); f.db.prepare('INSERT INTO workflow_lifecycle VALUES(?,?)').run('archived','archived');
  f.db.prepare('INSERT INTO workflow_library_meta VALUES(?,?)').run('deleted:deleted',JSON.stringify({title:'已删除历史'}));
  for(const id of ['active','recycled','archived','deleted']) f.run('run-'+id,id);
  const before=f.snapshot(), result=f.read(), states=Object.fromEntries(result.workflows.map(row=>[row.id,row.lifecycle]));
  assert.deepEqual(states,{active:'active',archived:'trashed',deleted:'deleted',recycled:'trashed'});
  assert.equal(result.totals.execution.runs,4); assert.equal(result.totals.recycledWorkflows,2); assert.equal(result.totals.deletedWorkflows,1);
  assert.deepEqual(f.snapshot(),before);
});

test('metadata summaries isolate supervisor usage, omit private material and aggregate registered storage honestly', t => {
  const f=fixture(t); f.document('workflow-a'); f.run('root');
  f.turn('chat','workflow-a',{modelSessionId:'workflow-model'}); f.turn('supervisor',null,{modelSessionIds:['supervisor-model'],status:'error',assistant:{progress:{modelCalls:1,toolCalls:2,elapsedMs:3000},text:'PRIVATE_REPLY'}});
  f.db.prepare('INSERT INTO application_conversations VALUES(?)').run('supervisor-one');
  f.model('workflow-call','workflow-model',{total:15}); f.model('supervisor-call','supervisor-model',{total:25});
  f.put('workflow_artifacts',{id:'artifact-one',runId:'root',size:123,path:'/PRIVATE/PATH',sha256:'PRIVATE_HASH'});
  f.put('workflow_artifacts',{id:'artifact-two',runId:'root',size:0}); f.put('workflow_artifacts',{id:'artifact-unknown',runId:'root'});
  const result=f.read(), row=result.workflows[0], serialized=JSON.stringify(result);
  assert.equal(row.artifacts.count,3); assert.equal(row.artifacts.registeredBytes,123); assert.equal(row.artifacts.unknownSizes,1);
  assert(row.storage.recordBytes>0); assert.equal(row.usage.total,15); assert.equal(result.supervisor.usage.total,25); assert.equal(result.totals.usage.total,40);
  assert.equal(result.supervisor.conversations.failed,1); assert.equal(result.supervisor.conversationCount,2); assert.equal(result.totals.conversations.turns,2);
  for(const secret of ['PRIVATE_PROMPT','PRIVATE_REPLY','PRIVATE_TRAINING','PRIVATE_CODE','PRIVATE/PATH','PRIVATE_HASH']) assert.equal(serialized.includes(secret),false,secret);
  assert(result.recentActivity.some(item=>item.kind==='conversation'&&item.workflowId===null));
});

test('context selects the newest single-session sample and never sums concurrent window percentages', t => {
  const f=fixture(t); f.document('workflow-a'); f.turn('chat','workflow-a',{modelSessionIds:['older','newer']});
  for(const [id,capturedAt,usage] of [['older','2026-10-26T01:00:00Z',{context_used:90,context_max:100}],['newer',at,{context_used:20,context_estimated:false,context_source:'provider'}]]) {
    f.db.prepare('INSERT INTO session_usage VALUES(?,?)').run(id,JSON.stringify({capturedAt,usage}));
  }
  const context=f.read().workflows[0].context;
  assert.equal(context.sessionId,'newer'); assert.equal(context.used,20); assert.equal(context.max,null); assert.equal(context.percent,null); assert.equal(context.source,'provider');
});

test('ambiguous session ownership is counted once in ordinary usage rather than attributed to multiple workflows', t => {
  const f=fixture(t); f.document('workflow-a'); f.document('workflow-b');
  f.turn('a','workflow-a',{modelSessionId:'shared'}); f.turn('b','workflow-b',{modelSessionId:'shared'});
  f.model('shared-call','shared',{total:100}); const result=f.read();
  assert.equal(result.totals.usage.total,100); assert.equal(result.ordinary.usage.total,100); assert.equal(result.coverage.ambiguousSessions,1);
  assert(result.workflows.every(row=>row.usage.total===null));
});

test('pending counts reuse the conversation issue projection without clearing historical failed attempts', t => {
  const f=fixture(t); f.document('workflow-a');
  const user={text:'相同任务 PRIVATE_PROMPT',context:{documentRevision:1}};
  f.turn('first','workflow-a',{status:'error',user});
  f.turn('retry','workflow-a',{status:'complete',retryOfTurnId:'first',user});
  f.turn('dismissed','workflow-a',{status:'dismissed',user});
  f.turn('applied','workflow-a',{status:'proposed',outcome:{applied:true},user});
  f.turn('review','workflow-a',{status:'awaiting_action',actions:[{kind:'review-approve',context:{runId:'root',nodeId:'gate',attempt:1,attemptId:'attempt-one'}}]});
  f.turn('unknown-review','workflow-a',{status:'awaiting_action',actions:[{kind:'review-approve',context:{runId:'root',nodeId:'gate',attempt:2,attemptId:'attempt-two'}}]});
  f.app.conversations={reviewState:(_workflowId,context)=>context.attempt===1?'resolved':'unknown'};
  const before=f.snapshot(), result=f.read(), row=result.workflows[0];
  assert.equal(row.conversations.turns,6); assert.equal(row.conversations.failed,1); assert.equal(row.conversations.pending,1);
  assert.equal(result.totals.conversations.pending,1); assert.equal(JSON.stringify(result).includes('PRIVATE_PROMPT'),false);
  assert.deepEqual(f.snapshot(),before);
});

test('workflow identity cannot collide with the supervisor owner and error metadata uses the diagnostic secret filter', t => {
  const f=fixture(t); f.document('supervisor');
  f.run('root','supervisor',{sessionId:'workflow-session',status:'error',error:'token=TOKEN_SENTINEL password=PASSWORD_SENTINEL secret=SECRET_SENTINEL Bearer BEARER_SENTINEL'});
  f.turn('manager',null,{modelSessionId:'manager-session'});
  f.model('workflow-call','workflow-session',{total:30}); f.model('manager-call','manager-session',{total:7});
  const result=f.read(); assert.equal(result.workflows[0].usage.total,30); assert.equal(result.supervisor.usage.total,7);
  for(const secret of ['TOKEN_SENTINEL','PASSWORD_SENTINEL','SECRET_SENTINEL','BEARER_SENTINEL']) assert.equal(JSON.stringify(result).includes(secret),false,secret);
});

test('new counter-only samples do not freshen a retained context snapshot or supersede a more recent actual context', t => {
  const f=fixture(t); f.document('workflow-a'); f.turn('chat','workflow-a',{modelSessionIds:['old-context','new-context']});
  f.db.prepare('INSERT INTO session_usage VALUES(?,?)').run('old-context',JSON.stringify({capturedAt:at,contextCapturedAt:'2026-10-25T00:00:00Z',usage:{context_used:10,context_max:100}}));
  f.db.prepare('INSERT INTO session_usage VALUES(?,?)').run('new-context',JSON.stringify({capturedAt:'2026-10-26T00:00:00Z',contextCapturedAt:'2026-10-26T00:00:00Z',usage:{context_used:40,context_max:100}}));
  const context=f.read().workflows[0].context; assert.equal(context.sessionId,'new-context'); assert.equal(context.percent,40); assert.equal(context.capturedAt,'2026-10-26T00:00:00Z');
});

function historical(f, sessionId, runId, extra = {}) {
  f.db.exec('CREATE TABLE IF NOT EXISTS hermes_usage_history(session_id TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const run = f.db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
  const value = { sessionId, storedSessionId: 'stored-' + sessionId, found: true, source: 'hermes.state-db', importedAt: now.toISOString(),
    tokensRecorded: true, usage: { input: 100, output: 10, prompt: 120, completion: 10, total: 130, calls: 1, cache_read: 20, cache_write: 0, reasoning: 5 },
    firstMessageAt: run.started_at, firstUserMessageAt: run.started_at, lastMessageAt: run.completed_at, parentId: null, hasChildren: false, compressed: false,
    allocation: { runId, reason: 'single-ended-local-run' },
    context: { used: 120, max: null, percent: null, estimated: false, historical: true, kind: 'last-request-input', capturedAt: null, source: 'hermes.persisted-usage-anchor' }, ...extra };
  f.db.prepare('INSERT INTO hermes_usage_history VALUES(?,?)').run(sessionId, JSON.stringify(value)); return value;
}

test('allocated historical metadata fills missing usage without writing live counters or inventing a context sample time', t => {
  const f = fixture(t); f.document('workflow-a'); f.run('execution', 'workflow-a', { sessionId: 'history-session' });
  f.model('model-run', 'history-session', null); historical(f, 'history-session', 'model-run'); const before = f.snapshot(), data = f.read(), row = data.workflows[0];
  assert.equal(row.usage.total, 130); assert.equal(row.usage.input, 100); assert.equal(row.usage.output, 10); assert.equal(row.usage.historicalRuns, 1);
  assert.equal(row.usage.measuredRuns, 1); assert.equal(row.usage.unmeasuredRuns, 0); assert.equal(data.totals.usage.total, 130);
  assert.equal(data.daily.at(-1).usage.total, 130); assert.equal(row.context.used, 120); assert.equal(row.context.max, null);
  assert.equal(row.context.historical, true); assert.equal(row.context.kind, 'last-request-input'); assert.equal(row.context.capturedAt, null);
  assert.deepEqual(f.snapshot(), before);
});

test('historical fallback never adds to measured live usage and only replaces dominated partial values', t => {
  const f = fixture(t); f.document('workflow-a');
  for (const [name, status, total] of [['measured', 'measured', 125], ['partial', 'partial', 20], ['large', 'partial', 150], ['reset', 'reset', 10]]) {
    f.run('execution-' + name, 'workflow-a', { sessionId: name });
    f.model('model-' + name, name, { total, calls: 1 }, status); historical(f, name, 'model-' + name);
  }
  const row = f.read().workflows[0]; assert.equal(row.usage.total, 125 + 130 + 150 + 10);
  assert.equal(row.usage.historicalRuns, 1); assert.equal(row.usage.measuredRuns, 2); assert.equal(row.usage.partialRuns, 2);
});

test('adding another local turn after importing a cumulative snapshot invalidates its historical run allocation', t => {
  const f = fixture(t); f.document('workflow-a'); f.run('execution', 'workflow-a', { sessionId: 'history-session' });
  f.model('model-run', 'history-session', null); historical(f, 'history-session', 'model-run'); assert.equal(f.read().workflows[0].usage.total, 130);
  f.db.prepare('INSERT INTO runs(id,session_id,started_at) VALUES(?,?,?)').run('later-run', 'history-session', '2026-10-27T02:00:00.000Z');
  const row = f.read().workflows[0]; assert.equal(row.usage.total, null); assert.equal(row.usage.historicalRuns, 0); assert.equal(row.usage.unmeasuredRuns, 2);
});

test('historical imports bucket by the original local run date and never supersede a genuine live context', t => {
  const f = fixture(t); f.document('workflow-a'); f.run('execution', 'workflow-a', { sessionId: 'history-session' });
  f.model('model-run', 'history-session', null, 'missing', '2026-10-21T01:00:00.000Z');
  f.db.prepare('UPDATE runs SET completed_at=? WHERE id=?').run('2026-10-21T01:01:00.000Z', 'model-run');
  historical(f, 'history-session', 'model-run');
  f.db.prepare('INSERT INTO session_usage VALUES(?,?)').run('history-session', JSON.stringify({ capturedAt: at, usage: { context_used: 400, context_max: 1000, context_estimated: false } }));
  const result = f.read(); assert.equal(result.daily[0].usage.total, 130); assert.equal(result.daily.at(-1).usage.total, null);
  assert.equal(result.workflows[0].context.used, 400); assert.equal(result.workflows[0].context.percent, 40); assert.equal(result.workflows[0].context.historical, undefined);
});
