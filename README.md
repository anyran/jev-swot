# 做题 Jev

这是一个 Chrome/Chromium Manifest V3 学习辅助扩展。它从当前网页提取单选或多选题；有视觉能力时先由 OpenAI 兼容视觉模型直接判断可能答案，无视觉能力且配置 JEV 时再将 OCR 结构交给兼容的 JEV 决策接口返回各选项概率，未配置 JEV 时由普通模型直接判断并按需补做题目结构化和答案解析。JEV 默认连接 [TypeSafe Jev](https://docs.typesafe.ai/introduction)，也可配置使用 OpenRouter 等兼容服务。

首版目标运行环境为 Chrome/Chromium 109 及以上；本地 OCR 使用扩展自带的 Offscreen Document 和 PP-OCRv5，旧版 Offscreen 文档查询接口会自动走兼容路径。

## 功能

- `Ctrl/Command + Shift + Y` 后拖拽框选题目；如果该组合被浏览器或其他扩展占用，可在 `chrome://extensions/shortcuts` 设置备用的 `Windows/Linux: Alt + Shift + Y；macOS: Command + Shift + U`。
- `Alt + 双击`打开整页逐题识别面板；确认后扫描当前网页和浏览器可读取的嵌入框架（包含视口外和滚动后加载的题目），每题分别显示结果，并在完成后恢复主页面与框架内滚动位置。无法访问的框架会提示；框架中的视觉题不会使用错位截图。
- 整页题目文本只在点击“开始整页分析”后逐题发送；需要视觉识别时，扩展在本地滚动拼接单道题截图，只有用户逐题允许后才上传。若 Chrome 尚未授予当前标签页临时截图权限，先点击扩展图标或使用已注册的浏览器快捷键，再重试该题；扩展不请求 `<all_urls>`。选择“仅本地 OCR”不会上传图片。
- DOM 优先；需要截图时，如果普通模型支持视觉，首次直接让视觉模型判断可能答案；点击详情后才请求题干、候选项和图形上下文。
- 无视觉能力时使用本地 PP-OCRv5。配置 JEV 时，普通模型必须返回每个 OCR 行属于题干、选项或排除内容的行证据；扩展再依据这些行重建题干和选项，明确排除“正确答案/解析/得分”等结果文字，最后才把确认后的结构交给 JEV。行证据缺失或冲突时会停在校正界面，不会把模型拼接的整段文字直接送入 JEV。
- 未配置 JEV 时不会停在“缺少密钥”：DOM 完整题直接交给普通模型；OCR 题把原始 OCR 文字整体交给普通模型判断可能答案，点击详情后再补做题干/候选项分离和解析。
- 即使 DOM 中已有完整题干和选项，只要检测到公式排版、图表或其他非文字视觉语义，也不会直接送入 JEV；会先要求视觉模型处理，或由用户补充/校正后再判断。
- 结果浮层默认只显示紧凑的答案提示，采用透明背景和低透明度文字；它会根据附近页面背景自动选择深浅色和阴影，悬停或展开时再增强可读性。点击右侧的详情图标后才展开概率、告警、题目校正和“答案解析”。没有普通模型时仍可离线 OCR，但必须人工校正后才会调用 JEV。
- 视觉直答和未配置 JEV 的普通模型直答都会返回可能答案、教学解释、知识点和不确定性；详情图标会按需加载题干与候选项分离结果。结构化题目上的“普通模型答题”仍只发送已确认的题干、上下文和选项，不上传截图。
- 单选显示归一化概率，多选显示每项独立选择概率。
- 设置页可维护敏感站点禁用列表，并控制视觉模型上传截图前是否逐次确认。
- 页面访问权限默认可选；未授权时扩展按钮和框选快捷键仍可在用户主动触发后临时使用。若要使用 `Alt + 双击`整页扫描（包括逐屏截图），请在设置页显式启用任意 HTTP/HTTPS 网页访问，已打开的网页需刷新一次。
- 模型地址、模型名、能力设置和 API Key 保存在本机 `chrome.storage.local`，浏览器重启后仍会恢复；“清除 API Key”操作会同时清除会话和本机保存的密钥。扩展仍不持久化页面或截图。

## 开发

```bash
npm install
npm run models:fetch
npm test
npm run build
```

在 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，加载
`dist/`。打开扩展设置页填写 JEV 的 API 地址、模型 ID 和 API Key。TypeSafe 是默认配置；如使用 OpenRouter，填写地址 `https://openrouter.ai/api/alpha/decisions`、模型 ID `typesafe/jev-1.13` 和 OpenRouter API Key。JEV 请求只需要决策 API，不要将该模型配置到普通模型的 Chat Completions 地址。

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
验收完成后，推送与 `package.json`、`public/manifest.json` 版本一致的 `v<version>` 标签
（例如 `git tag v0.1.0 && git push origin v0.1.0`），GitHub Actions 会重新执行发布校验，
并将 ZIP 附加到对应的 GitHub Release。Chrome Web Store 接收 ZIP 并负责生成供用户安装的
CRX；本项目的发布包因此是 ZIP，不需要在 Actions 中自行签名生成 CRX。
隐私数据流见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

如果已经准备好真实凭据，可用以下命令做一次不落盘的线上预检。脚本不会保存或打印密钥；
只设置 `JEV_API_KEY` 时验证默认的 TypeSafe JEV；旧变量 `JEV_TYPESAFE_API_KEY` 仍兼容。只设置 `OPENROUTER_API_KEY` 时自动使用 OpenRouter Decisions API 和 `typesafe/jev-1.13`；也可通过 `JEV_ENDPOINT`、`JEV_MODEL` 指定其他兼容服务。额外设置 `JEV_LLM_BASE_URL`、
`JEV_LLM_MODEL` 和 `JEV_LLM_API_KEY` 时还会验证普通文本模型及视觉能力：

```bash
OPENROUTER_API_KEY='…' \
JEV_LLM_BASE_URL='https://api.example.com/v1' \
JEV_LLM_MODEL='model-name' \
JEV_LLM_API_KEY='…' \
npm run verify:live
```

使用自定义决策服务时，改设 `JEV_API_KEY`、`JEV_ENDPOINT` 和 `JEV_MODEL`。

## 数据与使用边界

插件不会勾选或提交网页答案，也不提供监考规避能力。截图仅在用户主动触发且启用
视觉模型时发送给所配置的供应商；本地 OCR 不上传截图。若配置了普通文本模型，OCR 原文及文本框位置可能会发送给该模型进行题目结构化；模型标记为答案、解析、得分或页面杂讯的片段不会进入 JEV 题干、选项或上下文。
