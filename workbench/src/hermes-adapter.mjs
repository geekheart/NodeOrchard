import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { delimiter, join } from 'node:path';

export function redact(value) {
  return String(value)
    .replace(/\b(?:sk-[\w-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:access_token|refresh_token|api_key|authorization)\s*[=:]\s*)[^\s,}]+/gi, '$1[REDACTED]');
}

export class HermesAdapter extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.state = 'stopped';
    this.pending = new Map();
    this.serverRequests = new Map();
    this.nextId = 0;
    this.log = [];
    this.stopping = false;
  }

  setState(state, lastError = '') {
    this.state = state;
    this.lastError = lastError;
    this.emit('state', { state, lastError });
  }

  async start() {
    if (this.state === 'ready') return;
    if (this.starting) return this.starting;
    this.starting = this.#start();
    try { await this.starting; } finally { this.starting = null; }
  }

  async #start() {
    this.stopping = false;
    this.setState('starting');
    const c = this.config;
    const env = {
      ...process.env,
      ...c.childEnv,
      PYTHONDONTWRITEBYTECODE: '1',
      HERMES_HOME: c.hermesHome,
      HERMES_PYTHON_SRC_ROOT: c.hermesRoot,
      PYTHONPATH: [c.hermesRoot, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
      HERMES_YOLO_MODE: '0',
      HERMES_DISABLE_LAZY_INSTALLS: '1',
      WORKBENCH_GATEWAY_WORKSPACE_ROOT: c.workspaceRoot,
    };
    delete env.HERMES_TUI_SIDECAR_URL;
    // Hermes config owns the model; inherited launch overrides must not shadow
    // a model selection saved through Hermes from the top-level picker.
    delete env.HERMES_MODEL;
    delete env.HERMES_INFERENCE_MODEL;
    delete env.HERMES_TUI_PROVIDER;
    delete env.HERMES_INFERENCE_PROVIDER;
    this.proc = spawn(c.command || c.hermesPython, c.args || [join(c.appRoot, 'python/workflow_gateway.py')], {
      cwd: c.cwd || c.appRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const proc = this.proc;
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Hermes 启动超时，请检查安装和日志。')), c.readyTimeout || 45000);
      const onReady = () => finish();
      const onExit = () => finish(new Error(this.lastError || 'Hermes 在就绪前退出。'));
      const finish = (error) => {
        clearTimeout(timeout);
        this.off('gateway-ready', onReady);
        proc.off('exit', onExit);
        proc.off('error', finish);
        error ? reject(error) : resolve();
      };
      this.once('gateway-ready', onReady);
      proc.once('exit', onExit);
      proc.once('error', finish);
    });
    this.stdout = createInterface({ input: proc.stdout });
    this.stdout.on('line', (line) => this.handleLine(line));
    this.stderr = createInterface({ input: proc.stderr });
    this.stderr.on('line', (line) => {
      this.log.push(redact(line).slice(0, 2000));
      if (this.log.length > 60) this.log.shift();
    });
    proc.on('error', (error) => this.setState('error', redact(error.message)));
    proc.on('exit', (code, signal) => {
      if (this.proc === proc) this.proc = null;
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('Hermes 连接已断开；不会自动重复提交任务。'));
      }
      this.pending.clear();
      this.serverRequests.clear();
      this.setState(this.stopping ? 'stopped' : 'disconnected', this.stopping ? '' : `Hermes 已退出 (${signal || code})。可重新连接并恢复会话。`);
    });
    try {
      await ready;
      await this.request('client.capabilities', { server_requests: true });
      this.setState('ready');
    } catch (error) {
      await this.stop();
      this.setState('error', redact(error.message));
      throw error;
    }
  }

  handleLine(line) {
    let frame;
    try { frame = JSON.parse(line); } catch {
      this.log.push('[protocol] 忽略非 JSON 输出。');
      if (this.log.length > 60) this.log.shift();
      return;
    }
    if (frame.method === 'event') {
      const event = frame.params || {};
      if (event.type === 'gateway.ready') this.emit('gateway-ready');
      if (event.type === 'request.cancel') this.serverRequests.delete(event.payload?.id);
      this.emit('event', event);
      return;
    }
    if (frame.method && frame.id !== undefined) {
      if (!['approval', 'clarify'].includes(frame.method)) {
        this.send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: '此客户端尚未实现该交互，请使用 Hermes 原生界面。' } });
        return;
      }
      this.serverRequests.set(String(frame.id), frame);
      this.emit('request', frame);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.error) {
      const error = new Error(redact(frame.error.message || 'Hermes RPC failed'));
      error.code = frame.error.code;
      pending.reject(error);
    } else pending.resolve(frame.result);
  }

  send(frame) {
    if (!this.proc?.stdin?.writable) throw new Error('Hermes 尚未连接。');
    this.proc.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  request(method, params = {}, timeout = 45000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时；执行结果可能尚未确认，请先恢复会话检查。`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  reply(id, result) {
    const frame = this.serverRequests.get(String(id));
    if (!frame) throw new Error('交互请求已失效，请刷新会话。');
    if (frame.method === 'approval') {
      if (!['once', 'deny'].includes(result?.choice)) throw new Error('第一版只支持本次允许或拒绝。');
      if (frame.params?.choices?.length && !frame.params.choices.includes(result.choice)) throw new Error('Hermes 未提供此审批选项。');
      result = { choice: result.choice };
    } else if (frame.method === 'clarify') {
      if (Array.isArray(frame.params?.questions)) {
        if (!result?.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)) throw new Error('需要按问题编号回答。');
        const valid = new Set(frame.params.questions.map(q => q.qid));
        result = { answers: Object.fromEntries(Object.entries(result.answers).filter(([key, value]) => valid.has(key) && typeof value === 'string')) };
      } else {
        if (typeof result?.answer !== 'string') throw new Error('需要文字回答。');
        result = { answer: result.answer };
      }
    }
    this.send({ jsonrpc: '2.0', id: frame.id, result });
    this.serverRequests.delete(String(id));
    return { accepted: true };
  }

  async stop() {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    proc.stdin.end();
    await new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); clearTimeout(hard); resolve(); } };
      const kill = signal => {
        try { process.platform === 'win32' ? proc.kill(signal) : process.kill(-proc.pid, signal); } catch {}
      };
      const timer = setTimeout(() => kill('SIGTERM'), 2500);
      const hard = setTimeout(() => { kill('SIGKILL'); finish(); }, 4500);
      proc.once('exit', finish);
      if (proc.exitCode !== null || proc.signalCode !== null) finish();
    });
    this.stdout?.close();
    this.stderr?.close();
  }
}
