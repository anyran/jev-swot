import { PaddleOcr } from "./ocr";
import type { WorkerRequest } from "../shared/types";

const engine = new PaddleOcr();
chrome.runtime.onMessage.addListener((request: WorkerRequest, _sender, sendResponse) => {
  if (request.type === "CROP_IMAGE") {
    void cropImage(request.imageDataUrl, request.rect, request.devicePixelRatio).then(sendResponse).catch((error: unknown) => sendResponse({ ok: false, message: error instanceof Error ? error.message : "截图裁切失败" }));
    return true;
  }
  if (request.type !== "OCR") return false;
  void engine.recognize(request.imageDataUrl, request.rect, request.devicePixelRatio, request.useWebGpu).then((result) => sendResponse({ ok: true, ...result })).catch((error: unknown) => sendResponse({ ok: false, code: "OCR_FAILED", message: error instanceof Error ? error.message : "OCR 失败", recoverable: true }));
  return true;
});

async function cropImage(dataUrl: string, rect: { x: number; y: number; width: number; height: number }, dpr: number) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const left = Math.max(0, Math.min(bitmap.width - 1, Math.round(rect.x * dpr)));
  const top = Math.max(0, Math.min(bitmap.height - 1, Math.round(rect.y * dpr)));
  const right = Math.max(left + 1, Math.min(bitmap.width, Math.round((rect.x + rect.width) * dpr)));
  const bottom = Math.max(top + 1, Math.min(bitmap.height, Math.round((rect.y + rect.height) * dpr)));
  const x = left, y = top, width = right - left, height = bottom - top;
  const scale = Math.min(1, 2400 / Math.max(width, height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  canvas.getContext("2d")!.drawImage(bitmap, x, y, width, height, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { ok: true, imageDataUrl: await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer().then(toDataUrl), width: canvas.width, height: canvas.height };
}
function toDataUrl(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer); let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}
