---
name: author-code-node
description: 编写或修改本应用的 Python 与 JavaScript 代码节点，处理数据或生成文件。
---

# 按实际运行契约编写业务代码

1. 读取 `node.describe({type:"tool",schemaVersion:2})` 获取代码模式、端口和运行契约；需要整体能力边界时读取 `app.capabilities({section:"nodes"})`。`tool` 的代码模式可以执行 Python 或 JavaScript，无需注册新的工具名称。
2. 编写代码前用 `runtime.inspect` 检查目标语言环境及实际需要的依赖。例如 Excel 生成可用 `runtime.inspect({language:"python",modules:["openpyxl","xlsxwriter"]})`。根据检查结果选实现；模块缺失不代表节点不支持 Python，也不授权安装软件或改应用源码。
   调用Blender、FreeCADCmd或FFmpeg时用 `runtime.software.inspect` 检查真实位置；应用目录已发现的可执行文件可使用其路径，PATH不可见不等于未安装。固定版本探测与业务执行分别验证。修订现存Python节点可用 `runtime.code.check` 读取代码身份和语法结果；嵌套Python脚本只显式检查对应静态变量，不执行模板替换或子脚本。
3. 代码字段填写函数体。Python 由运行器包装为 `main(input, context=None)`；JavaScript 使用异步函数体。`input` 是上游真实数据，`return` 是 JSON 输出；日志通过 print/console 记录。具体类型和大小限制以能力契约为准。
4. 生成文件时写入运行时提供的节点产物目录，返回真实 `path` 或 `artifacts/files` 回执；交付内容与上游字段吻合。文件路径由运行上下文确定，不能把推测的现存文件、日志文本或聊天承诺当成交付物。
5. 把代码及端口设置交给 `workflow.propose`，形成实际业务节点的候选。用户要求替换旧 Skill 时，候选必须包含替换和重连；只返回代码解释或新增前置节点不足以完成。

完成标准：实现符合已读取的输入、输出、文件回执和依赖契约，并明确尚未运行的部分。生成候选前核对当前工作流修改与自定义节点权限。代码进程不是 OS 沙箱；业务代码仅处理用户授权的数据与产物，不用于绕过助手的工作文件夹、受限工具或人工权限设置边界、任意系统执行或应用源码写入。
