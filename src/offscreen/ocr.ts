import * as ort from "onnxruntime-web/webgpu";
import { inferVisualWarnings } from "../core/question";
import type { DOMRectLike, RecognitionWarning } from "../shared/types";

interface Point { x: number; y: number }
interface Box { x: number; y: number; width: number; height: number; confidence: number; quad?: [Point, Point, Point, Point]; lowConfidenceRatio?: number }
export interface OcrResult { text: string; confidence: number; warnings: RecognitionWarning[]; boxes: Array<Box & { text: string }>; backend: "wasm" | "webgpu"; rotation?: 0 | 90 | -90 }

export class PaddleOcr {
  private detector?: ort.InferenceSession;
  private recognizer?: ort.InferenceSession;
  private dictionary?: string[];
  private backend: "wasm" | "webgpu" = "wasm";
  async initialize(useWebGpu = false): Promise<void> {
    if (this.detector) return;
    const [dictResponse] = await Promise.all([fetch(chrome.runtime.getURL("models/ppocrv5-dict.txt"))]);
    if (!dictResponse.ok) throw new Error("PP-OCRv5 模型尚未安装；请参照 models/README.md 放置并校验模型资产。");
    this.dictionary = ["blank", ...(await dictResponse.text()).split(/\r?\n/).filter(Boolean), " "];
    try {
      const executionProviders = useWebGpu && "gpu" in navigator ? ["webgpu", "wasm"] : ["wasm"];
      this.backend = executionProviders[0] === "webgpu" ? "webgpu" : "wasm";
      [this.detector, this.recognizer] = await Promise.all([
        ort.InferenceSession.create(chrome.runtime.getURL("models/ppocrv5-mobile-det.onnx"), { executionProviders }),
        ort.InferenceSession.create(chrome.runtime.getURL("models/ppocrv5-mobile-rec.onnx"), { executionProviders })
      ]);
    } catch (error) { await this.releaseSessions(); throw new Error(`无法加载 PP-OCRv5：${error instanceof Error ? error.message : String(error)}`); }
  }
  async recognize(dataUrl: string, rect: DOMRectLike, dpr: number, useWebGpu = false, signal?: AbortSignal): Promise<OcrResult> {
    throwIfAborted(signal);
    try { await this.initialize(useWebGpu); }
    catch (error) {
      throwIfAborted(signal);
      if (!useWebGpu) throw error;
      await this.releaseSessions();
      await this.initialize(false);
    }
    try { return await this.recognizeLoaded(dataUrl, rect, dpr, signal); }
    catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error;
      if (!useWebGpu || this.backend !== "webgpu") throw error;
      await this.releaseSessions();
      await this.initialize(false);
      return this.recognizeLoaded(dataUrl, rect, dpr, signal);
    }
  }
  private async releaseSessions(): Promise<void> {
    await Promise.allSettled([this.detector?.release(), this.recognizer?.release()]);
    this.detector = undefined;
    this.recognizer = undefined;
    this.backend = "wasm";
  }
  private async recognizeLoaded(dataUrl: string, rect: DOMRectLike, dpr: number, signal?: AbortSignal): Promise<OcrResult> {
    throwIfAborted(signal);
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    throwIfAborted(signal);
    const crop = cropBitmap(bitmap, rect, dpr);
    const candidates = [crop, enhanceGrayscale(crop), adaptiveThreshold(crop)];
    const attempts: OcrResult[] = [];
    for (const candidate of candidates) { throwIfAborted(signal); attempts.push(await this.recognizeVariant(candidate, 0, signal)); }
    let best = attempts.reduce((winner, attempt) => qualityScore(attempt) > qualityScore(winner) ? attempt : winner);
    if (best.confidence < 0.62 && crop.height > crop.width * 1.35) {
      const rotations = [rotateImage(crop, 90), rotateImage(crop, -90)];
      for (const [index, rotated] of rotations.entries()) {
        throwIfAborted(signal);
        const attempt = await this.recognizeVariant(rotated, index === 0 ? 90 : -90, signal);
        if (qualityScore(attempt) > qualityScore(best)) best = attempt;
      }
    }
    const rotation = best.rotation;
    if (rotation) best = { ...best, boxes: best.boxes.map((box) => unrotateBox(box, crop.width, crop.height, rotation)), rotation: 0 };
    return best;
  }
  private async recognizeVariant(crop: ImageData, rotation: 0 | 90 | -90 = 0, signal?: AbortSignal): Promise<OcrResult> {
    throwIfAborted(signal);
    const detImage = resizeForDetection(crop);
    const detTensor = imageTensor(detImage.data, detImage.width, detImage.height, "det");
    const detResult = await this.detector!.run({ [this.detector!.inputNames[0]]: detTensor });
    throwIfAborted(signal);
    const output = detResult[this.detector!.outputNames[0]];
    const boxes = probabilityBoxes(output.data as Float32Array, output.dims, crop.width / detImage.width, crop.height / detImage.height).sort((a, b) => b.confidence - a.confidence).slice(0, 64);
    const results: Array<Box & { text: string }> = [];
    for (let offset = 0; offset < boxes.length; offset += 8) {
      throwIfAborted(signal);
      const batchBoxes = boxes.slice(offset, offset + 8), lines = batchBoxes.map((box) => resizeForRecognition(perspectiveCrop(crop, box)));
      const width = Math.max(...lines.map((line) => line.width));
      const tensor = imageTensorBatch(lines.map((line) => padToWidth(line, width)), width, 48);
      const recResult = await this.recognizer!.run({ [this.recognizer!.inputNames[0]]: tensor });
      throwIfAborted(signal);
      const outputTensor = recResult[this.recognizer!.outputNames[0]];
      batchBoxes.forEach((box, index) => { const decoded = decodeCtc(outputTensor, this.dictionary!, index); if (decoded.text) results.push({ ...box, text: decoded.text, confidence: box.confidence * decoded.confidence, lowConfidenceRatio: decoded.lowConfidenceRatio }); });
    }
    results.sort((a, b) => Math.abs(a.y - b.y) < Math.max(a.height, b.height) * 0.5 ? a.x - b.x : a.y - b.y);
    const text = results.map((x) => x.text).join("\n");
    const averageConfidence = results.length ? results.reduce((sum, x) => sum + x.confidence, 0) / results.length : 0;
    const lowConfidenceRatio = results.length ? results.reduce((sum, x) => sum + (x.lowConfidenceRatio ?? 1), 0) / results.length : 1;
    const textArea = results.reduce((sum, x) => sum + x.width * x.height, 0) / Math.max(1, crop.width * crop.height);
    const lines=text.split("\n"),firstOption=lines.findIndex(line=>/^\s*(?:[A-H]|[1-9]\d{0,2}|[①-⑨])[.、)）:]/i.test(line)),optionCount=lines.filter(line=>/^\s*(?:[A-H]|[1-9]\d{0,2}|[①-⑨])[.、)）:]/i.test(line)).length;
    const structureScore=(firstOption>0?0.05:0)+Math.min(0.1,optionCount*0.05),areaScore=textArea>=0.01?0.05:Math.min(0.05,textArea*5);
    const confidence=Math.max(0,Math.min(1,averageConfidence*0.7+(1-lowConfidenceRatio)*0.1+structureScore+areaScore));
    const warnings = inferVisualWarnings(text, textArea);
    if (confidence < 0.72) warnings.push("LOW_OCR_CONFIDENCE");
    if (warnings.includes("POSSIBLE_DIAGRAM") || warnings.includes("POSSIBLE_FORMULA")) warnings.push("VISION_MODEL_REQUIRED");
    return { text, confidence, warnings: [...new Set(warnings)], boxes: results, backend: this.backend, rotation };
  }
}

function qualityScore(result: OcrResult): number {
  const completeness = /(?:^|\n)\s*(?:[A-H]|[1-9]\d{0,2}|[①-⑨])[.、)）:]/m.test(result.text) ? 0.08 : 0;
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
  const scale = Math.min(2, 2400 / Math.max(w, h));
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
function padToWidth(image: ImageData, width: number): ImageData {
  if (image.width === width) return image;
  const canvas = new OffscreenCanvas(width, image.height), context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = "white"; context.fillRect(0, 0, width, image.height); const source = new OffscreenCanvas(image.width, image.height); source.getContext("2d")!.putImageData(image, 0, 0); context.drawImage(source, 0, 0);
  return context.getImageData(0, 0, width, image.height);
}
function imageTensorBatch(images: ImageData[], width: number, height: number): ort.Tensor {
  const plane = width * height, data = new Float32Array(images.length * 3 * plane);
  images.forEach((image, batch) => { for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) data[batch * 3 * plane + c * plane + i] = (image.data[i * 4 + (2 - c)] / 255 - 0.5) / 0.5; });
  return new ort.Tensor("float32", data, [images.length, 3, height, width]);
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
    const queue = [start]; seen[start] = 1; let minX=x,maxX=x,minY=y,maxY=y,sum=0,count=0,sumX=0,sumY=0,sumXX=0,sumYY=0,sumXY=0;
    while (queue.length) { const p=queue.pop()!, px=p%w, py=Math.floor(p/w); sum+=data[p];count++;sumX+=px;sumY+=py;sumXX+=px*px;sumYY+=py*py;sumXY+=px*py;minX=Math.min(minX,px);maxX=Math.max(maxX,px);minY=Math.min(minY,py);maxY=Math.max(maxY,py); const neighbors:number[]=[];if(px>0)neighbors.push(p-1);if(px+1<w)neighbors.push(p+1);if(py>0)neighbors.push(p-w);if(py+1<h)neighbors.push(p+w);for(const n of neighbors)if(!seen[n]&&data[n]>=0.3){seen[n]=1;queue.push(n);} }
    if (count > 8 && sum / count > 0.5) {
      const cx=sumX/count,cy=sumY/count,covXX=sumXX/count-cx*cx,covYY=sumYY/count-cy*cy,covXY=sumXY/count-cx*cy;
      const angle=0.5*Math.atan2(2*covXY,covXX-covYY),ux=Math.cos(angle),uy=Math.sin(angle),vx=-uy,vy=ux;
      let minU=Infinity,maxU=-Infinity,minV=Infinity,maxV=-Infinity;
      for(let py=minY;py<=maxY;py++) for(let px=minX;px<=maxX;px++) if(data[py*w+px]>=0.3){const dx=px-cx,dy=py-cy,u=dx*ux+dy*uy,v=dx*vx+dy*vy;minU=Math.min(minU,u);maxU=Math.max(maxU,u);minV=Math.min(minV,v);maxV=Math.max(maxV,v);}
      const pad=2,point=(u:number,v:number):Point=>({x:(cx+u*ux+v*vx)*sx,y:(cy+u*uy+v*vy)*sy});
      const quad=[point(minU-pad,minV-pad),point(maxU+pad,minV-pad),point(maxU+pad,maxV+pad),point(minU-pad,maxV+pad)] as [Point,Point,Point,Point];
      const qx=quad.map(p=>p.x),qy=quad.map(p=>p.y),left=Math.max(0,Math.min(...qx)),top=Math.max(0,Math.min(...qy)),right=Math.min(w*sx,Math.max(...qx)),bottom=Math.min(h*sy,Math.max(...qy));
      boxes.push({ x:left,y:top,width:Math.max(1,right-left),height:Math.max(1,bottom-top),confidence:sum/count,quad });
    }
  }
  return boxes;
}
function perspectiveCrop(image: ImageData, box: Box): ImageData {
  if (!box.quad) return cropRegion(image, box);
  const [tl,tr,br,bl]=box.quad,width=Math.max(1,Math.round(Math.max(distance(tl,tr),distance(bl,br)))),height=Math.max(1,Math.round(Math.max(distance(tl,bl),distance(tr,br))));
  const output=new ImageData(width,height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++){
    const point=projectQuadPoint(box.quad,x/Math.max(1,width-1),y/Math.max(1,height-1));
    sampleBilinear(image,point.x,point.y,output.data,(y*width+x)*4);
  }
  return output;
}
function cropRegion(image: ImageData, box: Box): ImageData { const canvas=new OffscreenCanvas(Math.max(1,Math.round(box.width)),Math.max(1,Math.round(box.height))); const source=new OffscreenCanvas(image.width,image.height);source.getContext("2d")!.putImageData(image,0,0);canvas.getContext("2d")!.drawImage(source,box.x,box.y,box.width,box.height,0,0,canvas.width,canvas.height);return canvas.getContext("2d",{willReadFrequently:true})!.getImageData(0,0,canvas.width,canvas.height); }
export function projectQuadPoint([p0,p1,p2,p3]: [Point,Point,Point,Point],u:number,v:number): Point {
  const dx1=p1.x-p2.x,dx2=p3.x-p2.x,dx3=p0.x-p1.x+p2.x-p3.x,dy1=p1.y-p2.y,dy2=p3.y-p2.y,dy3=p0.y-p1.y+p2.y-p3.y,den=dx1*dy2-dx2*dy1;
  let g=0,h=0;if(Math.abs(den)>1e-8){g=(dx3*dy2-dx2*dy3)/den;h=(dx1*dy3-dx3*dy1)/den;}
  const a=p1.x-p0.x+g*p1.x,b=p3.x-p0.x+h*p3.x,c=p0.x,d=p1.y-p0.y+g*p1.y,e=p3.y-p0.y+h*p3.y,f=p0.y,q=g*u+h*v+1;
  return {x:(a*u+b*v+c)/q,y:(d*u+e*v+f)/q};
}
function distance(a:Point,b:Point){return Math.hypot(a.x-b.x,a.y-b.y);}
export function unrotateBox(box: Box & { text: string }, originalWidth: number, originalHeight: number, rotation: 90 | -90): Box & { text: string } {
  const transform = (point: Point): Point => rotation === 90 ? { x: point.y, y: originalHeight - point.x } : { x: originalWidth - point.y, y: point.x };
  const points = box.quad ? box.quad.map(transform) : [
    transform({ x: box.x, y: box.y }), transform({ x: box.x + box.width, y: box.y }),
    transform({ x: box.x + box.width, y: box.y + box.height }), transform({ x: box.x, y: box.y + box.height })
  ];
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y), x = Math.max(0, Math.min(...xs)), y = Math.max(0, Math.min(...ys));
  const right = Math.min(originalWidth, Math.max(...xs)), bottom = Math.min(originalHeight, Math.max(...ys));
  return { ...box, x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y), quad: box.quad ? points as [Point, Point, Point, Point] : undefined };
}
function sampleBilinear(image:ImageData,x:number,y:number,target:Uint8ClampedArray,offset:number){const x0=Math.max(0,Math.min(image.width-1,Math.floor(x))),y0=Math.max(0,Math.min(image.height-1,Math.floor(y))),x1=Math.min(image.width-1,x0+1),y1=Math.min(image.height-1,y0+1),fx=Math.max(0,Math.min(1,x-x0)),fy=Math.max(0,Math.min(1,y-y0));for(let c=0;c<4;c++){const top=image.data[(y0*image.width+x0)*4+c]*(1-fx)+image.data[(y0*image.width+x1)*4+c]*fx,bottom=image.data[(y1*image.width+x0)*4+c]*(1-fx)+image.data[(y1*image.width+x1)*4+c]*fx;target[offset+c]=top*(1-fy)+bottom*fy;}}
export function decodeCtc(tensor: ort.Tensor, dict: string[], batchIndex = 0): { text: string; confidence: number; lowConfidenceRatio: number } {
  const data=tensor.data as Float32Array,dims=tensor.dims,classes=Number(dims[dims.length-1]),steps=Number(dims[dims.length-2]);let previous=-1,text="",score=0,count=0,low=0;
  const base=batchIndex*steps*classes;
  for(let t=0;t<steps;t++){let best=0,bestValue=-Infinity;for(let c=0;c<classes;c++){const value=data[base+t*classes+c];if(value>bestValue){bestValue=value;best=c;}}if(best!==0&&best!==previous){text+=dict[best]??"";score+=Math.max(0,Math.min(1,bestValue));count++;if(bestValue<0.5)low++;}previous=best;}
  return {text:text.trim(),confidence:count?score/count:0,lowConfidenceRatio:count?low/count:1};
}
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("OCR 请求已取消。");
  error.name = "AbortError";
  throw error;
}
function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
