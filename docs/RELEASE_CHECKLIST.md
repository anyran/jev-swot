# 发布检查清单

## 自动门槛

- [ ] `npm ci`
- [ ] `npm run models:fetch`
- [ ] `npm run release`
- [ ] `release/jevanswer-<version>.zip` 能作为未打包扩展加载
- [ ] Chrome 扩展页无 manifest、CSP 或 service worker 错误

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

- [ ] 托管并填写公开隐私政策 URL
- [ ] 准备商店截图、简短说明、详细说明和支持邮箱
- [ ] 解释 `storage`、`offscreen`、`activeTab`、站点访问及可选主机权限用途
- [ ] 确认扩展只执行包内代码，模型与 WASM 均随包发布
- [ ] 完成许可证审计并随发行包保留 `THIRD_PARTY_NOTICES.md`
