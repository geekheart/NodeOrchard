# HDK 原生导出执行器

固定代码负责副本、原生导出与验收；Skill 只产出目录/命名 JSON plan，不能注入脚本或修改 PCB。

```sh
python3 workbench/hdk/exporter/export_hdk.py --request REQUEST.json
python3 workbench/hdk/exporter/export_hdk.py --request REQUEST.json --execute
python3 workbench/hdk/exporter/export_hdk.py --verify EXPORT_REPORT.json
```

第一条只读检查输入 ZIP、源文档 UUID、plan 和目标命名，不打开 EDA，不创建输出目录。`--execute` 才执行。`--verify` 从磁盘重新读取产物、原生原件、源码快照，重建格式转换结果再比较；不直接信任导出报告的成功标记。

请求示例（plan 由 `hdk/learning/plan.schema.json` 定义，所有路径须与案例规则精确一致）：

```json
{
  "sourcePath": "/绝对路径/输入.epro2",
  "outputParent": "/已存在的专用输出目录",
  "productCode": "WT9932S31-TINY",
  "hardwareVersion": "V1.0",
  "releaseDate": "2026-10-24",
  "plan": {"packageName": "WT9932S31-TINY_HDK_V1.0", "paths": {}, "supplementalDirectories": [], "checks": {}}
}
```

路径占位须替换为完整有效 plan。输出为 `outputParent/packageName`，目录已存在即拒绝，不覆盖案例或上次成果。

## 本机原生兼容与来源

已实测 macOS 嘉立创 EDA 专业版 4.1.78。需 Python 3.9+、`pypdf`，原生程序路径默认为 `/Applications/嘉立创EDA(专业版).app/Contents/MacOS/LCEDA-Pro`。每次仅创建与关闭自身的新 headless session，不借用原用户 session：

1. 原 epro2 复制到私有 `.hdk-export-UUID/input.epro2`，比较 SHA256。
2. 公开 `importProjectByProjectFile(... Offline Client Local Path ...)` 导入该副本成新的本地 eprj2；关闭导入 session。
3. 新 headless session 打开本地 eprj2，按输入归档的 PCB/原理图 UUID 与实际 DOCHEAD 绑定。
4. 只调用公开读取和制造文件导出 API，不改名/保存源设计，不改线、过孔、覆铜、布局或叠层。本机构建的 alpha ready 接口即使实际源码和65器件已可读也返回 false；执行器记录此警告，并用匹配 DOCHEAD、可读有效源码和真实原生元件作为可观测就绪依据。
5. 导出前后保存有效源码，按排序后的完整记录比较（保留重复记录，忽略头部 ticket 与 DOCHEAD 时间变化）；原始输入 epro2 与副本的 SHA 不变。

文件均记录字节数、SHA256、CRC32，ZIP 全成员 CRC 与安全路径复读。原生原件存于 `evidence/*.native`，不会丢弃版本额外字段：

- Gerber 使用当前板实际层的一键默认原生导出，顶钢网从同次 ZIP 逐字节提取。底钢网仅在同次 Gerber 缺 GBP、当前坐标底面全为非 SMD、PCB 源无底面锡膏绘制对象三条件成立时记 `notApplicable`，不造空文件。
- 原生默认 BOM 有正确物料分组但仅10列；保留其全部位号/数量/分组，通过同输入 DEVICE/SYMBOL META 与本次 PCB Name getter 补回案例5列，得到15列。逐组数量=位号数，集合与源 PCB 一致，每组器件 UUID 必须唯一。
- 本机原生坐标为18列且第15列为 Value；保存完整原件，按案例保留15列，第15列 Name 从同一原生 getter 和属性解析。只支持明确的 `={属性名}` 插值，不执行表达式。坐标、层、旋转、所有65行和4个非 SMD 均保留。
- 原理图 API 可能返回包含唯一 PDF 的 ZIP；保留原 ZIP并做 CRC/成员哈希检查后抽取真实 PDF。
- PCB PDF API 忽略图页 checked 选项，会输出5页；按原生书签“顶面自动位号图”“底面自动位号图”定位并提取两页，保留完整5页原件和选择证据，不猜前两页。
- PDF 解析、页数与角色检查后仍需真实渲染视觉核对；不将 magic bytes 等同于中文、配色或图纸内容合格。

## 状态语义

`coreStatus=complete` 仅表示原理图、15列 BOM、Gerber、适用钢网、15列坐标、两页位号 PDF、DXF、原生工程均通过核心检查。`status=blocked` 会保留所有已导出的真实文件并列出问题；工艺表、精确器件手册、测试流程/固件需要本板独立来源，当前不会套用另一硬件案例，因此核心完成后总交付仍明确待补。

CLI stdout 为 JSON。`preflight`/`complete` 退出码0，`blocked` 退出码2；固定工作流节点应 `check=False` 解析结果，展示缺件并进入独立验证。遇 CLI 超时不盲目重试，不关闭仍可能有后台 RPC 的自建 session；报告中保留其 sessionId 供核实。

验证：`python3 workbench/test/hdk-export.test.py`，或 Node 测试套件自动执行 `test/hdk-export.test.mjs`。测试不启动 EDA。
