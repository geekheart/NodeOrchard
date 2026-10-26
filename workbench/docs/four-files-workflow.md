# epro2 四文件工作流

四文件交付是独立执行流程，源文件是输入的原始 epro2，原工程与参考案例只读。当前工作流在看板和节点编辑器中管理；以下示意说明业务职责，历史串行节点名称和数量不代表当前 DAG 布局。

```text
原始 epro2、正反面实拍图与发布参数
  → 工程 ZIP / 文档 / 原图 SHA / 照片校准 / 转换依赖预检
  → 独占本地副本导出 SCH PDF、STEP 与校准 PCB 俯视 PNG
  → OpenStep2DWG 生成三视图 CAD
  → 从 PAD_NET、封装和原生编号焊盘提取事实，独立校准两面实拍图
  → Pinout Skill 选择合法主标签与有限排版计划
  → OpenPinMap 在实拍图上导出正面、背面 Pinout
  → 四项来源/回读验收 + 真实 PNG/SVG 的 13 项 Pinout 展示评价
  → 成果路径与验收报告
    ↘ 参考样式评价 → 改进 Pinout Skill（仅学习模式）
```

执行模式运行交付业务并跳过学习支路；学习模式只允许改进选定的 Pinout Skill。当前编辑器支持按依赖并行执行，图片由明确的人工审核节点阻塞确认。SCH、STEP 与 CAD 的确定性转换继续保留。

Pinout 网络和针序来自当前工程，Skill 不可修改电气事实，只能选择工具给出的有限 `allowedLabels` 及受限展示样式。当前自动支持规则的单排通孔连接器，模糊针序、未知图像朝向和未校准底图会停止，保留已成功的成果与阻断证据。新的板型可在已有事实之上增加经核验的 profile。

独立 Pinout 流程可复用已核验的原生编号证据，专门迭代图片排版。它与四文件流程共用展示输入、真实 Skill 回执核验和渲染能力，不维护另一套 Pinout 渲染逻辑。本机历史 `hdk/*.workflow.json`、输入和学习案例属于个人资料，不随代码发布。已有的 S31 样式与 P4C61 正反面案例只验证特定视角的一致性，不证明独立板型泛化。详见 [Pinout 集成与学习](pinout-converter.md)。

## 使用

1. Node 24 执行 `node scripts/prepare-four-files-converters.mjs --check`。若缺依赖，执行 `--install`，按固定 commit 下载并构建两个上游项目及隔离 CAD 验证依赖。详见 [CAD 集成](openstep2dwg-integration.md)、[Pinout 集成](pinout-converter.md)。
2. 在看板新建流程，通过节点库放置输入、原生导出、CAD、Pinout Skill、实拍标注、人工审核和验收节点，按端口依赖连线；也可以导入自己备份的工作流文档，逐项核对其输入路径、工具、Skill 引用和固定版本。仓库不附带本机业务工作流或自动生成它们的脚本。
3. 配置输入节点的工程、正反面照片、已审核校准文件与发布参数，再在运行面板执行。下例是历史接口的输入结构说明，不是随仓库提供的真实案例。除原生 EDA 导入所需资源外，两个转换器仅访问独占的本地静态服务器，不上传工程到在线站点，不使用用户现有浏览器上下文。

```json
{
  "sourcePath": "/absolute/path/input.epro2",
  "productCode": "WT9932P4C61-TINY",
  "hardwareVersion": "1.0",
  "releaseDate": "2026-10-24",
  "cadRotation": 0,
  "cadLayout": "inspection",
  "cadDetail": "full",
  "images": [
    { "side": "front", "path": "/absolute/front.png", "sha256": "准确的原图 SHA-256" },
    { "side": "back", "path": "/absolute/back.png", "sha256": "准确的原图 SHA-256" }
  ],
  "pinoutPhotoProfilePath": "/absolute/reviewed-photo-calibration.json"
}
```

`cadRotation` 为 0/90/180/270；`cadLayout` 为 `inspection`（正面、背面、前侧）或 `first-angle`；`cadDetail` 默认为 `full`，可显式选择 `mechanical`。自动尺寸是整体包络尺寸，不推断机械公差或装配基准。新运行必须提供两张 PNG/JPEG 实拍图和 `pinoutPhotoProfilePath`；配置绑定准确工程、两张原图 SHA、实测控制点和实际编号焊盘。更换板型或照片需重新审核校准，不能只替换路径。

当前运行的产物位置以运行记录为准，原件与用户可见的交付副本分开保存；历史串行兼容执行器仍使用 `workspaces/four-files/<runId>/`，不会覆盖现有成果。四项主文件沿用案例命名：

- `<product>_SCH_V<version>.pdf`
- `<product>_3D_V<version>.step`
- `<product>_Pinout_V<version>.png`
- `<product>_CAD_V<version>.dwg`

四类成果中的 Pinout 另提供 `<product>_Pinout_Back_V<version>.png` 背面图。保留 SVG / DXF / PNG 预览、两面 OpenPinMap 与 CAD 可编辑 JSON、完整实拍原图及校准配置副本、引脚事实、原生证据、CAD 回读结果、`四文件验收.json` 及 `Pinout样式验收.json`。四文件验收记录本次 Skill 引用/版本，展示计划也保留在比较结果和可编辑项目中。节点端口只传本次运行的小回执，不通过大模型或节点 JSON 传递 34 MB STEP。

## 学习与版本边界

`board-pinout` Skill 输出有限 schema 的展示计划：预设、背景、引线开关、12–18 的字体、0–8 px 的标签边距、三类配色和逐针合法别名。共享工具拒绝改网、改针号、照片替换、校准/几何改写、缺针及非候选别名，最终项目保留 `_pin`、`_net` 和真实坐标。紧凑预设按原照片 100% 像素比例生成。

学习实际运行导出，再由固定工具读最终 PNG/SVG，检查透明竖版、照片像素/清晰度、简洁标签、双芯片与 BOOT/EN/UART 角色、参考配色、字体/针距、真实孔行/引线端点、遮挡裁切和源引脚一致性等 13 项。图片 hash 或自报 `passed` 不能替代这些检查。展示缺陷在学习中作为真实诊断反馈；执行模式若未达到展示要求则停止，不把失败图片作为合格成果。

学习采用同批次只读 Hermes memory 快照，禁止持久记忆写入和外部记忆工具；验证集输入、输出、评分及反馈不进入 Skill 优化提示，避免通过记忆泄漏答案。普通执行仍允许原有记忆更新，但按工作流文档中的内容哈希固定 Skill 版本。学习候选应用到四文件流程时，`four-pinout-skill` 必须引用对应的已发布 Skill 及准确版本，不能只替换成果图片或依赖“最新版本”。本说明不代表某轮学习已经达到目标或已经发布。

## 真实性与可读性边界

- SCH 指原理图 PDF，不是把 epro2 重命名成 `.sch`。原生矢量 PDF 的字体资源会逐项审计；字体完整时原样保留。本机若发生中文缺字，则重新导出同一源图页的原生高分辨率 PNG，无损封装为同纸张尺寸的 PDF，保留原矢量文件与逐页像素哈希；不重建文字，不修改电路图元。该兼容 PDF 的文字不可选择，实际约 200 dpi，不伪称 300 dpi。
- STEP 直接由本次 epro2 的 PCB 导出，不用旧案例 STEP，禁用按高度自动制造缺失模型。原生导出能表示的元件模型覆盖范围仍受 EDA 支持格式与源工程关联限制。
- Pinout 底图是用户提供的真实正反面照片，两面独立校准，翻面方向相反。仅裁去完全透明边缘，不旋转、拉伸、修图或生成板卡像素；最终验收逐像素对照原图裁剪。原生 PCB 顶视图仅保留为内部编号证据。主标签使用 Skill 选出的合法简写，位号、物理针号和当前 PAD_NET 留在项目与事实文件中追溯，不使用上游默认示例；不能从未核验的内部电源网名猜电压。
- CAD 是由 STEP 经 OpenCascade 精确隐藏线投影得到的二维工程 DWG，AC1015；保留原生线、弧、样条和尺寸。少数不支持曲线如需 0.01 mm 离散，会在转换清单报告。最终 DWG 经引擎回读和 ezdxf 独立几何、毫米单位校验。
- 已知原生 STEP 可能有仅涉及设计/机械上下文的非几何缺失引用。严格限定这类警告、保留原始字节并记录；几何或装配引用缺失仍阻断。实际 CAD 内核能否导入与投影是后续必须通过的检查。
- 自动检查不取代对 PDF、Pinout 标签和 CAD 图纸的视觉审核；结果中的 `visualReview` 单独表示该状态。

上游固定来源：[OpenPinMap](https://github.com/geekheart/OpenPinMap/tree/de6196839c6cf8126f4bf29b9792f73c17013b44)、[OpenStep2DWG](https://github.com/geekheart/OpenStep2DWG/tree/afd6a844e39ba0a205918dc866b60211f978b2b9)。保留原项目与内核许可证，不重新实现或冒充其转换结果。
