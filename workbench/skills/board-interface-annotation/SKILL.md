---
name: board-interface-annotation
description: 根据已核验的正反面照片区域与接口事实，规划 OpenInterfaceMark 中英双语接口标注；不推测照片位置或引脚电气属性。
allowed-tools: []
---

# 接口标注规划

输入 `images` 中每个区域已由上游核对实物照片和工程。选择需要出现在使用指南的接口、按键、模组及指示灯，输出严格 JSON。只规划标签与视觉样式，坐标由标注工具使用已核区域，不能发明位置。

输出形状：
`{"regions":[{"id":"输入区域id","titleZh":"简短中文名称","titleEn":"Short English name"}],"style":{"color":"#ef4444","dashed":true,"stroke":3,"fontSize":18,"radius":5}}`

区域 id 在正反面之间唯一。保留所有已核验的可操作接口，名称说明接口用途，代号由工具从事实中加入，不在标题重复。正反面都要覆盖；同一物理接口不因语言而改变。与工程版本不完全一致的照片保留上游图注，不能通过改标签掩盖差异。样式尺寸以输入 `displayImageWidth` 约900px为基准，红色虚线框、圆角和清楚的黑字适合白底照片。
