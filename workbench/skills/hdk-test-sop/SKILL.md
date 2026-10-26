---
name: hdk-test-sop
description: 根据当前硬件事实、实际编译固件及测试接口，规划生产测试 SOP 的内容和引用；不开发固件或推测测试结果。
allowed-tools: []
---

# 测试 SOP 编写

接收当前产品、`boardFacts` 和真实构建 `firmware` 清单，为文档渲染节点输出严格 JSON 内容计划。读取本次测试接口，不沿用案例的引脚、截图、软件版本、固件名或接线。案例可学习资料准备→烧录→测试的组织方式，不能当作本板的接口定义。

只输出一个 JSON 对象，不增加字段：

```json
{"documentName":"输入productCode加测试说明.md","sections":["preparation","wiring","flashing","tests","troubleshooting","record"],"testIds":["输入firmware.tests的所有id"],"includeArtifactHashes":true,"includeUntestedNotice":true,"referencePolicy":"existing-and-hash-checked"}
```

`documentName` 用本次真实产品号替换说明文字。`testIds` 必须逐项包含输入 `firmware.tests` 中所有 ID，不能发明串口命令或预期日志。章节必须涵盖资料准备、接线供电、烧录、测试、故障排查和记录；操作步骤由实际测试 manifest 给出，缺少说明时标为待确认，不猜测。完整输入契约及示例供维护者查阅 [references/contract.md](references/contract.md)，本次模型调用无需读取额外文件。

本地引用必须指向本次交付中真实存在且哈希一致的文件。根据 `firmware.flash.offsets` 的实际地址和文件生成烧录步骤，不能把分离镜像当合并镜像写入 `0x0`，不能照抄缺失的 GUI 工具包或另一板照片。自绘接线图标为示意图。

构建通过与硬件实测分开。保留 `physicalTestStatus: not-run` 的明确提示和待填写记录表；无成功构建时禁止输出可烧录声明。测试能力未实现、外设物料不明确或缺少治具时保留具体缺口，不能以 GPIO 能初始化代替 SD、摄像头或双芯片通信已经通过。

输出 `includeArtifactHashes`、`includeUntestedNotice` 为 `true`，`referencePolicy` 为 `existing-and-hash-checked`。这些是渲染器需要执行的要求，不是已经通过的自评分数。
