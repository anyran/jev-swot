import { elementFromRect, extractFromElement, findQuestionContainer } from "./extract";
import { ResultOverlay } from "./overlay";
import type { ExtractedQuestion, ProbabilityResult, WorkerResponse } from "../shared/types";

let selecting = false;
let selectionBox: HTMLDivElement | null = null;
let start = { x: 0, y: 0 };
const overlay = new ResultOverlay(analyze, explain, cancelActive);
let analysisSequence = 0;
let activeRequestId: string | undefined;
let explanationPort: chrome.runtime.Port | undefined;
let selectionCaptureAuthorized = false;
let lastCaptureAuthorized = false;

chrome.runtime.onMessage.addListener((message) => { if (message.type === "START_SELECTION") { selectionCaptureAuthorized = true; startSelection(); } });
document.addEventListener("dblclick", (event) => {
  if (!event.altKey || isEditable(event.target) || isExtensionNode(event.target)) return;
  event.preventDefault(); event.stopPropagation();
  const target = event.target instanceof Element ? event.target : document.body;
  analyze(extractFromElement(findQuestionContainer(target)), undefined, false);
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
  cleanup(); if (rect.width < 10 || rect.height < 10) return;
  const q = extractFromElement(elementFromRect(rect)); q.sourceRect = rect; analyze(q, undefined, selectionCaptureAuthorized); selectionCaptureAuthorized = false;
}
function cancelOnEscape(event: KeyboardEvent) { if (event.key === "Escape") cleanup(); }
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
function cancelActive() {
  if (activeRequestId) { void chrome.runtime.sendMessage({ type: "CANCEL", requestId: activeRequestId }); activeRequestId = undefined; }
  explanationPort?.disconnect(); explanationPort = undefined;
}
function isEditable(target: EventTarget | null) { return target instanceof Element && (!!target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false])") || document.designMode === "on"); }
function isExtensionNode(target: EventTarget | null) { return target instanceof Element && !!target.closest("[data-jev-swot-root]"); }
