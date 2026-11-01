import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, delimiter } from 'node:path';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { supervisorPython } from '../supervisor-profile.mjs';
import { redact } from '../hermes-adapter.mjs';

// Hermes owns due-time calculation, native job claims and its execution ledger.
// Only typed fire receipts cross this interface; workflow data stays in SQLite.
export class HermesWorkflowScheduler extends EventEmitter {
  constructor(config, { resolvePython = supervisorPython, spawnProcess = spawn, pollMs = 1000 } = {}) {
    super(); this.config = config; this.resolvePython = resolvePython; this.spawnProcess = spawnProcess;
    this.pollMs = pollMs; this.pending = new Map(); this.nextId = 0; this.closed = false;
    this.state = { engine: 'hermes-native', status: 'stopped' };
  }
  status() { return { ...this.state }; }
  async start() {
    if (this.closed) throw new Error('原生定时已关闭。');
    if (this.state.status === 'ready') return;
    if (this.starting) return this.starting;
    this.starting = this.open();
    try { await this.starting; }
    catch (error) { try { this.child?.kill('SIGTERM'); } catch {} this.disconnected(error); throw error; }
    finally { this.starting = null; }
  }
  async open() {
    this.state = { engine: 'hermes-native', status: 'starting' };
    const root = join(this.config.dataDir, 'native-workflow-schedules');
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('原生定时目录必须为真实私有目录。');
    const { python } = await this.resolvePython(this.config);
    if (this.closed) throw new Error('原生定时启动已取消。');
    const child = this.spawnProcess(python, [join(this.config.appRoot, 'python/workflow_scheduler.py'), root, String(this.pollMs)], {
      cwd: this.config.appRoot, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH || '', HOME: root, HERMES_HOME: root,
        PYTHONPATH: [this.config.hermesRoot, join(this.config.appRoot, 'python')].join(delimiter),
        HERMES_PYTHON_SRC_ROOT: this.config.hermesRoot, PYTHONDONTWRITEBYTECODE: '1', HERMES_DISABLE_LAZY_INSTALLS: '1',
        HERMES_YOLO_MODE: '0', HERMES_ENABLE_PROJECT_PLUGINS: '0' },
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      let frame; try { frame = JSON.parse(line); } catch { return; }
      if (frame.event === 'fire') { this.emit('fire', frame.value); return; }
      if (frame.event === 'advance') { this.emit('advance', frame.value); return; }
      if (frame.event === 'unavailable') { this.state = { engine: 'hermes-native', status: 'unavailable', error: 'Hermes 原生定时扫描失败；未降级或重放。' }; this.emit('state', this.status()); return; }
      const request = this.pending.get(frame.id); if (!request) return;
      this.pending.delete(frame.id); clearTimeout(request.timer);
      frame.error ? request.reject(new Error(redact(frame.error).slice(0, 1000))) : request.resolve(frame.result);
    });
    this.errors = createInterface({ input: child.stderr });
    this.errors.on('line', () => {}); // Protocol failures report typed errors; do not retain native diagnostics/paths.
    child.once('error', error => this.disconnected(error));
    child.once('exit', () => this.disconnected(new Error('Hermes 原生定时进程已断开；未重放触发。')));
    await this.request('status', {});
    if (this.closed) throw new Error('原生定时启动已取消。');
    this.state = { engine: 'hermes-native', status: 'ready' }; this.emit('state', this.status());
  }
  disconnected(error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.state = { engine: 'hermes-native', status: this.closed ? 'stopped' : 'unavailable', error: redact(error.message).slice(0, 500) };
    this.emit('state', this.status());
  }
  request(method, params) {
    if (this.closed || !this.child?.stdin.writable) return Promise.reject(new Error('Hermes 原生定时不可用。'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Hermes 原生定时回执未确认；未自动重试。')); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async sync(schedules) { await this.start(); return this.request('sync', { schedules }); }
  async poll() { await this.start(); return this.request('tick', {}); }
  async finish(fire, result) { if (this.closed) return; return this.request('finish', { executionId: fire.executionId, ...result }); }
  async close() {
    if (this.closed) return; this.closed = true;
    const child = this.child; this.child = null;
    this.disconnected(new Error('原生定时已关闭。'));
    if (!child) return;
    child.stdin.end();
    await new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} finish(); }, 2000);
      child.once('exit', finish); if (child.exitCode !== null) finish();
    });
    this.lines?.close(); this.errors?.close();
  }
}
