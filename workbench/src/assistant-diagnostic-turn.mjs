import { createHash } from 'node:crypto';
import { sanitizeDiagnosticEvidence, sanitizeDiagnosticText } from './app-diagnostics.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safe = value => sanitizeDiagnosticEvidence({ value }).value;
const now = () => new Date().toISOString();
export const ASSISTANT_DIAGNOSTIC_LIMITS = Object.freeze({ batchQueries: 4, toolRequests: 8, durationMs: 360000 });
const STATIC = new Set(['node.describe', 'app.capabilities', 'assistant.skills.list', 'assistant.skills.read']);
const REUSABLE = new Set([...STATIC, 'workflow.inspect', 'workflow.run', 'session.history', 'tools.catalog', 'runtime.inspect']);
const terminal = status => ['complete', 'completed', 'error', 'interrupted', 'cancelled', 'blocked', 'skipped'].includes(status);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const diagnosticRequestKey = (tool, args) => hash([tool, canonical(args)]);

export function validateDiagnosticArguments(value, schema = {}, path = 'arguments') {
  const invalid = () => { throw new Error(`诊断参数 ${path} 不符合工具 schema。`); };
  if (schema.enum && !schema.enum.includes(value)) invalid();
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) invalid();
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) { if (schema.additionalProperties === false) invalid(); continue; }
      validateDiagnosticArguments(item, schema.properties[key], path + '.' + key);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || (schema.maxItems !== undefined && value.length > schema.maxItems)) invalid();
    for (const [index, item] of value.entries()) validateDiagnosticArguments(item, schema.items, path + '.' + index);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.includes('\0') || (schema.maxLength !== undefined && value.length > schema.maxLength)
      || (schema.pattern && !new RegExp(schema.pattern).test(value))) invalid();
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))
      || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) invalid();
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') invalid();
}

// The initial routing prompt carries identities and failures. Large source,
// output and logs remain available through the existing admitted readers.
export function compactDiagnosticContext(value, { initial = false } = {}) {
  const visit = (item, key = '', depth = 0) => {
    if (typeof item === 'string') {
      if (initial && key === 'code') return { omitted: true, characters: item.length, sha256: hash(item), readWith: 'workflow.inspect（按需读取代码）' };
      if (initial && ['partialText', 'outputText', 'stdout', 'stderr'].includes(key) && item) return { omitted: true, characters: item.length, readWith: 'workflow.run / session.history（按需读取）' };
      const limit = key === 'error' ? 1600 : key === 'instructions' ? 6000 : initial ? 480 : 2200;
      return item.length > limit ? item.slice(0, limit) + '[已截断；按需读取完整证据]' : item;
    }
    if (item === null || typeof item !== 'object') return item;
    if (depth > 14) return '[深层内容已省略；按需读取]';
    if (Array.isArray(item)) {
      const limit = initial ? 30 : 40, result = item.slice(0, limit).map(row => visit(row, '', depth + 1));
      if (item.length > limit) result.push({ omitted: true, total: item.length, included: limit, note: '其余条目已省略；按需读取' });
      return result;
    }
    return Object.fromEntries(Object.entries(item).filter(([name]) => !initial || !['adapterLog', 'sessions', 'pendingRequests', 'tools', 'timeline'].includes(name))
      .map(([name, row]) => [name, visit(row, name, depth + 1)]));
  };
  return visit(safe(value));
}

export function diagnosticScope({ selection, evidence, modelRoute, capabilities, config, tools }) {
  // Control sessions and adapter log timestamps change during diagnosis. They
  // must not invalidate otherwise identical business evidence or renew its TTL.
  return hash({ selection, workflow: evidence.workflow, run: evidence.run, latestRun: evidence.latestRun,
    modelRoute, capabilities: Object.fromEntries(Object.entries(capabilities || {}).filter(([key]) => key !== 'loadedSkills')),
    tools, interpreter: config?.hermesPython, contractVersion: 2 });
}

function coveredBySnapshot(row, evidence) {
  if (STATIC.has(row.tool) || row.tool === 'runtime.inspect') return true;
  const args = row.arguments || {}, result = row.result || {};
  if (row.tool === 'workflow.inspect') {
    const current = evidence.workflow, id = current?.workflowId || current?.document?.id;
    // A scope covers the current workflow only. A tool may inspect another
    // target during this turn, but that target has no version in this snapshot.
    return !!id && result.workflowId === id && (!args.workflowId || args.workflowId === id)
      && result.savedRevision === current.savedRevision && result.source === current.source
      && !!current.document && !!result.document
      && hash(canonical(result.document)) === hash(canonical(current.document));
  }
  if (row.tool === 'workflow.run') {
    const id = args.runId || (args.runSelection === 'latest' ? evidence.latestRun?.id : evidence.run?.id);
    const current = [evidence.run, evidence.latestRun].find(run => run?.id === id && terminal(run.status));
    if (!current || result.id !== id || result.status !== current.status || result.workflowId !== current.workflowId
      || (args.workflowId && args.workflowId !== current.workflowId)) return false;
    return ['startedAt', 'completedAt'].every(key => current[key] === undefined || current[key] === result[key]);
  }
  // Ordinary sessions and native catalogs can change independently of the
  // selected workflow. They remain visible checkpoints, but are read again.
  return false;
}

export class AssistantDiagnosticTurn {
  constructor({ scope, checkpoint, evidence, onProgress, onCheckpoint, maxDurationMs = ASSISTANT_DIAGNOSTIC_LIMITS.durationMs }) {
    this.started = Date.now(); this.onProgress = onProgress; this.onCheckpoint = onCheckpoint;
    this.maxDurationMs = maxDurationMs; this.modelCalls = 0; this.toolCalls = 0;
    this.cache = new Map(); this.observations = []; this.steps = []; this.evidence = [];
    this.state = { version: 1, scope, createdAt: now(), updatedAt: now(), steps: this.steps, evidence: this.evidence, results: [] };
    this.admitCheckpoint(scope, checkpoint, evidence);
  }
  admitCheckpoint(scope, checkpoint, evidence = {}) {
    this.state.scope = scope;
    const stableRun = [evidence.run, evidence.latestRun].filter(row => row?.id).every(row => terminal(row.status));
    if (checkpoint?.version === 1 && checkpoint.scope === scope) {
      for (const row of (checkpoint.results || []).slice(-16)) {
        const age = Date.now() - Date.parse(row.collectedAt), ttl = STATIC.has(row.tool) ? 300000 : 60000;
        if (!REUSABLE.has(row.tool) || !coveredBySnapshot(row, evidence) || (!STATIC.has(row.tool) && !stableRun) || !(age >= 0 && age < ttl)
          || row.requestKey !== diagnosticRequestKey(row.tool, row.arguments) || row.result?.executed === false
          || row.result?.available === false || row.result?.restricted || row.result?.partial) continue;
        this.cache.set(row.requestKey, { ...safe(row), restored: true });
      }
      if (this.cache.size) this.state.resumed = true;
    }
  }
  publish() {
    this.state.updatedAt = now(); this.state.steps = this.steps.slice(-30).map(step => ({ ...step, label: step.label.slice(0, 240),
      ...(step.error ? { error: step.error.slice(0, 800) } : {}) })); this.state.evidence = this.evidence.slice(-24);
    let remaining = 24000;
    this.state.results = [...this.cache.values()].filter(row => REUSABLE.has(row.tool)).slice(-16).reverse().filter(row => {
      const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
      if (bytes > remaining) return false; remaining -= bytes; return true;
    }).reverse();
    // A checkpoint is evidence, never a model instruction or an action replay.
    let snapshot = safe(this.state);
    if (!Array.isArray(snapshot.results)) snapshot.results = [];
    if (!Array.isArray(snapshot.steps)) snapshot.steps = [];
    if (!Array.isArray(snapshot.evidence)) snapshot.evidence = [];
    while (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 48000 && snapshot.results.length) snapshot.results.shift();
    this.state = snapshot;
    this.onCheckpoint?.(structuredClone(snapshot));
  }
  phase(stage, label, detail = {}) {
    const active = this.steps.at(-1);
    if (active?.status === 'running') { active.status = 'complete'; active.completedAt = now(); active.elapsedMs = Date.now() - Date.parse(active.startedAt); }
    const step = { stage, label: sanitizeDiagnosticText(label), status: 'running', startedAt: now(), ...detail };
    this.steps.push(step);
    this.progress = { stage, label: step.label, startedAt: step.startedAt, turnStartedAt: this.state.createdAt,
      elapsedMs: Date.now() - this.started, modelCalls: this.modelCalls, toolCalls: this.toolCalls };
    this.publish(); this.onProgress?.(step.label, { ...this.progress });
  }
  finish(error) {
    const step = this.steps.at(-1);
    if (step?.status === 'running') { step.status = error ? 'error' : 'complete'; step.completedAt = now(); step.elapsedMs = Date.now() - Date.parse(step.startedAt);
      if (error) step.error = sanitizeDiagnosticText(error.message).slice(0, 1600); }
    this.state.status = error ? 'error' : 'complete'; this.publish();
  }
  async wait(promise, signal) {
    // Callers may already have started an async operation before this budget
    // check. Even an expired wait must observe its eventual rejection.
    const pending = Promise.resolve(promise); pending.catch(() => {});
    const remaining = this.maxDurationMs - (Date.now() - this.started);
    const timeout = () => Object.assign(new Error(`整轮诊断达到总等待上限（${Math.round(this.maxDurationMs / 1000)} 秒），已保留诊断进度。`), { code: 'ASSISTANT_TURN_TIMEOUT' });
    if (remaining <= 0) throw timeout();
    let timer, abort;
    try {
      return await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeout()), remaining);
        abort = () => reject(Object.assign(new Error('诊断已停止。'), { code: 'ABORT_ERR' }));
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  record(tool, args, value, { cached = false, key, collectedAt, cacheable = true } = {}) {
    const at = now(), result = safe(value);
    const failed = value?.executed === false && value?.proposed !== true;
    const uncertain = ['unknown', 'partial'].includes(value?.status);
    const step = this.steps.at(-1);
    if (failed && step?.status === 'running') { step.status = 'error'; step.completedAt = at; step.elapsedMs = Date.now() - Date.parse(step.startedAt);
      step.error = sanitizeDiagnosticText(value.error || '工具检查未完成。').slice(0, 1600); }
    this.evidence.push({ tool, status: failed ? 'error' : uncertain ? value.status : 'complete', at, ...(cached ? { cached: true, collectedAt } : {}), ...(value?.files ? { files: value.files } : {}) });
    const row = { tool, arguments: safe(args), result, requestKey: key, collectedAt: at };
    if (!cacheable && typeof result?.operationId === 'string') {
      const receipt = { tool, ...Object.fromEntries(['operationId', 'targetWorkflowId', 'status', 'revision', 'executed', 'recoverable']
        .filter(name => result[name] !== undefined).map(name => [name, result[name]])), collectedAt: at };
      this.state.mutationReceipts = [...(this.state.mutationReceipts || []).filter(item => item.operationId !== receipt.operationId), receipt].slice(-8);
    }
    if (!cacheable || uncertain) this.observations.push(row);
    else if (!cached && value?.executed !== false && result?.available !== false && !result?.restricted && !result?.partial) this.cache.set(key, row);
    this.publish(); return result;
  }
  transcript() { return [...this.cache.values(), ...this.observations].map(({ tool, arguments: args, result, collectedAt, restored }) => ({ tool, arguments: args,
    result: compactDiagnosticContext(result), collectedAt, ...(restored ? { restored: true } : {}) })); }
}
