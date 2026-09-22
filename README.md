# Jev SWOT / Jev 做题家

`Jev SWOT`（中文产品名：`Jev 做题家`）是一个 Chrome/Chromium Manifest V3 学习辅助扩展。它从当前网页提取单选或多选题，调用
[TypeSafe Jev](https://docs.typesafe.ai/introduction) 返回各选项概率，并按需使用
OpenAI 兼容模型生成答案解析。

## 功能

- `Ctrl/Command + Shift + Y` 后拖拽框选题目。
- `Alt + 双击`识别鼠标所在的题目容器。
- DOM 完整题目可直接通过 `Alt + 双击`分析；如果题目需要读取截图，浏览器的临时截图权限必须由框选快捷键授予。
- DOM 优先；不完整时依次尝试视觉模型和本地 PP-OCRv5。
- 单选显示归一化概率，多选显示每项独立选择概率。
- Shadow DOM 结果浮层支持校正题目和按需解析。
- API Key 只保存在 `chrome.storage.session`，不持久化页面或截图。

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
给出错误答案。发布 Chrome Web Store 前，必须将 ONNX、字典和 ONNX Runtime WASM
随扩展打包，并完成 PaddleOCR 与 ONNX Runtime 的许可证审计。

## 发布

```bash
npm run release
```

发布命令会执行类型检查、测试、模型哈希校验、图标生成、生产构建并生成
`release/jev-swot-<version>.zip`。发布前还必须完成
[`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) 中的真实 API 和跨平台人工验收。
隐私数据流见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

如果已经准备好真实凭据，可用以下命令做一次不落盘的线上预检。脚本不会打印密钥；
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
视觉模型时发送给所配置的供应商；本地 OCR 不上传截图。若配置了普通文本模型，OCR 文本可能会发送给该模型进行题目结构化。
