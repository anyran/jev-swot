import { elementFromRect, extractFromElement, findQuestionContainer } from "./extract";
import { ResultOverlay } from "./overlay";
import type { ExtractedQuestion, ProbabilityResult, WorkerResponse } from "../shared/types";

let selecting = false;
let selectionBox: HTMLDivElement | null = null;
let start = { x: 0, y: 0 };
const overlay = new ResultOverlay(analyze, explain);

chrome.runtime.onMessage.addListener((message) => { if (message.type === "START_SELECTION") startSelection(); });
document.addEventListener("dblclick", (event) => {
  if (!event.altKey || isEditable(event.target)) return;
  event.preventDefault(); event.stopPropagation();
  const target = event.target instanceof Element ? event.target : document.body;
  analyze(extractFromElement(findQuestionContainer(target)));
}, true);

function startSelection() {
  if (selecting) return; selecting = true;
  document.documentElement.style.cursor = "crosshair";
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("keydown", cancelOnEscape, true);
}
function down(event: PointerEvent) {
  if (event.button !== 0) return; event.preventDefault(); start = { x: event.clientX, y: event.clientY };
  selectionBox = document.createElement("div"); selectionBox.dataset.jevanswerRoot = "selection";
  Object.assign(selectionBox.style, { position: "fixed", zIndex: "2147483646", border: "2px solid #3b82f6", background: "#3b82f622", pointerEvents: "none" });
  document.documentElement.append(selectionBox); document.addEventListener("pointermove", move, true); document.addEventListener("pointerup", up, true);
}
function move(event: PointerEvent) { if (!selectionBox) return; const x = Math.min(start.x, event.clientX), y = Math.min(start.y, event.clientY); Object.assign(selectionBox.style, { left: `${x}px`, top: `${y}px`, width: `${Math.abs(event.clientX-start.x)}px`, height: `${Math.abs(event.clientY-start.y)}px` }); }
function up(event: PointerEvent) {
  const rect = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(event.clientX-start.x), height: Math.abs(event.clientY-start.y) };
  cleanup(); if (rect.width < 10 || rect.height < 10) return;
  const q = extractFromElement(elementFromRect(rect)); q.sourceRect = rect; analyze(q);
}
function cancelOnEscape(event: KeyboardEvent) { if (event.key === "Escape") cleanup(); }
function cleanup() { selecting = false; selectionBox?.remove(); selectionBox = null; document.documentElement.style.cursor = ""; document.removeEventListener("pointerdown", down, true); document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerup", up, true); document.removeEventListener("keydown", cancelOnEscape, true); }
async function analyze(question: ExtractedQuestion) { overlay.loading(question); const response = await chrome.runtime.sendMessage({ type: "ANALYZE", question, devicePixelRatio: window.devicePixelRatio }) as WorkerResponse; overlay.show(response); }
async function explain(question: ExtractedQuestion, probability: ProbabilityResult) { const response = await chrome.runtime.sendMessage({ type: "EXPLAIN", question, probability }) as WorkerResponse; overlay.explanation(response.ok ? response.explanation ?? "没有解析" : response.message); }
function isEditable(target: EventTarget | null) { return target instanceof Element && !!target.closest("input,textarea,select,[contenteditable=true]"); }
