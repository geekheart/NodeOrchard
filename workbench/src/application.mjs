import { EventEmitter } from 'node:events';
import { mkdirSync, realpathSync, existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, join, dirname } from 'node:path';
import { HermesAdapter, redact } from './hermes-adapter.mjs';
import { Store } from './store.mjs';
import { collectWorkbenchStatistics } from './workbench-statistics.mjs';
import { SessionUsage, sanitizeSessionUsage } from './session-usage.mjs';
import { HistoricalUsage } from './historical-usage.mjs';
import { ApplicationLog } from './application-log.mjs';
import { ApplicationLogEvents } from './application-log-events.mjs';
import { assertHermesPolicy } from './route-policy.mjs';
import { HermesModels } from './hermes-models.mjs';
import { validatePreferences } from './preferences.mjs';
import { initializeWorkspace } from './workspace-layout.mjs';
import { readSkillCatalog, readSkill, readSkillLabels, applySkillLabel } from './catalog.mjs';
import { WorkflowRuns } from './workflows/workflow-runs.mjs';
import { LearnedSkills } from './workflows/learned-skills.mjs';
import { LearningModel } from './workflows/learning-model.mjs';
import { WorkflowLearning } from './workflows/workflow-learning.mjs';
import { WorkflowSchedules } from './workflows/workflow-schedules.mjs';
import { WorkflowLibrary } from './workflows/workflow-library.mjs';
import { WorkflowFeedback } from './workflows/workflow-feedback.mjs';
import { WorkflowFiles } from './workflows/workflow-files.mjs';
import { WorkflowNodePresets } from './workflows/workflow-node-presets.mjs';
import { WorkflowConversations } from './workflows/workflow-conversations.mjs';
import { AppDiagnostics } from './app-diagnostics.mjs';
import { ApplicationAssistant } from './application-assistant.mjs';
import { AssistantPermissionSettings } from './assistant-permission-settings.mjs';
import { createAppDiagnosticBrowser } from './app-diagnostic-browser.mjs';

function infoView(info = {}) {
  const usage = sanitizeSessionUsage(info.usage);
  return { ...Object.fromEntries(['model', 'provider', 'version', 'cwd', 'running', 'yolo', 'approval_mode', 'tools', 'skills', 'credential_warning']
    .filter(key => info[key] !== undefined).map(key => [key, info[key]])), ...(usage ? { usage } : {}) };
}

export class Application extends EventEmitter {
  constructor(config, adapter = new HermesAdapter(config)) {
    super();
    this.config = config;
    this.adapter = adapter;
    this.models = new HermesModels(adapter);
    this.store = new Store(config.dataDir);
    try { this.logger = new ApplicationLog(this.store.db, { level: config.logLevel || 'info' }); }
    catch { this.logger = null; /* Log persistence cannot prevent business execution. */ }
    this.logEvents = new ApplicationLogEvents(this.logger);
    this.logEvents.write('info', 'application.starting', { component: 'application' });
    try { this.sessionUsage = new SessionUsage(this.store.db); this.store.sessionUsage = this.sessionUsage; }
    catch { this.sessionUsage = null; /* Missing telemetry must not prevent task execution. */ }
    this.requests = new Map();
    this.sessionInfo = new Map();
    this.sequence = 0;
    this.events = [];
    this.eventSizes = [];
    this.eventBytes = 0;
    this.eventQueue = [];
    this.publishing = false;
    this.busyMutations = new Set();
    this.resumes = new Map();
    this.historyOnlyRuntimes = new Set();
    this.resumeFrames = [];
    this.preferences = initializeWorkspace(config, this.store);
    this.backend = { state: 'stopped', provider: '', model: '',
      authenticated: null, hermesVersion: config.hermesVersion, lastError: '', cwdDefault: join(config.workspaceRoot, this.preferences.defaultWorkspace) };
    adapter.on('state', state => {
      if (this.closed) return;
      Object.assign(this.backend, state);
      this.publish('backend.status', null, { ...this.backend });
      if (['disconnected', 'error', 'stopped'].includes(state.state)) {
        this.historyOnlyRuntimes.clear();
        for (const request of this.requests.values()) this.publish('request.cancel', request.sessionId, { id: request.id });
        this.requests.clear();
        this.sessionInfo.clear();
        for (const session of this.store.list()) {
          if (!session.runtimeSessionId) continue;
          this.store.finishRun(session.id, 'unknown', 'Hermes 连接中断；请恢复会话核对。');
          this.updateSession(session.id, { runtimeSessionId: null, status: 'disconnected' });
        }
      }
    });
    adapter.on('event', event => this.onGatewayEvent(event));
    adapter.on('request', frame => this.onRequest(frame));
    this.learnedSkills = new LearnedSkills(this);
    this.workflowFiles = new WorkflowFiles(this);
    this.workflows = new WorkflowRuns(this);
    this.feedback = new WorkflowFeedback(this);
    this.learningModel = new LearningModel(this);
    this.learning = new WorkflowLearning(this);
    this.schedules = new WorkflowSchedules(this);
    this.workflowLibrary = new WorkflowLibrary(this);
    this.nodePresets = new WorkflowNodePresets(this);
    this.assistantModel = new LearningModel(this, { purpose: 'assistant' });
    this.diagnostics = new AppDiagnostics(this);
    this.diagnosticBrowser = createAppDiagnosticBrowser({ dataDir: config.dataDir, chromePath: config.diagnosticChromePath, ffmpegPath: config.diagnosticFfmpegPath });
    this.assistantPermissionSettings = new AssistantPermissionSettings(this);
    this.applicationAssistant = new ApplicationAssistant(this);
    this.conversations = new WorkflowConversations(this);
    this.historicalUsage = new HistoricalUsage(this);
    this.logEvents.write('info', 'application.started', { component: 'application', status: 'ready' });
  }

  publish(type, sessionId, payload) {
    const event = { id: ++this.sequence, type, sessionId, payload, at: new Date().toISOString() };
    this.logEvents?.handle(event);
    this.events.push(event);
    const size = Buffer.byteLength(JSON.stringify(event));
    this.eventSizes.push(size);
    this.eventBytes += size;
    // Learning records contain full per-sample I/O. Bound replay by bytes as well
    // as count, retaining at least the latest event; durable records remain in SQLite.
    while (this.events.length > 1 && (this.events.length > 1000 || this.eventBytes > 16 * 1024 * 1024)) {
      this.events.shift();
      this.eventBytes -= this.eventSizes.shift();
    }
    // Workflow listeners may publish state while handling another event. Deliver
    // that nested state after the original frame so SSE cursors stay monotonic.
    this.eventQueue.push(event);
    if (!this.publishing) {
      this.publishing = true;
      try { while (this.eventQueue.length) this.emit('event', this.eventQueue.shift()); }
      finally { this.publishing = false; }
    }
    return event;
  }

  bootstrap() {
    return { backend: { ...this.backend }, sessions: this.store.list().filter(session => !this.assistantModel.ownsSession(session.id)).map(session => ({
      ...session, workflowManaged: this.workflows.ownsSession(session.id) || this.learningModel.ownsSession(session.id) || this.assistantModel.ownsSession(session.id),
    })), requests: [...this.requests.values()] };
  }

  async settings() {
    let approvalMode = null;
    if (!this.closed && this.adapter.state === 'ready') {
      try {
        const approval = await this.adapter.request('config.get', { key: 'approvals.mode' });
        if (['manual', 'smart'].includes(approval?.value)) approvalMode = approval.value;
      } catch { /* A disconnected or unsupported backend has no confirmed approval mode. */ }
    }
    return { preferences: { ...this.preferences }, runtime: {
      provider: this.backend.provider, hermesVersion: this.config.hermesVersion,
      hermesRoot: this.config.hermesRoot, hermesHome: this.config.hermesHome,
      workspaceRoot: this.config.workspaceRoot,
      availableModels: Array.isArray(this.backend.availableModels)
        ? this.backend.availableModels.filter(model => typeof model === 'string') : [],
    }, approvalMode };
  }

  async saveSettings(input) {
    if (this.closed) throw new Error('工作台已关闭。');
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || !Object.hasOwn(input, 'preferences') || Object.keys(input).some(key => key !== 'preferences')) {
      throw new Error('只能保存工作台 preferences 设置。');
    }
    const preferences = validatePreferences(input.preferences, this.preferences, {
      workspaceRoot: this.config.workspaceRoot,
      availableModels: this.backend.availableModels || [],
      connected: this.adapter.state === 'ready' && this.backend.state === 'ready',
    });
    this.store.savePreferences(preferences);
    this.preferences = preferences;
    this.backend.cwdDefault = join(this.config.workspaceRoot, preferences.defaultWorkspace);
    this.publish('settings.updated', null, { preferences: { ...preferences } });
    return this.settings();
  }

  statistics(days = 7) {
    const statistics = this.store.statistics(days);
    statistics.recentRuns = statistics.recentRuns.map(run => ({ ...run, error: redact(run.error) }));
    statistics.dashboard = collectWorkbenchStatistics(this, { days });
    return statistics;
  }

  async backfillHistoricalUsage() {
    if (this.closed) throw new Error('工作台已关闭。');
    this.logEvents.write('info', 'statistics.history.started', { component: 'statistics' });
    try {
      const result = await this.historicalUsage.refresh();
      if (!this.closed) this.publish('statistics.history', null, result);
      return result;
    } catch (error) {
      this.logEvents.write('error', 'statistics.history.failed', { component: 'statistics', errorName: error.name, errorCode: error.code, httpStatus: error.httpStatus });
      throw error;
    }
  }

  async skills() {
    if (this.closed || this.adapter.state !== 'ready') return { connected: false, skills: [] };
    try {
      const [catalog, labels] = await Promise.all([readSkillCatalog(this.adapter), readSkillLabels(this.config.appRoot)]);
      return { connected: true, skills: [...catalog, ...this.learnedSkills.list()].map(skill => applySkillLabel(skill, labels)) };
    }
    catch (error) { return { connected: this.adapter.state === 'ready', skills: [], error: redact(error.message) }; }
  }

  async skill(name) {
    if (this.closed || this.adapter.state !== 'ready') throw Object.assign(new Error('请先连接 Hermes，再查看 Skill。'), { httpStatus: 409 });
    const [skill, labels] = await Promise.all([
      this.learnedSkills.has(name) ? this.learnedSkills.resolve(name) : readSkill(this.adapter, name),
      readSkillLabels(this.config.appRoot),
    ]);
    return applySkillLabel(skill, labels);
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect();
    try { return await this.connecting; } finally { this.connecting = null; }
  }
  async #connect() {
    await this.adapter.start();
    try {
      await assertHermesPolicy(this.adapter);
      const options = await this.models.read();
      this.applyModelOptions(options);
      Object.assign(this.backend, { state: 'ready', lastError: '' });
      this.publish('backend.status', null, { ...this.backend });
      return { ...this.backend };
    } catch (error) {
      this.backend.state = 'error';
      this.backend.lastError = redact(error.message);
      this.publish('backend.error', null, { message: this.backend.lastError });
      throw error;
    }
  }

  checkReady() {
    if (this.closed) throw new Error('工作台已关闭。');
    if (this.adapter.state !== 'ready' || this.backend.state !== 'ready') throw new Error(this.backend.lastError || '请先连接 Hermes。');
  }

  applyModelOptions(options) {
    const current = options.current || {};
    const provider = options.providers?.find(item => item.id === current.provider);
    Object.assign(this.backend, { provider: current.provider || '', model: current.model || '',
      authenticated: provider?.authenticated ?? null, availableModels: provider?.models || [] });
  }

  async modelOptions() {
    const options = await this.models.read();
    if (this.closed) throw new Error('工作台已关闭。');
    if (options.connected) {
      this.applyModelOptions(options);
      this.publish('backend.status', null, { ...this.backend });
    }
    return options;
  }

  async selectModel(input) {
    this.checkReady();
    const options = await this.models.set(input);
    if (this.closed) throw new Error('工作台已关闭。');
    this.applyModelOptions(options);
    this.publish('models.updated', null, options);
    this.publish('backend.status', null, { ...this.backend });
    return options;
  }

  async captureModelRoute({ optional = false } = {}) {
    if (optional && (this.closed || this.adapter.state !== 'ready' || this.backend.state !== 'ready')) return null;
    this.checkReady();
    const { current } = await this.modelOptions();
    if (!current?.provider || !current?.model) {
      if (optional) return null;
      throw new Error('Hermes 尚未配置默认模型，请从顶部选择模型或先运行 hermes model。');
    }
    return Object.freeze({ provider: current.provider, model: current.model });
  }

  recoverModelRoute(sessionIds) {
    const routes = new Map();
    for (const id of sessionIds) {
      const session = id && this.store.get(id);
      if (session?.provider && session.model) routes.set(JSON.stringify([session.provider, session.model]), { provider: session.provider, model: session.model });
    }
    return routes.size === 1 ? [...routes.values()][0] : null;
  }

  workspace(cwd) {
    const root = realpathSync(this.config.workspaceRoot);
    const configuredRoot = resolve(this.config.workspaceRoot);
    const target = cwd ? resolve(isAbsolute(cwd) ? cwd : join(configuredRoot, cwd)) : this.backend.cwdDefault;
    const inside = rel => rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
    // macOS aliases /var to /private/var; accept either spelling of the configured root.
    if (!inside(relative(configuredRoot, target)) && !inside(relative(root, target))) throw new Error('工作目录必须位于已配置的工作区内。');
    // Validate the existing parent before creating children through a symlink.
    let ancestor = target;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (!inside(relative(root, realpathSync(ancestor)))) throw new Error('工作目录不能通过符号链接越过工作区。');
    mkdirSync(target, { recursive: true });
    const canonical = realpathSync(target);
    const actualRel = relative(root, canonical);
    if (!inside(actualRel)) throw new Error('工作目录不能通过符号链接越过工作区。');
    return canonical;
  }

  async configureSession(snapshot, expectedRoute) {
    const runtime = snapshot.session_id;
    // The session's actual route is the authority; a requested pin must be
    // confirmed before any prompt, never silently replaced by the new default.
    if (expectedRoute && (snapshot.info?.provider !== expectedRoute.provider || snapshot.info?.model !== expectedRoute.model)) {
      throw new Error('Hermes 未确认所选会话模型，已停止提交。');
    }
    await this.adapter.request('config.set', { key: 'yolo', value: 'off', scope: 'session', session_id: runtime });
    if (snapshot.info?.approval_mode === 'off') throw new Error('Hermes 当前配置关闭了审批。请在 Hermes 设置中启用审批后重试；应用不会修改你的全局配置。');
    snapshot.info = infoView(snapshot.info);
    this.sessionInfo.set(runtime, snapshot.info);
    const current = this.store.byRuntime(runtime);
    if (current) this.observeUsage(current.id, snapshot.info.usage, 'session.info');
    return snapshot;
  }

  async createSession({ title = '', cwd = '', modelRoute, managedPurpose } = {}) {
    if (managedPurpose !== undefined && managedPurpose !== 'assistant') throw new Error('托管会话用途无效。');
    this.checkReady();
    await assertHermesPolicy(this.adapter);
    const route = modelRoute || await this.captureModelRoute();
    if (typeof route.provider !== 'string' || !route.provider || typeof route.model !== 'string' || !route.model) throw new Error('无效的 Hermes 会话模型。');
    const directory = this.workspace(cwd || this.preferences.defaultWorkspace);
    const snapshot = await this.adapter.request('session.create', {
      cwd: directory, source: 'tui', title: String(title || '新任务').slice(0, 120),
      provider: route.provider, model: route.model,
    });
    await this.configureSession(snapshot, route);
    this.checkReady();
    const session = this.store.create({ title: String(title || '新任务').slice(0, 120), cwd: directory,
      storedSessionId: snapshot.stored_session_id, runtimeSessionId: snapshot.session_id, model: snapshot.info.model, provider: snapshot.info.provider });
    try { this.sessionUsage?.registerNew(session.id); } catch { /* Observation only. */ }
    this.observeUsage(session.id, snapshot.info.usage, 'session.create');
    if (managedPurpose === 'assistant') this.store.db.prepare('INSERT OR IGNORE INTO application_model_sessions(id) VALUES(?)').run(session.id);
    else this.publish('session.updated', session.id, session);
    return session;
  }

  updateSession(id, changes) {
    const session = this.store.update(id, changes);
    this.publish('session.updated', id, { ...session, workflowManaged: this.workflows?.ownsSession(id) || this.learningModel?.ownsSession(id) || this.assistantModel?.ownsSession(id) || false });
    return session;
  }
  session(id) {
    const session = this.store.get(id);
    if (!session) throw Object.assign(new Error('会话不存在。'), { httpStatus: 404 });
    return session;
  }

  resume(id) {
    const pending = this.resumes.get(id);
    if (pending) return pending.promise;
    const recovery = { id, runtimeIds: new Set(), promise: null };
    this.resumes.set(id, recovery);
    recovery.promise = (async () => {
      try {
        if (this.closed) throw new Error('工作台已关闭。');
        this.checkReady();
        const current = this.session(id);
        if (current.runtimeSessionId) recovery.runtimeIds.add(current.runtimeSessionId);
        await assertHermesPolicy(this.adapter);
        if (this.closed) throw new Error('工作台已关闭。');
        let snapshot;
        if (current.runtimeSessionId) {
          snapshot = await this.adapter.request('session.activate', { session_id: current.runtimeSessionId });
        } else if (!current.hasPrompted && !this.store.runs(id).length) {
          // Hermes does not persist an empty session until its first prompt.
          if (!current.provider || !current.model) throw new Error('此旧空会话未记录模型，无法安全恢复，请新建任务。');
          snapshot = await this.adapter.request('session.create', { cwd: current.cwd, source: 'tui', title: current.title,
            provider: current.provider, model: current.model });
        } else {
          try {
            const managed = this.workflows.ownsSession(id) || this.learningModel.ownsSession(id) || this.assistantModel.ownsSession(id);
            snapshot = await this.adapter.request('session.resume', { session_id: current.storedSessionId, source: 'tui',
              ...(managed ? { lazy: true } : {}) });
            if (managed) {
              if (snapshot.info?.lazy !== true) throw new Error('Hermes 未确认托管历史的只读恢复，已停止恢复。');
              this.historyOnlyRuntimes.add(snapshot.session_id);
            }
          } catch (error) {
            // A first submission can fail before Hermes persists the empty session.
            // Only a definitive not-found and no accepted turn permits recreating it.
            if (error.code !== 4007 || current.hasPrompted) throw error;
            if (!current.provider || !current.model) throw new Error('此旧会话未记录模型，无法安全重建，请新建任务。');
            snapshot = await this.adapter.request('session.create', { cwd: current.cwd, source: 'tui', title: current.title,
              provider: current.provider, model: current.model });
          }
        }
        recovery.runtimeIds.add(snapshot.session_id);
        if (this.closed) throw new Error('工作台已关闭。');
        await this.configureSession(snapshot, current.provider && current.model ? current : undefined);
        if (this.closed) throw new Error('工作台已关闭。');
        if (this.adapter.state !== 'ready') throw new Error('Hermes 连接已断开，请重新连接后恢复。');
        const latestRun = this.store.runs(id).at(-1);
        const idleStatus = ['complete', 'error', 'interrupted', 'unknown'].includes(latestRun?.status)
          ? latestRun.status : 'idle';
        this.updateSession(id, { runtimeSessionId: snapshot.session_id,
          model: snapshot.info.model || current.model, provider: snapshot.info.provider || current.provider,
          storedSessionId: snapshot.stored_session_id || current.storedSessionId,
          status: snapshot.inflight?.streaming || snapshot.running ? 'running' : idleStatus });
        this.observeUsage(id, snapshot.info.usage, 'session.resume');
        for (const request of snapshot.open_requests || []) {
          if (!['approval', 'clarify'].includes(request.method)) continue;
          const frame = { jsonrpc: '2.0', id: request.id, method: request.method,
            params: { ...request.params, session_id: snapshot.session_id } };
          this.adapter.serverRequests.set(String(frame.id), frame);
          this.onRequest(frame, true);
        }
        // Hermes can continue a turn before its resume response reaches us. Apply its
        // snapshot first, then the retained live frames, so an older snapshot cannot
        // overwrite a completion or a still-open question.
        const frames = this.resumeFrames.filter(frame => recovery.runtimeIds.has(frame.runtimeId));
        this.resumeFrames = this.resumeFrames.filter(frame => !recovery.runtimeIds.has(frame.runtimeId));
        for (const frame of frames) {
          if (frame.kind === 'event') this.onGatewayEvent(frame.value, true);
          else this.onRequest(frame.value, true);
        }
        const session = this.session(id);
        const running = ['running', 'waiting'].includes(session.status);
        snapshot.running = running;
        snapshot.inflight = running && snapshot.inflight ? { ...snapshot.inflight, streaming: true } : null;
        snapshot.open_requests = [...this.requests.values()].filter(request => request.sessionId === id)
          .map(({ id, method, params }) => ({ id, method, params }));
        return { session, snapshot };
      } finally {
        this.resumes.delete(id);
        this.resumeFrames = this.resumeFrames.filter(frame => !recovery.runtimeIds.has(frame.runtimeId));
        if (!this.resumes.size) this.resumeFrames = [];
      }
    })();
    return recovery.promise;
  }

  async runtime(id) {
    let session = this.session(id);
    if (!session.runtimeSessionId) session = (await this.resume(id)).session;
    return session;
  }

  async history(id) {
    const session = await this.runtime(id);
    const history = await this.adapter.request('session.history', { session_id: session.runtimeSessionId });
    return { messages: history.messages || [], info: this.sessionInfo.get(session.runtimeSessionId) || {} };
  }

  async submit(id, text, { workflowRunId, learningRequestId, assistantRequestId } = {}) {
    this.checkReady();
    if (this.workflows.ownsSession(id) && !this.workflows.allowsSubmit(id, workflowRunId)) {
      throw Object.assign(new Error('这是工作流的固定运行会话。请回到工作流页面发起新的执行；此处保留历史、审批和停止操作。'), { httpStatus: 409 });
    }
    if (this.learningModel.ownsSession(id) && !this.learningModel.allowsSubmit(id, learningRequestId)) {
      throw Object.assign(new Error('这是学习控制会话，只能从学习面板发起评价或调整；此处可查看历史。'), { httpStatus: 409 });
    }
    if (this.assistantModel.ownsSession(id) && !this.assistantModel.allowsSubmit(id, assistantRequestId)) {
      throw Object.assign(new Error('这是应用对话的受限控制会话，请从右侧对话继续。'), { httpStatus: 409 });
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 200000) throw new Error('请输入有效消息（最多 200000 字符）。');
    if (this.busyMutations.has(id)) throw Object.assign(new Error('此会话正在提交，请稍候。'), { httpStatus: 409 });
    this.busyMutations.add(id);
    try {
      await assertHermesPolicy(this.adapter);
      const session = await this.runtime(id);
      // Stop or shutdown can happen while policy checks/session recovery await.
      // Recheck immediately before committing and submitting the prompt.
      this.checkReady();
      if (this.workflows.ownsSession(id) && !this.workflows.allowsSubmit(id, workflowRunId)) {
        throw Object.assign(new Error('工作流已停止或不再接受此节点的提交。'), { httpStatus: 409 });
      }
      if (this.learningModel.ownsSession(id) && !this.learningModel.allowsSubmit(id, learningRequestId)) {
        throw Object.assign(new Error('学习模型调用已停止或不再接受提交。'), { httpStatus: 409 });
      }
      if (this.assistantModel.ownsSession(id) && !this.assistantModel.allowsSubmit(id, assistantRequestId)) throw Object.assign(new Error('应用诊断已停止，未提交。'), { httpStatus: 409 });
      if (['running', 'waiting'].includes(session.status)) throw Object.assign(new Error('此会话正在执行；请等待或停止后再发送。'), { httpStatus: 409 });
      this.store.beginRun(id);
      this.publish('session.updated', id, this.store.get(id));
      try {
        const result = await this.adapter.request('prompt.submit', { session_id: session.runtimeSessionId, text });
        if (result.status === 'streaming') this.updateSession(id, { hasPrompted: true });
        return result;
      } catch (error) {
        // A completion can precede the submit ACK on the same protocol stream.
        // Never overwrite its confirmed terminal state with a later ACK failure.
        if (['running', 'waiting'].includes(this.store.get(id)?.status)) {
          this.store.finishRun(id, 'unknown', redact(error.message));
          this.updateSession(id, { status: 'unknown' });
        }
        throw error;
      }
    } finally { this.busyMutations.delete(id); }
  }

  async interrupt(id) {
    const session = this.session(id);
    if (!session.runtimeSessionId) throw new Error('会话未连接。');
    // Native interrupt calls _sess(), which would build an unguarded agent for
    // a cold, lazy history and later commit its old validation messages to memory.
    // A confirmed history-only runtime has no live turn to interrupt.
    if (this.historyOnlyRuntimes.has(session.runtimeSessionId)) return { interrupted: false, historyOnly: true };
    return this.adapter.request('session.interrupt', { session_id: session.runtimeSessionId });
  }

  onGatewayEvent(event, replaying = false) {
    if (this.closed) return;
    const session = event.session_id ? this.store.byRuntime(event.session_id) : null;
    if (!replaying && event.session_id && this.resumes.size && (!session
      || [...this.resumes.values()].some(recovery => recovery.id === session.id || recovery.runtimeIds.has(event.session_id)))) {
      this.resumeFrames.push({ kind: 'event', runtimeId: event.session_id, value: event });
      return;
    }
    if (event.session_id && !session) return;
    const payload = event.payload || {};
    if (session && ['session.info', 'session.usage', 'message.complete'].includes(event.type)) {
      this.observeUsage(session.id, payload.usage, event.type, event.type === 'message.complete');
    }
    if (session && event.type === 'session.info') this.sessionInfo.set(event.session_id, infoView(payload));
    if (session && event.type === 'message.start') this.updateSession(session.id, { status: 'running', hasPrompted: true });
    if (session && event.type === 'message.complete') {
      const successful = payload.status === 'complete' && !payload.error && !payload.partial;
      const status = successful ? 'complete' : payload.status === 'interrupted' ? 'interrupted' : 'error';
      this.store.finishRun(session.id, status, redact(payload.error || payload.failure_reason || ''), payload.status || 'unconfirmed');
      this.updateSession(session.id, { status });
      this.clearSessionRequests(session.id);
    }
    if (event.type === 'request.cancel') {
      this.requests.delete(String(payload.id));
      this.adapter.serverRequests.delete(String(payload.id));
    }
    if (session && event.type === 'error') {
      this.store.finishRun(session.id, 'error', redact(payload.message || 'Hermes 错误'));
      this.updateSession(session.id, { status: 'error' });
      this.clearSessionRequests(session.id);
    }
    this.publish(event.type, session?.id || null, payload);
  }

  observeUsage(sessionId, usage, source, final = false) {
    try { return this.sessionUsage?.observe(sessionId, usage, { source, final }) || null; }
    catch { return null; /* A telemetry read/write never changes execution outcomes. */ }
  }

  onRequest(frame, replaying = false) {
    if (this.closed) return;
    const session = this.store.byRuntime(frame.params?.session_id);
    if (!replaying && frame.params?.session_id && this.resumes.size && (!session
      || [...this.resumes.values()].some(recovery => recovery.id === session.id || recovery.runtimeIds.has(frame.params.session_id)))) {
      this.resumeFrames.push({ kind: 'request', runtimeId: frame.params.session_id, value: frame });
      return;
    }
    if (!session) return;
    const request = { id: String(frame.id), method: frame.method, sessionId: session.id, params: frame.params };
    if (this.requests.has(request.id)) {
      this.updateSession(session.id, { status: 'waiting' });
      return;
    }
    this.adapter.serverRequests.set(request.id, frame);
    this.requests.set(request.id, request);
    this.updateSession(session.id, { status: 'waiting' });
    this.publish('request.open', session.id, request);
  }

  reply(id, result) {
    const request = this.requests.get(id);
    if (!request) throw Object.assign(new Error('请求已失效。'), { httpStatus: 409 });
    if (this.store.get(request.sessionId)?.status !== 'waiting') {
      this.clearSessionRequests(request.sessionId);
      throw Object.assign(new Error('该运行已结束，交互请求已失效。'), { httpStatus: 409 });
    }
    const response = this.adapter.reply(id, result);
    this.requests.delete(id);
    this.publish('request.cancel', request.sessionId, { id });
    this.updateSession(request.sessionId, { status: [...this.requests.values()].some(item => item.sessionId === request.sessionId) ? 'waiting' : 'running' });
    return response;
  }

  clearSessionRequests(sessionId) {
    for (const [id, request] of this.requests) {
      if (request.sessionId !== sessionId) continue;
      this.requests.delete(id); this.adapter.serverRequests.delete(id);
      this.publish('request.cancel', sessionId, { id });
    }
  }

  async close() {
    if (this.closed) return;
    this.logEvents.write('info', 'application.stopping', { component: 'application' });
    this.historicalUsage?.close?.();
    await this.conversations.close();
    await this.applicationAssistant.close();
    await this.assistantModel.close();
    await this.diagnosticBrowser.close?.();
    await this.schedules.close();
    await this.learning.close();
    await this.learningModel.close();
    await this.workflows.close();
    await Promise.allSettled(this.store.list().filter(s => s.runtimeSessionId && !this.historyOnlyRuntimes.has(s.runtimeSessionId)
      && ['running', 'waiting'].includes(s.status))
      .map(s => this.adapter.request('session.interrupt', { session_id: s.runtimeSessionId }, 1500)));
    this.closed = true;
    await this.adapter.stop();
    this.logEvents.write('info', 'application.stopped', { component: 'application', status: 'stopped' });
    this.logEvents.close();
    this.logger?.close();
    this.store.close();
  }
}
