# OpenStep2DWG 转换适配器

`scripts/openstep2dwg-convert.mjs` 调用用户指定的 [OpenStep2DWG](https://github.com/geekheart/OpenStep2DWG)，固定版本为 `afd6a844e39ba0a205918dc866b60211f978b2b9`（1.0.1）。适配器启动隔离、无持久缓存的本地 Chrome，使用上游原有 STEP 导入、精确隐藏线投影和 DWG 编解码 Workers。源文件不上传，转换时只允许本地静态资源 GET。

## 安装与就绪检查

在工作台目录中使用 Node.js 24、桌面 Chrome 和 Python 3.12+：

四文件工作流可一次准备两个转换器。首次安装或重建前停止正在进行的转换；当前已就绪时只运行 `--check`：

```sh
node scripts/prepare-four-files-converters.mjs --check
node scripts/prepare-four-files-converters.mjs --install
```

`--install` 固定 OpenStep2DWG 为 `afd6a844e39ba0a205918dc866b60211f978b2b9`、OpenPinMap 为 `de6196839c6cf8126f4bf29b9792f73c17013b44`，使用各自 `package-lock.json` 重建静态依赖，并按 `requirements-cad-qa.txt` 准备独立验证环境。已有上游跟踪文件被修改时拒绝覆盖；安装后写入 `.local/converters/prepared.json`。`--check` 不启动浏览器、不安装或重建文件。

也可以手动准备单个 CAD 转换器：

```sh
git clone https://github.com/geekheart/OpenStep2DWG.git .local/converters/OpenStep2DWG
git -C .local/converters/OpenStep2DWG checkout afd6a844e39ba0a205918dc866b60211f978b2b9
cd .local/converters/OpenStep2DWG
npm ci
npm run build
cd ../../..
python3 -m venv .local/converters/qa-python
.local/converters/qa-python/bin/python -m pip install -r scripts/requirements-cad-qa.txt
node scripts/openstep2dwg-convert.mjs --check
```

只有 `ready: true` 且进程退出码为 0 才可执行。检查包括 Node 24、Chrome、Playwright、构建后的 OCCT/DWG WASM、固定且未修改的上游源码、独立 ezdxf 1.4.3 环境。无需 FreeCAD、ODA 或 Autodesk。

## 调用约定

```sh
node scripts/openstep2dwg-convert.mjs \
  --input /absolute/path/source.step \
  --output-dir /absolute/path/new-output \
  --basename BOARD_CAD_V1.0_2026-10-24 \
  --title BOARD \
  --drawing-number BOARD_CAD \
  --revision V1.0 \
  --date 2026-10-24 \
  --rotation 0 \
  --layout inspection \
  --detail full \
  --timeout-ms 900000
```

`inputStep/outputDir/basename/date` 为必填。可通过 ESM `convertStepToCad(options)` 传入相同驼峰字段，以及 `signal: AbortSignal`、`onProgress(text)`。`cadDependenciesStatus()` 可独立查询依赖。

- `rotation`：0、90、180、270，默认 0，不按产品名或文件名分支。
- `layout`：`inspection` 为正面、背面、前侧；`first-angle` 为正面、前侧、左侧。默认 `inspection`。
- `detail`：默认 `full` 保留完整几何。`mechanical` 按上游通用薄层规则简化，需检查移除数量和结果。
- 图纸为 A4 横向，坐标与尺寸均为毫米，自动排版。标题、图号、版本、日期写入图纸及可编辑项目。
- 进度在 stderr；stdout 为小于等于 64 KiB 的 JSON 摘要。完整投影几何只在项目文件中。
- 输出目标同名文件存在即报错；失败清理暂存产物，不覆盖已有交付。

## 产物与核验

同 basename 生成 `.dwg`、`.dxf`、`.svg`、`.png`；`.openstep2dwg.json` 可在原项目继续编辑；`.roundtrip.dxf` 为最终 DWG 的真实解码；`.cad-verification.json` 为独立几何验证；`.conversion.json` 为来源、版本、设置和所有产物 SHA-256 清单。

成功必须同时满足：本次全新 STEP 转换，输入 SHA 与上游保存的投影来源一致，三个视图非空，请求的方向/细节/单位一致；最终 DWG 头为 AutoCAD 2000 `AC1015`，在浏览器 Worker 中回读后原生实体数一致；ezdxf 比较 DXF 与最终 DWG 回读的原生直线、圆弧、圆、样条、文字、尺寸等签名，精度 7 位小数，差异为 0、CAD audit 错误为 0、单位为毫米。输入在转换期间变化则失败。

上游输出是二维工程 DWG，自动尺寸为整体包络尺寸。不能自动推断制造公差、基准或装配要求。曲线若按 0.01 mm 公差离散，清单会报告数量。内部与独立回读验证不能代替目标 CAD 软件的全部兼容性测试。

## 许可

上游应用为 MIT；OpenCascade.js 为 LGPL-2.1，OCCT 含相应例外；acadrust 为 MPL-2.0。适配器不修改几何算法；保留 `.local/converters/OpenStep2DWG/LICENSE`、`THIRD_PARTY_NOTICES.md`、`docs/licenses/` 与可替换 WASM 的源码和构建说明。公开交付应用时应一并附上上游及第三方许可，不把私人源 STEP 或本地回归产物加入仓库。
