# OpenInterfaceMark 标注适配

工作流通过 [OpenInterfaceMark](https://github.com/geekheart/OpenInterfaceMark) 的真实项目导入、项目下载和 PNG/SVG 下载入口生成插图，不另外实现一份标注渲染器。固定版本为 **1.0.2**，提交为 `f8f92636b2eb87ac956997e77c9239cf483913fc`，保留原仓库 MIT 许可。

## 准备与调用

本地检出位置为 `.local/converters/OpenInterfaceMark`。该版本没有第三方依赖；使用 Node.js 24 执行仓库的 `scripts/build.mjs` 即可生成 `dist/`。适配器检查固定提交、受版本控制源码是否干净，以及导出所需各文件与 `dist/` 是否逐字节一致。浏览器运行时复用已安装 OpenStep2DWG 的 `playwright-core`，每次创建独立的无头 Chrome，不接管用户正在使用的浏览器。

```sh
node scripts/openinterfacemark-convert.mjs --check
node scripts/openinterfacemark-convert.mjs \
  --project /absolute/path/front-plan.oim.json \
  --output-dir /absolute/path/assets \
  --basename board-front-zh
```

也可导入 `convertInterfaceMark({projectPath,outputDir,basename,timeoutMs,signal})`。默认超时 180 秒，范围 1–600 秒；Node 进程收到 SIGINT/SIGTERM 后关闭本次创建的浏览器并清除未完成产物。输出文件已存在时拒绝覆盖，失败时不会留下半套最终文件。一次转换只接收一张原图；正面、背面、中英文标签分别建立项目。取消操作会保留调用方的原始图片和计划。

## 调用方提供的项目

```json
{
  "format": "open-interface-mark",
  "version": 1,
  "name": "Board front — interfaces",
  "image": {
    "name": "board-front.png",
    "width": 800,
    "height": 600,
    "src": "data:image/png;base64,..."
  },
  "regions": [{
    "id": "connector-1", "kind": "rect",
    "code": "J1", "title": "Verified connector name",
    "x": 330, "y": 240, "w": 140, "h": 120,
    "labelX": 620, "labelY": 300,
    "color": "#ef4444", "dashed": true,
    "stroke": 3, "fontSize": 22, "radius": 4,
    "fontFamily": "sans"
  }],
  "exportSettings": { "background": "white", "scale": 1 }
}
```

上例只说明结构，不对应任何真实开发板。框、标签、可选引线折点均以原图像素为坐标；标签可以放在图片之外，导出边界由上游渲染器按真实字体尺寸计算。图片可选 `scale`（0.05–1）、`rotation`（−180°–180°）；不是编辑视图缩放。每个区域可选 `textColor`、`anchorSide`、`anchorOffset`、`bendX`、`bendY`，由原项目校验器检查。

原图必须是内嵌 PNG/JPEG/WebP，不接受远程图片；真实解码尺寸必须与声明相同。沿用上游限制：原图 32 MB、6400 万像素、单边 16000 px；最多 300 个区域，编号 40 字符、名称 160 字符。PNG 最大 3200 万像素，必要时上游只等比缩小。当前适配器要求至少一个真实区域和显式导出设置；若上游校验会更改或丢弃任何字段，直接报错。事实来源、证据、置信度等工作流字段保存在旁路报告，不能加入 `.oim.json`。

工具不识别硬件、不判断接口用途。调用方必须从原理图、PCB 和清晰照片核对位号、芯片、坐标及中英文名称，不能把上游内置开发板示例当作当前输入。未核实的区域不应进入最终插图。中英文项目复用相同区域与编号，仅替换标题文本；英文展开词长变化后仍需检查标注排布。

## 使用指南工作流中的照片布局

`hdk/guide_pipeline.py` 的使用指南工作流要求照片区域已由清晰照片与当前工程位号/引脚证据共同核对，并绑定原始照片 SHA-256。Skill 只选择这些既有区域的中英文标题及有限样式，不能新增器件、改写位号或重新猜测坐标。这是经过审阅的区域输入，不是图像自动识别能力；新增板卡或照片取向改变后，需要新的区域审阅数据。

工作流保留原始正反面照片，同时为文档插图确定性地等比缩小到不超过 720×950 像素，再加入白色外边距。标注框按同一比例和平移变换映射，准备后的图片连同标注保存在项目 JSON 中。PNG/SVG 的内嵌图片哈希因此对应准备后的画布，原始照片哈希与来源链另外保存在工作流事实及证据记录中；这项操作不会生成新的照片细节。

排版使用独立 Chrome 的实际字体测量结果，按物理位置排列左右列。OpenInterfaceMark 的 `labelX/labelY` 是文字基线锚点，文字对齐还受引线斜率影响；工作流显式指定左右边界锚点并保持横向主导，引线的纵向折点放在照片外的白色边距。密集器件间优先选择不会穿过其他已标注框的边界点。自动布局仍需实际检查，未被框选的器件和无法避开的密集连接不因自动检查而被视为人工确认。

## 产物与核验

每次产生 `basename.png`、`basename.svg`、`basename.oim.json`、`basename.conversion.json`。前两项来自上游下载的实际文件，JSON 可重新导入 OpenInterfaceMark 编辑。报告记录：

- 固定提交、版本、源码文件 SHA-256 和所有最终文件 SHA-256。
- 输入项目与内嵌原图的 SHA-256、图片真实尺寸、区域编号及原图像素矩形。
- 真实界面导入后再次下载项目，结构与绑定输入完全相等。
- PNG 签名与实际导出尺寸，SVG 标签数量、每一条编号与名称、原始图片内嵌匹配。
- 独立浏览器上下文，页面无异常，所有网络请求均为本地静态服务的 GET。

浏览器初次打开时上游会载入内置示例；适配器等待其初始化，然后完整导入绑定项目，只导出读回核对一致的项目。示例不会成为最终标注内容。图片和字体不上传，浏览器不能访问外部 URL。

自动检查不等于人工确认接口身份与标注美观。工作流还需实际查看最终正反面 PNG，核对框选对象、引线、字号、遮挡、裁切，以及文档与中英文插图编号是否一致。SVG 的系统字体不内嵌，跨机器阅读可能有字形差异；Markdown 默认引用 PNG，SVG 和项目 JSON 保留为编辑源。

## 验证范围

适配器自动测试覆盖不安全输出名、非法计划与空区域、静默字段丢弃、PNG 尺寸限制、预取消、离线输入和依赖缺失。可使用合成图片独立检查上游构建、项目导入、导出、读回一致性与取消清理；这类探针只证明工具通路，不代表真实板卡的接口标注已完成视觉验收。
