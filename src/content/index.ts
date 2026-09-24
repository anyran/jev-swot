import { elementFromRect, extractFromElement, extractPageQuestions, type PageQuestionCandidate } from "./extract";
import { ResultOverlay } from "./overlay";
import { PageResultsOverlay } from "./page-results";
import { isSelectionShortcut } from "./shortcut";
import type { DOMRectLike, EmbeddedFrameScanResult, ExtractedQuestion, PersistentSettings, ProbabilityResult, RuntimeProgressMessage, WorkerResponse } from "../shared/types";

// Keep the content script self-contained. Manifest V3 content scripts are classic
// scripts, so Vite must not leave an ESM import to the shared storage chunk here.
const DEFAULT_CONTENT_SETTINGS: PersistentSettings = {
  jev: { endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" },
  llm: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", vision: "auto", structuredOutput: "auto" },
  ocrThreshold: 0.72,
  useWebGpu: false,
  confirmVisionUpload: true,
  disabledHosts: []
};
async function getSettings(): Promise<PersistentSettings> {
  const response = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" }) as { ok?: boolean; settings?: PersistentSettings };
  if (!response?.ok || !response.settings) throw new Error("无法读取扩展设置");
  return response.settings;
}

let selecting = false;
let selectionBox: HTMLDivElement | null = null;
let start = { x: 0, y: 0 };
let previousCursor = "";
const overlay = new ResultOverlay(analyze, explain, directAnswer, cancelActive, loadDetails);
let analysisSequence = 0;
let activeRequestId: string | undefined;
let explanationPort: chrome.runtime.Port | undefined;
type PageCapture = { imageDataUrl: string; screenshotRect: { x: number; y: number; width: number; height: number }; question: ExtractedQuestion };
interface PageBatch {
  sequence: number;
  candidates: Array<PageQuestionCandidate | FramePageQuestionCandidate>;
  captures: Map<number, PageCapture>;
  requestRows: Map<string, number>;
  results: PageResultsOverlay;
  cancelled: boolean;
  frameScanRequestId?: string;
  previousScan?: Promise<void>;
  scanPromise?: Promise<void>;
}
interface FramePageQuestionCandidate { frameId: number; sourceLabel: string; question: ExtractedQuestion }
let currentPageBatch: PageBatch | undefined;
let pageBatchSequence = 0;
let pageResults: PageResultsOverlay | undefined;
let lastPageCaptureAt = 0;
let selectionCaptureAuthorized = false;
let disabledForSite: boolean | undefined;
let disabledStateReady = refreshDisabledState();
const cancelledFrameScanIds = new Set<string>();
chrome.runtime.onMessage.addListener((message: { type?: string; settings?: PersistentSettings } | RuntimeProgressMessage, _sender, sendResponse) => {
  if (message.type === "PING") { sendResponse({ ok: true }); return false; }
  if (message.type === "START_PAGE_SCAN") {
    if (window === window.top) void whenSiteEnabled(analyzeWholePage);
    return false;
  }
  if (message.type === "SCAN_EMBEDDED_FRAME") {
    if (window === window.top) { sendResponse({ ok: false, message: "扫描目标不是嵌入框架。" }); return false; }
    const requestId = (message as { requestId?: string }).requestId;
    if (!requestId) { sendResponse({ ok: false, message: "缺少框架扫描批次编号。" }); return false; }
    void scanEmbeddedFrame(requestId).then(sendResponse).catch((error: unknown) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "框架内容读取失败。" }));
    return true;
  }
  if (message.type === "CANCEL_EMBEDDED_FRAME") {
    const requestId = (message as { requestId?: string }).requestId;
    if (requestId) {
      cancelledFrameScanIds.add(requestId);
      setTimeout(() => cancelledFrameScanIds.delete(requestId), 60_000);
    }
    return false;
  }
  if (message.type === "SETTINGS_CHANGED" && "settings" in message && message.settings) {
    disabledStateReady = Promise.resolve(applyDisabledState(message.settings));
    return false;
  }
  if (message.type === "START_SELECTION") {
    void whenSiteEnabled(() => {
      if (pageResults) {
        pageResults.setNotice("当前网页的临时截图权限已启用；可重试此前因浏览器权限失败的视觉题。 ");
        return;
      }
      selectionCaptureAuthorized = true;
      startSelection();
    });
  }
  if (message.type === "ANALYZE_PROGRESS" && "requestId" in message) {
    if (message.requestId === activeRequestId) overlay.progress(message.message);
    else {
      const batch = currentPageBatch, row = batch?.requestRows.get(message.requestId);
      if (batch && row != null) batch.results.setProgress(row, message.message);
    }
  }
});
document.addEventListener("dblclick", (event) => {
  // Do not intercept while the disabled-site setting is still loading.  A
  // sensitive site must remain untouched unless we have confirmed it is
  // enabled for this extension.
  if (!event.altKey || isEditable(event.target) || isExtensionNode(event.target) || disabledForSite !== false) return;
  // Cancel the page's double-click action synchronously; the settings check
  // below may need to await storage, which is too late for preventDefault.
  event.preventDefault(); event.stopPropagation();
  void whenSiteEnabled(() => window === window.top ? analyzeWholePage() : requestTopPageScan());
}, true);
document.addEventListener("keydown", (event) => {
  // Chrome may leave a suggested command unassigned when Ctrl/Command+Shift+Y
  // conflicts with the browser or another extension.  Once this content
  // script is present (persistent optional page access or an activeTab
  // injection), keep the same gesture as a reliable in-page fallback.
  if (!isSelectionShortcut(event) || isEditable(event.target) || isExtensionNode(event.target) || disabledForSite !== false) return;
  // While the page-results panel is open, only the browser-level extension
  // command can grant activeTab. Let it handle the shortcut so its START_SELECTION
  // message can preserve the panel and expose the per-question capture retry.
  if (pageResults) return;
  event.preventDefault(); event.stopPropagation();
  void whenSiteEnabled(() => { selectionCaptureAuthorized = true; startSelection(); });
}, true);

function startSelection() {
  if (selecting) return;
  closePageResults();
  selecting = true;
  previousCursor = document.documentElement.style.cursor;
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
function cleanup() { selecting = false; selectionBox?.remove(); selectionBox = null; document.documentElement.style.cursor = previousCursor; previousCursor = ""; document.removeEventListener("pointerdown", down, true); document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerup", up, true); document.removeEventListener("keydown", cancelOnEscape, true); }
async function analyzeWholePage() {
  if (selecting) cleanup();
  selectionCaptureAuthorized = false;
  const previousScan = currentPageBatch?.scanPromise;
  cancelPageBatch();
  pageResults?.dismiss();
  pageResults = undefined;
  cancelActive();
  overlay.dismiss();
  const sequence = ++pageBatchSequence;
  let batch: PageBatch | undefined;
  const results = new PageResultsOverlay(
    [],
    () => { if (batch && !batch.scanPromise) batch.scanPromise = runPageBatch(batch); },
    (index, consent) => { if (batch) void runPageQuestion(batch, index, consent === "retry" ? undefined : consent); },
    cancelPageBatch,
    (index) => {
      const item = batch?.results.itemAt(index);
      if (batch && item?.response) overlay.showExisting(item.question, item.response, batch.captures.has(index));
    },
    () => { if (batch) dismissPageBatch(batch); },
    "没有在当前网页中识别到完整题目。含图片或画布的特殊题目可先用框选快捷键识别。"
  );
  batch = { sequence, candidates: [], captures: new Map(), requestRows: new Map(), results, cancelled: false, previousScan };
  currentPageBatch = batch;
  pageResults = results;
}
function requestTopPageScan() {
  void chrome.runtime.sendMessage({ type: "START_TOP_PAGE_SCAN" }).catch(() => undefined);
}
async function runPageBatch(batch: PageBatch) {
  if (batch.previousScan) await batch.previousScan.catch(() => undefined);
  const isCancelled = () => batch.cancelled || currentPageBatch !== batch;
  if (isCancelled()) return;
  const originalScroll = { x: window.scrollX, y: window.scrollY };
  const originalNestedScroll = new Map<HTMLElement, { x: number; y: number }>();
  const scannedNestedScrollers = new Map<HTMLElement, number>();
  const seen = new Set<string>();
  const step = Math.max(240, Math.floor(window.innerHeight * 0.72));
  let scanY = 0, scanSteps = 0, timedOutRescanHeight: number | undefined;
  const scanWarnings = new Set<string>();
  const visibleFrameCount = [...document.querySelectorAll("iframe,frame")].filter((frame) => {
    const style = getComputedStyle(frame), rect = frame.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }).length;
  const collectQuestionsAtCurrentPosition = async () => {
    const currentOffset = { x: window.scrollX, y: window.scrollY };
    for (const candidate of extractPageQuestions(document.body, currentOffset)) {
      if (isCancelled()) break;
      const key = pageQuestionKey(candidate.question);
      if (seen.has(key)) continue;
      seen.add(key);
      const index = batch.candidates.length;
      batch.candidates.push(candidate);
      batch.results.addQuestion(candidate.question);
      await runPageQuestion(batch, index);
    }
  };
  const scanNestedScrollers = async () => {
    // Some quiz apps keep the document fixed and virtualize questions inside
    // an overflow:auto panel. Traverse those panels too; a window-only scan
    // would otherwise see just the currently rendered rows.
    const scrollers = [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => {
      if (isExtensionNode(element) || !(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const vertical = /^(auto|scroll|overlay)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      const horizontal = /^(auto|scroll|overlay)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
      return vertical || horizontal;
    });
    for (const scroller of scrollers) {
      if (isCancelled() || scanSteps >= 1000) break;
      const previousHeight = scannedNestedScrollers.get(scroller);
      if (previousHeight != null && previousHeight >= scroller.scrollHeight) continue;
      if (!originalNestedScroll.has(scroller)) originalNestedScroll.set(scroller, { x: scroller.scrollLeft, y: scroller.scrollTop });
      const nestedStep = Math.max(160, Math.floor(scroller.clientHeight * 0.72));
      let nestedY = 0, nestedX = 0, nestedPasses = 0;
      while (!isCancelled() && scanSteps < 1000 && nestedPasses < 1000) {
        const maxY = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const maxX = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        const currentY = Math.min(nestedY, maxY), currentX = Math.min(nestedX, maxX);
        scroller.scrollTo({ left: currentX, top: currentY, behavior: "instant" });
        await waitForPagePaint();
        await delay(120);
        await collectQuestionsAtCurrentPosition();
        scanSteps++;
        nestedPasses++;
        if (isCancelled()) break;
        if (currentY >= maxY && currentX >= maxX) {
          const settled = await waitForPageStability(scroller, isCancelled);
          await collectQuestionsAtCurrentPosition();
          const expandedMaxY = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          const expandedMaxX = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
          if (settled.timedOut) scanWarnings.add("页面内容持续变化；已扫描当前加载的题目，结果可能不完整。");
          if (expandedMaxY > maxY || expandedMaxX > maxX) {
            nestedY = Math.min(expandedMaxY, maxY + nestedStep);
            nestedX = Math.min(expandedMaxX, maxX + Math.max(160, Math.floor(scroller.clientWidth * 0.72)));
          } else break;
        } else {
          nestedY = Math.min(maxY, currentY + nestedStep);
          nestedX = Math.min(maxX, currentX + Math.max(160, Math.floor(scroller.clientWidth * 0.72)));
        }
      }
      scannedNestedScrollers.set(scroller, scroller.scrollHeight);
      if (nestedPasses >= 1000 && !isCancelled()) scanWarnings.add("网页持续滚动加载，已达到整页扫描安全上限；当前结果可能不完整。");
    }
  };
  try {
    while (!isCancelled() && scanSteps < 1000) {
      const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const currentY = Math.min(scanY, maxY);
      window.scrollTo({ left: 0, top: currentY, behavior: "instant" });
      await waitForPagePaint();
      await delay(120);
      await collectQuestionsAtCurrentPosition();
      await scanNestedScrollers();
      if (isCancelled()) break;
      if (currentY >= maxY) {
        const settled = await waitForPageStability(document.documentElement, isCancelled);
        const expandedMax = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        if (settled.timedOut) {
          scanWarnings.add("页面内容持续变化；已扫描当前加载的题目，结果可能不完整。");
          // Give content that arrived during the timeout one final extraction
          // pass, but do not wait forever on animated or continuously updating pages.
          if (settled.changed && timedOutRescanHeight !== expandedMax) {
            timedOutRescanHeight = expandedMax;
            scanY = Math.min(expandedMax, maxY + step);
          } else break;
        } else if (expandedMax > maxY || settled.changed) {
          timedOutRescanHeight = undefined;
          scanY = Math.min(expandedMax, maxY + step);
        } else break;
      } else scanY = Math.min(maxY, currentY + step);
      scanSteps++;
    }
    if (scanSteps >= 1000 && !isCancelled()) scanWarnings.add("网页持续滚动加载，已达到整页扫描安全上限；当前结果可能不完整。");
    if (!isCancelled() && visibleFrameCount) await appendEmbeddedFrameQuestions(batch, scanWarnings);
  } catch (error) {
    if (!isCancelled()) scanWarnings.add(`整页扫描中断：${error instanceof Error ? error.message : "网页内容读取失败。"}`);
  } finally {
    for (const [scroller, position] of originalNestedScroll) {
      if (scroller.isConnected) scroller.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
    }
    window.scrollTo({ left: originalScroll.x, top: originalScroll.y, behavior: "instant" });
    await waitForPagePaint();
    if (currentPageBatch === batch) batch.results.finishScan(scanWarnings.size ? [...scanWarnings].join(" ") : undefined);
  }
}
async function appendEmbeddedFrameQuestions(batch: PageBatch, warnings: Set<string>) {
  if (pageBatchIsCancelled(batch)) return;
  const requestId = crypto.randomUUID();
  batch.frameScanRequestId = requestId;
  let response: WorkerResponse;
  try {
    response = await chrome.runtime.sendMessage({ type: "SCAN_EMBEDDED_FRAMES", requestId }) as WorkerResponse;
  } catch (error) {
    if (!pageBatchIsCancelled(batch)) warnings.add(`嵌入框架扫描失败：${error instanceof Error ? error.message : "扩展后台暂不可用。"}`);
    return;
  } finally {
    if (batch.frameScanRequestId === requestId) batch.frameScanRequestId = undefined;
  }
  if (pageBatchIsCancelled(batch)) return;
  if (!response.ok) {
    warnings.add(response.message || "浏览器未允许读取嵌入框架；其题目可能未纳入整页结果。");
    return;
  }
  const frames = response.frames ?? [];
  if (!frames.length) {
    warnings.add("页面含嵌入框架，但浏览器未返回可扫描的框架；框架题目可能未纳入整页结果。");
    return;
  }
  for (const frame of frames) {
    if (pageBatchIsCancelled(batch)) return;
    const label = frameSourceLabel(frame.url);
    if (!frame.ok) {
      warnings.add(`${label}未能扫描：${frame.message || "内容不可读取。"}`);
      continue;
    }
    if (frame.warning) warnings.add(`${label}：${frame.warning}`);
    for (const sourceQuestion of frame.questions ?? []) {
      if (pageBatchIsCancelled(batch)) return;
      const question = withoutFrameCoordinates(sourceQuestion);
      const index = batch.candidates.length;
      batch.candidates.push({ frameId: frame.frameId, sourceLabel: label, question });
      batch.results.addQuestion(question, label);
      await runPageQuestion(batch, index);
    }
  }
}

function frameSourceLabel(value?: string) {
  try { return `嵌入框架 · ${new URL(value!).origin}`; }
  catch { return "嵌入框架"; }
}

function withoutFrameCoordinates(question: ExtractedQuestion): ExtractedQuestion {
  const { coordinateSpace: _coordinateSpace, ...rest } = question;
  return {
    ...rest,
    sourceRect: { x: 0, y: 0, width: 0, height: 0 },
    options: question.options.map(({ sourceRect: _sourceRect, ...option }) => option)
  };
}

async function scanEmbeddedFrame(requestId: string): Promise<{ ok: boolean; questions?: ExtractedQuestion[]; warning?: string; message?: string }> {
  await disabledStateReady;
  let settings: PersistentSettings;
  try { settings = await getSettings(); }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : "无法读取扩展设置。" }; }
  applyDisabledState(settings);
  if (disabledForSite) return { ok: false, message: "该嵌入框架所在站点已在设置中禁用。" };

  const originalScroll = { x: window.scrollX, y: window.scrollY };
  const originalNestedScroll = new Map<HTMLElement, { x: number; y: number }>();
  const scannedNestedScrollers = new Map<HTMLElement, number>();
  const questions: ExtractedQuestion[] = [];
  const seen = new Set<string>();
  const warnings = new Set<string>();
  const isCancelled = () => cancelledFrameScanIds.has(requestId);
  const step = Math.max(240, Math.floor(window.innerHeight * 0.72));
  let scanY = 0, scanSteps = 0;
  const collect = () => {
    for (const candidate of extractPageQuestions(document.body, { x: window.scrollX, y: window.scrollY })) {
      const key = pageQuestionKey(candidate.question);
      if (seen.has(key)) continue;
      seen.add(key);
      questions.push(candidate.question);
    }
  };
  const scanNestedScrollers = async () => {
    const scrollers = [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => {
      if (isExtensionNode(element) || !(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const vertical = /^(auto|scroll|overlay)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      const horizontal = /^(auto|scroll|overlay)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
      return vertical || horizontal;
    });
    for (const scroller of scrollers) {
      if (isCancelled() || scanSteps >= 1000) break;
      const previousHeight = scannedNestedScrollers.get(scroller);
      if (previousHeight != null && previousHeight >= scroller.scrollHeight) continue;
      if (!originalNestedScroll.has(scroller)) originalNestedScroll.set(scroller, { x: scroller.scrollLeft, y: scroller.scrollTop });
      const nestedStep = Math.max(160, Math.floor(scroller.clientHeight * 0.72));
      let nestedY = 0, nestedX = 0, nestedPasses = 0;
      while (!isCancelled() && scanSteps < 1000 && nestedPasses < 1000) {
        const maxY = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const maxX = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        const currentY = Math.min(nestedY, maxY), currentX = Math.min(nestedX, maxX);
        scroller.scrollTo({ left: currentX, top: currentY, behavior: "instant" });
        await waitForPagePaint(); await delay(120); collect(); scanSteps++; nestedPasses++;
        if (isCancelled()) break;
        if (currentY >= maxY && currentX >= maxX) {
          const settled = await waitForPageStability(scroller, isCancelled);
          collect();
          if (settled.timedOut) warnings.add("框架内容持续变化；已扫描当前加载的题目，结果可能不完整。");
          const expandedY = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          const expandedX = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
          if (expandedY > maxY || expandedX > maxX) {
            nestedY = Math.min(expandedY, maxY + nestedStep);
            nestedX = Math.min(expandedX, maxX + Math.max(160, Math.floor(scroller.clientWidth * 0.72)));
          } else break;
        } else {
          nestedY = Math.min(maxY, currentY + nestedStep);
          nestedX = Math.min(maxX, currentX + Math.max(160, Math.floor(scroller.clientWidth * 0.72)));
        }
      }
      scannedNestedScrollers.set(scroller, scroller.scrollHeight);
      if (nestedPasses >= 1000 && !isCancelled()) warnings.add("框架滚动加载达到安全上限；结果可能不完整。");
    }
  };
  try {
    while (!isCancelled() && scanSteps < 1000) {
      const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const currentY = Math.min(scanY, maxY);
      window.scrollTo({ left: 0, top: currentY, behavior: "instant" });
      await waitForPagePaint(); await delay(120); collect(); await scanNestedScrollers();
      if (isCancelled()) break;
      if (currentY >= maxY) {
        const settled = await waitForPageStability(document.documentElement, isCancelled);
        collect();
        const expandedMax = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        if (settled.timedOut) {
          warnings.add("框架内容持续变化；已扫描当前加载的题目，结果可能不完整。");
          if (settled.changed && scanY <= maxY) scanY = Math.min(expandedMax, maxY + step);
          else break;
        } else if (expandedMax > maxY || settled.changed) scanY = Math.min(expandedMax, maxY + step);
        else break;
      } else scanY = Math.min(maxY, currentY + step);
      scanSteps++;
    }
    if (scanSteps >= 1000 && !isCancelled()) warnings.add("框架滚动加载达到安全上限；结果可能不完整。");
  } catch (error) {
    if (!isCancelled()) warnings.add(`框架扫描中断：${error instanceof Error ? error.message : "内容读取失败。"}`);
  } finally {
    for (const [scroller, position] of originalNestedScroll) {
      if (scroller.isConnected) scroller.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
    }
    window.scrollTo({ left: originalScroll.x, top: originalScroll.y, behavior: "instant" });
    await waitForPagePaint();
    const wasCancelled = isCancelled();
    cancelledFrameScanIds.delete(requestId);
    if (wasCancelled) return { ok: true, questions: [] };
  }
  return { ok: true, questions, warning: warnings.size ? [...warnings].join(" ") : undefined };
}

function pageQuestionKey(question: ExtractedQuestion) {
  const fingerprint = [question.stem, ...question.options.map((option) => `${option.label}:${option.text}`)]
    .join("|").normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "").toLocaleLowerCase();
  return `${fingerprint}|${Math.round(question.sourceRect.x / 8)}|${Math.round(question.sourceRect.y / 8)}`;
}
function requiresPageRecognitionFallback(question: ExtractedQuestion) {
  const ids = question.options.map((option) => option.id);
  const labels = question.options.map((option) => option.label.trim().toLocaleUpperCase());
  const texts = question.options.map((option) => option.text.trim().toLocaleLowerCase());
  const incomplete = !question.stem.trim() || question.options.length < 2 || question.options.length > 255 ||
    new Set(ids).size !== ids.length || question.options.some((option) => !option.label.trim() || !option.text.trim()) ||
    new Set(labels).size !== labels.length || new Set(texts).size !== texts.length;
  return incomplete || question.warnings.some((warning) => warning === "INCOMPLETE_OPTIONS" || warning === "POSSIBLE_FORMULA" || warning === "POSSIBLE_DIAGRAM" || warning === "VISION_MODEL_REQUIRED");
}
function pageBatchIsCancelled(batch: PageBatch) {
  return batch.cancelled || currentPageBatch !== batch;
}
async function runPageQuestion(batch: PageBatch, index: number, visionConsent?: "allow" | "deny") {
  const candidate = batch.candidates[index], results = batch.results;
  if (!candidate || pageBatchIsCancelled(batch)) return;
  let question = candidate.question;
  let capture = batch.captures.get(index);
  const isFrameQuestion = !("element" in candidate);
  if (isFrameQuestion && requiresPageRecognitionFallback(question)) {
    results.setResult(index, { ok: false, code: "FRAME_VISUAL_UNSUPPORTED", message: "这道嵌入框架题需要视觉/截图识别；为避免截取错位内容，请在框架页面单独打开后识别。", recoverable: true, question });
    return;
  }
  if (!isFrameQuestion && !capture && requiresPageRecognitionFallback(question)) {
    results.setProgress(index, "正在读取整道题的页面内容…");
    try {
      capture = await capturePageQuestion(candidate as PageQuestionCandidate, batch);
      batch.captures.set(index, capture);
      question = capture.question;
    } catch (error) {
      if (!pageBatchIsCancelled(batch)) results.setResult(index, { ok: false, code: "PAGE_CAPTURE_FAILED", message: error instanceof Error ? error.message : "无法截取完整题目。", recoverable: true, question });
      return;
    }
  } else if (capture) question = capture.question;
  if (pageBatchIsCancelled(batch)) return;
  const requestId = crypto.randomUUID();
  batch.requestRows.set(requestId, index);
  results.setProgress(index, `正在请求第 ${index + 1} 题…`);
  const response = await chrome.runtime.sendMessage({
    type: "ANALYZE", requestId, question,
    screenshot: capture?.imageDataUrl,
    screenshotRect: capture?.screenshotRect,
    devicePixelRatio: capture ? 1 : window.devicePixelRatio,
    visionConsent,
    captureAuthorized: !!capture
  }).catch((error: unknown) => ({ ok: false, code: "UNEXPECTED", message: error instanceof Error ? error.message : "扩展后台暂时不可用，请重试。", recoverable: true, question })) as WorkerResponse;
  batch.requestRows.delete(requestId);
  if (!pageBatchIsCancelled(batch)) results.setResult(index, response);
}
async function capturePageQuestion(candidate: PageQuestionCandidate, batch: PageBatch): Promise<PageCapture> {
  const element = candidate.element;
  if (!element.isConnected) throw new Error("题目在整页扫描期间已被网页替换，请重新触发 Alt + 双击。 ");
  const originalScroll = { x: window.scrollX, y: window.scrollY };
  const resumePageResults = batch.results.suspend();
  try {
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    await waitForPagePaint();
    const questionScroll = { x: window.scrollX, y: window.scrollY };
    const bounds = element.getBoundingClientRect();
    const pageRect = { x: bounds.left + window.scrollX, y: bounds.top + window.scrollY, width: bounds.width, height: bounds.height };
    if (pageRect.width < 1 || pageRect.height < 1) throw new Error("题目当前不可见，无法截取完整内容。");
    const question = extractFromElement(element);
    question.sourceRect = pageRect;
    question.coordinateSpace = "document";
    question.options = question.options.map((option) => option.sourceRect ? {
      ...option,
      sourceRect: { ...option.sourceRect, x: option.sourceRect.x + questionScroll.x, y: option.sourceRect.y + questionScroll.y }
    } : option);
    const captureRect = { x: pageRect.x, y: pageRect.y, width: pageRect.width, height: pageRect.height };
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const scale = Math.min(1, 2400 / Math.max(pageRect.width, pageRect.height), Math.sqrt(5_000_000 / Math.max(1, pageRect.width * pageRect.height)));
    const width = Math.max(1, Math.round(pageRect.width * scale)), height = Math.max(1, Math.round(pageRect.height * scale));
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法组合整道题的截图。");
    context.fillStyle = "white"; context.fillRect(0, 0, width, height);
    const maxX = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const xPositions = capturePositions(pageRect.x, pageRect.x + pageRect.width, window.innerWidth, maxX);
    const yPositions = capturePositions(pageRect.y, pageRect.y + pageRect.height, window.innerHeight, maxY);
    for (const scrollY of yPositions) for (const scrollX of xPositions) {
      if (pageBatchIsCancelled(batch)) throw new Error("整页识别已取消。");
      window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
      await waitForPagePaint();
      const elapsed = performance.now() - lastPageCaptureAt;
      if (elapsed < 520) await delay(520 - elapsed);
      const captured = await chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE_TAB" }) as WorkerResponse;
      if (!captured.ok) throw new Error(captured.message || "浏览器拒绝截取当前网页。");
      if (!captured.imageDataUrl) throw new Error("浏览器未返回网页截图。");
      lastPageCaptureAt = performance.now();
      const bitmap = await createImageBitmap(await (await fetch(captured.imageDataUrl)).blob());
      try {
        const left = Math.max(pageRect.x, window.scrollX), top = Math.max(pageRect.y, window.scrollY);
        const right = Math.min(pageRect.x + pageRect.width, window.scrollX + window.innerWidth), bottom = Math.min(pageRect.y + pageRect.height, window.scrollY + window.innerHeight);
        if (right <= left || bottom <= top) continue;
        const sourceX = Math.max(0, Math.round((left - window.scrollX) * dpr)), sourceY = Math.max(0, Math.round((top - window.scrollY) * dpr));
        const sourceWidth = Math.min(bitmap.width - sourceX, Math.round((right - left) * dpr)), sourceHeight = Math.min(bitmap.height - sourceY, Math.round((bottom - top) * dpr));
        const destinationX = Math.round((left - pageRect.x) * scale), destinationY = Math.round((top - pageRect.y) * scale);
        const destinationWidth = Math.max(1, Math.round(sourceWidth / dpr * scale)), destinationHeight = Math.max(1, Math.round(sourceHeight / dpr * scale));
        if (sourceWidth > 0 && sourceHeight > 0) context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, destinationX, destinationY, destinationWidth, destinationHeight);
      } finally { bitmap.close(); }
    }
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return { imageDataUrl: await blobToDataUrl(blob), screenshotRect: { x: 0, y: 0, width, height }, question };
  } finally {
    window.scrollTo({ left: originalScroll.x, top: originalScroll.y, behavior: "instant" });
    await waitForPagePaint();
    resumePageResults?.();
  }
}
function capturePositions(start: number, end: number, viewport: number, maximum: number): number[] {
  const step = Math.max(1, Math.floor(viewport * 0.75));
  const positions: number[] = [];
  let current = Math.max(0, Math.min(maximum, Math.floor(start - 48)));
  while (!positions.includes(current)) {
    positions.push(current);
    if (current + viewport >= end || current >= maximum) break;
    const next = Math.min(maximum, current + step);
    if (next === current) break;
    current = next;
  }
  return positions;
}
async function waitForPagePaint() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await delay(80);
}
async function waitForPageStability(root: Element, isCancelled: () => boolean): Promise<{ changed: boolean; timedOut: boolean }> {
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  const getHeight = () => root === document.documentElement || root === document.body
    ? document.documentElement.scrollHeight
    : (root as HTMLElement).scrollHeight;
  let previousHeight = getHeight();
  let changed = false;
  const observer = new MutationObserver(() => { changed = true; lastActivityAt = Date.now(); });
  observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-hidden", "class", "hidden", "style"] });
  try {
    while (!isCancelled()) {
      await delay(100);
      const height = getHeight();
      if (height !== previousHeight) { changed = true; previousHeight = height; lastActivityAt = Date.now(); }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= 1_800 && Date.now() - lastActivityAt >= 700) return { changed, timedOut: false };
      if (elapsed >= 10_000) return { changed, timedOut: true };
    }
    return { changed, timedOut: false };
  } finally { observer.disconnect(); }
}
function delay(milliseconds: number) { return new Promise<void>((resolve) => setTimeout(resolve, milliseconds)); }
async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}
function cancelPageBatch() {
  const batch = currentPageBatch;
  if (!batch || batch.cancelled) return;
  batch.cancelled = true;
  cancelEmbeddedFrameScan(batch);
  for (const requestId of batch.requestRows.keys()) void chrome.runtime.sendMessage({ type: "CANCEL", requestId }).catch(() => undefined);
  batch.requestRows.clear();
}
function dismissPageBatch(batch: PageBatch) {
  if (currentPageBatch === batch) {
    cancelPageBatch();
    currentPageBatch = undefined;
  } else {
    batch.cancelled = true;
    cancelEmbeddedFrameScan(batch);
    for (const requestId of batch.requestRows.keys()) void chrome.runtime.sendMessage({ type: "CANCEL", requestId }).catch(() => undefined);
    batch.requestRows.clear();
  }
}
function cancelEmbeddedFrameScan(batch: PageBatch) {
  const requestId = batch.frameScanRequestId;
  if (!requestId) return;
  batch.frameScanRequestId = undefined;
  void chrome.runtime.sendMessage({ type: "CANCEL_EMBEDDED_FRAME_SCAN", requestId }).catch(() => undefined);
}
function closePageResults() {
  const current = pageResults;
  pageResults = undefined;
  current?.dismiss();
}
async function analyze(question: ExtractedQuestion, visionConsent?: "allow" | "deny", captureAuthorized = false) {
  closePageResults(); cancelPageBatch(); cancelActive(); const sequence = ++analysisSequence, requestId = crypto.randomUUID(); activeRequestId = requestId; overlay.loading(question, captureAuthorized);
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
function loadDetails(detailToken: string) {
  cancelActive();
  const sequence = ++analysisSequence, requestId = crypto.randomUUID();
  activeRequestId = requestId;
  overlay.detailsLoading();
  void chrome.runtime.sendMessage({ type: "LOAD_DETAILS", requestId, detailToken }).then((response: WorkerResponse) => {
    if (sequence === analysisSequence) { activeRequestId = undefined; overlay.showDetails(response); }
  }).catch((error: unknown) => {
    if (sequence === analysisSequence) { activeRequestId = undefined; overlay.showDetails({ ok: false, code: "DETAILS_FAILED", message: error instanceof Error ? error.message : "题目详情识别失败，请重试。", recoverable: true }); }
  });
}
function cancelActive() {
  analysisSequence++;
  if (activeRequestId) { void chrome.runtime.sendMessage({ type: "CANCEL", requestId: activeRequestId }).catch(() => undefined); activeRequestId = undefined; }
  explanationPort?.disconnect(); explanationPort = undefined;
}
function isEditable(target: EventTarget | null) { return target instanceof Element && (!!target.closest("input,textarea,select,[contenteditable]:not([contenteditable=false])") || document.designMode === "on"); }
function isExtensionNode(target: EventTarget | null) { return target instanceof Element && !!target.closest("[data-jev-swot-root]"); }
async function refreshDisabledState() {
  try {
    applyDisabledState(await getSettings());
  } catch {
    // Fail closed if storage is unavailable.  A transient settings failure
    // must not enable page interception or screenshot analysis by accident.
    disabledForSite = true;
    stopForDisabledSite();
  }
}
function applyDisabledState(settings: PersistentSettings) {
  const host = location.hostname.toLowerCase();
  disabledForSite = settings.disabledHosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (disabledForSite) stopForDisabledSite();
}
function stopForDisabledSite() {
  disabledForSite = true;
  selectionCaptureAuthorized = false;
  if (selecting) cleanup();
  closePageResults();
  overlay.dismiss();
}
async function whenSiteEnabled(action: () => void): Promise<void> {
  await disabledStateReady;
  if (!disabledForSite) action();
}
