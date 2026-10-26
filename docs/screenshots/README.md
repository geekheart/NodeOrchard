# 公开演示截图

这些截图来自单独启动、未连接 Hermes 的演示实例。所有流程均在软件界面中新建或导入通用示例后配置，未使用个人业务工作流、真实工程资料或私人训练答案。

| 文件 | 展示内容 |
| --- | --- |
| `editor.jpg` | 通过界面搭建的文稿发布审核流程：输入、JavaScript、人工审核、输出 |
| `execution.jpg` | 通用本地数据流程真实执行完成，共六个节点，不调用模型 |
| `human-review.jpg` | 文稿流程停在人工审核，下游等待；修改意见是尚未发送的演示草稿 |
| `learning.jpg` | 学习支线与两条通用验证样例的配置，未开始训练 |
| `learning-training.jpg` | 同一演示的三条通用训练样例，未开始训练 |
| `board.jpg` | 仅包含这些新建演示的工作流看板 |
| `hermes-model.jpg` | 独立协议演示后端的顶部模型切换，使用测试服务商和模型，未访问真实 Hermes 配置 |

文稿流程由界面导出为 [`publication-review.workflow.json`](../../workbench/examples/publication-review.workflow.json)，并通过人工审核入口实际跑通四个节点。数据处理和学习配置分别使用 [`local-data.workflow.json`](../../workbench/examples/local-data.workflow.json) 与 [`multi-example-learning.workflow.json`](../../workbench/examples/multi-example-learning.workflow.json) 中的通用数据。

图片为浏览器原始截图，JPEG 格式，未合成界面、伪造运行结果或添加学习成绩。演示实例路径和运行标识仅属于临时隔离环境。
