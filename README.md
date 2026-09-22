# Jev SWOT / Jev 做题家

`Jev SWOT`（中文产品名：`Jev 做题家`）是一个 Chrome/Chromium Manifest V3 学习辅助扩展。它从当前网页提取单选或多选题，调用
[TypeSafe Jev](https://docs.typesafe.ai/introduction) 返回各选项概率，并使用
OpenAI 兼容模型完成截图文字结构化与按需答案解析。

首版目标运行环境为 Chrome/Chromium 109 及以上；本地 OCR 使用扩展自带的 Offscreen Document 和 PP-OCRv5，旧版 Offscreen 文档查询接口会自动走兼容路径。

## 功能

- `Ctrl/Command + Shift + Y` 后拖拽框选题目。
- `Alt + 双击`识别鼠标所在的题目容器。
- DOM 完整题目可直接通过 `Alt + 双击`分析；如果题目需要读取截图，浏览器的临时截图权限必须由框选快捷键授予。
- DOM 优先；不完整时依次尝试视觉模型和本地 PP-OCRv5。
- 本地 OCR 只负责文字与位置检测；如果配置了普通模型，会先由普通模型划分题干、选项和上下文，并明确排除“正确答案/解析/得分”等结果文字，再把确认后的结构交给 JEV。
- 即使 DOM 中已有完整题干和选项，只要检测到公式排版、图表或其他非文字视觉语义，也不会直接送入 JEV；会先要求视觉模型处理，或由用户补充/校正后再判断。
- 结果浮层默认只显示紧凑的答案提示，采用透明背景和低透明度文字；它会根据附近页面背景自动选择深浅色和阴影，悬停或展开时再增强可读性。点击右侧的详情图标后才展开概率、告警、题目校正和“答案解析”。没有普通模型时仍可离线 OCR，但必须人工校正后才会调用 JEV。
- 在结果详情中可以主动选择“普通模型答题”；如果没有配置 TypeSafe Key，也可以从 JEV 缺少密钥提示进入该路径。该模式只发送已确认的题干、上下文和选项，返回答案、教学解释、知识点和不确定性，不上传截图。
- 单选显示归一化概率，多选显示每项独立选择概率。
- 设置页可维护敏感站点禁用列表，并控制视觉模型上传截图前是否逐次确认。
- 页面访问权限默认可选；未授权时扩展按钮和框选快捷键仍可在用户主动触发后临时使用。若要直接使用 `Alt + 双击`，请在设置页显式启用任意 HTTP/HTTPS 网页访问，已打开的网页需刷新一次。
- 模型地址、模型名、能力设置和 API Key 保存在本机 `chrome.storage.local`，浏览器重启后仍会恢复；“清除 API Key”操作会同时清除会话和本机保存的密钥。扩展仍不持久化页面或截图。

## 开发

```bash
npm install
npm run models:fetch
npm test
npm run build
```

在 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，加载
`dist/`。打开扩展设置页填写 TypeSafe API Key 和可选的 OpenAI 兼容模型配置。

## 本地 OCR 资产

OCR 运行时已实现，但二进制模型不提交到 Git。以下命令从 PaddlePaddle 官方
Hugging Face 仓库的固定 revision 获取检测、识别模型及字典并校验 SHA-256：

```bash
npm run models:fetch
npm run verify:models
npm run build
```

缺少模型时，DOM 与视觉模型识别仍可使用；本地 OCR 会显示可恢复错误，不会静默
给出未经确认的答案。发布 Chrome Web Store 前，必须将 ONNX、字典和 ONNX Runtime WASM
随扩展打包，并完成 PaddleOCR 与 ONNX Runtime 的许可证审计。

## 发布

```bash
npm run release
```

发布命令会执行生产依赖审计、类型检查、测试、模型哈希校验、图标生成、生产构建并生成
`release/jev-swot-<version>.zip`。发布前还必须完成
[`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) 中的真实 API 和跨平台人工验收。
隐私数据流见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

如果已经准备好真实凭据，可用以下命令做一次不落盘的线上预检。脚本不会保存或打印密钥；
只设置 `JEV_TYPESAFE_API_KEY` 时验证 JEV，额外设置 `JEV_LLM_BASE_URL`、
`JEV_LLM_MODEL` 和 `JEV_LLM_API_KEY` 时还会验证普通文本模型及视觉能力：

```bash
JEV_TYPESAFE_API_KEY='…' \
JEV_LLM_BASE_URL='https://api.example.com/v1' \
JEV_LLM_MODEL='model-name' \
JEV_LLM_API_KEY='…' \
npm run verify:live
```

## 数据与使用边界

插件不会勾选或提交网页答案，也不提供监考规避能力。截图仅在用户主动触发且启用
视觉模型时发送给所配置的供应商；本地 OCR 不上传截图。若配置了普通文本模型，OCR 原文及文本框位置可能会发送给该模型进行题目结构化；模型标记为答案、解析、得分或页面杂讯的片段不会进入 JEV 题干、选项或上下文。
