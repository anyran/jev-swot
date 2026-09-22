import { askJev } from "../core/typesafe";
import { LlmError, explainAnswer, recognizeWithVision, structureOcrText } from "../core/llm";
import { parseQuestionText, stableOptionId, validateQuestion } from "../core/question";
import { getSecrets, getSettings, setSecrets } from "../shared/storage";
import type { ExtractedQuestion, WorkerRequest, WorkerResponse } from "../shared/types";

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

async function handle(request: Exclude<WorkerRequest, { type: "OCR" | "CROP_IMAGE" }>, sender: chrome.runtime.MessageSender): Promise<WorkerResponse> {
  if (request.type === "CLEAR_SESSION") { await chrome.storage.session.clear(); return { ok: true }; }
  if (request.type === "RELEASE_OCR") {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
    return { ok: true };
  }
  const settings = await getSettings();
  const secrets = await getSecrets();
  if (request.type === "EXPLAIN") {
    if (!secrets.llmApiKey) return { ok: false, code: "LLM_KEY_MISSING", message: "请先在设置页填写普通模型 API Key。", recoverable: true };
    return { ok: true, explanation: await explainAnswer(request.question, request.probability, settings.llm, secrets.llmApiKey) };
  }
  const host = sender.tab?.url ? new URL(sender.tab.url).hostname : "";
  if (host && settings.disabledHosts.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
    return { ok: false, code: "SITE_DISABLED", message: "JevAnswer 已在此站点禁用。", recoverable: true };
  }
  let question = request.question;
  if (validateQuestion(question).length) {
    const screenshot = request.screenshot ?? await capture(sender.tab?.windowId);
    question = await recognizeFallback(question, screenshot, request.devicePixelRatio ?? 1, settings, secrets);
  }
  const errors = validateQuestion(question);
  if (errors.length) return { ok: false, code: "QUESTION_INCOMPLETE", message: `${errors.join("；")}。请在覆盖层中校正后重试。`, recoverable: true };
  if (question.source === "local-ocr" && question.recognitionConfidence < settings.ocrThreshold) {
    return { ok: false, code: "LOW_OCR_CONFIDENCE", message: `OCR 置信度 ${Math.round(question.recognitionConfidence * 100)}%，低于阈值。请校正后重试。`, recoverable: true };
  }
  if (!secrets.typeSafeApiKey) return { ok: false, code: "JEV_KEY_MISSING", message: "请先在设置页填写 TypeSafe API Key。", recoverable: true };
  return { ok: true, question, probability: await askJev(question, secrets.typeSafeApiKey) };
}

async function recognizeFallback(base: ExtractedQuestion, screenshot: string, devicePixelRatio: number, settings: Awaited<ReturnType<typeof getSettings>>, secrets: Awaited<ReturnType<typeof getSecrets>>): Promise<ExtractedQuestion> {
  await ensureOffscreen();
  const cropped = await chrome.runtime.sendMessage({ type: "CROP_IMAGE", imageDataUrl: screenshot, rect: base.sourceRect, devicePixelRatio });
  if (!cropped?.ok) throw new Error(cropped?.message ?? "截图裁切失败");
  const questionImage = cropped.imageDataUrl as string;
  if (secrets.llmApiKey && settings.llm.vision !== "unsupported" && secrets.visionDetected !== "unsupported") {
    try {
      let parsed: Partial<ExtractedQuestion>;
      try { parsed = await recognizeWithVision(questionImage, settings.llm, secrets.llmApiKey); }
      catch (error) {
        if (!(error instanceof LlmError) || !error.retryable) throw error;
        parsed = await recognizeWithVision(questionImage, settings.llm, secrets.llmApiKey);
      }
      return normalizeParsed(parsed, base, "vision", 0.9);
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
    try { parsed = normalizeParsed(await structureOcrText(ocr.text, settings.llm, secrets.llmApiKey), parsed, "local-ocr", ocr.confidence); } catch { /* keep deterministic parse */ }
  }
  return parsed;
}

function normalizeParsed(parsed: Partial<ExtractedQuestion>, base: ExtractedQuestion, source: "vision" | "local-ocr", confidence: number): ExtractedQuestion {
  const options = (parsed.options ?? []).map((x, i) => ({ id: stableOptionId(i), label: x.label || String.fromCharCode(65 + i), text: x.text, confidence: x.confidence }));
  return { ...base, source, questionType: parsed.questionType ?? "unknown", stem: parsed.stem?.trim() ?? "", context: parsed.context ?? "", options, recognitionConfidence: confidence, warnings: parsed.warnings ?? [] };
}
async function capture(windowId?: number): Promise<string> {
  return windowId == null ? chrome.tabs.captureVisibleTab({ format: "png" }) : chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}
async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.BLOBS], justification: "Crop screenshots and run local PP-OCRv5 inference without blocking the web page" });
}
function failure(error: unknown): WorkerResponse { return { ok: false, code: "UNEXPECTED", message: error instanceof Error ? error.message : "发生未知错误", recoverable: true }; }
