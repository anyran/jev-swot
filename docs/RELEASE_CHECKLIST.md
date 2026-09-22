# Jev SWOT / Jev 做题家发布检查清单

## 自动门槛

- [x] `npm ci`（锁文件安装）
- [x] 固定 revision 的模型资产通过 `npm run verify:models` SHA-256 校验
- [x] `npm run release`（生产依赖审计、类型检查、完整单元测试、模型、构建、Chrome 冒烟及 ZIP；构建本身也会拒绝缺失或哈希错误的模型）
- [x] 生产目录作为未打包扩展加载并实际运行 PP-OCRv5
- [x] Chrome 冒烟覆盖多题页面 Alt+双击 DOM→JEV（在测试环境授予可选网页权限时）、截图→视觉模型成功识别→JEV、视觉模型不支持时→本地 OCR→普通文本结构化→JEV、流式答案解析；并确认仅本地路径不会上传视觉截图、禁用站点不发起请求、浏览器重启后恢复本机配置与 API Key、显式清除 API Key 后无残留。无头 Chrome 拒绝可选网页权限时，Alt+双击部分保留到人工验收。
- [x] OCR 结构化失败或未配置普通模型时要求人工校正，不把规则猜测直接送入 JEV；模型排除文本不会进入 JEV 输入
- [x] DOM 中检测到公式/图形语义时强制进入视觉或人工复核路径；JEV 与普通模型错误详情会脱敏 API Key
- [x] JEV 请求在进行中收到取消信号时会中止网络请求（单元测试覆盖）；浏览器手势取消仍需人工验收
- [x] 结果详情可由用户显式触发普通模型直答；没有 TypeSafe Key 时也可从密钥提示进入；不绕过结构、视觉语义或人工校正门禁
- [x] 默认结果覆盖层保持紧凑，仅显示答案提示；详情页才显示概率、校正和答案解析
- [x] Chrome 无 manifest、CSP 或 service worker 错误
- [x] 发布 ZIP 包含模型、WASM、许可证、第三方声明和隐私说明
- [x] `npm run assets:store` 可重复生成 1280×800 商店截图
- [ ] GitHub Actions `Validate extension` 在目标提交上通过，并保留发布 ZIP 构建产物

## 必须人工验证

- [ ] 使用真实 TypeSafe Key 验证单选 `Choice` 概率合计约为 1
- [ ] 使用真实 TypeSafe Key 验证多选独立 `Noul`
- [ ] 使用至少一个支持视觉和一个不支持视觉的 OpenAI 兼容模型
- [ ] 使用环境变量运行 `npm run verify:live`，并保存不含密钥的输出作为发布记录
- [ ] 验证 DOM 题、图片文字题、Canvas 题、低清截图、中英混排和动态 SPA
- [ ] 验证视觉上传确认、“仅本地 OCR”、禁用站点和浏览器重启恢复模型配置与 API Key；验证显式清除 API Key 后无残留
- [ ] 未授予网页访问权限时，扩展按钮与快捷键仍可框选识别；在设置页授予可选网页权限并刷新页面后，Alt + 双击识别生效
- [ ] 验证主快捷键 `Ctrl/Command + Shift + Y`、备用快捷键 Windows/Linux `Alt + Shift + Y`、macOS `Command + Shift + U`、冲突提示、框选取消、请求取消和流式解析
- [ ] 验证公式、图表、几何图不会在低可靠性时静默进入 JEV
- [ ] 在 Windows、macOS 和 Linux 当前稳定版 Chrome 各完成一次冒烟测试

## Chrome Web Store

- [ ] 推送后在仓库 Settings → Pages 中选择 GitHub Actions，确认 `https://anyran.github.io/jev-swot/privacy.html` 可公开访问
- [x] 准备商店截图、简短说明、详细说明和权限说明
- [ ] 在 Chrome Web Store 开发者账号中验证支持邮箱
- [ ] 解释 `storage`、`offscreen`、`activeTab`、站点访问及可选主机权限用途
- [ ] 确认扩展只执行包内代码，模型与 WASM 均随包发布
- [ ] 完成许可证审计并随发行包保留 `THIRD_PARTY_NOTICES.md`
