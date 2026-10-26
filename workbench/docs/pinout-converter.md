# 原生工程到 Pinout

`hdk/pinout_facts.py` 和 `scripts/openpinmap-convert.mjs` 分别负责电气/几何事实准备与图片渲染。OpenPinMap 不读取 SCH、STEP 或 epro2，也不推测引脚连接。`hdk/pinout_pipeline.py` 增加独立的 Pinout 工作流，并提供四文件工作流共用的 `prepare_plan_input()`、`checked_skill_plan()`、`render_photo_plan()`；两条流程使用同一个受限排版接口和真实渲染器。

## 独立执行与学习

在看板新建独立 Pinout 流程，通过节点库配置输入、源工程/照片准备、`board-pinout` Skill、OpenPinMap 渲染、人工图片审核、验收与输出，并按需连接评价和 Skill 改进支路；也可以导入自己备份的工作流文档。普通执行跳过学习支路，按节点中固定的 `skillRef` 与内容哈希版本运行，不会在执行中修改 Skill。

本机历史 `hdk/pinout.workflow.json` 和 `hdk/pinout-input-p4c61.json` 是个人案例，不随代码发布。历史串行接口除 epro2、两面原图、已核验照片配置与发布参数，还接收已完成四文件运行中的 `nativeReportPath`、准确的 `nativeReportSha256`，以及 `viewSides`（`["front"]`、`["back"]` 或两面）。执行器核对 SQLite 中的原生运行、私有回执和当前工程 SHA，拒绝将任意历史报告冒充当前编号焊盘证据。当前 DAG 由原生资料节点显式提供对应事实和回执，不能用另一个项目的报告替代。

训练输入、已知结果、训练集与验证集通过学习面板配置，并明确指定可改进的 Skill 节点。一次性生成历史案例的脚本已移除；导入个人备份后应核对 Skill 引用和固定版本。使用同一块板的正面训练、背面验证时，验证范围是另一视角的布局、翻面方向与标注一致性，不能声称已验证独立板型泛化。

学习沿用工作台已有的同批次只读 memory 快照机制：训练执行、验证执行、评分与优化均禁止记忆写入及外部记忆工具；验证输入、输出、得分与反馈不进入 Skill 优化提示。S31 参考特征只进入 evaluator 的 expected 与优化目标，不加入普通执行事实或 Skill 的原始能力输入。普通执行保留原有 Hermes 记忆更新机制，Skill 版本仍固定。

## Skill 能修改的展示计划

准备工具从当前工程产生 `displayOptions`，提供每个引脚的确切 `connector`、`pad`、`net` 和有限的 `allowedLabels`。Skill 只输出 `workbench-pinout-display-plan` v1：

```json
{
  "format": "workbench-pinout-display-plan",
  "version": 1,
  "style": {
    "preset": "reference-compact",
    "background": "transparent",
    "guides": false,
    "fontSize": 12,
    "labelGapPx": 3,
    "palette": { "gpio": "#3498db", "power": "#ff0000", "ground": "#2ecc71" }
  },
  "displayAliases": [
    { "connector": "J1", "pad": "1", "net": "GND", "label": "GND" }
  ]
}
```

以上只说明结构，示例的一行不能替代真实完整引脚清单。`preset` 可选 `engineering` / `reference-compact`，背景可选 white / transparent，字体为 12–18，照片边距为 0–8 px，配色必须明确提供 GPIO / power / ground 三个六位色值；每条显示别名必须从相应源引脚的候选中选择，且覆盖全部引脚一次。工具严格拒绝额外字段、改网、重复/缺失针脚和未经核验的别名。

Skill 不能修改源网络、物理针号、照片、校准点或焊盘几何。紧凑预设按原照片 100% 像素比例排版；其余背景、字体、主标签、颜色与是否使用引线由 Skill 的有效计划选择，是否符合目标由真实导出验收决定。主标签可以简化，最终项目仍保留 `_pin`、`_net`、源焊盘与图像坐标；`workbenchAlignment.displayPlan` / `aliasMapping` 及转换回执保留本次展示计划。未知 LDO 的网名不构成电压证据。

## 实拍图准备接口（当前工作流）

```python
from hdk.pinout_facts import prepare_photo_pinouts

result = prepare_photo_pinouts({
    'sourcePath': '/absolute/board.epro2',
    'images': [
        {'side': 'front', 'path': '/absolute/front.png', 'sha256': '<exact SHA-256>'},
        {'side': 'back', 'path': '/absolute/back.png', 'sha256': '<exact SHA-256>'},
    ],
    'photoProfilePath': '/absolute/reviewed-photo-calibration.json',
    'nativeMetaPath': '/absolute/native-report.json',
    'outputDir': '/absolute/run/.pinout-preparation',
    'productCode': 'WT9932P4C61-TINY',
    'hardwareVersion': 'V1.0',
})
```

返回 `views` 中两份准备回执。每面用完整实拍原图上的控制点独立拟合，并用另外的检查点验证误差及针号；两面矩阵方向必须相反。照片校准配置由使用者放在私有工作环境中，仅适用于其中绑定的准确工程和照片，仓库不附带本机案例配置。

四文件流程把原图保留在交付目录 `sources/photos/`，独立 Pinout 流程保留在 `sources/`。项目内只裁掉透明空白；`facts.photograph`、`workbenchAlignment.photograph` 和转换回执共同记录原图 SHA、`cropBox`、派生图 SHA、配置 SHA、面别及历史版本注记。最终重新裁剪原图并逐像素比较，不只相信 `pixelsUnchanged` 标志。主标签采用 Skill 选出的合法显示别名，位号、针号和原始网络留在可编辑项目与事实文件中追溯。未提供展示计划的历史接口仍保留 `J3.1 · GND` 工程标签，不能据此声称已经达到参考样式。

## 原生 PCB 准备接口（历史兼容）

```python
from pinout_facts import prepare_pinout

result = prepare_pinout({
    'sourcePath': '/absolute/board.epro2',
    'boardImagePath': '/absolute/native-PCB-top.png',
    'outputDir': '/absolute/run/.internal/pinout-preparation',
    'productCode': 'WT9932P4C61-TINY',
    'hardwareVersion': 'V1.0',
    'nativeMetaPath': '/absolute/native-report.json',
})
```

CLI：`python3 hdk/pinout_facts.py --request request.json`。不传参数时从 stdin 读取同样的 JSON 对象。stdout 只有 JSON，返回 `status`（`ready` 或 `blocked`）、`validated`、`factsPath`、`projectPath` 和 `pinCount`。阻断时仍保存源事实与原因，不生成貌似成功的 Pinout 项目。

默认自动识别具有明确位号、等距单排镀通孔封装的外部排针，P4C61 原工程对应 J3/J4。可用 `connectorDesignators` 显式限制，但仍必须满足几何和完整 PAD_NET 校验。针脚身份与网络直接来自此输入工程的 `PAD_NET`，显示名称只能选用基于这些网络生成的有限候选；不会使用 OpenPinMap 内置 P4/S31 示例。

`nativeMetaPath` 可含 `pinoutEvidence` 对象，或直接是该对象：

```json
{
  "sourceSha256": "输入 epro2 的 SHA-256",
  "pcbUuid": "原生 PCB UUID",
  "view": "top",
  "coordinateFrame": "pcb-data-mil",
  "image": { "sha256": "PNG SHA-256", "width": 640, "height": 480 },
  "worldToPixel": [1, 0, 0, -1, 0, 480],
  "calibration": { "passed": true, "maxErrorPx": 0.5 },
  "controlPoints": [
    { "world": [0, 0], "pixel": [0, 480] },
    { "world": [100, 0], "pixel": [100, 480] },
    { "world": [0, 100], "pixel": [0, 380] }
  ],
  "componentPads": [{
    "componentId": "输入工程的 component ID",
    "designator": "J3",
    "pads": [{ "parentComponentId": "同一个 component ID", "number": "1", "net": "GND", "x": 100, "y": 200 }]
  }]
}
```

矩阵约定：`pixelX = a*worldX + c*worldY + e`，`pixelY = b*worldX + d*worldY + f`。文档中的数值仅说明字段，不可冒充真实校准。必须提供至少 3 个非共线的真实控制点，校准最大误差不超过 1.5 px。原生绝对焊盘坐标/编号与源封装的局部焊盘、组件旋转/层镜像必须一致。底面排列存在针号歧义时明确阻断。

可传 `profilePath` 代替原生元数据，要求同样的源 hash、图像 hash、坐标、编号和校准证据，并明确 `alignmentVerified: true`。它用于已经人工核验的特殊布局，不关闭校验。

## 渲染接口

```js
import { convertPinout } from '../scripts/openpinmap-convert.mjs';

const result = await convertPinout({
  projectPath: '/absolute/run/.internal/pinout-preparation/WT9932P4C61-TINY_Pinout_V1.0.openpinmap.json',
  outputDir: '/absolute/run/delivery',
  basename: 'WT9932P4C61-TINY_Pinout_V1.0',
  signal,
  onProgress: text => process.stderr.write(text + '\n'),
});
```

CLI：`node scripts/openpinmap-convert.mjs --project /absolute/bound.json --output-dir /absolute/delivery --basename WT9932P4C61-TINY_Pinout_V1.0`。依赖检查：`node scripts/openpinmap-convert.mjs --check`，不启动浏览器。

转换器固定 OpenPinMap commit `de6196839c6cf8126f4bf29b9792f73c17013b44`。默认源码目录为 `.local/converters/OpenPinMap`，先执行其 `node scripts/build.mjs`；Playwright Core 默认复用 `.local/converters/OpenStep2DWG/node_modules/playwright-core/index.mjs`，可通过函数参数 `repository`/`playwrightPath` 指定。使用系统 Google Chrome 的独占临时 headless 上下文，不连接或改变用户现有浏览器。

专属 localhost 只提供当前绑定项目与已固定的上游静态代码；所有外网、写请求和 Service Worker 均被阻止。准备项目的标签中心会按实际 Canvas 字体度量校准到源焊盘的投影顺序，确认不重叠、不越界后导出。

产物包括 PNG、SVG、可重新编辑的 `.openpinmap.json` 和 `.conversion.json`。逐项检查项目读回、源 hash、PNG 尺寸、SVG 标签数量与完整嵌入底图。发布使用 no-overwrite 的原子硬链接；转换失败回滚本次发布的文件。准备目录与正式交付目录应分开，避免覆盖同名项目 JSON。

## 实际图片的 13 项评价

`hdk/pinout_learning.py` 重新解码最终 PNG、解析真实 SVG，并逐项核对最终保存项目和本次源事实，生成 `qualitySummary`、逐针 `labelInventory`、测量指标与 `diagnostics`。比较模型收到文本证据及图片指标，不等于直接看过 PNG；不得把项目的自报通过、单个 hash 或首行高度一致当成图片合格。

| 检查 | 实际证据 |
| --- | --- |
| 导出可读 | PNG 解码、SVG 元素、最终画布尺寸 |
| 透明竖版 | 最终 PNG 的长宽与真实 alpha 像素比例 |
| 原照片保留 | 内嵌图片对照原图裁剪的逐像素比较，以及最终 PNG 照片采样 |
| 原始照片分辨率 | 实际输出照片/原始照片的缩放比例 |
| 源引脚追溯 | 完整连接器、针号与原网名清单对照当前 epro2 事实 |
| 可见标签一致 | 实际 SVG 文字/颜色、保存项目及 PNG 胶囊位置采样 |
| 简洁主标签 | 实际主标签长度，避免工程长 trace 充当主标签 |
| 多芯片与特殊信号 | 主控/C61 归属及源网络已证明的 BOOT、EN、RX、TX 角色 |
| 参考配色 | 实际胶囊颜色与 S31 参考颜色的对照 |
| 紧凑且可读 | 实际胶囊/照片宽度、字体/针距比例 |
| 孔行或引线对应 | 实际标签行中心、所属照片边、真实引线端点与校准焊盘的距离 |
| 无遮挡裁切 | 真实 SVG 胶囊互相重叠、侵入照片及画布越界检查 |
| 双面电气一致 | 最终双面源引脚清单一致；单视角训练/验证则核验所选视角 |

S31 参考本身没有引线，因此紧贴照片且对应孔行的无引线标签可接受；如果选择保留引线，实际端点必须到达对应孔位，不能只停在照片矩形边缘。完整指标报告保留全部证据，压缩后的 `learningComparison` 进入评价节点；学习允许展示缺陷以诊断形式触发 Skill 改写，普通执行验收失败则停止。自动检查之后仍须实际查看两面最终 PNG，报告中的 `visualReview: required` 不代表已完成视觉审核。学习隔离与轮次指标见[学习协议](learning-protocol.md)。

历史接口保留原生 2D PCB 底图的解释和重读能力，不将其称作实拍图。新四文件预检要求两面实拍图，不静默退回历史底图。
