import { realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const nativeErrorStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
const entries = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 200).map(key => [key, own(value, key)]) : [];
const list = value => Array.isArray(value) ? value : [];
const levelFor = status => ['error', 'failed', 'exhausted'].includes(status) ? 'error'
  : ['interrupted', 'cancelled', 'unknown', 'partial', 'disconnected', 'skipped', 'blocked'].includes(status) ? 'warn' : 'info';
const elapsed = (start, end) => { const value = Date.parse(end) - Date.parse(start); return Number.isFinite(value) && value >= 0 ? value : undefined; };

// Observe existing state transitions. No payload, prompt, source, output, or
// caller text is copied to logs, and streaming snapshots do not churn storage.
export class ApplicationLogEvents {
  constructor(logger, { maxKeys = 4096 } = {}) { this.logger = logger; this.maxKeys = maxKeys; this.states = new Map(); this.closed = false; }
  write(level, event, context) { if (!this.closed) { try { this.logger?.write(level, event, context); } catch { /* Observability never participates in execution. */ } } }
  changed(key, signature) {
    if (this.states.get(key) === signature) return false;
    this.states.delete(key); this.states.set(key, signature);
    while (this.states.size > this.maxKeys) this.states.delete(this.states.keys().next().value);
    return true;
  }
  handle(event) {
    if (this.closed) return;
    try { this.record(event); } catch { /* Ignore malformed observations, not business state. */ }
  }
  record(event) {
    const type = own(event, 'type'), payload = own(event, 'payload') || {}, sessionId = own(event, 'sessionId');
    if (type === 'backend.status') {
      const status = own(payload, 'state');
      if (status && this.changed('backend', status)) this.write(levelFor(status), 'hermes.connection', { component: 'hermes', status,
        model: own(payload, 'model'), provider: own(payload, 'provider'), code: status === 'error' ? 'BACKEND_UNAVAILABLE' : undefined });
      return;
    }
    if (type === 'backend.error') { this.write('error', 'hermes.connection.failed', { component: 'hermes', code: 'BACKEND_CONNECTION_FAILED' }); return; }
    if (type === 'workflow.run') {
      const runId = own(payload, 'id'), workflowId = own(payload, 'workflowId'), status = own(payload, 'status');
      if (!runId) return;
      const parentRunId = own(payload, 'parentRunId'), learningId = own(payload, 'learningId');
      if (this.changed('run:' + runId, status)) this.write(levelFor(status), 'workflow.run.state', { component: 'workflow', workflowId, runId, parentRunId, learningId, sessionId, status,
        stage: own(payload, 'phase'), durationMs: elapsed(own(payload, 'startedAt'), own(payload, 'completedAt')), code: status === 'error' ? 'WORKFLOW_RUN_FAILED' : undefined });
      for (const [nodeId, node] of entries(own(payload, 'nodes'))) {
        const nodeStatus = own(node, 'status'), attempt = own(node, 'attempt'), attemptId = own(node, 'attemptId');
        const signature = [nodeStatus, attempt, attemptId].join(':');
        if (!nodeStatus || nodeStatus === 'idle' || !this.changed('node:' + runId + ':' + nodeId, signature)) continue;
        this.write(levelFor(nodeStatus), 'workflow.node.state', { component: 'workflow', workflowId, runId, parentRunId, learningId, nodeId, status: nodeStatus, attempt, attemptId,
          sessionId: own(node, 'sessionId'), durationMs: elapsed(own(node, 'startedAt'), own(node, 'completedAt')), code: nodeStatus === 'error' ? 'WORKFLOW_NODE_FAILED' : undefined });
      }
      return;
    }
    if (type === 'workflow.conversation' || type === 'application.conversation') {
      const conversation = own(payload, 'conversation'), turn = list(own(conversation, 'turns')).at(-1);
      if (!turn) return;
      const workflowId = own(payload, 'workflowId') || own(turn, 'workflowId'), conversationId = own(conversation, 'id') || own(turn, 'conversationId');
      const turnId = own(turn, 'id'), assistant = own(turn, 'assistant') || {}, progress = own(assistant, 'progress') || {}, status = own(turn, 'status');
      const stage = own(progress, 'stage'), modelCalls = own(progress, 'modelCalls'), toolCalls = own(progress, 'toolCalls');
      const context = { component: 'assistant', workflowId, conversationId, turnId, status, stage,
        runId: own(own(own(turn, 'user'), 'context'), 'runId'), sessionId: own(turn, 'modelSessionId'),
        modelCalls, toolCalls, elapsedMs: own(progress, 'elapsedMs'), durationMs: elapsed(own(turn, 'createdAt'), own(turn, 'updatedAt')),
        code: status === 'error' ? 'ASSISTANT_TURN_FAILED' : undefined };
      if (turnId && this.changed('turn:' + turnId, [status, stage, modelCalls, toolCalls].join(':'))) this.write(levelFor(status), 'assistant.turn.state', context);
      for (const evidence of list(own(assistant, 'evidence')).slice(-12)) {
        const tool = own(evidence, 'tool'), toolStatus = own(evidence, 'status'), at = own(evidence, 'at');
        if (!tool || !at || !this.changed('tool:' + turnId + ':' + tool + ':' + at, toolStatus)) continue;
        this.write(levelFor(toolStatus), 'assistant.tool.result', { ...context, tool, status: toolStatus,
          cacheHit: own(evidence, 'cached') === true, code: toolStatus === 'error' ? 'ASSISTANT_TOOL_FAILED' : undefined });
      }
      return;
    }
    if (type === 'learning.run') {
      const learningId = own(payload, 'id'), status = own(payload, 'status'), stage = own(payload, 'phase');
      if (learningId && this.changed('learning:' + learningId, [status, stage, own(payload, 'round')].join(':'))) this.write(levelFor(status), 'learning.state', {
        component: 'learning', learningId, workflowId: own(payload, 'workflowId'), status, stage, sessionId: own(payload, 'modelSessionId'), count: own(payload, 'round') });
      return;
    }
    if (type === 'workflow.schedule') {
      const schedule = own(payload, 'schedule'), scheduleId = own(schedule, 'id');
      if (!scheduleId) return;
      const trigger = own(schedule, 'lastTrigger'), status = own(trigger, 'status') || (own(schedule, 'enabled') ? 'enabled' : 'paused');
      if (this.changed('schedule:' + scheduleId, [own(schedule, 'revision'), status, own(trigger, 'id')].join(':'))) this.write(levelFor(status), 'schedule.state', {
        component: 'schedule', scheduleId, workflowId: own(schedule, 'workflowId'), runId: own(trigger, 'runId'), status, revision: own(schedule, 'revision') });
      return;
    }
    if (type === 'workflow.lifecycle') {
      const workflow = own(payload, 'workflow') || payload;
      this.write('info', 'workflow.lifecycle', { component: 'workflow', workflowId: own(workflow, 'id'), status: own(workflow, 'lifecycle'), revision: own(workflow, 'revision') }); return;
    }
    if (type === 'message.start') { this.write('info', 'hermes.turn.started', { component: 'hermes', sessionId }); return; }
    if (type === 'message.complete') { const status = own(payload, 'status'); this.write(own(payload, 'error') ? 'error' : own(payload, 'partial') ? 'warn' : levelFor(status), 'hermes.turn.completed', {
      component: 'hermes', sessionId, status, code: own(payload, 'partial') ? 'PARTIAL_RESPONSE' : own(payload, 'error') ? 'MODEL_RESPONSE_FAILED' : undefined }); return; }
    if (type === 'error') { this.write('error', 'hermes.turn.failed', { component: 'hermes', sessionId, code: 'HERMES_ERROR' }); return; }
    if (type === 'request.open' || type === 'request.cancel') this.write(type === 'request.open' ? 'info' : 'debug', 'hermes.request.state', {
      component: 'hermes', sessionId, requestId: own(payload, 'id'), stage: own(payload, 'method'), status: type === 'request.open' ? 'waiting' : 'closed' });
    if (type === 'statistics.history') this.write('info', 'statistics.history.completed', { component: 'statistics', count: own(payload, 'attributedRuns'), historyRuns: own(payload, 'imported'), status: 'complete' });
  }
  close() { this.closed = true; this.states.clear(); }
}

const STATIC_ROUTES = new Set(['/', '/api/bootstrap', '/api/app-capabilities', '/api/app-assistant', '/api/conversation-hub', '/api/app-assistant/conversations', '/api/app-assistant/messages',
  '/api/settings', '/api/assistant-permissions', '/api/models', '/api/statistics', '/api/statistics/history', '/api/skills', '/api/skill-integrations', '/api/skill-integrations/image-provider', '/api/events', '/api/connect',
  '/api/workflow-node-presets', '/api/workflow-examples', '/api/workflow-library', '/api/workflow-packages/import', '/api/workflow-runs', '/api/workflow-schedules', '/api/workflow-v2/queue', '/api/sessions']);
const ROUTES = [
  [/^\/api\/workflow-examples\/[^/]+\/prepare$/, '/api/workflow-examples/:exampleId/prepare'],
  [/^\/api\/workflow-library\/[^/]+\/attachments\/[^/]+\/content$/, '/api/workflow-library/:workflowId/attachments/:attachmentId/content'],
  [/^\/api\/workflow-library\/[^/]+\/(attachments(?:\/reference)?)$/, '/api/workflow-library/:workflowId'],
  [/^\/api\/workflow-library\/[^/]+\/(folder(?:\/open)?|export)$/, '/api/workflow-library/:workflowId'],
  [/^\/api\/workflow-library\/[^/]+(?:\/(archive|unarchive|trash|restore|purge))?$/, '/api/workflow-library/:workflowId'],
  [/^\/api\/workflow-runs\/[^/]+(?:\/(rerun|stop|review|feedback))?$/, '/api/workflow-runs/:runId'],
  [/^\/api\/workflow-conversations\/[^/]+(?:\/(messages|pending|turns\/[^/]+\/action))?$/, '/api/workflow-conversations/:workflowId'],
  [/^\/api\/app-assistant\/conversations\/[^/]+(?:\/(messages|turns\/[^/]+\/action))?$/, '/api/app-assistant/conversations/:conversationId'],
  [/^\/api\/app-assistant\/turns\/[^/]+\/action$/, '/api/app-assistant/turns/:turnId/action'],
  [/^\/api\/workflow-node-presets\/[^/]+(?:\/(versions))?$/, '/api/workflow-node-presets/:presetId'],
  [/^\/api\/workflow-schedules\/[^/]+$/, '/api/workflow-schedules/:scheduleId'],
  [/^\/api\/sessions\/[^/]+(?:\/(history|runs|resume|messages|interrupt))?$/, '/api/sessions/:sessionId'],
  [/^\/api\/requests\/[^/]+\/reply$/, '/api/requests/:requestId/reply'],
  [/^\/api\/skills\/[^/]+$/, '/api/skills/:skillId'],
  [/^\/api\/workflow-v2\/artifacts\/[^/]+$/, '/api/workflow-v2/artifacts/:artifactId'],
  [/^\/api\/app-diagnostics\/captures\/[^/]+\/[^/]+$/, '/api/app-diagnostics/captures/:captureId/:file'],
];

export function applicationHttpRoute(url) {
  try {
    const path = new URL(url, 'http://127.0.0.1').pathname;
    if (STATIC_ROUTES.has(path)) return path;
    for (const [pattern, template] of ROUTES) {
      const match = path.match(pattern);
      if (match) return template + (match[1] ? '/' + match[1].replace(/\/[^/]+\//g, '/:turnId/') : '');
    }
    return path.startsWith('/api/') ? '/api/[unmatched]' : '/[asset]';
  } catch { return '/[invalid]'; }
}

export function applicationResponseTrace(data) {
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : undefined;
  const workflow = own(data, 'workflow'), run = own(data, 'run'), session = own(data, 'session'), turn = own(data, 'turn'), conversation = own(data, 'conversation');
  return { workflowId: validId(own(data, 'workflowId') || own(workflow, 'id') || own(run, 'workflowId')),
    runId: validId(own(run, 'id') || (own(data, 'nodes') && own(data, 'workflowId') ? own(data, 'id') : undefined)),
    sessionId: validId(own(session, 'id') || (own(data, 'storedSessionId') ? own(data, 'id') : undefined)),
    turnId: validId(own(turn, 'id')), conversationId: validId(own(conversation, 'id')), operationId: validId(own(data, 'operationId')) };
}
export function applicationErrorLocation(error, appRoot) {
  try {
    const descriptor = error && Object.getOwnPropertyDescriptor(error, 'stack');
    const stack = descriptor?.value ?? (error instanceof Error && nativeErrorStackGetter && descriptor?.get === nativeErrorStackGetter
      ? nativeErrorStackGetter.call(error) : undefined);
    if (typeof stack !== 'string' || typeof appRoot !== 'string') return {};
    const root = realpathSync(appRoot);
    for (const frame of stack.split('\n').slice(1, 16)) {
      const match = frame.match(/\(?((?:file:\/\/\/|\/|[A-Za-z]:\\)[^()]+):(\d+):(\d+)\)?$/);
      if (!match) continue;
      const source = match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1];
      const logical = relative(root, resolve(source));
      if (!/^(?:src|public)[/\\]/.test(logical)) continue;
      const path = realpathSync(source), file = relative(root, path).split(sep).join('/');
      if (!/^(?:src|public)\/[A-Za-z0-9_./-]+\.(?:mjs|js)$/.test(file) || !statSync(path).isFile()) continue;
      const line = Number(match[2]), column = Number(match[3]);
      if (!Number.isSafeInteger(line) || line < 1 || line > 10000000 || !Number.isSafeInteger(column) || column < 1 || column > 1000000) continue;
      const name = frame.slice(0, match.index).replace(/^\s*at\s+(?:async\s+)?/, '').replace(/\s*\($/, '').trim();
      return { file, line, column, ...(/^[A-Za-z0-9_.$<>-]{1,80}$/.test(name) ? { functionName: name } : {}) };
    }
  } catch { /* A source location is optional metadata, never an arbitrary file reader. */ }
  return {};
}
