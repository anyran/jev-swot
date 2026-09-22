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
    const candidates = [crop, enhanceGrayscale(crop), adaptiveThreshold(crop)];
    const attempts: OcrResult[] = [];
    for (const candidate of candidates) attempts.push(await this.recognizeVariant(candidate));
    let best = attempts.reduce((winner, attempt) => qualityScore(attempt) > qualityScore(winner) ? attempt : winner);
    if (best.confidence < 0.62 && crop.height > crop.width * 1.35) {
      const rotations = [rotateImage(crop, 90), rotateImage(crop, -90)];
      for (const rotated of rotations) { const attempt = await this.recognizeVariant(rotated); if (qualityScore(attempt) > qualityScore(best)) best = attempt; }
    }
    return best;
  }
  private async recognizeVariant(crop: ImageData): Promise<OcrResult> {
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

function qualityScore(result: OcrResult): number {
  const completeness = /(?:^|\n)\s*(?:[A-H]|[1-9]|[①-⑨])[.、)）:]/m.test(result.text) ? 0.08 : 0;
  return result.confidence + Math.min(0.08, result.boxes.length * 0.005) + completeness;
}
function enhanceGrayscale(image: ImageData): ImageData {
  const output = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  let sum = 0;
  for (let i = 0; i < output.data.length; i += 4) sum += output.data[i] * 0.299 + output.data[i + 1] * 0.587 + output.data[i + 2] * 0.114;
  const mean = sum / (image.width * image.height);
  for (let i = 0; i < output.data.length; i += 4) {
    const gray = output.data[i] * 0.299 + output.data[i + 1] * 0.587 + output.data[i + 2] * 0.114;
    const value = Math.max(0, Math.min(255, (gray - mean) * 1.45 + 128));
    output.data[i] = output.data[i + 1] = output.data[i + 2] = value;
  }
  return output;
}
function adaptiveThreshold(image: ImageData): ImageData {
  const gray = enhanceGrayscale(image), output = new ImageData(image.width, image.height), radius = 8;
  const integral = new Float64Array((image.width + 1) * (image.height + 1));
  for (let y = 1; y <= image.height; y++) for (let x = 1, row = 0; x <= image.width; x++) { row += gray.data[((y - 1) * image.width + x - 1) * 4]; integral[y * (image.width + 1) + x] = integral[(y - 1) * (image.width + 1) + x] + row; }
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const x0=Math.max(0,x-radius),x1=Math.min(image.width-1,x+radius),y0=Math.max(0,y-radius),y1=Math.min(image.height-1,y+radius),stride=image.width+1;
    const local=(integral[(y1+1)*stride+x1+1]-integral[y0*stride+x1+1]-integral[(y1+1)*stride+x0]+integral[y0*stride+x0])/((x1-x0+1)*(y1-y0+1));
    const value=gray.data[(y*image.width+x)*4] < local-10 ? 0 : 255, offset=(y*image.width+x)*4;
    output.data[offset]=output.data[offset+1]=output.data[offset+2]=value; output.data[offset+3]=255;
  }
  return output;
}
function rotateImage(image: ImageData, degrees: 90 | -90): ImageData {
  const source=new OffscreenCanvas(image.width,image.height),target=new OffscreenCanvas(image.height,image.width);source.getContext("2d")!.putImageData(image,0,0);const ctx=target.getContext("2d")!;ctx.translate(target.width/2,target.height/2);ctx.rotate(degrees*Math.PI/180);ctx.drawImage(source,-image.width/2,-image.height/2);return ctx.getImageData(0,0,target.width,target.height);
}

function cropBitmap(bitmap: ImageBitmap, rect: DOMRectLike, dpr: number): ImageData {
  const x = Math.max(0, Math.min(bitmap.width - 1, Math.round(rect.x * dpr)));
  const y = Math.max(0, Math.min(bitmap.height - 1, Math.round(rect.y * dpr)));
  const right = Math.max(x + 1, Math.min(bitmap.width, Math.round((rect.x + rect.width) * dpr)));
  const bottom = Math.max(y + 1, Math.min(bitmap.height, Math.round((rect.y + rect.height) * dpr)));
  const w = right - x, h = bottom - y;
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
