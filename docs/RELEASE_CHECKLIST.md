# 做题 Jev 发布检查清单

## 自动门槛

- [x] `npm ci`（锁文件安装）
- [x] 固定 revision 的模型资产通过 `npm run verify:models` SHA-256 校验
- [x] `npm run release`（生产依赖审计、类型检查、完整单元测试、模型、构建、Chrome 冒烟及 ZIP；构建本身也会拒绝缺失或哈希错误的模型）。本次全链验证通过，并通过 `JEV_RELEASE_FILENAME=jev-swot-0.1.0-build-20260924-ci-smoke-fix.zip` 生成独立归档，排除了 Synology `@eaDir` 索引并保留旧包。
- [x] 生产目录作为未打包扩展加载并实际运行 PP-OCRv5
- [x] Chrome 冒烟覆盖整页 Alt+双击：确认前不发请求；整页扫描立即重触发会取消旧批次并等待页面与框架恢复后再启动新批次；实际滚动至约 12,000px 文档底部、`overflow:auto` 虚拟列表底部及 7,200px 跨源 iframe 底部，并扫描远端 DOM、延迟题、开放式 Shadow DOM、`srcdoc` 和跨源 HTTP 框架。断言八条独立结果（其中框架视觉题安全失败关闭）、六条文本 JEV 请求、框架视觉题不上传、主页面画布题在未触发浏览器级截图授权时显示逐题可恢复提示且不上传图片、框架与主页面滚动位置恢复，以及跨源框架扫描中取消后不再发送题目请求。另覆盖视觉模型直答→详情、视觉模型不支持→本地 OCR→普通文本结构化→JEV、无 JEV 时 OCR 原文→普通模型答案、流式解析、禁用站点、密钥持久化及清除。测试副本只在隔离临时目录中把可选 HTTP/HTTPS 主机权限提升为必需权限，模拟用户授予网页站点访问；不添加 `<all_urls>`，也不影响发布 manifest。正式 Chrome 中触发浏览器级 `activeTab` 并逐题重试的路径仍需人工验收。
- [x] OCR 结构化失败或未配置普通模型时要求人工校正，不把规则猜测直接送入 JEV；模型排除文本不会进入 JEV 输入
- [x] DOM 中检测到公式/图形语义时强制进入视觉或人工复核路径；JEV 与普通模型错误详情会脱敏 API Key
- [x] JEV 请求在进行中收到取消信号时会中止网络请求（单元测试覆盖）；浏览器手势取消仍需人工验收
- [x] 结果详情可由用户显式触发普通模型直答；没有 JEV API Key 时 DOM 题自动直答、OCR 题整体直答并在详情中补做分离；不绕过视觉语义或人工校正门禁
- [x] 默认结果覆盖层保持紧凑，仅显示答案提示；详情页才显示概率、校正和答案解析
- [x] Chrome 无 manifest、CSP 或 service worker 错误
- [x] `release/jev-swot-0.1.0-build-20260924-ci-smoke-fix.zip` 包含模型、WASM、许可证、第三方声明和隐私说明；ZIP CRC 检查及与 `dist/` 文件清单比对通过，且不含 Synology `@eaDir` 索引。SHA-256：`62074dd00051406685292920d50a921aac599b425ae921dbfda350f6af37e43d`。旧的同版本归档均保留未覆盖。
- [x] `npm run assets:store` 生成 1280×800 的最新版设置页与逐题概率结果截图，保存在 `store-assets/`。
- [x] GitHub Actions [`Validate extension` 通过（提交 `3a8a56a`）](https://github.com/anyran/jev-swot/actions/runs/35941009588)，Linux、Windows、macOS 均成功；已保留三个 ZIP 构建产物至 2026-10-08：`jev-swot-release-ubuntu-latest-3a8a56a447ad54ff13cfba5512614871ae1cac97`、`jev-swot-release-windows-latest-3a8a56a447ad54ff13cfba5512614871ae1cac97`、`jev-swot-release-macos-latest-3a8a56a447ad54ff13cfba5512614871ae1cac97`
- [ ] 完成人工发布验收后，推送与 `package.json`、`public/manifest.json` 版本一致的 `v<version>` 标签；GitHub Actions 会重新验证并把 `release/jev-swot-<version>.zip` 发布为 GitHub Release 资产

## 必须人工验证

- [ ] 使用真实 TypeSafe 或 OpenRouter JEV Key 验证单选 `Choice` 概率合计约为 1
- [ ] 使用真实 TypeSafe 或 OpenRouter JEV Key 验证多选独立 `Noul`
- [ ] 使用 OpenRouter 自定义 JEV 地址保存设置，确认只申请对应 API 域名权限，并验证拒绝权限时界面有明确提示
- [ ] 使用至少一个支持视觉和一个不支持视觉的 OpenAI 兼容模型
- [x] 已将浏览器可访问的嵌入框架并入同一整页逐题列表；含浏览器拒绝访问或尚未注入脚本的框架仍会明确显示未扫描警告
- [ ] 使用 `OPENROUTER_API_KEY`（或 `JEV_API_KEY` / `JEV_TYPESAFE_API_KEY`）运行 `npm run verify:live`，并保存不含密钥的输出作为发布记录
- [ ] 验证 DOM 题、图片文字题、Canvas 题、低清截图、中英混排和动态 SPA
- [ ] 验证视觉上传确认、“仅本地 OCR”、禁用站点和浏览器重启恢复模型配置与 API Key；验证显式清除 API Key 后无残留
- [ ] 未授予网页访问权限时，扩展按钮与快捷键仍可框选识别；在设置页授予可选网页权限并刷新页面后，Alt + 双击识别生效
- [ ] 在正式 Chrome 中验证：网页访问权限不会代替 `activeTab` 截图授权；视觉题失败后，点击扩展图标或触发浏览器快捷键可保留结果面板并允许逐题重试
- [ ] 验证主快捷键 `Ctrl/Command + Shift + Y`、备用快捷键 Windows/Linux `Alt + Shift + Y`、macOS `Command + Shift + U`、冲突提示、框选取消、请求取消和流式解析
- [ ] 验证公式、图表、几何图不会在低可靠性时静默进入 JEV
- [ ] 在 Windows、macOS 和 Linux 当前稳定版 Chrome 各完成一次冒烟测试

## Chrome Web Store

- [ ] 推送后在仓库 Settings → Pages 中选择 GitHub Actions，确认 `https://anyran.github.io/jev-swot/privacy.html` 可公开访问
- [x] 准备商店截图（`store-assets/`）、简短说明、详细说明和权限说明
- [ ] 在 Chrome Web Store 开发者账号中验证支持邮箱
- [ ] 解释 `storage`、`offscreen`、`activeTab`、站点访问及可选主机权限用途
- [ ] 确认扩展只执行包内代码，模型与 WASM 均随包发布
- [x] 锁定依赖树的许可证正文、PaddleOCR Apache-2.0 与 ONNX Runtime v1.30.0 上游第三方 notices 随 `dist/third_party_licenses/` 打包，并由 `verify:build` 检查
