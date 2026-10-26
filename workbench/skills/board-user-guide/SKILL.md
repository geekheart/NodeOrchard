---
name: board-user-guide
description: 基于当前板卡的可追溯工程、接口、开发与照片资料，编写中英文使用指南的说明内容；不生成测试固件或更改电路设计。
allowed-tools: []
---

# 中英文使用指南编写

本节点只编写当前输入 `facts` 支持的说明文字。后续工具把它与真实引脚表、尺寸、图片及开发命令组合成 Markdown。读者是第一次使用板卡的开发者，需要知道它是什么、如何供电和接线、如何开发、异常时如何排查。

只输出严格 JSON：
```json
{"overview":{"zh":"产品介绍","en":"Product introduction"},"features":[{"zh":"特点","en":"Feature"}],"hardware":{"zh":"硬件组成与接口使用说明","en":"Hardware and interface usage"},"power":{"zh":"供电及接线说明","en":"Power and wiring"},"preparation":{"zh":"准备开发板、数据线和开发环境","en":"What to prepare"},"development":{"zh":"开发步骤说明","en":"Development instructions"},"troubleshooting":[{"symptomZh":"现象","symptomEn":"Symptom","actionZh":"依据资料给出处理步骤","actionEn":"Action based on supplied evidence"}],"notice":{"zh":"资料范围和使用注意事项","en":"Scope and use notes"}}
```

各文字为纯段落，允许 Markdown 行内代码，不插入标题、图片、链接或引脚表。每个字段同时提供中文和英文，信息一致，中文说明总量约900–1500字，英文约600–1000词；按内容需要分段，不重复堆砌。特点4–8条，故障排查3–6条。明确区分主处理器、无线协处理器、板载器件和需要另接的显示屏/摄像头/存储卡等。没有来源的电气限制、速度、容量、兼容配件、软件版本和功能不能补写。

GPIO、芯片及接口代号来自当前事实；不沿用参考案例的板名、引脚、代码截图或驱动。引脚复用时说明需协调，不能保证外设可同时使用。若资料不支持确定供电范围，只说已核的输入路径并要求查阅原理图，不能把电源网络名当作绝对最大额定值。`physicalTestStatus=not-run` 不能写成实测通过。照片与工程的差异、缺少配件或开发步骤核验范围应在相关段落自然说明。

开发说明围绕当前 `development` 中已核的仓库、分支、板型和命令；编译成功不等于实板验证。中文和英文保留完全相同的引脚/文件/命令标识。不要输出自评、评分、学习指令、内部工作流术语或验收已通过的声明。
