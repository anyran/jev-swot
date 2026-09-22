import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getSecrets, getSettings, setSecrets, setSettings } from "../shared/storage";
import { DEFAULT_SETTINGS, type PersistentSettings, type SessionSecrets } from "../shared/types";
import "./styles.css";

function App() {
  const [settings, updateSettings] = useState<PersistentSettings>(DEFAULT_SETTINGS);
  const [secrets, updateSecrets] = useState<SessionSecrets>({});
  const [saved, setSaved] = useState("");
  useEffect(() => { void Promise.all([getSettings(), getSecrets()]).then(([s, k]) => { updateSettings(s); updateSecrets(k); }); }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const origin = new URL(settings.llm.baseUrl).origin + "/*";
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) { setSaved("未获得模型接口域名权限，设置未保存。"); return; }
    await Promise.all([setSettings(settings), setSecrets(secrets)]); setSaved("设置已保存；密钥会在浏览器重启后清除。");
  }
  async function clear() { await chrome.runtime.sendMessage({ type: "CLEAR_SESSION" }); updateSecrets({}); setSaved("会话密钥已清除。"); }
  return <main><h1>JevAnswer 设置</h1><p className="lead">密钥仅保存在 Chrome 会话存储中。浏览器重启后需要重新填写。</p><form onSubmit={save}>
    <section><h2>JEV / TypeSafe</h2><label>TypeSafe API Key<input type="password" autoComplete="off" value={secrets.typeSafeApiKey ?? ""} onChange={e => updateSecrets({ ...secrets, typeSafeApiKey: e.target.value })}/></label></section>
    <section><h2>普通大模型（OpenAI 兼容）</h2><label>Base URL<input value={settings.llm.baseUrl} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, baseUrl: e.target.value } })}/></label><label>模型名称<input value={settings.llm.model} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, model: e.target.value } })}/></label><label>API Key<input type="password" autoComplete="off" value={secrets.llmApiKey ?? ""} onChange={e => updateSecrets({ ...secrets, llmApiKey: e.target.value })}/></label><label>视觉能力<select value={settings.llm.vision} onChange={e => updateSettings({ ...settings, llm: { ...settings.llm, vision: e.target.value as "auto"|"supported"|"unsupported" } })}><option value="auto">自动检测</option><option value="supported">支持图像</option><option value="unsupported">不支持图像（直接本地 OCR）</option></select></label></section>
    <section><h2>本地 OCR</h2><label>自动放行阈值 <output>{settings.ocrThreshold.toFixed(2)}</output><input type="range" min="0.5" max="0.95" step="0.01" value={settings.ocrThreshold} onChange={e => updateSettings({ ...settings, ocrThreshold: Number(e.target.value) })}/></label><label className="check"><input type="checkbox" checked={settings.useWebGpu} onChange={e => updateSettings({ ...settings, useWebGpu: e.target.checked })}/>启用实验性 WebGPU 加速（失败时自动回退 WASM）</label></section>
    <div className="actions"><button type="button" className="muted" onClick={clear}>清除会话密钥</button><button type="submit">保存设置</button></div>{saved && <p className="message">{saved}</p>}
  </form><aside>快捷键：Ctrl/Command + Shift + Y 框选；Alt + 双击识别当前题目。插件不会自动选择或提交答案。</aside></main>;
}
createRoot(document.getElementById("root")!).render(<App/>);
