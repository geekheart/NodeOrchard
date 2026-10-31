import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.mjs';
import { Application } from '../src/application.mjs';
import { createWorkbenchServer } from '../src/server.mjs';
class Offline extends EventEmitter { constructor(){super();this.state='stopped';this.serverRequests=new Map();} async stop(){} }
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'maintenance-http-'));
  const config={...readConfig({WORKBENCH_DATA_DIR:join(root,'data'),WORKBENCH_WORKSPACE_ROOT:join(root,'workspace')}),port:0};
  const app=new Application(config,new Offline());await app.workflowFoldersReady;
  const server=createWorkbenchServer(config,app),origin=await server.listen();
  t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
  const directory=join(root,'isolated');await mkdir(directory);
  const body='<script>window.permissionChanged=true</script>';await writeFile(join(directory,'result.html'),body);
  const value={id:'experiment-http',taskId:'task-http',kind:'reproduce',status:'passed',directory,result:{artifacts:[{path:'result.html',size:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')}]}};
  app.store.db.prepare('INSERT INTO assistant_maintenance_experiments VALUES(?,?,?,?)').run(value.id,value.taskId,'once-http',JSON.stringify(value));
  return {app,root,body,url:origin+app.applicationAssistant.maintenance.experimentView(value).artifacts[0].url,origin};
}
test('maintenance HTTP serves manifest artifacts as safe downloads and rejects origin/query/identity escapes',async t=>{
  const f=await fixture(t),response=await fetch(f.url);
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/octet-stream');
  assert.match(response.headers.get('content-disposition'),/^attachment;/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(await response.text(),f.body);
  assert.equal((await fetch(f.url+'?path=/outside')).status,400);
  assert.equal((await fetch(f.url,{headers:{Origin:'https://example.com'}})).status,403);
  assert.equal((await fetch(f.url.replace(/artifact-[a-f0-9]+$/,'artifact-unknown'))).status,404);
  await writeFile(join(f.root,'isolated/result.html'),'changed');assert.equal((await fetch(f.url)).status,409);
});
test('maintenance card module is served through the fixed static registry',async t=>{
  const f=await fixture(t),response=await fetch(f.origin+'/maintenance-task-ui.js');
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);assert.match(await response.text(),/renderMaintenanceTask/);
});
