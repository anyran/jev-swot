import { PaddleOcr } from "./ocr";
import type { WorkerRequest } from "../shared/types";

const engine = new PaddleOcr();
chrome.runtime.onMessage.addListener((request: WorkerRequest, _sender, sendResponse) => {
  if (request.type !== "OCR") return false;
  void engine.recognize(request.imageDataUrl, request.rect, request.devicePixelRatio).then((result) => sendResponse({ ok: true, ...result })).catch((error: unknown) => sendResponse({ ok: false, code: "OCR_FAILED", message: error instanceof Error ? error.message : "OCR 失败", recoverable: true }));
  return true;
});
