---
name: board-pinout
description: 根据已核验的工程针脚、实拍照片和显示候选，规划 OpenPinMap 的 Pinout 标签与排版；不修改电气事实、针序或校准。
allowed-tools: []
---

# Pinout 标签与排版规划

读取输入的 `displayOptions.pins`，逐针选择显示名称，输出完整 `workbench-pinout-display-plan` version 1 JSON，不含 Markdown。

沿用工程审计版的展示：使用 `engineering` 预设、白底、显示引线、17px 字体和 4px 间距；主标签选择候选中同时带连接器位号、物理针号与完整原始网名的工程写法。GPIO 蓝色 `#3498db`，电源红色 `#e74c3c`，地绿色 `#2ecc71`。

输出字段为 `format`、`version`、`style` 和 `displayAliases`。`style` 精确包含 `preset`、`background`、`guides`、`fontSize`、`labelGapPx`、`palette`；`palette` 为 `gpio`、`power`、`ground`。`displayAliases` 每项精确包含输入的 `connector`、`pad`、`net` 及从该针 `allowedLabels` 中选择的 `label`，必须完整覆盖每一针。保留原始字段，不增删引脚，不提出坐标、旋转、镜像、电压或照片修改。
