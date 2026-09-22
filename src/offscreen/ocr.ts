import * as ort from "onnxruntime-web/webgpu";
import { inferVisualWarnings } from "../core/question";
import type { DOMRectLike, RecognitionWarning } from "../shared/types";

interface Box { x: number; y: number; width: number; height: number; confidence: number }
export interface OcrResult { text: string; confidence: number; warnings: RecognitionWarning[]; boxes: Array<Box & { text: string }> }

export class PaddleOcr {
  private detector?: ort.InferenceSession;
  private recognizer?: ort.InferenceSession;
  private dictionary?: string[];
  async initialize(useWebGpu = false): Promise<void> {
    if (this.detector) return;
    const [dictResponse] = await Promise.all([fetch(chrome.runtime.getURL("models/ppocrv5-dict.txt"))]);
    if (!dictResponse.ok) throw new Error("PP-OCRv5 模型尚未安装；请参照 models/README.md 放置并校验模型资产。");
    this.dictionary = ["blank", ...(await dictResponse.text()).split(/\r?\n/).filter(Boolean), " "];
    try {
      const executionProviders = useWebGpu && "gpu" in navigator ? ["webgpu", "wasm"] : ["wasm"];
      [this.detector, this.recognizer] = await Promise.all([
        ort.InferenceSession.create(chrome.runtime.getURL("models/ppocrv5-mobile-det.onnx"), { executionProviders }),
        ort.InferenceSession.create(chrome.runtime.getURL("models/ppocrv5-mobile-rec.onnx"), { executionProviders })
      ]);
    } catch (error) { this.detector = undefined; throw new Error(`无法加载 PP-OCRv5：${error instanceof Error ? error.message : String(error)}`); }
  }
  async recognize(dataUrl: string, rect: DOMRectLike, dpr: number, useWebGpu = false): Promise<OcrResult> {
    try { await this.initialize(useWebGpu); }
    catch (error) {
      if (!useWebGpu) throw error;
      this.detector = undefined; this.recognizer = undefined;
      await this.initialize(false);
    }
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const crop = cropBitmap(bitmap, rect, dpr);
    const detImage = resizeForDetection(crop);
    const detTensor = imageTensor(detImage.data, detImage.width, detImage.height, "det");
    const detResult = await this.detector!.run({ [this.detector!.inputNames[0]]: detTensor });
    const output = detResult[this.detector!.outputNames[0]];
    const boxes = probabilityBoxes(output.data as Float32Array, output.dims, crop.width / detImage.width, crop.height / detImage.height);
    const results: Array<Box & { text: string }> = [];
    for (const box of boxes.slice(0, 128)) {
      const line = cropRegion(crop, box);
      const recImage = resizeForRecognition(line);
      const tensor = imageTensor(recImage.data, recImage.width, recImage.height, "rec");
      const recResult = await this.recognizer!.run({ [this.recognizer!.inputNames[0]]: tensor });
      const decoded = decodeCtc(recResult[this.recognizer!.outputNames[0]], this.dictionary!);
      if (decoded.text) results.push({ ...box, text: decoded.text, confidence: box.confidence * decoded.confidence });
    }
    results.sort((a, b) => Math.abs(a.y - b.y) < Math.max(a.height, b.height) * 0.5 ? a.x - b.x : a.y - b.y);
    const text = results.map((x) => x.text).join("\n");
    const confidence = results.length ? results.reduce((sum, x) => sum + x.confidence, 0) / results.length : 0;
    const textArea = results.reduce((sum, x) => sum + x.width * x.height, 0) / Math.max(1, crop.width * crop.height);
    const warnings = inferVisualWarnings(text, textArea);
    if (confidence < 0.72) warnings.push("LOW_OCR_CONFIDENCE");
    if (warnings.includes("POSSIBLE_DIAGRAM")) warnings.push("VISION_MODEL_REQUIRED");
    return { text, confidence, warnings: [...new Set(warnings)], boxes: results };
  }
}

function cropBitmap(bitmap: ImageBitmap, rect: DOMRectLike, dpr: number): ImageData {
  const x = Math.max(0, Math.round(rect.x * dpr)), y = Math.max(0, Math.round(rect.y * dpr));
  const w = Math.max(1, Math.min(bitmap.width - x, Math.round(rect.width * dpr))), h = Math.max(1, Math.min(bitmap.height - y, Math.round(rect.height * dpr)));
  const scale = Math.min(1, 2400 / Math.max(w, h));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, x, y, w, h, 0, 0, canvas.width, canvas.height); bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
function resizeForDetection(image: ImageData): ImageData {
  const scale = Math.min(1, 960 / Math.max(image.width, image.height));
  const width = Math.max(32, Math.round(image.width * scale / 32) * 32), height = Math.max(32, Math.round(image.height * scale / 32) * 32);
  return resize(image, width, height);
}
function resizeForRecognition(image: ImageData): ImageData {
  const height = 48, width = Math.min(640, Math.max(16, Math.ceil((image.width / image.height) * height)));
  return resize(image, width, height);
}
function resize(image: ImageData, width: number, height: number): ImageData {
  const source = new OffscreenCanvas(image.width, image.height), target = new OffscreenCanvas(width, height);
  source.getContext("2d")!.putImageData(image, 0, 0); target.getContext("2d")!.drawImage(source, 0, 0, width, height);
  return target.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, width, height);
}
function imageTensor(image: Uint8ClampedArray, width: number, height: number, mode: "det" | "rec"): ort.Tensor {
  const data = new Float32Array(3 * width * height);
  const mean = mode === "det" ? [0.485, 0.456, 0.406] : [0.5, 0.5, 0.5];
  const std = mode === "det" ? [0.229, 0.224, 0.225] : [0.5, 0.5, 0.5];
  // PaddleOCR inference configs expect BGR while Canvas ImageData is RGBA.
  for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) data[c * width * height + i] = (image[i * 4 + (2 - c)] / 255 - mean[c]) / std[c];
  return new ort.Tensor("float32", data, [1, 3, height, width]);
}
function probabilityBoxes(data: Float32Array, dims: readonly number[], sx: number, sy: number): Box[] {
  const h = Number(dims[dims.length - 2]), w = Number(dims[dims.length - 1]), seen = new Uint8Array(w * h), boxes: Box[] = [];
  const step = Math.max(1, Math.floor(Math.min(w, h) / 400));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const start = y * w + x; if (seen[start] || data[start] < 0.3) continue;
    const queue = [start]; seen[start] = 1; let minX=x,maxX=x,minY=y,maxY=y,sum=0,count=0;
    while (queue.length) { const p=queue.pop()!, px=p%w, py=Math.floor(p/w); sum+=data[p];count++;minX=Math.min(minX,px);maxX=Math.max(maxX,px);minY=Math.min(minY,py);maxY=Math.max(maxY,py); for(const n of [p-1,p+1,p-w,p+w]) if(n>=0&&n<data.length&&!seen[n]&&data[n]>=0.3){seen[n]=1;queue.push(n);} }
    if (count > 8 && sum / count > 0.5) boxes.push({ x: Math.max(0,(minX-2)*sx), y: Math.max(0,(minY-2)*sy), width: (maxX-minX+5)*sx, height:(maxY-minY+5)*sy, confidence: sum/count });
  }
  return boxes;
}
function cropRegion(image: ImageData, box: Box): ImageData { const canvas=new OffscreenCanvas(Math.max(1,Math.round(box.width)),Math.max(1,Math.round(box.height))); const source=new OffscreenCanvas(image.width,image.height);source.getContext("2d")!.putImageData(image,0,0);canvas.getContext("2d")!.drawImage(source,box.x,box.y,box.width,box.height,0,0,canvas.width,canvas.height);return canvas.getContext("2d",{willReadFrequently:true})!.getImageData(0,0,canvas.width,canvas.height); }
function decodeCtc(tensor: ort.Tensor, dict: string[]): { text: string; confidence: number } {
  const data=tensor.data as Float32Array,dims=tensor.dims,classes=Number(dims[dims.length-1]),steps=Number(dims[dims.length-2]);let previous=-1,text="",score=0,count=0;
  for(let t=0;t<steps;t++){let best=0,bestValue=-Infinity;for(let c=0;c<classes;c++){const value=data[t*classes+c];if(value>bestValue){bestValue=value;best=c;}}if(best!==0&&best!==previous){text+=dict[best]??"";score+=Math.max(0,Math.min(1,bestValue));count++;}previous=best;}
  return {text:text.trim(),confidence:count?score/count:0};
}
