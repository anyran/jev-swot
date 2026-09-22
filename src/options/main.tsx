import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { validateLlmBaseUrl } from "../core/llm";
import { getSecrets, getSettings, setSecrets, setSettings } from "../shared/storage";
import { DEFAULT_SETTINGS, type PersistentSettings, type StoredSecrets } from "../shared/types";
import "./styles.css";

const PAGE_ORIGINS = ["http://*/*", "https://*/*"];

function App() {
  const [settings, updateSettings] = useState<PersistentSettings>(DEFAULT_SETTINGS);
  const [secrets, updateSecrets] = useState<StoredSecrets>({});
  const [saved, setSaved] = useState("");
  const [shortcutMissing, setShortcutMissing] = useState(false);
  const [pageAccessGranted, setPageAccessGranted] = useState(false);
  useEffect(() => {
    void Promise.all([getSettings(), getSecrets()]).then(([s, k]) => { updateSettings(s); updateSecrets(k); });
    void chrome.commands.getAll().then((commands) => setShortcutMissing(commands.some((command) => command.name === "select-question" && !command.shortcut)));
    void chrome.permissions.contains({ origins: PAGE_ORIGINS }).then(setPageAccessGranted).catch(() => setPageAccessGranted(false));
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const nextSettings = { ...settings, llm: { ...settings.llm, baseUrl: settings.llm.baseUrl.trim(), model: settings.llm.model.trim() } };
    await setSettings(nextSettings);
    await setSecrets({ ...secrets, typeSafeApiKey: secrets.typeSafeApiKey?.trim(), llmApiKey: secrets.llmApiKey?.trim() });
    if (secrets.llmApiKey && !await ensureLlmPermission()) return;
    setSaved("设置已保存；模型配置和 API Key 会保存在本机浏览器配置中。");
  }
  async function clearSession() { await chrome.runtime.sendMessage({ type: "CLEAR_SESSION" }); setSaved("已清除本次会话数据；已保存的模型配置和 API Key 保留。"); }
  async function clearApiKeys() { await chrome.runtime.sendMessage({ type: "CLEAR_API_KEYS" }); updateSecrets({}); setSaved("已清除会话和本机保存的 API Key。"); }
  async function enablePageAccess() {
    try {
      const granted = await chrome.permissions.request({ origins: PAGE_ORIGINS });
      setPageAccessGranted(granted);
      setSaved(granted ? "已启用任意网页的 Alt + 双击识别；已打开的网页请刷新一次。" : "未获得网页权限；扩展按钮和框选快捷键仍可在当前页临时使用。");
    } catch (error) {
      setSaved(error instanceof Error ? `无法申请网页权限：${error.message}` : "无法申请网页权限；扩展按钮和框选快捷键仍可在当前页临时使用。");
    }
  }
  async function releaseOcr() { await chrome.runtime.sendMessage({ type: "RELEASE_OCR" }); setSaved("OCR 模型内存已释放；下次使用时会重新加载。"); }
  async function testConnections() {
    const nextSettings = { ...settings, llm: { ...settings.llm, baseUrl: settings.llm.baseUrl.trim(), model: settings.llm.model.trim() } };
    await setSettings(nextSettings);
    await setSecrets({ ...secrets, typeSafeApiKey: secrets.typeSafeApiKey?.trim(), llmApiKey: secrets.llmApiKey?.trim() });
    if (secrets.llmApiKey && !await ensureLlmPermission()) return;
    setSaved("正在测试连接…");
    try {
      const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 100; const context = canvas.getContext("2d")!; context.fillStyle = "white"; context.fillRect(0, 0, 320, 100); context.fillStyle = "black"; context.font = "28px sans-serif"; context.fillText("2 + 2 = 4", 30, 60);
      const response = await chrome.runtime.sendMessage({ type: "TEST_CONNECTIONS", imageDataUrl: canvas.toDataURL("image/png") });
      setSaved(response.ok ? response.diagnostic : response.message);
    } catch (error) { setSaved(error instanceof Error ? error.message : "连接测试失败，请稍后重试。"); }
  }
  async function ensureLlmPermission() {
    const invalidBaseUrl = validateLlmBaseUrl(settings.llm.baseUrl);
    if (invalidBaseUrl) { setSaved(invalidBaseUrl); return false; }
    const url = new URL(settings.llm.baseUrl);
    try {
      const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
      if (!granted) setSaved("未获得模型接口域名权限；配置已保存，模型请求暂未启用。");
      return granted;
    } catch (error) {
      setSaved(error instanceof Error ? `无法申请模型接口权限：${error.message}；配置已保存。` : "无法申请模型接口权限；配置已保存，模型请求暂未启用。");
      return false;
    }
  }
  return <main><h1>Jev 做题家设置 <small>Jev SWOT</small></h1><p className="lead">模型地址、模型名和 API Key 会保存在本机 Chrome 配置中；浏览器重启后仍会保留。“清除本次会话”不会删除已保存配置；“清除 API Key”会主动删除会话和本机保存的密钥。</p>{shortcutMissing && <p className="message warning">框选快捷键未注册，可能与其他扩展冲突。请打开 <code>chrome://extensions/shortcuts</code> 手动设置。</p>}{!pageAccessGranted && <p className="message warning">尚未授予网页访问权限。扩展按钮和框选快捷键仍可在用户主动触发后临时使用；如需直接使用 Alt + 双击，请点击下方按钮授权任意 HTTP/HTTPS 网页。</p>}<form onSubmit={save}>
    <section><h2>JEV / TypeSafe</h2><label>TypeSafe API Key<input type="password" autoComplete="off" value={secrets.typeSafeApiKey ?? ""} onChange={e => updateSecrets({ ...secrets, typeSafeApiKey: e.target.value })}/></label></section>
    <section><h2>普通大模型（OpenAI 兼容）</h2><p className="hint">截图文字先由此模型整理出题干、选项和必要上下文，并主动排除“正确答案/解析/得分”等结果文字；整理成功后才交给 JEV 判断概率。结果详情中也可以主动让普通模型直接给出答案和教学解析。未配置时仍可本地 OCR，但必须先在覆盖层中人工校正。</p><label>Base URL<input value={settings.llm.baseUrl} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, baseUrl: e.target.value } })}/></label><label>模型名称<input value={settings.llm.model} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, model: e.target.value } })}/></label><label>API Key<input type="password" autoComplete="off" value={secrets.llmApiKey ?? ""} onChange={e => updateSecrets({ ...secrets, llmApiKey: e.target.value })}/></label><label>视觉能力<select value={settings.llm.vision} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, vision: e.target.value as "auto"|"supported"|"unsupported" } })}><option value="auto">自动检测并缓存</option><option value="supported">支持图像</option><option value="unsupported">不支持图像（直接本地 OCR）</option></select></label><label>结构化输出能力<select value={settings.llm.structuredOutput} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, structuredOutput: e.target.value as "auto"|"supported"|"unsupported" } })}><option value="auto">自动检测并降级</option><option value="supported">支持 JSON Schema</option><option value="unsupported">仅 JSON 对象/纯文本</option></select></label></section>
    <section><h2>本地 OCR</h2><label>自动放行阈值 <output>{settings.ocrThreshold.toFixed(2)}</output><input type="range" min="0.5" max="0.95" step="0.01" value={settings.ocrThreshold} onChange={e => updateSettings({ ...settings, ocrThreshold: Number(e.target.value) })}/></label><label className="check"><input type="checkbox" checked={settings.useWebGpu} onChange={e => updateSettings({ ...settings, useWebGpu: e.target.checked })}/>启用实验性 WebGPU 加速（失败时自动回退 WASM）</label></section>
    <section><h2>隐私与站点</h2><p className="hint">每行填写一个主机名；禁用后扩展不会在该站点显示覆盖层，也不会发送 JEV、视觉或解析请求。</p><label>敏感站点禁用列表<textarea value={settings.disabledHosts.join("\n")} onChange={e => updateSettings({ ...settings, disabledHosts: e.target.value.split(/[\n,]+/).map(host => host.trim().toLowerCase().replace(/^\.+|\.+$/g, "")).filter(Boolean) })} placeholder="example.com\nprivate.example.org" /></label><label className="check"><input type="checkbox" checked={settings.confirmVisionUpload} onChange={e => updateSettings({ ...settings, confirmVisionUpload: e.target.checked })}/>视觉模型上传截图前始终询问</label></section>
    <div className="actions">{!pageAccessGranted && <button type="button" data-action="enable-page-access" className="muted" onClick={enablePageAccess}>启用任意网页双击识别</button>}<button type="button" className="muted" onClick={releaseOcr}>释放 OCR 内存</button><button type="button" className="muted" onClick={clearSession}>清除本次会话</button><button type="button" className="muted" onClick={clearApiKeys}>清除 API Key</button><button type="button" className="muted" onClick={testConnections}>测试连接与能力</button><button type="submit">保存设置</button></div>{saved && <p className="message">{saved}</p>}
  </form><aside>快捷键：Ctrl/Command + Shift + Y 框选；Alt + 双击识别当前题目。若题目依赖截图，浏览器需要快捷键授予临时截图权限，请改用框选快捷键。插件不会自动选择或提交答案。</aside></main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
