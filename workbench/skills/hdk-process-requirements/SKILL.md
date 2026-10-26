---
name: hdk-process-requirements
description: Select a manufacturing profile for an HDK process-requirements workbook from current EDA facts and a supplied template. Return structured profile data for the fixed workbook tool; use for process-table preparation, not EDA redesign, firmware or test instructions.
allowed-tools: []
---

You receive `facts`, `profileSchema` and `referenceProfile` from `prepare_process_request`. Return one JSON object conforming to `profileSchema`, without Markdown or a wrapper. The fixed `generate_process_requirements` tool writes the workbook. Do not write files or claim validation yourself.

Use the current source as the authority for identity, revision, enabled copper layers, physical stack and geometry. A capability-template label such as “Two Layers” can be stale. Board dimensions come from native board-outline coordinates, not old dimension strings, project descriptions or the example board. These source facts cannot be overridden by the profile.

Reuse the supplied example's non-geometric manufacturing preferences when appropriate: solder-mask/silkscreen colors, surface finish, Tg, electrical test and packaging. They are configurable manufacturing requirements, not observed physical properties or completed tests. Nominal board thickness and nominal copper weight may differ slightly from the source's modeled thickness; keep their nominal meaning. Use order quantity/delivery date only when supplied; the fixed tool writes “按采购订单” otherwise.

Choose impedance targets only for interfaces present in the source. USB differential 90 Ω ±10% is the example's requirement. When present, ESP32-P4 MIPI differential 100 Ω ±10% and SDIO single-ended 50 Ω ±10% follow the [official layout guidelines](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32p4/pcb-layout-design-esp32p4.html). These are manufacturing targets, not proof that the existing routing achieves them. The fixed tool redraws actual source nets and layers; never copy another board's “third layer” image.

The template contains two sheets and 45 native form controls. Do not replace them with cell text, force every future board to four layers, add a gold thickness to a non-gold finish, or describe via cover-mask as via filling. Leave native-control mechanics and independent reread validation to the fixed tool.

Example profile for the paired S31 format-training case:

```json
{"schemaVersion":1,"nominalThicknessMm":1.6,"innerCopperOz":0.5,"outerCopperOz":1,"solderMaskColor":"哑光黑色","silkscreenColor":"白色","surfaceFinish":"无铅喷锡","tg":"Normal TG(130度以上","viaMask":"from_file","impedanceTargets":[{"name":"USB","netPattern":"USB","kind":"differential","targetOhms":90,"tolerancePercent":10}]}
```

For a new board, adapt this profile using its supplied facts and schema. Do not return geometry, layer count, arbitrary paths, tool commands, golden-answer content or a pass/fail score.
