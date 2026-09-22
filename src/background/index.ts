import { askJev } from "../core/typesafe";
import { LlmError, answerWithLlm, explainAnswer, recognizeWithVision, streamExplanation, structureOcrText } from "../core/llm";
import { hasQuestionTextConflict, parseQuestionText, requiresRecognitionFallback, sanitizeDomQuestion, validateQuestion } from "../core/question";
import { hasStructuredQuestionFields, normalizeParsed } from "../core/recognition";
import { getSecrets, getSettings, setSecrets } from "../shared/storage";
import type { ExtractedQuestion, RecognitionPreview, WorkerRequest, WorkerResponse } from "../shared/types";

const activeRequests = new Map<string, AbortController>();

// Keep session secrets confined to trusted extension contexts.  Content
// scripts do not need API keys; making the access level explicit protects
// against accidental exposure if a future content-script path reads storage.
void Promise.all([
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
]).catch(() => undefined);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.settings) return;
  void getSettings().then((settings) => chrome.tabs.query({}).then((tabs) => Promise.all(tabs
    .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id != null)
    .map((tab) => chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_CHANGED", settings }).catch(() => undefined)))))
    .catch(() => undefined);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "select-question" && tab?.id) await startSelection(tab);
});
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) await startSelection(tab);
});

async function startSelection(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id == null) return;
  try {
    const ready = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    if (ready?.ok) { await chrome.tabs.sendMessage(tab.id, { type: "START_SELECTION" }); return; }
  } catch {
    // Tabs opened before installation may not have the static content script.
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["assets/content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "START_SELECTION" });
  } catch {
    // Chrome internal and other restricted pages reject injection.
  }
}

chrome.runtime.onMessage.addListener((request: WorkerRequest, sender, sendResponse) => {
  if (request.type === "OCR" || request.type === "CROP_IMAGE" || request.type === "CANCEL_OCR") return false;
  void handle(request, sender).then(sendResponse).catch((error: unknown) => sendResponse(failure(error)));
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "jev-swot-explanation") return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener((message: { question: ExtractedQuestion; probability: import("../shared/types").ProbabilityResult }) => {
    void (async () => {
      const settings = await getSettings(), secrets = await getSecrets();
      const host = port.sender?.tab?.url ? new URL(port.sender.tab.url).hostname : "";
      if (hostDisabled(host, settings.disabledHosts)) { port.postMessage({ type: "error", message: "Jev 做题家已在此站点禁用。" }); return; }
      if (!secrets.llmApiKey) throw new Error("请先在设置页填写普通模型 API Key。");
      await streamExplanation(message.question, message.probability, settings.llm, secrets.llmApiKey, (chunk) => port.postMessage({ type: "chunk", chunk }), controller.signal);
      port.postMessage({ type: "done" });
    })().catch((error: unknown) => { if (!controller.signal.aborted) port.postMessage({ type: "error", message: error instanceof Error ? error.message : "解析失败" }); });
  });
});

async function handle(request: Exclude<WorkerRequest, { type: "OCR" | "CROP_IMAGE" | "CANCEL_OCR" }>, sender: chrome.runtime.MessageSender): Promise<WorkerResponse> {
  if (request.type === "CANCEL") {
    activeRequests.get(request.requestId)?.abort();
    void chrome.runtime.sendMessage({ type: "CANCEL_OCR", requestId: request.requestId }).catch(() => undefined);
    activeRequests.delete(request.requestId);
    return { ok: true };
  }
  if (request.type === "CLEAR_SESSION") { await chrome.storage.session.clear(); return { ok: true }; }
  if (request.type === "CLEAR_API_KEYS") { await chrome.storage.session.clear(); await chrome.storage.local.remove("savedSecrets"); return { ok: true }; }
  if (request.type === "RELEASE_OCR") {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
    return { ok: true };
  }
  if (request.type === "GET_SETTINGS") return { ok: true, settings: await getSettings() };
  const settings = await getSettings();
  const secrets = await getSecrets();
  if (request.type === "TEST_CONNECTIONS") {
    const capabilities = currentCapabilities(settings.llm, secrets);
    const llm = effectiveLlm(settings.llm, capabilities);
    const results: string[] = [];
    if (secrets.typeSafeApiKey) {
      const probe: ExtractedQuestion = { source: "user-edited", questionType: "single", stem: "2 + 2 等于多少？", options: [{ id: "option_1", label: "A", text: "3" }, { id: "option_2", label: "B", text: "4" }], sourceRect: { x: 0, y: 0, width: 1, height: 1 }, recognitionConfidence: 1, warnings: [] };
      try { const answer = await askJev(probe, secrets.typeSafeApiKey); results.push(`JEV：正常（${answer.model}）`); }
      catch (error) { results.push(`JEV：失败（${messageOf(error)}）`); }
    } else results.push("JEV：未配置密钥");
    if (secrets.llmApiKey) {
      try {
        const structured = await structureOcrText("题目：2+2？ A. 3 B. 4", llm, secrets.llmApiKey);
        if (!hasStructuredQuestionFields(structured)) {
          results.push("文本模型：返回结构不完整（必须包含题干、选项和 ignoredText）");
        } else {
          await cacheCapabilities(settings.llm, secrets, undefined, structured.structuredOutputDetected);
          results.push(`文本模型：正常（结构化输出${structured.structuredOutputDetected === "supported" ? "支持" : "已兼容降级"}）`);
        }
      } catch (error) { results.push(`文本模型：失败（${messageOf(error)}）`); }
      if (settings.llm.vision === "unsupported") results.push("视觉模型：按设置禁用，将使用本地 OCR");
      else {
        try {
          const vision = await recognizeWithVision(request.imageDataUrl, llm, secrets.llmApiKey);
          if (!hasStructuredQuestionFields(vision)) results.push("视觉模型：返回结构不完整，将使用本地 OCR");
          else { await cacheCapabilities(settings.llm, secrets, "supported", vision.structuredOutputDetected); results.push("视觉模型：正常"); }
        }
        catch (error) {
          if (error instanceof LlmError && error.unsupportedVision) { await cacheCapabilities(settings.llm, secrets, "unsupported"); results.push("视觉模型：不支持，将使用本地 OCR"); }
          else results.push(`视觉模型：失败（${messageOf(error)}）`);
        }
      }
    } else results.push("普通模型：未配置密钥");
    return { ok: true, diagnostic: results.join("；") };
  }
  if (request.type === "EXPLAIN") {
    const host = sender.tab?.url ? new URL(sender.tab.url).hostname : "";
    if (hostDisabled(host, settings.disabledHosts)) return { ok: false, code: "SITE_DISABLED", message: "Jev 做题家已在此站点禁用。", recoverable: true };
    if (!secrets.llmApiKey) return { ok: false, code: "LLM_KEY_MISSING", message: "请先在设置页填写普通模型 API Key。", recoverable: true };
    return { ok: true, explanation: await explainAnswer(request.question, request.probability, settings.llm, secrets.llmApiKey) };
  }
  if (request.type === "DIRECT_ANSWER") {
    const host = sender.tab?.url ? new URL(sender.tab.url).hostname : "";
    if (hostDisabled(host, settings.disabledHosts)) {
      return { ok: false, code: "SITE_DISABLED", message: "Jev 做题家已在此站点禁用。", recoverable: true };
    }
    if (!secrets.llmApiKey) return { ok: false, code: "LLM_KEY_MISSING", message: "请先在设置页填写普通模型 API Key。", recoverable: true, question: request.question };
    const errors = validateQuestion(request.question);
    if (errors.length) return { ok: false, code: "QUESTION_INCOMPLETE", message: `${errors.join("；")}。请先在覆盖层中校正题目。`, recoverable: true, question: request.question };
    if (request.question.warnings.includes("VISION_MODEL_REQUIRED") || request.question.warnings.includes("DOM_OCR_CONFLICT") || request.question.warnings.includes("STRUCTURE_REVIEW_REQUIRED")) {
      return { ok: false, code: "QUESTION_REVIEW_REQUIRED", message: "这道题仍需要视觉语义或结构校正，请先完成校正后再让普通模型作答。", recoverable: true, question: request.question };
    }
    const controller = new AbortController(); activeRequests.set(request.requestId, controller);
    try {
      const llm = effectiveLlm(settings.llm, currentCapabilities(settings.llm, secrets));
      const directAnswer = await answerWithLlm(request.question, llm, secrets.llmApiKey, controller.signal);
      await cacheCapabilities(settings.llm, secrets, undefined, directAnswer.structuredOutputDetected);
      return { ok: true, question: request.question, directAnswer };
    } catch (error) {
      return { ok: false, code: controller.signal.aborted ? "CANCELLED" : "DIRECT_ANSWER_FAILED", message: controller.signal.aborted ? "已取消普通模型答题。" : messageOf(error), recoverable: true, question: request.question };
    } finally { activeRequests.delete(request.requestId); }
  }
  const host = sender.tab?.url ? new URL(sender.tab.url).hostname : "";
  if (hostDisabled(host, settings.disabledHosts)) {
    return { ok: false, code: "SITE_DISABLED", message: "Jev 做题家已在此站点禁用。", recoverable: true };
  }
  const controller = new AbortController(); activeRequests.set(request.requestId, controller);
  let question = sanitizeDomQuestion(request.question);
  let preview: RecognitionPreview | undefined;
  try {
    if (requiresRecognitionFallback(question)) {
      if (!request.captureAuthorized) return { ok: false, code: "CAPTURE_REQUIRES_SHORTCUT", message: "这道题需要截图识别。请使用扩展框选快捷键重新选择题目，以授予当前页面的临时截图权限。", recoverable: true };
      const capabilities = currentCapabilities(settings.llm, secrets);
      const canUseVision = !!secrets.llmApiKey && settings.llm.vision !== "unsupported" && (settings.llm.vision === "supported" || capabilities.visionDetected !== "unsupported");
      if (canUseVision && settings.confirmVisionUpload && !request.visionConsent) {
        return { ok: false, code: "VISION_CONSENT_REQUIRED", message: "DOM 无法完整提取这道题。是否允许将当前题目选区截图发送给你配置的视觉模型？", recoverable: true };
      }
      sendProgress(sender, request.requestId, "capture", "正在准备题目截图…");
      let screenshot: string;
      try { screenshot = request.screenshot ?? await capture(sender.tab?.windowId); }
      catch (error) { throw new CaptureError("无法从当前页面读取截图。请使用 Ctrl/Command + Shift + Y 框选题目后重试。", error); }
      const recognized = await recognizeFallback(question, screenshot, request.devicePixelRatio ?? 1, settings, secrets, request.requestId, controller.signal, request.visionConsent !== "deny", (stage, message) => sendProgress(sender, request.requestId, stage, message));
      question = recognized.question; preview = recognized.preview;
    }
    if (question.warnings.includes("STRUCTURE_REVIEW_REQUIRED")) {
      return { ok: false, code: "STRUCTURE_REVIEW_REQUIRED", message: "普通模型未完成题目结构化。请在覆盖层中确认题干和选项，排除答案、解析或页面结果文字后再重试。", recoverable: true, question, preview };
    }
    const errors = validateQuestion(question);
    if (errors.length) return { ok: false, code: "QUESTION_INCOMPLETE", message: `${errors.join("；")}。请在覆盖层中校正后重试。`, recoverable: true, question, preview };
    if (question.source === "local-ocr" && question.recognitionConfidence < settings.ocrThreshold) {
      return { ok: false, code: "LOW_OCR_CONFIDENCE", message: `OCR 置信度 ${Math.round(question.recognitionConfidence * 100)}%，低于阈值。请校正后重试。`, recoverable: true, question, preview };
    }
    if (question.warnings.includes("DOM_OCR_CONFLICT")) {
      return { ok: false, code: "DOM_OCR_CONFLICT", message: "OCR 结果与网页文字明显冲突。请查看原图、校正识别结果后再重试。", recoverable: true, question, preview };
    }
    if (question.source === "local-ocr" && question.warnings.includes("VISION_MODEL_REQUIRED")) {
      return { ok: false, code: "VISION_MODEL_REQUIRED", message: "本题可能依赖图表、几何关系或其他视觉信息，本地 OCR 只能读取文字。请配置支持图像的模型，或在校正界面补充完整的图形描述。", recoverable: true, question, preview };
    }
    if (!secrets.typeSafeApiKey) return { ok: false, code: "JEV_KEY_MISSING", message: "请先在设置页填写 TypeSafe API Key。", recoverable: true, question, preview };
    sendProgress(sender, request.requestId, "jev", "正在请求 JEV 概率…");
    return { ok: true, question, probability: await askJev(question, secrets.typeSafeApiKey, controller.signal), preview };
  } catch (error) {
    return {
      ok: false,
      code: controller.signal.aborted ? "CANCELLED" : error instanceof CaptureError ? "CAPTURE_FAILED" : error instanceof LlmError ? "MODEL_REQUEST_FAILED" : "ANALYSIS_FAILED",
      message: controller.signal.aborted ? "已取消当前识别。" : messageOf(error),
      recoverable: true,
      question,
      preview
    };
  } finally { activeRequests.delete(request.requestId); }
}

async function recognizeFallback(base: ExtractedQuestion, screenshot: string, devicePixelRatio: number, settings: Awaited<ReturnType<typeof getSettings>>, secrets: Awaited<ReturnType<typeof getSecrets>>, requestId: string, signal: AbortSignal, allowVision: boolean, progress: (stage: "vision" | "ocr-loading" | "ocr-running", message: string) => void): Promise<{ question: ExtractedQuestion; preview?: RecognitionPreview }> {
  await ensureOffscreen();
  const cropped = await chrome.runtime.sendMessage({ type: "CROP_IMAGE", imageDataUrl: screenshot, rect: base.sourceRect, devicePixelRatio });
  if (!cropped?.ok) throw new Error(cropped?.message ?? "截图裁切失败");
  if (signal.aborted) throw new Error("识别请求已取消。");
  const questionImage = cropped.imageDataUrl as string;
  const capabilities = currentCapabilities(settings.llm, secrets);
  const llm = effectiveLlm(settings.llm, capabilities);
  let visionFallbackWarning: "VISION_MODEL_UNSUPPORTED" | "VISION_SERVICE_UNAVAILABLE" | undefined;
  if (settings.llm.vision === "unsupported" || capabilities.visionDetected === "unsupported") {
    visionFallbackWarning = "VISION_MODEL_UNSUPPORTED";
  }
  if (allowVision && secrets.llmApiKey && settings.llm.vision !== "unsupported" && (settings.llm.vision === "supported" || capabilities.visionDetected !== "unsupported")) {
    progress("vision", "正在调用视觉模型识别题目…");
    try {
      let parsed: import("../core/llm").StructuredQuestionResult;
      try { parsed = await recognizeWithVision(questionImage, llm, secrets.llmApiKey, signal); }
      catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof LlmError) || !error.retryable) throw error;
        parsed = await recognizeWithVision(questionImage, llm, secrets.llmApiKey, signal);
      }
      await cacheCapabilities(settings.llm, secrets, "supported", parsed.structuredOutputDetected);
      if (signal.aborted) throw new Error("识别请求已取消。");
      if (!hasStructuredQuestionFields(parsed)) throw new LlmError("视觉模型返回的题目结构不完整，将改用本地 OCR。", undefined, false, false);
      const visionQuestion = normalizeParsed(parsed, base, "vision", 0.9);
      // A successful HTTP response is not enough: malformed or incomplete
      // vision JSON must continue through local OCR instead of silently
      // surfacing an unstructured question for JEV.
      if (!validateQuestion(visionQuestion).every((error) => error === "请确认题目是单选还是多选")) throw new LlmError("视觉模型未提取出完整题目，将改用本地 OCR。", undefined, false, false);
      return { question: visionQuestion, preview: { imageDataUrl: questionImage, width: cropped.width, height: cropped.height, boxes: [], excludedText: parsed.ignoredText?.trim() || undefined } };
    } catch (error) {
      if (signal.aborted) throw error;
      if ((error as Error & { unsupportedVision?: boolean }).unsupportedVision) {
        await cacheCapabilities(settings.llm, secrets, "unsupported");
        visionFallbackWarning = "VISION_MODEL_UNSUPPORTED";
      }
      else visionFallbackWarning = "VISION_SERVICE_UNAVAILABLE";
    }
  }
  progress("ocr-loading", "正在加载本地 PP-OCRv5 模型…");
  progress("ocr-running", "正在本地 OCR 识别文字…");
  const ocr = await chrome.runtime.sendMessage({ type: "OCR", requestId, imageDataUrl: questionImage, rect: { x: 0, y: 0, width: cropped.width, height: cropped.height }, devicePixelRatio: 1, useWebGpu: settings.useWebGpu });
  if (!ocr?.ok) throw new Error(ocr?.message ?? "本地 OCR 失败");
  if (signal.aborted) throw new Error("识别请求已取消。");
  let parsed = parseQuestionText(ocr.text, base.sourceRect);
  if (parsed.questionType === "unknown" && base.questionType !== "unknown") parsed.questionType = base.questionType;
  parsed.context = base.context;
  parsed.visualDependency = base.visualDependency;
  parsed.visualDependencyReason = base.visualDependencyReason;
  parsed.recognitionConfidence = ocr.confidence;
  const inheritedWarnings = base.warnings.filter((warning) => warning !== "INCOMPLETE_OPTIONS");
  parsed.warnings = [...new Set([...inheritedWarnings, ...parsed.warnings, ...(ocr.warnings ?? []), ...(visionFallbackWarning ? [visionFallbackWarning] : [])])];
  let excludedText = "";
  if (secrets.llmApiKey) {
    try {
      const structured = await structureOcrText(ocr.text, llm, secrets.llmApiKey, signal, ocr.boxes ?? []);
      await cacheCapabilities(settings.llm, secrets, undefined, structured.structuredOutputDetected);
      excludedText = typeof structured.ignoredText === "string" ? structured.ignoredText.trim() : "";
      parsed = normalizeParsed(structured, parsed, "local-ocr", ocr.confidence);
      if (!hasStructuredQuestionFields(structured)) parsed.warnings.push("STRUCTURE_REVIEW_REQUIRED");
    } catch (error) {
      if (signal.aborted) throw error;
      parsed.warnings.push("STRUCTURE_REVIEW_REQUIRED");
    }
  } else {
    parsed.warnings.push("STRUCTURE_REVIEW_REQUIRED");
  }
  if (hasQuestionTextConflict(base, parsed)) parsed.warnings.push("DOM_OCR_CONFLICT");
  parsed.warnings = [...new Set(parsed.warnings)];
  attachOcrRects(parsed, ocr.boxes ?? [], base.sourceRect, cropped.width, cropped.height);
  return { question: parsed, preview: { imageDataUrl: questionImage, width: cropped.width, height: cropped.height, boxes: ocr.boxes ?? [], excludedText: excludedText || undefined } };
}

function attachOcrRects(question: ExtractedQuestion, boxes: Array<{ x: number; y: number; width: number; height: number; text: string; confidence: number }>, sourceRect: ExtractedQuestion["sourceRect"], cropWidth: number, cropHeight: number) {
  const scaleX = sourceRect.width / Math.max(1, cropWidth), scaleY = sourceRect.height / Math.max(1, cropHeight);
  for (const option of question.options) {
    const box = boxes.find((candidate) => candidate.text.includes(option.text) || option.text.includes(candidate.text));
    if (!box) continue;
    option.confidence = box.confidence;
    option.sourceRect = { x: sourceRect.x + box.x * scaleX, y: sourceRect.y + box.y * scaleY, width: box.width * scaleX, height: box.height * scaleY };
  }
}

async function capture(windowId?: number): Promise<string> {
  return windowId == null ? chrome.tabs.captureVisibleTab({ format: "png" }) : chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}
async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  if (!offscreenCreation) offscreenCreation = (async () => {
    if (await hasOffscreenDocument()) return;
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.BLOBS], justification: "Crop screenshots and run local PP-OCRv5 inference without blocking the web page" });
  })().finally(() => { offscreenCreation = undefined; });
  await offscreenCreation;
}
async function hasOffscreenDocument(): Promise<boolean> {
  const offscreen = chrome.offscreen as typeof chrome.offscreen & { hasDocument?: () => Promise<boolean> };
  if (typeof offscreen.hasDocument === "function") return offscreen.hasDocument();
  const runtime = chrome.runtime as typeof chrome.runtime & {
    getContexts?: (filter: { contextTypes: string[]; documentUrls?: string[] }) => Promise<Array<unknown>>;
  };
  if (typeof runtime.getContexts === "function") {
    const contexts = await runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("offscreen.html")] });
    return contexts.length > 0;
  }
  const workerClients = (globalThis as typeof globalThis & { clients?: { matchAll: () => Promise<Array<{ url?: string }>> } }).clients;
  if (!workerClients) return false;
  const clients = await workerClients.matchAll();
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  return clients.some((client) => client.url === offscreenUrl);
}
let offscreenCreation: Promise<void> | undefined;
function failure(error: unknown): WorkerResponse { return { ok: false, code: "UNEXPECTED", message: error instanceof Error ? error.message : "发生未知错误", recoverable: true }; }
function messageOf(error: unknown): string { return (error instanceof Error ? error.message : "未知错误").replace(/[\r\n]+/g, " ").slice(0, 180); }
class CaptureError extends Error {
  constructor(message: string, cause: unknown) { super(`${message}${cause instanceof Error && cause.message ? `（${messageOf(cause)}）` : ""}`); this.name = "CaptureError"; }
}
function sendProgress(sender: chrome.runtime.MessageSender, requestId: string, stage: "capture" | "vision" | "ocr-loading" | "ocr-running" | "jev", message: string): void {
  if (sender.tab?.id == null) return;
  void chrome.tabs.sendMessage(sender.tab.id, { type: "ANALYZE_PROGRESS", requestId, stage, message }).catch(() => undefined);
}
function effectiveLlm(settings: import("../shared/types").LLMSettings, secrets: Awaited<ReturnType<typeof getSecrets>>) {
  const capabilities = currentCapabilities(settings, secrets);
  return settings.structuredOutput === "auto" && capabilities.structuredOutputDetected && capabilities.structuredOutputDetected !== "auto" ? { ...settings, structuredOutput: capabilities.structuredOutputDetected } : settings;
}
function capabilityKey(settings: import("../shared/types").LLMSettings): string { return `${settings.baseUrl.trim().replace(/\/$/, "")}|${settings.model.trim()}`; }
function hostDisabled(host: string, disabledHosts: string[]): boolean {
  return !!host && disabledHosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
}
function currentCapabilities(settings: import("../shared/types").LLMSettings, secrets: Awaited<ReturnType<typeof getSecrets>>) {
  return secrets.capabilityKey === capabilityKey(settings) ? secrets : { ...secrets, visionDetected: undefined, structuredOutputDetected: undefined };
}
async function cacheCapabilities(settings: import("../shared/types").LLMSettings, secrets: Awaited<ReturnType<typeof getSecrets>>, vision?: "supported" | "unsupported", structuredOutput?: "supported" | "unsupported") {
  if (!vision && !structuredOutput) return;
  const latest = await getSecrets();
  const next = { ...latest, capabilityKey: capabilityKey(settings) };
  if (latest.capabilityKey !== next.capabilityKey) { delete next.visionDetected; delete next.structuredOutputDetected; }
  if (vision) next.visionDetected = vision;
  if (structuredOutput) next.structuredOutputDetected = structuredOutput;
  await setSecrets(next);
}
