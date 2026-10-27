import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Application } from './application.mjs';
import { redact } from './hermes-adapter.mjs';

async function readJson(req, limit = 1000000) {
  const chunks = []; let bytes = 0, oversized = false;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > limit) { oversized = true; chunks.length = 0; }
    if (!oversized) chunks.push(part);
  }
  // Finish consuming an oversized request before replying. Throwing out of the
  // async iterator destroys its socket and can hide the HTTP 413 from clients.
  if (oversized) throw Object.assign(new Error('请求过大。'), { httpStatus: 413 });
  // HTTP chunks may split a multibyte UTF-8 character. Decode only after joining.
  const body = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(body || '{}'); }
  catch { throw Object.assign(new Error('无效的 JSON。'), { httpStatus: 400 }); }
}

export function createWorkbenchServer(config, application = new Application(config)) {
  const csrfToken = randomBytes(24).toString('hex');
  const clients = new Set();
  const publicEvent = event => !event.sessionId || !application.assistantModel?.ownsSession(event.sessionId);
  const json = (res, code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: '无效的主机地址。' });
      if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: '禁止跨站请求。' });
      const requestURL = new URL(req.url, origin);
      const path = requestURL.pathname;
      if (req.method === 'POST') {
        const token = Buffer.from(req.headers['x-workbench-token'] || '');
        const expected = Buffer.from(csrfToken);
        if (token.length !== expected.length || !timingSafeEqual(token, expected)) return json(res, 403, { error: '客户端校验失败，请刷新页面。' });
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要 application/json。' });
      }
      if (req.method === 'GET' && path === '/api/bootstrap') return json(res, 200, { ...application.bootstrap(), eventCursor: application.sequence, csrfToken });
      if (req.method === 'GET' && path === '/api/app-capabilities') {
        if ([...requestURL.searchParams.keys()].some(key => !['section', 'schemaVersion'].includes(key))
          || [...new Set(requestURL.searchParams.keys())].some(key => requestURL.searchParams.getAll(key).length > 1)) return json(res, 400, { error: '能力目录查询参数无效。' });
        const schemaVersion = requestURL.searchParams.get('schemaVersion');
        if (schemaVersion !== null && !['1', '2'].includes(schemaVersion)) return json(res, 400, { error: '能力目录版本无效。' });
        return json(res, 200, await application.applicationAssistant.capabilities.read('app.capabilities', {
          ...(requestURL.searchParams.has('section') ? { section: requestURL.searchParams.get('section') } : {}),
          ...(schemaVersion !== null ? { schemaVersion: Number(schemaVersion) } : {}),
        }));
      }
      if (req.method === 'GET' && path === '/api/app-assistant') return json(res, 200, application.applicationAssistant.get());
      if (req.method === 'POST' && path === '/api/app-assistant/messages') return json(res, 202, await application.applicationAssistant.message(await readJson(req, 100000)));
      const assistantAction = path.match(/^\/api\/app-assistant\/turns\/([A-Za-z0-9_-]+)\/action$/);
      if (req.method === 'POST' && assistantAction) return json(res, 200, application.applicationAssistant.action(assistantAction[1], await readJson(req, 4096)));
      const diagnosticCapture = path.match(/^\/api\/app-diagnostics\/captures\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/);
      if (req.method === 'GET' && diagnosticCapture) {
        const file = await application.applicationAssistant.captureFile(diagnosticCapture[1], diagnosticCapture[2]);
        const content = await readFile(file.path);
        res.writeHead(200, { 'Content-Type': file.mimeType, 'Cache-Control': 'no-store', 'Content-Length': content.length });
        return res.end(content);
      }
      if (req.method === 'GET' && path === '/api/settings') return json(res, 200, await application.settings());
      if (req.method === 'POST' && path === '/api/settings') return json(res, 200, await application.saveSettings(await readJson(req)));
      if (req.method === 'GET' && path === '/api/models') return json(res, 200, await application.modelOptions());
      if (req.method === 'POST' && path === '/api/models') return json(res, 200, await application.selectModel(await readJson(req, 4096)));
      if (req.method === 'GET' && path === '/api/statistics') {
        const days = requestURL.searchParams.get('days') || '7';
        if (!['7', '30'].includes(days)) return json(res, 400, { error: '统计周期只支持 7 天或 30 天。' });
        return json(res, 200, await application.statistics(Number(days)));
      }
      if (req.method === 'GET' && path === '/api/skills') return json(res, 200, await application.skills());
      const skillMatch = path.match(/^\/api\/skills\/([^/]+)$/);
      if (req.method === 'GET' && skillMatch) return json(res, 200, await application.skill(decodeURIComponent(skillMatch[1])));
      if (req.method === 'GET' && path === '/api/events') {
        const cursor = req.headers['last-event-id'] ?? requestURL.searchParams.get('after');
        const hasCursor = cursor !== null && cursor !== undefined;
        const lastId = hasCursor ? Number(cursor) : 0;
        if (hasCursor && (!/^\d+$/.test(String(cursor)) || !Number.isSafeInteger(lastId))) {
          return json(res, 400, { error: '无效的事件游标。' });
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        if (hasCursor) for (const event of application.events.filter(e => e.id > lastId && publicEvent(e))) res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && path === '/api/connect') { await readJson(req); return json(res, 200, await application.connect()); }
      if (path === '/api/workflow-node-presets' && requestURL.search) return json(res, 400, { error: '节点预设列表或创建请求不能包含查询参数。' });
      if (req.method === 'GET' && path === '/api/workflow-node-presets') return json(res, 200, { presets: application.nodePresets.list() });
      if (req.method === 'POST' && path === '/api/workflow-node-presets') return json(res, 201, { preset: application.nodePresets.create(await readJson(req, 2 * 1024 * 1024 + 8192)) });
      const nodePresetMatch = path.match(/^\/api\/workflow-node-presets\/([^/]+)$/);
      if (nodePresetMatch) {
        const id = decodeURIComponent(nodePresetMatch[1]);
        if (req.method === 'GET') {
          const keys = [...requestURL.searchParams.keys()];
          const version = requestURL.searchParams.get('version');
          if (keys.some(key => key !== 'version') || requestURL.searchParams.getAll('version').length > 1 || (version !== null && !/^[1-9]\d*$/.test(version))) return json(res, 400, { error: '节点预设版本查询无效。' });
          return json(res, 200, { preset: application.nodePresets.get(id, version === null ? {} : { version: Number(version) }) });
        }
        if (req.method === 'POST') {
          if (requestURL.search) return json(res, 400, { error: '保存预设不能包含查询参数。' });
          return json(res, 200, { preset: application.nodePresets.update(id, await readJson(req, 2 * 1024 * 1024 + 8192)) });
        }
      }
      const conversationMatch = path.match(/^\/api\/workflow-conversations\/([^/]+)(?:\/(messages|turns\/([^/]+)\/action))?$/);
      if (conversationMatch) {
        if (requestURL.search) return json(res, 400, { error: '工作流对话不接受查询参数。' });
        let workflowId, turnId;
        try { workflowId = decodeURIComponent(conversationMatch[1]); turnId = conversationMatch[3] ? decodeURIComponent(conversationMatch[3]) : null; }
        catch { return json(res, 400, { error: '无效的工作流对话 ID。' }); }
        if (req.method === 'GET' && !conversationMatch[2]) return json(res, 200, application.conversations.get(workflowId));
        if (req.method === 'POST' && conversationMatch[2] === 'messages') return json(res, 202,
          await application.conversations.message(workflowId, await readJson(req, 2 * 1024 * 1024 + 32768)));
        if (req.method === 'POST' && turnId) return json(res, 200,
          await application.conversations.action(workflowId, turnId, await readJson(req, 2 * 1024 * 1024 + 32768)));
      }
      if (req.method === 'GET' && path === '/api/workflow-library') return json(res, 200, { workflows: application.workflowLibrary.list({ lifecycle: requestURL.searchParams.get('lifecycle') ?? 'active' }) });
      if (req.method === 'POST' && path === '/api/workflow-library') return json(res, 200, { workflow: application.workflowLibrary.save(await readJson(req, 2 * 1024 * 1024 + 65536)) });
      const lifecycleMatch = path.match(/^\/api\/workflow-library\/([^/]+)\/(archive|unarchive|trash|restore|purge)$/);
      if (req.method === 'POST' && lifecycleMatch) {
        let id;
        try { id = decodeURIComponent(lifecycleMatch[1]); } catch { return json(res, 400, { error: '无效的工作流 ID。' }); }
        return json(res, 200, application.workflowLibrary.transition(id, lifecycleMatch[2], await readJson(req, 8192)));
      }
      const libraryMatch = path.match(/^\/api\/workflow-library\/([^/]+)$/);
      if (req.method === 'GET' && libraryMatch) {
        let id;
        try { id = decodeURIComponent(libraryMatch[1]); } catch { return json(res, 400, { error: '无效的工作流 ID。' }); }
        return json(res, 200, { workflow: application.workflowLibrary.get(id) });
      }
      if (req.method === 'GET' && path === '/api/workflow-schedules') {
        return json(res, 200, { schedules: application.schedules.list(requestURL.searchParams.get('workflowId') || undefined) });
      }
      if (req.method === 'POST' && path === '/api/workflow-schedules') {
        return json(res, 201, { schedule: application.schedules.create(await readJson(req)) });
      }
      const scheduleMatch = path.match(/^\/api\/workflow-schedules\/([^/]+)(\/(enabled|delete))?$/);
      if (scheduleMatch) {
        let id;
        try { id = decodeURIComponent(scheduleMatch[1]); }
        catch { return json(res, 400, { error: '无效的定时任务 ID。' }); }
        if (req.method === 'GET' && !scheduleMatch[2]) return json(res, 200, { schedule: application.schedules.get(id) });
        if (req.method === 'POST' && !scheduleMatch[2]) return json(res, 200, { schedule: application.schedules.update(id, await readJson(req)) });
        if (req.method === 'POST' && scheduleMatch[3] === 'enabled') {
          const body = await readJson(req);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') {
            return json(res, 400, { error: '请只提供 enabled 布尔值。' });
          }
          return json(res, 200, { schedule: application.schedules.setEnabled(id, body.enabled) });
        }
        if (req.method === 'POST' && scheduleMatch[3] === 'delete') {
          const body = await readJson(req);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return json(res, 400, { error: '删除定时任务不接受其它字段。' });
          return json(res, 200, application.schedules.remove(id));
        }
      }
      if (req.method === 'GET' && path === '/api/workflow-learning') {
        return json(res, 200, { learnings: application.learning.list(requestURL.searchParams.get('workflowId') || undefined) });
      }
      if (req.method === 'POST' && path === '/api/workflow-learning') {
        return json(res, 202, await application.learning.start(await readJson(req)));
      }
      const learningMatch = path.match(/^\/api\/workflow-learning\/([^/]+)(\/(interrupt|apply|apply-feedback))?$/);
      if (learningMatch) {
        const id = decodeURIComponent(learningMatch[1]);
        if (req.method === 'GET' && !learningMatch[2]) return json(res, 200, application.learning.get(id));
        if (req.method === 'POST' && learningMatch[3] === 'interrupt') {
          await readJson(req); return json(res, 200, await application.learning.interrupt(id));
        }
        if (req.method === 'POST' && learningMatch[3] === 'apply') {
          await readJson(req);
          const learning = application.learning.get(id);
          application.workflowLibrary.assertRunnable(learning.workflowId);
          if (learning.kind === 'feedback') return json(res, 409, { error: '反馈学习生成的是待验证候选，请使用反馈候选应用入口。' });
          if (['running', 'waiting'].includes(learning.status)) return json(res, 409, { error: '请先等待学习结束或停止，再应用已验证版本。' });
          if (!learning.bestDocument || !learning.rounds.some(round => round.index === learning.bestRound && round.status === 'complete')) {
            return json(res, 409, { error: '没有已验证的最佳版本可应用。' });
          }
          for (const node of learning.bestDocument.nodes.filter(node => node.type === 'skill')) {
            const skill = await application.skill(node.config.skillRef);
            if (skill.revision !== node.config.version) return json(res, 409, { error: 'Skill 来源版本已变化，请重新学习后应用。' });
          }
          await application.learnedSkills.publish(learning.bestDocument, { beforePublish: () => application.workflowLibrary.assertRunnable(learning.workflowId) });
          return json(res, 200, { document: learning.bestDocument, learningId: id, round: learning.bestRound, score: learning.bestScore });
        }
        if (req.method === 'POST' && learningMatch[3] === 'apply-feedback') {
          const body = await readJson(req);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
            return json(res, 400, { error: '应用反馈候选不接受其它字段。' });
          }
          return json(res, 200, await application.learning.applyFeedback(id));
        }
      }
      if (req.method === 'GET' && path === '/api/workflow-runs') {
        return json(res, 200, { runs: application.workflows.list(requestURL.searchParams.get('workflowId') || undefined) });
      }
      if (req.method === 'POST' && path === '/api/workflow-runs') {
        return json(res, 202, await application.workflows.start(await readJson(req)));
      }
      if (req.method === 'POST' && path === '/api/workflow-v2/preflight') {
        return json(res, 200, await application.workflowFiles.preflight(await readJson(req, 2 * 1024 * 1024 + 65536)));
      }
      if (req.method === 'GET' && path === '/api/workflow-v2/files') {
        return json(res, 200, await application.workflowFiles.browse({
          directory: requestURL.searchParams.get('directory') || undefined,
          kind: requestURL.searchParams.get('kind') || 'file', extensions: requestURL.searchParams.get('extensions') || '',
        }));
      }
      if (req.method === 'POST' && path === '/api/workflow-v2/open-directory') {
        return json(res, 200, await application.workflowFiles.openRunDirectory(await readJson(req)));
      }
      if (req.method === 'GET' && path === '/api/workflow-v2/queue') {
        return json(res, 200, application.workflows.queueStatus());
      }
      const artifactMatch = path.match(/^\/api\/workflow-v2\/artifacts\/([^/]+)$/);
      if (req.method === 'GET' && artifactMatch) {
        if (req.headers['x-nodeorchard-diagnostic'] === 'readonly') {
          const artifact = application.workflowFiles.getArtifact(decodeURIComponent(artifactMatch[1]));
          const run = application.workflows.get(artifact.runId);
          if (run.learningId || run.memoryScopeId || run.document?.mode === 'learn') return json(res, 403, { error: '诊断截图不能读取学习与验证样本产物。' });
        }
        const { record, data } = await application.workflowFiles.readArtifact(decodeURIComponent(artifactMatch[1]));
        const download = requestURL.searchParams.get('download') === '1' || !/^(image\/|application\/pdf|text\/plain|application\/json)/.test(record.mimeType);
        res.writeHead(200, { 'Content-Type': record.mimeType, 'Content-Length': data.length, 'Cache-Control': 'no-store',
          'Content-Disposition': (download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(record.name),
          'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" });
        return res.end(data);
      }
      const workflowPublish = path.match(/^\/api\/workflow-runs\/([^/]+)\/publish$/);
      if (req.method === 'POST' && workflowPublish) {
        const body = await readJson(req);
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) return json(res, 400, { error: '交付重试不接受额外参数。' });
        return json(res, 200, { run: await application.workflows.publishDelivery(decodeURIComponent(workflowPublish[1])) });
      }
      const workflowReview = path.match(/^\/api\/workflow-runs\/([^/]+)\/(review|rerun)$/);
      if (req.method === 'POST' && workflowReview) {
        const id = decodeURIComponent(workflowReview[1]);
        const body = await readJson(req);
        return json(res, 202, workflowReview[2] === 'review'
          ? await application.workflows.approve(id, body) : await application.workflows.rerun(id, body));
      }
      const workflowFeedback = path.match(/^\/api\/workflow-runs\/([^/]+)\/feedback(\/learn)?$/);
      if (workflowFeedback) {
        let id;
        try { id = decodeURIComponent(workflowFeedback[1]); }
        catch { return json(res, 400, { error: '无效的运行 ID。' }); }
        if (req.method === 'GET' && !workflowFeedback[2]) return json(res, 200, application.feedback.get(id));
        if (req.method === 'POST' && !workflowFeedback[2]) {
          return json(res, 200, { feedback: application.feedback.save(id, await readJson(req)) });
        }
        if (req.method === 'POST' && workflowFeedback[2]) {
          const record = application.feedback.learningRequest(id, await readJson(req));
          return json(res, 202, await application.learning.startFeedback({ runId: id, feedbackRevision: record.revision }));
        }
      }
      const workflowRun = path.match(/^\/api\/workflow-runs\/([^/]+)(\/interrupt)?$/);
      if (workflowRun) {
        const id = decodeURIComponent(workflowRun[1]);
        if (req.method === 'GET' && !workflowRun[2]) return json(res, 200, application.workflows.get(id));
        if (req.method === 'POST' && workflowRun[2]) {
          await readJson(req); return json(res, 200, await application.workflows.interrupt(id));
        }
      }
      if (req.method === 'POST' && path === '/api/sessions') {
        const input = await readJson(req);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['title', 'cwd'].includes(key))
          || ['title', 'cwd'].some(key => input[key] !== undefined && typeof input[key] !== 'string')) {
          return json(res, 400, { error: '新建任务只接受名称和工作目录；模型由 Hermes 默认配置管理。' });
        }
        return json(res, 201, await application.createSession(input));
      }
      const match = path.match(/^\/api\/sessions\/([^/]+)\/(resume|history|messages|interrupt|runs)$/);
      if (match) {
        const [, rawId, operation] = match;
        const id = decodeURIComponent(rawId);
        if (req.method === 'GET' && operation === 'history') return json(res, 200, await application.history(id));
        if (req.method === 'GET' && operation === 'runs') { application.session(id); return json(res, 200, { runs: application.store.runs(id) }); }
        if (req.method === 'POST' && operation === 'resume') { await readJson(req); return json(res, 200, await application.resume(id)); }
        if (req.method === 'POST' && operation === 'messages') return json(res, 202, await application.submit(id, (await readJson(req)).text));
        if (req.method === 'POST' && operation === 'interrupt') { await readJson(req); return json(res, 200, await application.interrupt(id)); }
      }
      const reply = path.match(/^\/api\/requests\/([^/]+)\/reply$/);
      if (req.method === 'POST' && reply) return json(res, 200, application.reply(decodeURIComponent(reply[1]), (await readJson(req)).result));
      const assets = {
        '/hermes-model-ui.js': ['hermes-model-ui.js', 'text/javascript'],
        '/': ['index.html', 'text/html'],
        '/app.js': ['app.js', 'text/javascript'],
        '/app-diagnostic-client.js': ['app-diagnostic-client.js', 'text/javascript'],
        '/application-conversation-ui.js': ['application-conversation-ui.js', 'text/javascript'],
        '/diagnostic-events.js': ['diagnostic-events.js', 'text/javascript'],
        '/style.css': ['style.css', 'text/css'],
        '/workflow-editor.js': ['workflow-editor.js', 'text/javascript'],
        '/workflow-studio-ui.js': ['workflow-studio-ui.js', 'text/javascript'],
        '/workflow-studio-ui.css': ['workflow-studio-ui.css', 'text/css'],
        '/workflow-versioning-ui.js': ['workflow-versioning-ui.js', 'text/javascript'],
        '/workflow-conversation-ui.js': ['workflow-conversation-ui.js', 'text/javascript'],
        '/workflow-conversation-ui.css': ['workflow-conversation-ui.css', 'text/css'],
        '/workflow-node-library-ui.js': ['workflow-node-library-ui.js', 'text/javascript'],
        '/workflow-editor.css': ['workflow-editor.css', 'text/css'],
        '/workflow-runtime-ui.js': ['workflow-runtime-ui.js', 'text/javascript'],
        '/workflow-runtime-ui.css': ['workflow-runtime-ui.css', 'text/css'],
        '/workflow-learning-ui.js': ['workflow-learning-ui.js', 'text/javascript'],
        '/workflow-learning-ui.css': ['workflow-learning-ui.css', 'text/css'],
        '/workflow-feedback-ui.js': ['workflow-feedback-ui.js', 'text/javascript'],
        '/workflow-feedback-ui.css': ['workflow-feedback-ui.css', 'text/css'],
        '/workflow-schedules-ui.js': ['workflow-schedules-ui.js', 'text/javascript'],
        '/workflow-schedules-ui.css': ['workflow-schedules-ui.css', 'text/css'],
        '/workflow-board.js': ['workflow-board.js', 'text/javascript'],
        '/workflow-board.css': ['workflow-board.css', 'text/css'],
        '/workflow-library-client.js': ['workflow-library-client.js', 'text/javascript'],
      };
      // Browser-safe domain modules are explicit assets; no repository browsing.
      const sharedAssets = {
        '/shared/diagnostics.mjs': '../diagnostics.mjs',
        '/shared/workflow/workflow-components.mjs': 'workflow-components.mjs',
        '/shared/workflow/workflow-capability-contract.mjs': 'workflow-capability-contract.mjs',
        '/shared/workflow/workflow-conversation-commands.mjs': 'workflow-conversation-commands.mjs',
        '/shared/workflow/workflow-dataset.mjs': 'workflow-dataset.mjs',
        '/shared/workflow/workflow-inputs.mjs': 'workflow-inputs.mjs',
        '/shared/workflow/workflow-model.mjs': 'workflow-model.mjs',
        '/shared/workflow/workflow-plan.mjs': 'workflow-plan.mjs',
        '/shared/workflow/workflow-presets.mjs': 'workflow-presets.mjs',
        '/shared/workflow/workflow-schedule-time.mjs': 'workflow-schedule-time.mjs',
        '/shared/workflow/workflow-studio-utils.mjs': 'workflow-studio-utils.mjs',
        '/shared/workflow/workflow-tools.mjs': 'workflow-tools.mjs',
        '/shared/workflow/workflow-validation.mjs': 'workflow-validation.mjs',
        '/shared/workflow/workflow-versioning.mjs': 'workflow-versioning.mjs',
      };
      if (req.method === 'GET' && Object.hasOwn(sharedAssets, path)) {
        const content = await readFile(join(config.appRoot, 'shared', 'workflow', sharedAssets[path]));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
        return res.end(content);
      }
      if (req.method === 'GET' && Object.hasOwn(assets, path)) {
        const [name, type] = assets[path];
        const content = await readFile(join(config.appRoot, 'public', name));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return res.end(content);
      }
      return json(res, 404, { error: '接口不存在。' });
    } catch (error) { return json(res, error.httpStatus || 400, { error: redact(error.message),
      ...(Array.isArray(error.details) ? { errors: error.details } : {}) }); }
  });
  const onEvent = event => {
    if (!publicEvent(event)) return;
    const frame = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 2000000 || client.destroyed) { client.destroy(); clients.delete(client); }
      else client.write(frame);
    }
  };
  application.on('event', onEvent);
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 15000);
  heartbeat.unref();
  return {
    application, server,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
      origin = `http://${config.host}:${server.address().port}`;
      application.diagnosticBrowser?.setOrigin(origin);
      return origin;
    },
    async close() {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
      application.off('event', onEvent);
      await application.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
