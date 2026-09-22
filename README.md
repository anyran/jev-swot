# JevAnswer

Chrome/Chromium Manifest V3 学习辅助扩展。它从当前网页提取单选或多选题，调用
[TypeSafe Jev](https://docs.typesafe.ai/introduction) 返回各选项概率，并按需使用
OpenAI 兼容模型生成答案解析。

## 功能

- `Ctrl/Command + Shift + Y` 后拖拽框选题目。
- `Alt + 双击`识别鼠标所在的题目容器。
- DOM 优先；不完整时依次尝试视觉模型和本地 PP-OCRv5。
- 单选显示归一化概率，多选显示每项独立选择概率。
- Shadow DOM 结果浮层支持校正题目和按需解析。
- API Key 只保存在 `chrome.storage.session`，不持久化页面或截图。

## 开发

```bash
npm install
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
`release/jevanswer-<version>.zip`。发布前还必须完成
[`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) 中的真实 API 和跨平台人工验收。
隐私数据流见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。

## 数据与使用边界

插件不会勾选或提交网页答案，也不提供监考规避能力。截图仅在用户主动触发且启用
视觉模型时发送给所配置的供应商；本地 OCR 不上传截图。
