const ACTIONS = Object.freeze({
  'workflow.copy': /(?:复制|拷贝|\bcopy\b|\bduplicate\b)/i,
  'workflow.create-test': /(?:新建|新增|创建|建立|\bcreate\b|\badd\b)/i,
  'workflow.delete': /(?:删除|删掉|移入(?:到)?回收站|移到回收站|移至回收站|放入回收站|放进回收站|\bdelete\b|\btrash\b)/i,
});
const fail = () => { throw Object.assign(new Error('本轮没有明确授权这项工作流管理操作；请在对话中直接说明要复制、创建测试或删除的目标。'), { httpStatus: 403 }); };
const quoteFree = text => text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, ' 资料引用 ');
const negation = /(?:不要|不必|不用|不能|不可以|不允许|禁止|请勿|切勿|别|暂不|先不|并非要|不是要|没有要求|未授权|无需)\s*.{0,24}(?:复制|拷贝|新建|新增|创建|建立|删除|删|回收站|copy|duplicate|create|delete|trash)/i;
const readOnly = /只读|仅(?:仅)?(?:查看|检查|分析|诊断)|保留现场|保持现场|保持(?:当前|现有|原有)?(?:工作流|流程|节点|内容|现场)(?:完全)?(?:不变|不动)|不(?:做|进行|允许)(?:任何)?(?:修改|改动|管理|写入|操作)/i;
const discussion = /^(?:为什么|为啥|为何|如何|怎么|解释|分析|诊断|查看|检查)|(?:是否|该不该|应不应该|合适吗|合理吗|是什么意思|怎么办|失败了|报错了|超时了)/i;
const requestPrefix = /^(?:请|麻烦(?:你)?|劳驾|帮我|替我|给我|直接|现在|立刻|可以(?:请你)?|能不能|能否|我想(?:要)?(?:让你)?|我希望(?:你)?|我要|请你|please\s+|can\s+you\s+|could\s+you\s+)/i;

function actionClause(clause, name) {
  let value = quoteFree(clause).trim();
  if (negation.test(value) || readOnly.test(value) || discussion.test(value)) return false;
  for (let count = 0; count < 8 && requestPrefix.test(value); count++) value = value.replace(requestPrefix, '').trim();
  const action = ACTIONS[name];
  if (!action) return false;
  const start = value.match(/^(?:把|将)\s*(.{0,240})$/);
  if (!(start ? action.test(start[1]) : action.test(value) && value.search(action) === 0)) return false;
  return name !== 'workflow.create-test' || /(?:测试|复现|\btest\b|\breproduction\b)/i.test(value);
}

function titleMention(text, title) {
  if (typeof title !== 'string' || !title.trim()) return false;
  if (/^[A-Za-z0-9_-]+$/.test(title)) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?:^|[^A-Za-z0-9_-])' + escaped + '(?:$|[^A-Za-z0-9_-])').test(text);
  }
  if (title.length === 1) return ['“' + title + '”', '「' + title + '」', '『' + title + '』', '"' + title + '"', "'" + title + "'"].some(value => text.includes(value));
  return text.includes(title);
}

// Callers pass the original human message, never model arguments or quoted
// tool evidence, as context.text. A permission flag grants capability; this
// separate check requires an actual request for the specific management act.
export function authorizeSupervisorMutation(app, name, args = {}, context = {}) {
  if (!Object.hasOwn(ACTIONS, name)) return;
  if (context.role !== 'supervisor' || typeof context.text !== 'string' || !context.text.trim()) fail();
  const text = context.text.trim(), unquoted = quoteFree(text);
  if (readOnly.test(unquoted)) fail();
  const clauses = text.split(/[。；;，,\n]/).map(value => value.trim()).filter(Boolean);
  const actions = clauses.filter(clause => actionClause(clause, name));
  if (!actions.length) fail();
  if (name === 'workflow.create-test') return;
  if (typeof args.workflowId !== 'string') fail();
  const workflows = app.workflowLibrary.list({ lifecycle: 'all' });
  const counts = new Map();
  for (const workflow of workflows) counts.set(workflow.title, (counts.get(workflow.title) || 0) + 1);
  for (const clause of actions) {
    const explicit = workflows.filter(workflow => titleMention(clause, workflow.id)
      || counts.get(workflow.title) === 1 && titleMention(clause, workflow.title));
    if (explicit.length) {
      if (explicit.some(workflow => workflow.id === args.workflowId)) return;
    } else if (titleMention(clause, args.workflowId) || context.workflowId === args.workflowId) return;
  }
  fail();
}
