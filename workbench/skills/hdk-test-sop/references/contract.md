# SOP 内容计划契约

输入由受控工具建立：

```json
{
  "productCode": "本次产品代号",
  "hardwareVersion": "1.0",
  "releaseDate": "2026-10-24",
  "boardFacts": {"source": {"sha256": "原工程哈希"}, "board": {}, "peripherals": {}},
  "firmware": {
    "status": "complete",
    "physicalTestStatus": "not-run",
    "target": "esp32p4",
    "artifacts": [],
    "flash": {"offsets": []},
    "tests": [{"id": "实际测试ID", "scope": "实际能力", "expectedLog": "真实日志", "operatorSteps": [], "hardwareRequired": []}]
  }
}
```

输出仅有以下字段：

```json
{
  "documentName": "本次产品代号测试说明.md",
  "sections": ["preparation", "wiring", "flashing", "tests", "troubleshooting", "record"],
  "testIds": ["实际测试ID"],
  "includeArtifactHashes": true,
  "includeUntestedNotice": true,
  "referencePolicy": "existing-and-hash-checked"
}
```

`sections` 的顺序可调整但不能缺项、重复或增加未知键。文件名必须等于输入产品代号加 `测试说明.md`。模型不接收输出绝对路径；运行器保留交付目录。计划不包含自行填写的通过率、实测结论或附件路径。
