import { elementFromRect, extractFromElement, findQuestionContainer } from "./extract";
import { ResultOverlay } from "./overlay";
import type { ExtractedQuestion, PersistentSettings, ProbabilityResult, RuntimeProgressMessage, WorkerResponse } from "../shared/types";

// Keep the content script self-contained. Manifest V3 content scripts are classic
// scripts, so Vite must not leave an ESM import to the shared storage chunk here.
const DEFAULT_CONTENT_SETTINGS: PersistentSettings = {
  llm: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", vision: "auto", structuredOutput: "auto" },
  ocrThreshold: 0.72,
  useWebGpu: false,
  confirmVisionUpload: true,
  disabledHosts: []
};
async function getSettings(): Promise<PersistentSettings> {
  const stored = await chrome.storage.local.get("settings");
  const raw = stored.settings && typeof stored.settings === "object" ? stored.settings as Record<string, unknown> : {};
  const llm = raw.llm && typeof raw.llm === "object" ? raw.llm as Record<string, unknown> : {};
  const capability = (value: unknown, fallback: "auto" | "supported" | "unsupported") => value === "auto" || value === "supported" || value === "unsupported" ? value : fallback;
  const disabledHosts = Array.isArray(raw.disabledHosts) ? [...new Set(raw.disabledHosts.map((host) => typeof host === "string" ? host.trim().toLowerCase().replace(/^\.+|\.+$/g, "") : "").filter(Boolean))] : [];
  const threshold = Number(raw.ocrThreshold);
  return {
    llm: {
      baseUrl: typeof llm.baseUrl === "string" && llm.baseUrl.trim() ? llm.baseUrl.trim() : DEFAULT_CONTENT_SETTINGS.llm.baseUrl,
      model: typeof llm.model === "string" && llm.model.trim() ? llm.model.trim() : DEFAULT_CONTENT_SETTINGS.llm.model,
      vision: capability(llm.vision, "auto"),
      structuredOutput: capability(llm.structuredOutput, "auto")
    },
    ocrThreshold: Number.isFinite(threshold) ? Math.min(0.95, Math.max(0.5, threshold)) : DEFAULT_CONTENT_SETTINGS.ocrThreshold,
    useWebGpu: raw.useWebGpu === true,
    confirmVisionUpload: raw.confirmVisionUpload !== false,
    disabledHosts
  };
}

let selecting = false;
let selectionBox: HTMLDivElement | null = null;
let start = { x: 0, y: 0 };
const overlay = new ResultOverlay(analyze, explain, directAnswer, cancelActive);
let analysisSequence = 0;
let activeRequestId: string | undefined;
let explanationPort: chrome.runtime.Port | undefined;
let selectionCaptureAuthorized = false;
let lastCaptureAuthorized = false;
let disabledForSite: boolean | undefined;
let disabledStateReady = refreshDisabledState();
chrome.storage.onChanged.addListener((changes, areaName) => { if (areaName === "local" && changes.settings) disabledStateReady = refreshDisabledState(); });

chrome.runtime.onMessage.addListener((message: { type?: string } | RuntimeProgressMessage) => {
  if (message.type === "START_SELECTION") {
    void whenSiteEnabled(() => { selectionCaptureAuthorized = true; startSelection(); });
  }
  if (message.type === "ANALYZE_PROGRESS" && "requestId" in message && message.requestId === activeRequestId) overlay.progress(message.message);
});
document.addEventListener("dblclick", (event) => {
  if (!event.altKey || isEditable(event.target) || isExtensionNode(event.target) || disabledForSite === true) return;
  // Cancel the page's double-click action synchronously; the settings check
  // below may need to await storage, which is too late for preventDefault.
  event.preventDefault(); event.stopPropagation();
  void whenSiteEnabled(() => {
    const target = event.target instanceof Element ? event.target : document.body;
    // Alt + double-click is an explicit user gesture; allow a best-effort
    // screenshot fallback for image/canvas questions. Chrome may still require
    // the extension command/action to grant activeTab, in which case the
    // background returns a recoverable message telling the user to use the
    // selection shortcut.
    analyze(extractFromElement(findQuestionContainer(target)), undefined, true);
  });
}, true);

function startSelection() {
  if (selecting) return; selecting = true;
  document.documentElement.style.cursor = "crosshair";
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("keydown", cancelOnEscape, true);
}
function down(event: PointerEvent) {
  if (event.button !== 0 || isEditable(event.target) || isExtensionNode(event.target)) return; event.preventDefault(); start = { x: event.clientX, y: event.clientY };
  selectionBox = document.createElement("div"); selectionBox.dataset.jevSwotRoot = "selection";
  Object.assign(selectionBox.style, { position: "fixed", zIndex: "2147483646", border: "2px solid #3b82f6", background: "#3b82f622", pointerEvents: "none" });
  document.documentElement.append(selectionBox); document.addEventListener("pointermove", move, true); document.addEventListener("pointerup", up, true);
}
function move(event: PointerEvent) { if (!selectionBox) return; const x = Math.min(start.x, event.clientX), y = Math.min(start.y, event.clientY); Object.assign(selectionBox.style, { left: `${x}px`, top: `${y}px`, width: `${Math.abs(event.clientX-start.x)}px`, height: `${Math.abs(event.clientY-start.y)}px` }); }
function up(event: PointerEvent) {
  const rect = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(event.clientX-start.x), height: Math.abs(event.clientY-start.y) };
  const captureAuthorized = selectionCaptureAuthorized;
  selectionCaptureAuthorized = false;
  cleanup(); if (rect.width < 10 || rect.height < 10) return;
  const q = extractFromElement(elementFromRect(rect), rect); analyze(q, undefined, captureAuthorized);
}
function cancelOnEscape(event: KeyboardEvent) { if (event.key === "Escape") { selectionCaptureAuthorized = false; cleanup(); } }
function cleanup() { selecting = false; selectionBox?.remove(); selectionBox = null; document.documentElement.style.cursor = ""; document.removeEventListener("pointerdown", down, true); document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerup", up, true); document.removeEventListener("keydown", cancelOnEscape, true); }
async function analyze(question: ExtractedQuestion, visionConsent?: "allow" | "deny", captureAuthorized = lastCaptureAuthorized) {
  lastCaptureAuthorized = captureAuthorized;
  cancelActive(); const sequence = ++analysisSequence, requestId = crypto.randomUUID(); activeRequestId = requestId; overlay.loading(question);
  const response = await chrome.runtime.sendMessage({ type: "ANALYZE", requestId, question, devicePixelRatio: window.devicePixelRatio, visionConsent, captureAuthorized }).catch((error: unknown) => ({ ok: false, code: "UNEXPECTED", message: error instanceof Error ? error.message : "扩展后台暂时不可用，请重试。", recoverable: true })) as WorkerResponse;
  if (sequence === analysisSequence) { activeRequestId = undefined; overlay.show(response); }
}
function explain(question: ExtractedQuestion, probability: ProbabilityResult) {
  explanationPort?.disconnect(); overlay.explanation("");
  const port = chrome.runtime.connect({ name: "jev-swot-explanation" }); explanationPort = port;
  port.onMessage.addListener((message: { type: string; chunk?: string; message?: string }) => {
    if (message.type === "chunk") overlay.explanationChunk(message.chunk ?? "");
    if (message.type === "error") overlay.explanation(`解析失败：${message.message ?? "未知错误"}`);
    if (message.type === "done" || message.type === "error") { port.disconnect(); if (explanationPort === port) explanationPort = undefined; }
  });
  port.postMessage({ question, probability });
}
function directAnswer(question: ExtractedQuestion) {
  cancelActive();
  const sequence = ++analysisSequence, requestId = crypto.randomUUID();
  activeRequestId = requestId;
  overlay.directLoading(question);
  void chrome.runtime.sendMessage({ type: "DIRECT_ANSWER", requestId, question }).then((response: WorkerResponse) => {
    if (sequence === analysisSequence) { activeRequestId = undefined; overlay.show(response); }
  }).catch((error: unknown) => {
    if (sequence === analysisSequence) { activeRequestId = undefined; overlay.show({ ok: false, code: "DIRECT_ANSWER_FAILED", message: error instanceof Error ? error.message : "普通模型答题失败，请重试。", recoverable: true, question }); }
  });
}
function cancelActive() {
  analysisSequence++;
  if (activeRequestId) { void chrome.runtime.sendMessage({ type: "CANCEL", requestId: activeRequestId }); activeRequestId = undefined; }
  explanationPort?.disconnect(); explanationPort = undefined;
}
function isEditable(target: EventTarget | null) { return target instanceof Element && (!!target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false])") || document.designMode === "on"); }
function isExtensionNode(target: EventTarget | null) { return target instanceof Element && !!target.closest("[data-jev-swot-root]"); }
async function refreshDisabledState() {
  const settings = await getSettings();
  const host = location.hostname.toLowerCase();
  disabledForSite = settings.disabledHosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (disabledForSite) overlay.dismiss();
}
async function whenSiteEnabled(action: () => void): Promise<void> {
  await disabledStateReady;
  if (!disabledForSite) action();
}
