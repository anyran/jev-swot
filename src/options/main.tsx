import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getSecrets, getSettings, setSecrets, setSettings } from "../shared/storage";
import { DEFAULT_SETTINGS, type PersistentSettings, type StoredSecrets } from "../shared/types";
import { getModelPermissionOrigins } from "./model-permissions";
import "./styles.css";

const PAGE_ORIGINS = ["http://*/*", "https://*/*"];

function App() {
  const [settings, updateSettings] = useState<PersistentSettings>(DEFAULT_SETTINGS);
  const [secrets, updateSecrets] = useState<StoredSecrets>({});
  const [saved, setSaved] = useState("");
  const [shortcutState, setShortcutState] = useState({ primary: false, fallback: false });
  const [pageAccessGranted, setPageAccessGranted] = useState(false);
  useEffect(() => {
    void Promise.all([getSettings(), getSecrets()]).then(([s, k]) => { updateSettings(s); updateSecrets(k); });
    void chrome.commands.getAll().then((commands) => setShortcutState({
      primary: !!commands.find((command) => command.name === "select-question" && command.shortcut),
      fallback: !!commands.find((command) => command.name === "select-question-alt" && command.shortcut)
    }));
    void chrome.permissions.contains({ origins: PAGE_ORIGINS }).then(setPageAccessGranted).catch(() => setPageAccessGranted(false));
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const nextSettings = { ...settings, jev: { endpoint: settings.jev.endpoint.trim(), model: settings.jev.model.trim() }, llm: { ...settings.llm, baseUrl: settings.llm.baseUrl.trim(), model: settings.llm.model.trim() } };
    // Start the optional-host permission prompt within the submit gesture,
    // before awaiting storage writes (Chrome requires a direct user gesture).
    const permissionRequest = ensureModelPermissions();
    await setSettings(nextSettings);
    await setSecrets({ ...secrets, typeSafeApiKey: secrets.typeSafeApiKey?.trim(), llmApiKey: secrets.llmApiKey?.trim() });
    if (!await permissionRequest) return;
    setSaved("设置已保存；模型配置和 API Key 会保存在本机浏览器配置中。");
  }
  async function clearSession() { await chrome.runtime.sendMessage({ type: "CLEAR_SESSION" }); setSaved("已清除本次会话数据；已保存的模型配置和 API Key 保留。"); }
  async function clearApiKeys() { await chrome.runtime.sendMessage({ type: "CLEAR_API_KEYS" }); updateSecrets({}); setSaved("已清除会话和本机保存的 API Key。"); }
  async function openShortcutSettings() {
    try { await chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); }
    catch { setSaved("无法自动打开快捷键设置，请在地址栏打开 chrome://extensions/shortcuts。"); }
  }
  async function enablePageAccess() {
    try {
      const granted = await chrome.permissions.request({ origins: PAGE_ORIGINS });
      setPageAccessGranted(granted);
      setSaved(granted ? "已启用任意网页的 Alt + 双击整页识别；已打开的网页请刷新一次。" : "未获得网页权限；扩展按钮和框选快捷键仍可在当前页临时使用。");
    } catch (error) {
      setSaved(error instanceof Error ? `无法申请网页权限：${error.message}` : "无法申请网页权限；扩展按钮和框选快捷键仍可在当前页临时使用。");
    }
  }
  async function releaseOcr() { await chrome.runtime.sendMessage({ type: "RELEASE_OCR" }); setSaved("OCR 模型内存已释放；下次使用时会重新加载。"); }
  async function testConnections() {
    const nextSettings = { ...settings, jev: { endpoint: settings.jev.endpoint.trim(), model: settings.jev.model.trim() }, llm: { ...settings.llm, baseUrl: settings.llm.baseUrl.trim(), model: settings.llm.model.trim() } };
    const permissionRequest = ensureModelPermissions();
    await setSettings(nextSettings);
    await setSecrets({ ...secrets, typeSafeApiKey: secrets.typeSafeApiKey?.trim(), llmApiKey: secrets.llmApiKey?.trim() });
    if (!await permissionRequest) return;
    setSaved("正在测试连接…");
    try {
      const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 100; const context = canvas.getContext("2d")!; context.fillStyle = "white"; context.fillRect(0, 0, 320, 100); context.fillStyle = "black"; context.font = "28px sans-serif"; context.fillText("2 + 2 = 4", 30, 60);
      const response = await chrome.runtime.sendMessage({ type: "TEST_CONNECTIONS", imageDataUrl: canvas.toDataURL("image/png") });
      setSaved(response.ok ? response.diagnostic : response.message);
    } catch (error) { setSaved(error instanceof Error ? error.message : "连接测试失败，请稍后重试。"); }
  }
  async function ensureModelPermissions() {
    const permissionRequest = getModelPermissionOrigins(settings, secrets);
    if (permissionRequest.error) { setSaved(permissionRequest.error); return false; }
    const origins = permissionRequest.origins;
    if (!origins.length) return true;
    try {
      const granted = await chrome.permissions.request({ origins: [...new Set(origins)] });
      if (!granted) setSaved("未获得模型接口域名权限；配置已保存，模型请求暂未启用。");
      return granted;
    } catch (error) {
      setSaved(error instanceof Error ? `无法申请模型接口权限：${error.message}；配置已保存。` : "无法申请模型接口权限；配置已保存，模型请求暂未启用。");
      return false;
    }
  }
  const shortcutHint = !shortcutState.primary
    ? shortcutState.fallback
      ? "主快捷键未分配，但备用快捷键 Windows/Linux: Alt + Shift + Y；macOS: Command + Shift + U 已可用。"
      : "主快捷键和备用快捷键都未分配，通常是与浏览器或其他扩展冲突。"
    : "";
  return <main><h1>做题 Jev 设置</h1><p className="lead">模型地址、模型名和 API Key 会保存在本机 Chrome 配置中；浏览器重启后仍会保留。“清除本次会话”不会删除已保存配置；“清除 API Key”会主动删除会话和本机保存的密钥。</p>{shortcutHint && <p className="message warning">{shortcutHint}<button type="button" className="muted" onClick={openShortcutSettings}>打开快捷键设置</button>。如果当前网页已加载扩展脚本，Ctrl/Command + Shift + Y 及备用组合也有页面内监听；否则请先点击扩展按钮。</p>}{!pageAccessGranted && <p className="message warning">尚未授予网页访问权限。扩展按钮和框选快捷键仍可在用户主动触发后临时使用；如需直接使用 Alt + 双击，请点击下方按钮授权任意 HTTP/HTTPS 网页。</p>}<form onSubmit={save}>
    <section><h2>JEV 概率模型</h2><p className="hint">默认使用 TypeSafe。使用 OpenRouter 时，接口地址填写 https://openrouter.ai/api/alpha/decisions，模型 ID 填写 typesafe/jev-1.13；其他兼容决策接口的服务也可在此配置。自定义 API 域名的网络权限会在保存或测试连接时单独申请；拒绝后不会向该服务发送请求，可稍后重试。</p><label>API 地址<input value={settings.jev.endpoint} onChange={e => updateSettings({ ...settings, jev: { ...settings.jev, endpoint: e.target.value } })}/></label><label>模型 ID<input value={settings.jev.model} onChange={e => updateSettings({ ...settings, jev: { ...settings.jev, model: e.target.value } })}/></label><label>JEV API Key<input type="password" autoComplete="off" value={secrets.typeSafeApiKey ?? ""} onChange={e => updateSecrets({ ...secrets, typeSafeApiKey: e.target.value })}/></label></section>
    <section><h2>普通大模型（OpenAI 兼容）</h2><p className="hint">有视觉能力时，首次把题目截图直接交给视觉模型判断可能答案；点击详情后才识别题干、候选项和图形上下文。无视觉能力时，DOM 完整题直接使用，本地 OCR 负责截图文字；配置 JEV 时由普通模型按 OCR 行证据分离题干/候选项后再交给 JEV，未配置 JEV 时则把 OCR 原文整体交给普通模型作答，点击详情后再补做结构化分离。</p><label>Base URL<input value={settings.llm.baseUrl} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, baseUrl: e.target.value } })}/></label><label>模型名称<input value={settings.llm.model} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, model: e.target.value } })}/></label><label>API Key<input type="password" autoComplete="off" value={secrets.llmApiKey ?? ""} onChange={e => updateSecrets({ ...secrets, llmApiKey: e.target.value })}/></label><label>视觉能力<select value={settings.llm.vision} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, vision: e.target.value as "auto"|"supported"|"unsupported" } })}><option value="auto">自动检测并缓存</option><option value="supported">支持图像</option><option value="unsupported">不支持图像（直接本地 OCR）</option></select></label><label>结构化输出能力<select value={settings.llm.structuredOutput} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, structuredOutput: e.target.value as "auto"|"supported"|"unsupported" } })}><option value="auto">自动检测并降级</option><option value="supported">支持 JSON Schema</option><option value="unsupported">仅 JSON 对象/纯文本</option></select></label></section>
    <section><h2>本地 OCR</h2><label>自动放行阈值 <output>{settings.ocrThreshold.toFixed(2)}</output><input type="range" min="0.5" max="0.95" step="0.01" value={settings.ocrThreshold} onChange={e => updateSettings({ ...settings, ocrThreshold: Number(e.target.value) })}/></label><label className="check"><input type="checkbox" checked={settings.useWebGpu} onChange={e => updateSettings({ ...settings, useWebGpu: e.target.checked })}/>启用实验性 WebGPU 加速（失败时自动回退 WASM）</label></section>
    <section><h2>隐私与站点</h2><p className="hint">每行填写一个主机名；禁用后扩展不会在该站点显示覆盖层，也不会发送 JEV、视觉或解析请求。</p><label>敏感站点禁用列表<textarea value={settings.disabledHosts.join("\n")} onChange={e => updateSettings({ ...settings, disabledHosts: e.target.value.split(/[\n,]+/).map(host => host.trim().toLowerCase().replace(/^\.+|\.+$/g, "")).filter(Boolean) })} placeholder="example.com\nprivate.example.org" /></label><label className="check"><input type="checkbox" checked={settings.confirmVisionUpload} onChange={e => updateSettings({ ...settings, confirmVisionUpload: e.target.checked })}/>视觉模型上传截图前始终询问</label></section>
    <div className="actions">{!pageAccessGranted && <button type="button" data-action="enable-page-access" className="muted" onClick={enablePageAccess}>启用任意网页整页识别</button>}<button type="button" className="muted" onClick={releaseOcr}>释放 OCR 内存</button><button type="button" className="muted" onClick={clearSession}>清除本次会话</button><button type="button" className="muted" onClick={clearApiKeys}>清除 API Key</button><button type="button" className="muted" onClick={testConnections}>测试连接与能力</button><button type="submit">保存设置</button></div>{saved && <p className="message">{saved}</p>}
  </form><aside>快捷键：Ctrl/Command + Shift + Y 框选；冲突时可用 Windows/Linux: Alt + Shift + Y；macOS: Command + Shift + U；Alt + 双击扫描整页并逐题识别。视觉题截图在本地逐屏拼接，只有逐题允许后才上传；若浏览器拒绝截图，先点击扩展图标或使用已注册的浏览器快捷键，再重试该题。插件不会自动选择或提交答案。</aside></main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
