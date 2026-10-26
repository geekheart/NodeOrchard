import {spawn} from 'node:child_process';
import {homedir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WORKFLOW_TOOLS} from '../../shared/workflow/workflow-tools.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const python=join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
const registeredCapabilities=new Set(WORKFLOW_TOOLS.filter(tool=>tool.id.startsWith('hdk.')).map(tool=>tool.id));
const localPathVariables=Object.freeze([
  'WORKBENCH_HDK_SOURCE_ROOT', 'WORKBENCH_HDK_PROCESS_TEMPLATE', 'WORKBENCH_HDK_PINOUT_REFERENCE',
  'WORKBENCH_HDK_ESPRESSIF_HOME', 'WORKBENCH_HDK_COMPILER_BIN', 'WORKBENCH_HDK_CMAKE_BIN',
  'WORKBENCH_HDK_NINJA_BIN', 'WORKBENCH_HDK_RESOURCE_OVERLAY',
]);

// Only controller configuration selects a workspace. Neither process-global
// workspace defaults nor model/user input may replace the bound app workspace.
export function capabilityEnvironment(context, environment=process.env) {
  const env=Object.fromEntries(['PATH','TMPDIR','TMP','TEMP','LANG','LC_ALL','HOME',...localPathVariables]
    .filter(key=>typeof environment[key]==='string'&&environment[key]).map(key=>[key,environment[key]]));
  if(context?.workspaceRoot!==undefined) {
    if(typeof context.workspaceRoot!=='string'||!isAbsolute(context.workspaceRoot)||context.workspaceRoot.includes('\0')) {
      throw Object.assign(Error('能力工作区必须由控制器指定绝对路径。'),{code:'CONTEXT_INVALID'});
    }
    env.WORKBENCH_WORKSPACE_ROOT=context.workspaceRoot;
  }
  return env;
}

export async function executeCapability({toolName,input,signal,onLog,context}) {
  if(!registeredCapabilities.has(toolName))throw Error('未知板卡能力。');
  if(signal?.aborted)throw Error('任务已停止。');
  const env=capabilityEnvironment(context);
  return new Promise((resolve,reject)=>{
    const child=spawn(python,['-I','-B',join(root,'hdk/dag_capabilities.py')],{cwd:root,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
    let data='',error='',settled=false,timer;
    const stop=()=>{try{process.platform==='win32'?child.kill('SIGTERM'):process.kill(-child.pid,'SIGTERM');}catch{} timer=setTimeout(()=>{try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL');}catch{}},2000);timer.unref?.();};
    signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    child.stdout.on('data',chunk=>{data+=chunk.toString();if(Buffer.byteLength(data)>65536){error='能力回执超过64KiB。';stop();}});
    child.stderr.on('data',chunk=>{const text=chunk.toString();error=(error+text).slice(-16000);onLog?.({stream:'stderr',text});});
    child.on('error',cause=>{if(!settled){settled=true;reject(cause);}});
    child.on('close',code=>{signal?.removeEventListener('abort',stop);clearTimeout(timer);if(settled)return;settled=true;try{const value=JSON.parse(data);if(code||!value.ok){const failure=Error(value.error||error||'能力执行失败。');if(value.code==='LEARNING_INVALID_PLAN')failure.code=value.code;throw failure;}resolve(value.output);}catch(cause){const failure=new Error(signal?.aborted?'已停止本次能力。':cause.message+(!data?' '+error:''));if(!signal?.aborted&&cause.code==='LEARNING_INVALID_PLAN')failure.code=cause.code;reject(failure);}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({operation:toolName,input,context}));
  });
}
