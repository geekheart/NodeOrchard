import { readConfig } from './config.mjs';
import { createWorkbenchServer } from './server.mjs';

const app = createWorkbenchServer(readConfig());
const url = await app.listen();
console.log(`个人 AI 工作台：${url}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
}
process.on('SIGINT', () => { close().then(() => process.exit(0)); });
process.on('SIGTERM', () => { close().then(() => process.exit(0)); });
