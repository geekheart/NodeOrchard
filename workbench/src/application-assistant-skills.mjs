import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { appRoot as defaultAppRoot } from './config.mjs';

export const APPLICATION_ASSISTANT_SKILL_LIMITS = Object.freeze({ instructionsBytes: 16 * 1024 });
export const APPLICATION_ASSISTANT_SKILL_MANIFEST = Object.freeze([
  { name: 'diagnose-workflow', description: '诊断本应用助手对话超时、工作流失败或结果异常，关联模型调用、当前草稿与真实运行证据。' },
  { name: 'edit-workflow', description: '搭建、配置或替换本应用工作流节点与连线，提出可应用的最小修改。' },
  { name: 'author-code-node', description: '编写或修改本应用的 Python 与 JavaScript 代码节点，处理数据或生成文件。' },
  { name: 'verify-result', description: '核验本应用运行状态、真实交付文件及修复验证结果。' },
  { name: 'repair-application', description: '人工开启总控源码自修复后，定位并修改允许的应用源码，运行隔离相关测试，核对修复记录或按版本回滚。' },
].map(value => Object.freeze(value)));
const manifest = new Map(APPLICATION_ASSISTANT_SKILL_MANIFEST.map(value => [value.name, value]));
const fail = (message, httpStatus = 400) => { throw Object.assign(new Error(message), { httpStatus }); };

function metadata(content, expected) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) fail('内部 Skill 元数据格式无效。', 500);
  const fields = new Map();
  for (const line of match[1].split(/\r?\n/).filter(line => line.trim())) {
    const field = /^(name|description):[ \t]+([^\r\n]+)$/.exec(line);
    if (!field || fields.has(field[1])) fail('内部 Skill 元数据包含未知或重复字段。', 500);
    fields.set(field[1], field[2].trim());
  }
  if (fields.get('name') !== expected.name || fields.get('description') !== expected.description) fail('内部 Skill 元数据与固定目录不一致。', 500);
  if (!match[2].trim()) fail('内部 Skill 正文不能为空。', 500);
}

// Internal instructions are repo-owned. This catalog never scans the user's
// Hermes Skill directories or accepts a model-supplied filename/root.
export class ApplicationAssistantSkills {
  constructor(options = defaultAppRoot) {
    const appRoot = typeof options === 'string' ? options : options?.appRoot;
    if (typeof appRoot !== 'string' || !isAbsolute(appRoot) || appRoot.includes('\0')) fail('内部 Skill 应用根目录无效。');
    this.appRoot = resolve(appRoot);
  }

  async list() {
    return Promise.all(APPLICATION_ASSISTANT_SKILL_MANIFEST.map(async ({ name }) => {
      const { description, revision } = await this.read(name);
      return { name, description, revision };
    }));
  }

  async read(name) {
    const expected = typeof name === 'string' ? manifest.get(name) : null;
    if (!expected) fail('未开放此内部 Skill 工作方法。', 404);
    let file;
    try {
      const appRoot = await realpath(this.appRoot), root = join(appRoot, 'assistant-skills');
      const path = join(root, expected.name, 'SKILL.md');
      if (await realpath(root) !== root || await realpath(path) !== path) fail('内部 Skill 只能读取固定目录中的普通文件，不能使用符号链接。', 403);
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = await file.stat();
      if (!stat.isFile()) fail('内部 Skill 文件不可用。', 500);
      if (stat.size > APPLICATION_ASSISTANT_SKILL_LIMITS.instructionsBytes) fail('内部 Skill 大小超过读取上限。', 413);
      const bytes = Buffer.alloc(APPLICATION_ASSISTANT_SKILL_LIMITS.instructionsBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > APPLICATION_ASSISTANT_SKILL_LIMITS.instructionsBytes) fail('内部 Skill 大小超过读取上限。', 413);
      const source = bytes.subarray(0, length);
      let instructions;
      try { instructions = new TextDecoder('utf-8', { fatal: true }).decode(source); }
      catch { fail('内部 Skill 必须是有效 UTF-8 文本。', 500); }
      if (instructions.includes('\0')) fail('内部 Skill 正文包含无效字符。', 500);
      metadata(instructions, expected);
      return { name: expected.name, description: expected.description,
        revision: 'sha256:' + createHash('sha256').update(source).digest('hex'), instructions };
    } catch (error) {
      if (error.httpStatus) throw error;
      fail('内部 Skill 文件不可用。', 500);
    } finally { await file?.close(); }
  }
}
