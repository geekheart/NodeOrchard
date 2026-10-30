import { isAbsolute } from 'node:path';
const errorFor = (code, message) => Object.assign(new Error(message), { code });

export function minimalEnvironment(context) {
  const env = {};
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  if (context !== undefined) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) throw errorFor('CONTEXT_INVALID', '代码节点运行上下文无效。');
    for (const [key, variable] of Object.entries({ runId: 'WORKBENCH_RUN_ID', workflowId: 'WORKBENCH_WORKFLOW_ID', nodeId: 'WORKBENCH_NODE_ID', learningId: 'WORKBENCH_LEARNING_ID', attemptId: 'WORKBENCH_ATTEMPT_ID' })) {
      if (context[key] === undefined) continue;
      if (typeof context[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(context[key])) throw errorFor('CONTEXT_INVALID', '代码节点运行上下文标识无效。');
      env[variable] = context[key];
    }
    if (context.outputDirectory !== undefined) {
      if (typeof context.outputDirectory !== 'string' || !isAbsolute(context.outputDirectory)) throw errorFor('CONTEXT_INVALID', '产物目录必须是绝对路径。');
      env.WORKBENCH_OUTPUT_DIRECTORY = context.outputDirectory;
      env.WORKBENCH_NODE_DIRECTORY = context.outputDirectory;
    }
    if (context.runOutputDirectory !== undefined) {
      if (typeof context.runOutputDirectory !== 'string' || !isAbsolute(context.runOutputDirectory)) throw errorFor('CONTEXT_INVALID', '运行产物目录必须是绝对路径。');
      env.WORKBENCH_RUN_OUTPUT_DIRECTORY = context.runOutputDirectory;
    }
    if (context.databasePath !== undefined) {
      if (typeof context.databasePath !== 'string' || !isAbsolute(context.databasePath)) throw errorFor('CONTEXT_INVALID', '运行数据库路径必须是绝对路径。');
      env.WORKBENCH_DATABASE_PATH = context.databasePath;
    }
    if (context.attempt !== undefined) {
      if (!Number.isInteger(context.attempt) || context.attempt < 1) throw errorFor('CONTEXT_INVALID', '节点尝试次数无效。');
      env.WORKBENCH_ATTEMPT = String(context.attempt);
    }
    if (context.reviewFeedback) env.WORKBENCH_REVIEW_FEEDBACK = String(context.reviewFeedback).slice(0, 8000);
  }
  return { ...env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };
}
