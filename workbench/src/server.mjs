import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { applicationHttpRoute, applicationResponseTrace, applicationErrorLocation } from './application-log-events.mjs';
import { Application } from './application.mjs';
import { redact } from './hermes-adapter.mjs';
import { WORKFLOW_ZIP_LIMITS } from './workflows/workflow-zip.mjs';
import { WORKFLOW_ATTACHMENT_LIMITS } from './workflows/workflow-attachments.mjs';
import { imageDimensions } from './workflows/workflow-files.mjs';

const PUBLIC_REVIEW_ERROR_CODES = new Set(['REVISION_REQUIRES_PROPOSAL']);

async function readPackage(req) {
  const chunks = []; let length = 0, oversized = false;
  for await (const chunk of req) { length += chunk.length; if (length > WORKFLOW_ZIP_LIMITS.maxCompressedBytes) oversized = true; if (!oversized) chunks.push(chunk); }
  if (oversized) throw Object.assign(new Error('工作流包不能超过 256 MB。'), { httpStatus: 413 });
  return Buffer.concat(chunks);
}

async function readAttachment(req) {
  const chunks = []; let length = 0, oversized = false;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > WORKFLOW_ATTACHMENT_LIMITS.fileBytes) { oversized = true; chunks.length = 0; }
    if (!oversized) chunks.push(chunk);
  }
  if (oversized) throw Object.assign(new Error('单个素材文件不能超过 32MB。'), { httpStatus: 413 });
  return Buffer.concat(chunks);
}

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
  const responseTraces = new WeakMap();
  const publicEvent = event => !event.sessionId || !application.assistantModel?.ownsSession(event.sessionId);
  const json = (res, code, data) => {
    responseTraces.set(res, applicationResponseTrace(data));
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  let origin;
  const server = createServer(async (req, res) => {
    const requestId = randomUUID(), startedAt = performance.now(), route = applicationHttpRoute(req.url);
    const method = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER';
    res.setHeader('X-Request-Id', requestId);
    try { application.logger?.write(method === 'GET' || method === 'HEAD' ? 'debug' : 'info', 'http.request.started', { component: 'http', requestId, route, method }); }
    catch { /* Requests remain admitted when diagnostics are unavailable. */ }
    let completed = false;
    const logRequest = aborted => {
      if (completed) return; completed = true;
      const httpStatus = aborted ? 499 : res.statusCode;
      const level = route === '/api/events' ? 'debug' : httpStatus >= 500 ? 'error' : httpStatus >= 400 ? 'warn' : method === 'GET' || method === 'HEAD' ? 'debug' : 'info';
      try { application.logger?.write(level, 'http.request.completed', { component: 'http', requestId, route, method, httpStatus,
        ...responseTraces.get(res), durationMs: Math.max(0, Math.round(performance.now() - startedAt)), code: aborted ? 'CLIENT_DISCONNECTED' : undefined }); } catch { /* Response completion is authoritative. */ }
    };
    res.once('finish', () => logRequest(false));
    res.once('close', () => { if (!res.writableFinished) logRequest(true); });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: '无效的主机地址。' });
      if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: '禁止跨站请求。' });
      const requestURL = new URL(req.url, origin);
      const path = requestURL.pathname;
      if (['POST', 'PUT'].includes(req.method)) {
        const token = Buffer.from(req.headers['x-workbench-token'] || '');
        const expected = Buffer.from(csrfToken);
        if (token.length !== expected.length || !timingSafeEqual(token, expected)) return json(res, 403, { error: '客户端校验失败，请刷新页面。' });
        const mediaType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
        if (path === '/api/workflow-packages/import' && req.method === 'POST') {
          if (!['application/octet-stream', 'application/zip'].includes(mediaType)) return json(res, 415, { error: '工作流导入需要二进制 ZIP 文件。' });
        } else if (/^\/api\/workflow-library\/[A-Za-z0-9_-]+\/attachments$/.test(path) && req.method === 'POST') {
          if (mediaType !== 'application/octet-stream') return json(res, 415, { error: '素材上传需要 application/octet-stream。' });
        } else if (mediaType !== 'application/json') return json(res, 415, { error: '需要 application/json。' });
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
      if (req.method === 'GET' && path === '/api/conversation-hub') {
        const allowed = ['lifecycle', 'search', 'limit'];
        if ([...requestURL.searchParams.keys()].some(key => !allowed.includes(key) || requestURL.searchParams.getAll(key).length !== 1)) return json(res, 400, { error: '会话目录查询参数无效。' });
        const args = Object.fromEntries(requestURL.searchParams);
        if (args.limit !== undefined) args.limit = Number(args.limit);
        return json(res, 200, { ...application.applicationAssistant.hub.list({ lifecycle: 'active', ...args }), supervisors: application.applicationAssistant.listConversations() });
      }
      if (path === '/api/app-assistant/conversations' && requestURL.search) return json(res, 400, { error: '总控会话不接受查询参数。' });
      if (req.method === 'GET' && path === '/api/app-assistant/conversations') return json(res, 200, { supervisors: application.applicationAssistant.listConversations() });
      if (req.method === 'POST' && path === '/api/app-assistant/conversations') return json(res, 201, application.applicationAssistant.createConversation(await readJson(req, 4096)));
      const supervisorConversation = path.match(/^\/api\/app-assistant\/conversations\/([A-Za-z0-9_-]+)(?:\/(messages|turns\/([A-Za-z0-9_-]+)\/action))?$/);
      if (supervisorConversation) {
        if (requestURL.search) return json(res, 400, { error: '总控会话不接受查询参数。' });
        const [, id, operation, turnId] = supervisorConversation;
        if (req.method === 'GET' && !operation) return json(res, 200, application.applicationAssistant.get(id));
        if (req.method === 'POST' && operation === 'messages') return json(res, 202, await application.applicationAssistant.message(await readJson(req, 100000), id));
        if (req.method === 'POST' && turnId) return json(res, 200, await application.applicationAssistant.action(turnId, await readJson(req, 4096), id));
      }
      if (req.method === 'POST' && path === '/api/app-assistant/messages') return json(res, 202, await application.applicationAssistant.message(await readJson(req, 100000)));
      const assistantAction = path.match(/^\/api\/app-assistant\/turns\/([A-Za-z0-9_-]+)\/action$/);
      if (req.method === 'POST' && assistantAction) return json(res, 200, await application.applicationAssistant.action(assistantAction[1], await readJson(req, 4096)));
      const diagnosticCapture = path.match(/^\/api\/app-diagnostics\/captures\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/);
      if (req.method === 'GET' && diagnosticCapture) {
        const file = await application.applicationAssistant.captureFile(diagnosticCapture[1], diagnosticCapture[2]);
        const content = await readFile(file.path);
        res.writeHead(200, { 'Content-Type': file.mimeType, 'Cache-Control': 'no-store', 'Content-Length': content.length });
        return res.end(content);
      }
      if (req.method === 'GET' && path === '/api/settings') return json(res, 200, await application.settings());
      if (req.method === 'POST' && path === '/api/settings') return json(res, 200, await application.saveSettings(await readJson(req)));
      if (req.method === 'GET' && path === '/api/assistant-permissions') return json(res, 200, application.assistantPermissionSettings.get());
      if (req.method === 'PUT' && path === '/api/assistant-permissions') return json(res, 200, application.assistantPermissionSettings.save(await readJson(req, 4096)));
      if (path === '/api/source-repairs') {
        if (requestURL.search) return json(res, 400, { error: '源码修复记录不接受任意查询参数。' });
        if (req.method === 'GET') return json(res, 200, await application.sourceRepairs.history({ limit: 20 }));
      }
      const sourceRollback = path.match(/^\/api\/source-repairs\/([A-Za-z0-9_-]+)\/rollback$/);
      if (req.method === 'POST' && sourceRollback) {
        if (requestURL.search) return json(res, 400, { error: '回滚请求不接受查询参数。' });
        const input = await readJson(req, 4096);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'operationId')
          || typeof input.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.operationId)) return json(res, 400, { error: '源码回滚身份无效。' });
        return json(res, 200, await application.sourceRepairs.rollback({ ...input, repairId: sourceRollback[1] }, { human: true, role: 'human', authorize: async () => {} }));
      }
      if (req.method === 'GET' && path === '/api/models') return json(res, 200, await application.modelOptions());
      if (req.method === 'POST' && path === '/api/models') return json(res, 200, await application.selectModel(await readJson(req, 4096)));
      if (req.method === 'GET' && path === '/api/statistics') {
        const days = requestURL.searchParams.get('days') || '7';
        if (!['7', '30'].includes(days)) return json(res, 400, { error: '统计周期只支持 7 天或 30 天。' });
        return json(res, 200, await application.statistics(Number(days)));
      }
      if (req.method === 'POST' && path === '/api/statistics/history') {
        if (requestURL.search) return json(res, 400, { error: '历史补齐不接受查询参数。' });
        const body = await readJson(req, 1024);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return json(res, 400, { error: '历史补齐不接受自定义会话或路径。' });
        return json(res, 200, await application.backfillHistoricalUsage());
      }
      const skillView = () => {
        if ([...requestURL.searchParams.keys()].some(key => key !== 'view') || requestURL.searchParams.getAll('view').length > 1
          || requestURL.searchParams.has('view') && requestURL.searchParams.get('view') !== 'management') throw Object.assign(new Error('Skill 视图参数无效。'), { httpStatus: 400 });
        return requestURL.searchParams.get('view') || undefined;
      };
      if (req.method === 'GET' && path === '/api/skills') return json(res, 200, await application.skills({ view: skillView() }));
      if (req.method === 'POST' && path === '/api/skills') return json(res, 201, await application.skillIntegrations.create(await readJson(req, 64000), { human: true }));
      if (req.method === 'GET' && path === '/api/skill-integrations') return json(res, 200, await application.skillIntegrations.inspect());
      if (req.method === 'POST' && path === '/api/skill-integrations/image-provider') return json(res, 200,
        await application.skillIntegrations.selectImageProvider(await readJson(req, 4096), { human: true }));
      const skillMatch = path.match(/^\/api\/skills\/([^/]+)$/);
      if (req.method === 'GET' && skillMatch) return json(res, 200, await application.skill(decodeURIComponent(skillMatch[1]), { view: skillView() }));
      const skillDelete = path.match(/^\/api\/skills\/([^/]+)\/delete$/);
      if (req.method === 'POST' && skillDelete) {
        if (requestURL.search) return json(res, 400, { error: 'Skill 删除不接受查询参数。' });
        const input = await readJson(req, 4096);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['expectedRevision', 'expectedCreationId', 'operationId'].includes(key))) return json(res, 400, { error: 'Skill 删除参数无效。' });
        return json(res, 200, await application.skillIntegrations.remove({ ...input, name: decodeURIComponent(skillDelete[1]) }, { human: true }));
      }
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
      if (path === '/api/workflow-node-presets' && requestURL.search) return json(res, 400, { error: '节点派生列表或创建请求不能包含查询参数。' });
      if (req.method === 'GET' && path === '/api/workflow-node-presets') return json(res, 200, { presets: application.nodePresets.list() });
      if (req.method === 'POST' && path === '/api/workflow-node-presets') return json(res, 201, { preset: application.nodePresets.create(await readJson(req, 2 * 1024 * 1024 + 8192)) });
      const nodePresetMatch = path.match(/^\/api\/workflow-node-presets\/([^/]+)$/);
      if (nodePresetMatch) {
        const id = decodeURIComponent(nodePresetMatch[1]);
        if (req.method === 'GET') {
          const keys = [...requestURL.searchParams.keys()];
          const version = requestURL.searchParams.get('version');
          if (keys.some(key => key !== 'version') || requestURL.searchParams.getAll('version').length > 1 || (version !== null && !/^[1-9]\d*$/.test(version))) return json(res, 400, { error: '节点派生版本查询无效。' });
          return json(res, 200, { preset: application.nodePresets.get(id, version === null ? {} : { version: Number(version) }) });
        }
        if (req.method === 'POST') {
          if (requestURL.search) return json(res, 400, { error: '保存预设不能包含查询参数。' });
          return json(res, 200, { preset: application.nodePresets.update(id, await readJson(req, 2 * 1024 * 1024 + 8192)) });
        }
      }
      const proposalValidation = path.match(/^\/api\/workflow-conversations\/([A-Za-z0-9_-]+)\/turns\/([A-Za-z0-9_-]+)\/validate-proposal$/);
      if (req.method === 'POST' && proposalValidation) {
        if (requestURL.search) return json(res, 400, { error: '工作流对话不接受查询参数。' });
        return json(res, 200, await application.conversations.validateProposal(proposalValidation[1], proposalValidation[2], await readJson(req, 4096)));
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
      if (req.method === 'GET' && path === '/api/workflow-examples') {
        if (requestURL.search) return json(res, 400, { error: '示例目录不接受路径或查询参数。' });
        return json(res, 200, { examples: application.workflowExamples.list() });
      }
      const exampleMatch = path.match(/^\/api\/workflow-examples\/([a-z0-9-]+)\/prepare$/);
      if (req.method === 'POST' && exampleMatch) {
        if (requestURL.search) return json(res, 400, { error: '示例准备不接受路径或查询参数。' });
        return json(res, 200, await application.workflowExamples.prepare(exampleMatch[1], await readJson(req, 4096)));
      }
      if (req.method === 'POST' && path === '/api/workflow-library') return json(res, 200, { workflow: application.workflowLibrary.save(await readJson(req, 2 * 1024 * 1024 + 65536)) });
      if (req.method === 'POST' && path === '/api/workflow-packages/import') {
        if ([...requestURL.searchParams.keys()].some(key => key !== 'filename') || requestURL.searchParams.getAll('filename').length !== 1) return json(res, 400, { error: '工作流导入参数无效。' });
        return json(res, 201, await application.workflowPackages.import(await readPackage(req), {
          filename: requestURL.searchParams.get('filename'), operationId: req.headers['x-workflow-import-id'],
        }));
      }
      const attachmentMatch = path.match(/^\/api\/workflow-library\/([A-Za-z0-9_-]+)\/attachments(?:\/(reference)|\/([A-Za-z0-9_-]+)\/content)?$/);
      if (attachmentMatch) {
        const workflowId = attachmentMatch[1], isUpload = req.method === 'POST' && !attachmentMatch[2] && !attachmentMatch[3];
        if (isUpload) {
          if ([...requestURL.searchParams.keys()].some(key => key !== 'filename') || requestURL.searchParams.getAll('filename').length !== 1) return json(res, 400, { error: '素材上传参数无效。' });
          return json(res, 201, { attachment: await application.workflowAttachments.upload(workflowId, {
            name: requestURL.searchParams.get('filename'), operationId: req.headers['x-workflow-attachment-id'], mimeType: req.headers['x-workflow-attachment-type'] || '',
          }, await readAttachment(req)) });
        }
        if (requestURL.search) return json(res, 400, { error: '素材读取与引用不接受查询参数。' });
        if (req.method === 'GET' && !attachmentMatch[2] && !attachmentMatch[3]) return json(res, 200, { attachments: application.workflowAttachments.list(workflowId) });
        if (req.method === 'POST' && attachmentMatch[2]) return json(res, 201, { attachment: await application.workflowAttachments.reference(workflowId, await readJson(req, 8192)) });
        if (req.method === 'GET' && attachmentMatch[3]) {
          const { attachment, data } = await application.workflowAttachments.content(workflowId, attachmentMatch[3]), image = imageDimensions(data);
          const raster = image?.width && image?.height && ['png', 'jpeg', 'gif', 'webp'].includes(image.format);
          const encoded = encodeURIComponent(attachment.name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
          res.writeHead(200, { 'Content-Type': raster ? 'image/' + image.format : 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store',
            'Content-Disposition': (raster ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encoded, 'Content-Security-Policy': "sandbox; default-src 'none'" });
          return res.end(data);
        }
      }
      const folderMatch = path.match(/^\/api\/workflow-library\/([A-Za-z0-9_-]+)\/folder(?:\/(open))?$/);
      if (folderMatch) {
        if (requestURL.search) return json(res, 400, { error: '工作流文件夹不接受路径或查询参数。' });
        const workflowId = folderMatch[1]; application.workflowLibrary.get(workflowId);
        if (req.method === 'GET' && !folderMatch[2]) return json(res, 200, { workflowId, directory: application.workflowFolders.directory(workflowId), ...application.workflowFolders.status(workflowId) });
        if (req.method === 'POST' && folderMatch[2]) {
          const body = await readJson(req, 4096);
          if (!body || Array.isArray(body) || Object.keys(body).length) return json(res, 400, { error: '打开工作流文件夹只接受空对象。' });
          return json(res, 200, await application.workflowFolders.open(workflowId));
        }
      }
      const exportMatch = path.match(/^\/api\/workflow-library\/([A-Za-z0-9_-]+)\/export$/);
      if (req.method === 'GET' && exportMatch) {
        if ([...requestURL.searchParams.keys()].some(key => key !== 'expectedRevision') || requestURL.searchParams.getAll('expectedRevision').length !== 1) return json(res, 400, { error: '工作流导出版本参数无效。' });
        const result = await application.workflowPackages.export(exportMatch[1], { expectedRevision: Number(requestURL.searchParams.get('expectedRevision')) });
        const encoded = encodeURIComponent(result.filename).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="workflow.workflow"; filename*=UTF-8''${encoded}`,
          'Content-Length': result.data.length, 'Cache-Control': 'no-store' }); return res.end(result.data);
      }
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
          const body = await readJson(req);
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return json(res, 400, { error: '应用学习候选不接受其它字段。' });
          return json(res, 200, await application.learning.applyBest(id));
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
        '/assistant-permissions-ui.js': ['assistant-permissions-ui.js', 'text/javascript'],
        '/source-repair-ui.js': ['source-repair-ui.js', 'text/javascript'],
        '/shortcut-settings-ui.js': ['shortcut-settings-ui.js', 'text/javascript'],
        '/keyboard-shortcuts.js': ['keyboard-shortcuts.js', 'text/javascript'],
        '/conversation-hub-ui.js': ['conversation-hub-ui.js', 'text/javascript'],
        '/statistics-dashboard.js': ['statistics-dashboard.js', 'text/javascript'],
        '/statistics-dashboard.css': ['statistics-dashboard.css', 'text/css'],
        '/diagnostic-events.js': ['diagnostic-events.js', 'text/javascript'],
        '/style.css': ['style.css', 'text/css'],
        '/workflow-editor.js': ['workflow-editor.js', 'text/javascript'],
        '/workflow-toolbar-controls.js': ['workflow-toolbar-controls.js', 'text/javascript'],
        '/workflow-studio-ui.js': ['workflow-studio-ui.js', 'text/javascript'],
        '/workflow-studio-ui.css': ['workflow-studio-ui.css', 'text/css'],
        '/workflow-versioning-ui.js': ['workflow-versioning-ui.js', 'text/javascript'],
        '/workflow-conversation-ui.js': ['workflow-conversation-ui.js', 'text/javascript'],
        '/pending-notice-dismissals.js': ['pending-notice-dismissals.js', 'text/javascript'],
        '/conversation-attachments.js': ['conversation-attachments.js', 'text/javascript'],
        '/workflow-attachment-input.js': ['workflow-attachment-input.js', 'text/javascript'],
        '/workflow-examples-ui.js': ['workflow-examples-ui.js', 'text/javascript'],
        '/workflow-conversation-ui.css': ['workflow-conversation-ui.css', 'text/css'],
        '/workflow-node-library-ui.js': ['workflow-node-library-ui.js', 'text/javascript'],
        '/workflow-editor.css': ['workflow-editor.css', 'text/css'],
        '/workflow-runtime-ui.js': ['workflow-runtime-ui.js', 'text/javascript'],
        '/skill-authoring-ui.js': ['skill-authoring-ui.js', 'text/javascript'],
        '/skill-library-ui.js': ['skill-library-ui.js', 'text/javascript'],
        '/skill-library-ui.css': ['skill-library-ui.css', 'text/css'],
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
        '/workflow-package-ui.js': ['workflow-package-ui.js', 'text/javascript'],
      };
      // Browser-safe domain modules are explicit assets; no repository browsing.
      const sharedAssets = {
        '/shared/diagnostics.mjs': '../diagnostics.mjs',
        '/shared/keyboard-shortcuts.mjs': '../keyboard-shortcuts.mjs',
        '/shared/workflow/workflow-autosave.mjs': 'workflow-autosave.mjs',
        '/shared/workflow/workflow-components.mjs': 'workflow-components.mjs',
        '/shared/workflow/workflow-capability-contract.mjs': 'workflow-capability-contract.mjs',
        '/shared/workflow/workflow-conversation-commands.mjs': 'workflow-conversation-commands.mjs',
        '/shared/workflow/workflow-conversation-issues.mjs': 'workflow-conversation-issues.mjs',
        '/shared/workflow/workflow-dataset.mjs': 'workflow-dataset.mjs',
        '/shared/workflow/workflow-inputs.mjs': 'workflow-inputs.mjs',
        '/shared/workflow/workflow-model.mjs': 'workflow-model.mjs',
        '/shared/workflow/workflow-integrations.mjs': 'workflow-integrations.mjs',
        '/shared/workflow/workflow-plan.mjs': 'workflow-plan.mjs',
        '/shared/workflow/workflow-learning-scope.mjs': 'workflow-learning-scope.mjs',
        '/shared/workflow/workflow-presets.mjs': 'workflow-presets.mjs',
        '/shared/workflow/workflow-review-revision.mjs': 'workflow-review-revision.mjs',
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
    } catch (error) {
      try { application.logger?.write(error.httpStatus && error.httpStatus < 500 ? 'warn' : 'error', 'http.request.failed', {
        component: 'http', requestId, route, method, httpStatus: error.httpStatus || 400, errorName: error.name, errorCode: error.code,
        ...applicationErrorLocation(error, config.appRoot) }); } catch { /* Keep the existing HTTP error contract. */ }
      return json(res, error.httpStatus || 400, { error: redact(error.message),
        ...(PUBLIC_REVIEW_ERROR_CODES.has(error.code) ? { code: error.code } : {}),
        ...(Array.isArray(error.details) ? { errors: error.details } : {}) });
    }
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
