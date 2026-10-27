import { readConfig } from './config.mjs';
import { createWorkbenchServer } from './server.mjs';
import { applicationErrorLocation } from './application-log-events.mjs';

let app;
try {
  app = createWorkbenchServer(readConfig());
  const url = await app.listen();
  console.log(`个人 AI 工作台：${url}`);
} catch (error) {
  app?.application?.logEvents?.write('fatal', 'application.start.failed', { component: 'application', code: 'APPLICATION_START_FAILED', errorName: error.name,
    errorCode: error.code, ...applicationErrorLocation(error, app?.application?.config?.appRoot) });
  // Startup diagnostics use bounded classifications; configuration values and
  // complete exception messages can contain credentials or private paths.
  console.error('个人 AI 工作台启动失败，请检查本地配置与持久日志。');
  await app?.close().catch(() => {});
  process.exitCode = 1;
}
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app?.close();
}
process.on('SIGINT', () => { close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { close().then(() => process.exit(0)); });
