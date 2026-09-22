# Jev SWOT / Jev 做题家发布检查清单

## 自动门槛

- [x] `npm ci`（锁文件安装）
- [x] 固定 revision 的模型资产通过 `npm run verify:models` SHA-256 校验
- [x] `npm run release`（类型检查、完整单元测试、模型、构建、Chrome 冒烟及 ZIP）
- [x] 生产目录作为未打包扩展加载并实际运行 PP-OCRv5
- [x] Chrome 冒烟覆盖 DOM→JEV 与截图→本地 OCR→普通文本结构化→JEV，并确认无视觉模型上传
- [x] Chrome 无 manifest、CSP 或 service worker 错误
- [x] 发布 ZIP 包含模型、WASM、许可证、第三方声明和隐私说明
- [x] `npm run assets:store` 可重复生成 1280×800 商店截图

## 必须人工验证

- [ ] 使用真实 TypeSafe Key 验证单选 `Choice` 概率合计约为 1
- [ ] 使用真实 TypeSafe Key 验证多选独立 `Noul`
- [ ] 使用至少一个支持视觉和一个不支持视觉的 OpenAI 兼容模型
- [ ] 验证 DOM 题、图片文字题、Canvas 题、低清截图、中英混排和动态 SPA
- [ ] 验证视觉上传确认、“仅本地 OCR”、禁用站点和浏览器重启清除密钥
- [ ] 验证快捷键冲突提示、框选取消、请求取消和流式解析
- [ ] 验证公式、图表、几何图不会在低可靠性时静默进入 JEV
- [ ] 在 Windows、macOS 和 Linux 当前稳定版 Chrome 各完成一次冒烟测试

## Chrome Web Store

- [ ] 推送后在仓库 Settings → Pages 中选择 GitHub Actions，确认 `https://anyran.github.io/jev-swot/privacy.html` 可公开访问
- [x] 准备商店截图、简短说明、详细说明和权限说明
- [ ] 在 Chrome Web Store 开发者账号中验证支持邮箱
- [ ] 解释 `storage`、`offscreen`、`activeTab`、站点访问及可选主机权限用途
- [ ] 确认扩展只执行包内代码，模型与 WASM 均随包发布
- [ ] 完成许可证审计并随发行包保留 `THIRD_PARTY_NOTICES.md`
