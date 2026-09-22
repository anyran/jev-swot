import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getSecrets, getSettings, setSecrets, setSettings } from "../shared/storage";
import { DEFAULT_SETTINGS, type PersistentSettings, type SessionSecrets } from "../shared/types";
import "./styles.css";

function App() {
  const [settings, updateSettings] = useState<PersistentSettings>(DEFAULT_SETTINGS);
  const [secrets, updateSecrets] = useState<SessionSecrets>({});
  const [saved, setSaved] = useState("");
  const [shortcutMissing, setShortcutMissing] = useState(false);
  useEffect(() => {
    void Promise.all([getSettings(), getSecrets()]).then(([s, k]) => { updateSettings(s); updateSecrets(k); });
    void chrome.commands.getAll().then((commands) => setShortcutMissing(commands.some((command) => command.name === "select-question" && !command.shortcut)));
  }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (secrets.llmApiKey && !await ensureLlmPermission()) return;
    await Promise.all([setSettings({ ...settings, llm: { ...settings.llm, baseUrl: settings.llm.baseUrl.trim(), model: settings.llm.model.trim() } }), setSecrets({ ...secrets, typeSafeApiKey: secrets.typeSafeApiKey?.trim(), llmApiKey: secrets.llmApiKey?.trim() })]); setSaved("设置已保存；密钥会在浏览器重启后清除。");
  }
  async function clear() { await chrome.runtime.sendMessage({ type: "CLEAR_SESSION" }); updateSecrets({}); setSaved("会话密钥已清除。"); }
  async function releaseOcr() { await chrome.runtime.sendMessage({ type: "RELEASE_OCR" }); setSaved("OCR 模型内存已释放；下次使用时会重新加载。"); }
  async function testConnections() {
    if (secrets.llmApiKey && !await ensureLlmPermission()) return;
    await Promise.all([setSettings({ ...settings, llm: { ...settings.llm, baseUrl: settings.llm.baseUrl.trim(), model: settings.llm.model.trim() } }), setSecrets({ ...secrets, typeSafeApiKey: secrets.typeSafeApiKey?.trim(), llmApiKey: secrets.llmApiKey?.trim() })]); setSaved("正在测试连接…");
    try {
      const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 100; const context = canvas.getContext("2d")!; context.fillStyle = "white"; context.fillRect(0, 0, 320, 100); context.fillStyle = "black"; context.font = "28px sans-serif"; context.fillText("2 + 2 = 4", 30, 60);
      const response = await chrome.runtime.sendMessage({ type: "TEST_CONNECTIONS", imageDataUrl: canvas.toDataURL("image/png") });
      setSaved(response.ok ? response.diagnostic : response.message);
    } catch (error) { setSaved(error instanceof Error ? error.message : "连接测试失败，请稍后重试。"); }
  }
  async function ensureLlmPermission() {
    let url: URL;
    try { url = new URL(settings.llm.baseUrl); }
    catch { setSaved("Base URL 不是有效的网址。"); return false; }
    if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      setSaved("模型地址必须使用 HTTPS；仅本机调试地址允许 HTTP，且不能在 URL 中包含账号密码。"); return false;
    }
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!granted) setSaved("未获得模型接口域名权限，设置未保存。");
    return granted;
  }
  return <main><h1>Jev 做题家设置 <small>Jev SWOT</small></h1><p className="lead">密钥仅保存在 Chrome 会话存储中。浏览器重启后需要重新填写。</p>{shortcutMissing && <p className="message warning">框选快捷键未注册，可能与其他扩展冲突。请打开 <code>chrome://extensions/shortcuts</code> 手动设置。</p>}<form onSubmit={save}>
    <section><h2>JEV / TypeSafe</h2><label>TypeSafe API Key<input type="password" autoComplete="off" value={secrets.typeSafeApiKey ?? ""} onChange={e => updateSecrets({ ...secrets, typeSafeApiKey: e.target.value })}/></label></section>
    <section><h2>普通大模型（OpenAI 兼容）</h2><label>Base URL<input value={settings.llm.baseUrl} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, baseUrl: e.target.value } })}/></label><label>模型名称<input value={settings.llm.model} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, model: e.target.value } })}/></label><label>API Key<input type="password" autoComplete="off" value={secrets.llmApiKey ?? ""} onChange={e => updateSecrets({ ...secrets, llmApiKey: e.target.value })}/></label><label>视觉能力<select value={settings.llm.vision} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, vision: e.target.value as "auto"|"supported"|"unsupported" } })}><option value="auto">自动检测</option><option value="supported">支持图像</option><option value="unsupported">不支持图像（直接本地 OCR）</option></select></label><label>结构化输出能力<select value={settings.llm.structuredOutput} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, structuredOutput: e.target.value as "auto"|"supported"|"unsupported" } })}><option value="auto">自动检测并降级</option><option value="supported">支持 JSON Schema</option><option value="unsupported">仅 JSON 对象/纯文本</option></select></label></section>
    <section><h2>本地 OCR</h2><label>自动放行阈值 <output>{settings.ocrThreshold.toFixed(2)}</output><input type="range" min="0.5" max="0.95" step="0.01" value={settings.ocrThreshold} onChange={e => updateSettings({ ...settings, ocrThreshold: Number(e.target.value) })}/></label><label className="check"><input type="checkbox" checked={settings.useWebGpu} onChange={e => updateSettings({ ...settings, useWebGpu: e.target.checked })}/>启用实验性 WebGPU 加速（失败时自动回退 WASM）</label></section>
    <section><h2>隐私</h2><label className="check"><input type="checkbox" checked={settings.confirmVisionUpload} onChange={e => updateSettings({ ...settings, confirmVisionUpload: e.target.checked })}/>每次向视觉模型上传题目截图前询问</label><label>禁用站点（每行一个域名）<textarea value={settings.disabledHosts.join("\n")} onChange={e => updateSettings({ ...settings, disabledHosts: e.target.value.split(/\n+/).map(x => x.trim().toLowerCase()).filter(Boolean) })}/></label></section>
    <div className="actions"><button type="button" className="muted" onClick={releaseOcr}>释放 OCR 内存</button><button type="button" className="muted" onClick={clear}>清除会话密钥</button><button type="button" className="muted" onClick={testConnections}>测试连接与能力</button><button type="submit">保存设置</button></div>{saved && <p className="message">{saved}</p>}
  </form><aside>快捷键：Ctrl/Command + Shift + Y 框选；Alt + 双击识别当前题目。插件不会自动选择或提交答案。</aside></main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
