import { askJev } from "../core/typesafe";
import { LlmError, explainAnswer, recognizeWithVision, streamExplanation, structureOcrText } from "../core/llm";
import { parseQuestionText, stableOptionId, validateQuestion } from "../core/question";
import { getSecrets, getSettings, setSecrets } from "../shared/storage";
import type { ExtractedQuestion, RecognitionPreview, WorkerRequest, WorkerResponse } from "../shared/types";

const activeRequests = new Map<string, AbortController>();

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "select-question" && tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "START_SELECTION" }).catch(() => undefined);
});
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) await chrome.tabs.sendMessage(tab.id, { type: "START_SELECTION" }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((request: WorkerRequest, sender, sendResponse) => {
  if (request.type === "OCR" || request.type === "CROP_IMAGE") return false;
  void handle(request, sender).then(sendResponse).catch((error: unknown) => sendResponse(failure(error)));
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "jevanswer-explanation") return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener((message: { question: ExtractedQuestion; probability: import("../shared/types").ProbabilityResult }) => {
    void (async () => {
      const settings = await getSettings(), secrets = await getSecrets();
      if (!secrets.llmApiKey) throw new Error("请先在设置页填写普通模型 API Key。");
      await streamExplanation(message.question, message.probability, settings.llm, secrets.llmApiKey, (chunk) => port.postMessage({ type: "chunk", chunk }), controller.signal);
      port.postMessage({ type: "done" });
    })().catch((error: unknown) => { if (!controller.signal.aborted) port.postMessage({ type: "error", message: error instanceof Error ? error.message : "解析失败" }); });
  });
});

async function handle(request: Exclude<WorkerRequest, { type: "OCR" | "CROP_IMAGE" }>, sender: chrome.runtime.MessageSender): Promise<WorkerResponse> {
  if (request.type === "CANCEL") { activeRequests.get(request.requestId)?.abort(); activeRequests.delete(request.requestId); return { ok: true }; }
  if (request.type === "CLEAR_SESSION") { await chrome.storage.session.clear(); return { ok: true }; }
  if (request.type === "RELEASE_OCR") {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
    return { ok: true };
  }
  const settings = await getSettings();
  const secrets = await getSecrets();
  if (request.type === "TEST_CONNECTIONS") {
    const results: string[] = [];
    if (secrets.typeSafeApiKey) {
      const probe: ExtractedQuestion = { source: "user-edited", questionType: "single", stem: "2 + 2 等于多少？", options: [{ id: "option_1", label: "A", text: "3" }, { id: "option_2", label: "B", text: "4" }], sourceRect: { x: 0, y: 0, width: 1, height: 1 }, recognitionConfidence: 1, warnings: [] };
      const answer = await askJev(probe, secrets.typeSafeApiKey); results.push(`JEV：正常（${answer.model}）`);
    } else results.push("JEV：未配置密钥");
    if (secrets.llmApiKey) {
      await structureOcrText("题目：2+2？ A. 3 B. 4", settings.llm, secrets.llmApiKey); results.push("文本模型：正常");
      if (settings.llm.vision !== "unsupported") {
        try { await recognizeWithVision(request.imageDataUrl, settings.llm, secrets.llmApiKey); await setSecrets({ ...secrets, visionDetected: "supported" }); results.push("视觉模型：正常"); }
        catch (error) { if (error instanceof LlmError && error.unsupportedVision) { await setSecrets({ ...secrets, visionDetected: "unsupported" }); results.push("视觉模型：不支持，将使用本地 OCR"); } else throw error; }
      }
    } else results.push("普通模型：未配置密钥");
    return { ok: true, diagnostic: results.join("；") };
  }
  if (request.type === "EXPLAIN") {
    if (!secrets.llmApiKey) return { ok: false, code: "LLM_KEY_MISSING", message: "请先在设置页填写普通模型 API Key。", recoverable: true };
    return { ok: true, explanation: await explainAnswer(request.question, request.probability, settings.llm, secrets.llmApiKey) };
  }
  const host = sender.tab?.url ? new URL(sender.tab.url).hostname : "";
  if (host && settings.disabledHosts.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
    return { ok: false, code: "SITE_DISABLED", message: "JevAnswer 已在此站点禁用。", recoverable: true };
  }
  const controller = new AbortController(); activeRequests.set(request.requestId, controller);
  let question = request.question;
  let preview: RecognitionPreview | undefined;
  try {
    if (validateQuestion(question).length || question.warnings.includes("VISION_MODEL_REQUIRED")) {
      if (!request.captureAuthorized) return { ok: false, code: "CAPTURE_REQUIRES_SHORTCUT", message: "这道题需要截图识别。请使用扩展框选快捷键重新选择题目，以授予当前页面的临时截图权限。", recoverable: true };
      const canUseVision = !!secrets.llmApiKey && settings.llm.vision !== "unsupported" && secrets.visionDetected !== "unsupported";
      if (canUseVision && settings.confirmVisionUpload && !request.visionConsent) {
        return { ok: false, code: "VISION_CONSENT_REQUIRED", message: "DOM 无法完整提取这道题。是否允许将当前题目选区截图发送给你配置的视觉模型？", recoverable: true };
      }
      const screenshot = request.screenshot ?? await capture(sender.tab?.windowId);
      const recognized = await recognizeFallback(question, screenshot, request.devicePixelRatio ?? 1, settings, secrets, controller.signal, request.visionConsent !== "deny");
      question = recognized.question; preview = recognized.preview;
    }
    const errors = validateQuestion(question);
    if (errors.length) return { ok: false, code: "QUESTION_INCOMPLETE", message: `${errors.join("；")}。请在覆盖层中校正后重试。`, recoverable: true, question, preview };
    if (question.source === "local-ocr" && question.recognitionConfidence < settings.ocrThreshold) {
      return { ok: false, code: "LOW_OCR_CONFIDENCE", message: `OCR 置信度 ${Math.round(question.recognitionConfidence * 100)}%，低于阈值。请校正后重试。`, recoverable: true, question, preview };
    }
    if (question.source === "local-ocr" && question.warnings.includes("VISION_MODEL_REQUIRED")) {
      return { ok: false, code: "VISION_MODEL_REQUIRED", message: "本题可能依赖图表、几何关系或其他视觉信息，本地 OCR 只能读取文字。请配置支持图像的模型，或在校正界面补充完整的图形描述。", recoverable: true, question, preview };
    }
    if (!secrets.typeSafeApiKey) return { ok: false, code: "JEV_KEY_MISSING", message: "请先在设置页填写 TypeSafe API Key。", recoverable: true, question, preview };
    return { ok: true, question, probability: await askJev(question, secrets.typeSafeApiKey, controller.signal), preview };
  } finally { activeRequests.delete(request.requestId); }
}

async function recognizeFallback(base: ExtractedQuestion, screenshot: string, devicePixelRatio: number, settings: Awaited<ReturnType<typeof getSettings>>, secrets: Awaited<ReturnType<typeof getSecrets>>, signal: AbortSignal, allowVision: boolean): Promise<{ question: ExtractedQuestion; preview?: RecognitionPreview }> {
  await ensureOffscreen();
  const cropped = await chrome.runtime.sendMessage({ type: "CROP_IMAGE", imageDataUrl: screenshot, rect: base.sourceRect, devicePixelRatio });
  if (!cropped?.ok) throw new Error(cropped?.message ?? "截图裁切失败");
  const questionImage = cropped.imageDataUrl as string;
  if (allowVision && secrets.llmApiKey && settings.llm.vision !== "unsupported" && secrets.visionDetected !== "unsupported") {
    try {
      let parsed: Partial<ExtractedQuestion>;
      try { parsed = await recognizeWithVision(questionImage, settings.llm, secrets.llmApiKey, signal); }
      catch (error) {
        if (!(error instanceof LlmError) || !error.retryable) throw error;
        parsed = await recognizeWithVision(questionImage, settings.llm, secrets.llmApiKey, signal);
      }
      return { question: normalizeParsed(parsed, base, "vision", 0.9), preview: { imageDataUrl: questionImage, width: cropped.width, height: cropped.height, boxes: [] } };
    } catch (error) {
      if ((error as Error & { unsupportedVision?: boolean }).unsupportedVision) await setSecrets({ ...secrets, visionDetected: "unsupported" });
    }
  }
  const ocr = await chrome.runtime.sendMessage({ type: "OCR", imageDataUrl: questionImage, rect: { x: 0, y: 0, width: cropped.width, height: cropped.height }, devicePixelRatio: 1, useWebGpu: settings.useWebGpu });
  if (!ocr?.ok) throw new Error(ocr?.message ?? "本地 OCR 失败");
  let parsed = parseQuestionText(ocr.text, base.sourceRect);
  parsed.recognitionConfidence = ocr.confidence;
  parsed.warnings = [...new Set([...parsed.warnings, ...(ocr.warnings ?? [])])];
  if (secrets.llmApiKey) {
    try { parsed = normalizeParsed(await structureOcrText(ocr.text, settings.llm, secrets.llmApiKey, signal), parsed, "local-ocr", ocr.confidence); } catch { /* keep deterministic parse */ }
  }
  attachOcrRects(parsed, ocr.boxes ?? [], base.sourceRect, cropped.width, cropped.height);
  return { question: parsed, preview: { imageDataUrl: questionImage, width: cropped.width, height: cropped.height, boxes: ocr.boxes ?? [] } };
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

function normalizeParsed(parsed: Partial<ExtractedQuestion>, base: ExtractedQuestion, source: "vision" | "local-ocr", confidence: number): ExtractedQuestion {
  const options = (parsed.options ?? []).map((x, i) => ({ id: stableOptionId(i), label: x.label || String.fromCharCode(65 + i), text: x.text, confidence: x.confidence }));
  const warnings = [...(parsed.warnings ?? [])];
  if (parsed.visualDependency) warnings.push("POSSIBLE_DIAGRAM");
  if (source === "local-ocr" && parsed.visualDependency) warnings.push("VISION_MODEL_REQUIRED");
  return { ...base, source, questionType: parsed.questionType ?? "unknown", stem: parsed.stem?.trim() ?? "", context: parsed.context ?? "", options, recognitionConfidence: confidence, warnings: [...new Set(warnings)], visualDependency: parsed.visualDependency, visualDependencyReason: parsed.visualDependencyReason };
}
async function capture(windowId?: number): Promise<string> {
  return windowId == null ? chrome.tabs.captureVisibleTab({ format: "png" }) : chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}
async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.BLOBS], justification: "Crop screenshots and run local PP-OCRv5 inference without blocking the web page" });
}
function failure(error: unknown): WorkerResponse { return { ok: false, code: "UNEXPECTED", message: error instanceof Error ? error.message : "发生未知错误", recoverable: true }; }
