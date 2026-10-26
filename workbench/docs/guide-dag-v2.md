# 使用指南 v2 能力合同

这是独立 DAG 适配，不调用旧 `guide_pipeline.run_stage`，不读取旧 release-gate 的通过状态。旧模块仅提供事实提取、受限计划校验、实际图片/文档生成及核验函数。执行 Skill 必须固定已有版本；旧案例学习记录不能证明新 DAG 已迁移成功。

## 输入与准备

`hdk.guide.prepare` 输入为以下八项，路径由工作流文件选择器和公共预检收集：

```json
{"sourcePath":"/absolute/project.epro2","frontImage":"/absolute/front.png","backImage":"/absolute/back.png","guideProfilePath":"/absolute/guide-profile.json","fourFilesDirectory":"/absolute/four-verify/版本-1","productCode":"WT9932P4C61-TINY","hardwareVersion":"1.0","releaseDate":"2026-10-25"}
```

配置格式为 `workbench-guide-profile`、version 1，包含 sourceSha256、pcbUuid、images、technicalDocuments、bspRepository、sdkRepository、drawioTemplate。每面 images 指定 side、sha256、width、height、reviewStatus=`visually-reviewed`、regions。每个 region 指定全局唯一 id、当前工程 refs、x/y/w/h，可用 normalized 或 pixels 坐标。旧配置的 titleZh/titleEn 不作为标注名称真值：标注名称、型号与针脚网络由当前SCH/PCB重新核对。实际照片路径只来自 frontImage/backImage。

drawioTemplate 必须为 `{path,sha256}`，指向用户明确选择并核对 SHA-256 的原始 `.drawio`/XML，不能用其 PNG 替代源文件。prepare 冻结模板文件及独立 v2 适配源码，实际读取、改写模板的 cell 并保留页面、位置与样式，按当前事实替换功能块及关系，输出模板到 cell 的审计证据。旧 `guide_drawio` 的从零 XML 重建不用于新准备的运行。

Pinout 的 pad 到照片变换与指南的接口矩形区域是两套校准。复用同一工程和原图 SHA，不将前者当作后者。板卡配置需独立准备经审核的区域与技术来源，不依赖历史四文件目录。照片与工程存在版本差异时保留说明；校准记录不证明实物批次与工程完全一致。

prepare 不调用模型、EDA 或图片导出。它核验原工程、区域/尺寸/照片、明确技术文件、固定 SDK/BSP 仓库及消费的 Git blobs、已完成四文件来源与当前审批。未知答案仅属于学习评估器；目标指南路径及已知目标 SHA 禁止进入技术资料。声明未知/重复工程衍生角色或会在打包时同名覆盖的技术资料会被拒绝。

## 具名节点

| operation | 输入端口/值 | 输出附加端口 |
| --- | --- | --- |
| hdk.guide.prepare | 八项结构化输入 | 回执 |
| hdk.guide.import-four | `{prepared}` | 回执 |
| hdk.guide.facts | `{prepared,engineering}` | annotationInput |
| hdk.guide.drawio | `{facts}` | 回执、实际图片产物 |
| hdk.guide.annotate-front-zh | `{facts,plan}` | 回执、实际图片产物 |
| hdk.guide.annotate-front-en | `{facts,plan}` | 回执、实际图片产物 |
| hdk.guide.annotate-back-zh | `{facts,plan}` | 回执、实际图片产物 |
| hdk.guide.annotate-back-en | `{facts,plan}` | 回执、实际图片产物 |
| hdk.guide.author-input | `{facts,images}` | skillInput |
| hdk.guide.assemble | `{author,plan}` | 回执、Markdown/HTML/全部打包产物 |
| hdk.guide.verify | `{bundle}` | qualitySummary、outputPath、zhPath、enPath、reportPath，学习时另有 learningComparison |

表中 prepared/engineering/facts/author/bundle 都是当前运行的完整能力回执 token。facts 的 annotationInput 接“接口标注”Skill，其完整 JSON 输出 plan 同时接四个 annotate 节点；DrawIO 与四图可并行，各写自己节点及版本目录。plan 必须来自当前 complete Skill 节点、与对应实际输入完全相同，记录其 Skill 引用和版本。

四个标注与 DrawIO 回执 merge 为 `{frontZh,frontEn,backZh,backEn,diagram}`，经过一个 human 节点后，其完整输出连接 author-input 的 images 端口。author-input 核验五个不同实际 PNG 的当前审批与 SHA，才给作者 Skill 生成 skillInput。作者 Skill 完整 plan 接 assemble，与 author-input 回执共同打包。assemble 与 verify 再检查当前审批与实际图像；修改/重跑由通用 DAG 引擎管理。

标注Skill的 style 新增 `orientation:"horizontal"`、`connectors:"straight"`，旧计划缺省也采用这两个v2布局值。其它方向/折线模式拒绝。每个区域的中英名称须从 annotationInput 提供的源名称候选选择，工具追加实际器件型号、固定真实位号；针脚网络作为只读映射证据，不凭区域名称猜电气功能。

竖向原照片先做90°顺时针无损像素转置，使用同一仿射矩阵转换已核区域，文字独立保持横向；不旋转已有标签成品、不重采样照片。工具以实际字体测量寻找无文字遮挡、不会横穿其它已标区域的锚点和标签位置，仅用OIM现有字段使实际引线路径各点共线。真实导出后重新读取源PNG、内嵌图、矩形坐标、元件映射及SVG每条引线的端点/共线性，要求实际PNG/SVG横宽大于高度，失败不能靠布尔回执放行。未标注的其它小元件仍需要单独的人工位置校准；不能把11个已校准区域说成当前工程60个元件全部标完。

## 外部四文件与证据

必须显式选择 v2 四文件 verify 的版本目录。通过数据库核验已完成普通执行的当前节点 token、实际 attempt 目录、回执 SHA、全部源与证明文件 SHA，并重验其源 prepare 的原图与产品。不能导入 learning-candidate、等待审核、旧报告、过期版本或当前已撤销审批。后续每个能力再次核对外部回执与审批。

导入工程角色为 SCH PDF、STEP、DWG、CAD PNG、正反 Pinout PNG。导入节点用 pypdfium2 实际栅格化 SCH PDF 第一页作为预览，保留完整原 PDF，写转换说明与 source-bound import 清单供旧事实提取器使用。不会根据照片重画电路。

OpenInterfaceMark 仍执行固定版本的实际浏览器导入/保存/PNG+SVG 导出，DrawIO 仍执行实际桌面 CLI。适配额外重读实际 OIM 工程、PNG、SVG 标签和内嵌原图；DrawIO 仍从当前事实重建 XML 并验证 PNG/SVG 的内嵌图。所有上游文件和本轮实现文件 SHA 都进入依赖链，不用新的自声明哈希覆盖原产物 SHA。

## 结果与学习边界

每个能力独立写 `receipt.json`，不能覆盖。目录由通用文件服务提供，兼容默认输出根和自定义输出根。指南包位于 assemble 的版本目录；verify 版本目录保存验收报告，同时登记完整指南包产物，供预览/下载。中间五张图在各生成节点完成时即可输出并等待审核。

普通执行要求原有 24 项真实检查全部通过。学习可以将叙述深度、章节/说明等质量不足作为未合格候选反馈；源表、命令、实际本地资产、双语源表一致、真实导出和源变化仍为硬错误。仅受限 Skill JSON/schema 失败可标记 LEARNING_INVALID_PLAN；转换器、源文件、校准、Git/SDK、文件系统错误不能伪装成可学习质量分。

目标 Markdown 只由学习 evaluator 的 build_learning_expected 读取。验证集反馈不传优化器，继续使用控制器的原始只读 memory 快照和重启恢复。普通执行继续使用 Hermes 的记忆更新机制。

自动测试使用隔离的真实 ZIP/PNG/PDF/Git/SQLite，覆盖输入、导入、版本、Skill 及审核哈希边界。协议、图形 fixture 不能代替实际 EDA、浏览器或 DrawIO 业务验收。迁移后的 DAG 仍需使用者以自己的资料运行并逐图审核，不能继承旧实现的放行证明；BSP 配置与实物芯片版本、存储器的匹配情况需另行核对，physicalTestStatus 只依据真实硬件测试记录。

修改布局适配、模板或配置会改变依赖 SHA。已经冻结旧源码、配置的运行不能直接重画后续节点绕过输入校验；应从新的准备快照重新运行，保留原驳回与历史版本。测试不会替用户批准图片。
