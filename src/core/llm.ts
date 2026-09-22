import type { ExtractedQuestion, LLMSettings, OcrTextBox, ProbabilityResult } from "../shared/types";

export class LlmError extends Error {
  constructor(message: string, public status?: number, public unsupportedVision = false, public retryable = false) { super(message); }
}
function endpoint(baseUrl: string): string { return `${baseUrl.replace(/\/$/, "")}/chat/completions`; }
function questionSchema() {
  return { name: "question", strict: true, schema: { type: "object", additionalProperties: false, required: ["questionType", "stem", "options", "context", "visualDependency", "visualDependencyReason"], properties: { questionType: { enum: ["single", "multiple", "unknown"] }, stem: { type: "string" }, context: { type: "string" }, visualDependency: { type: "boolean" }, visualDependencyReason: { type: "string" }, options: { type: "array", minItems: 2, maxItems: 255, items: { type: "object", additionalProperties: false, required: ["label", "text"], properties: { label: { type: "string" }, text: { type: "string" } } } } } } };
}
async function call(settings: LLMSettings, apiKey: string, body: object, signal?: AbortSignal): Promise<Response> {
  if (signal?.aborted) throw new LlmError("模型请求已取消。", undefined, false, false);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("模型请求超时", "TimeoutError")), 45_000);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(endpoint(settings.baseUrl), { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    if (signal?.aborted) throw new LlmError("模型请求已取消。", undefined, false, false);
    if (controller.signal.aborted) throw new LlmError("模型请求超时。", undefined, false, true);
    throw new LlmError(error instanceof Error ? error.message : "模型网络请求失败。", undefined, false, true);
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}
type Message = { role: string; content: unknown };
export type StructuredQuestionResult = Partial<ExtractedQuestion> & { structuredOutputDetected?: "supported" | "unsupported" };
async function structuredQuestion(messages: Message[], settings: LLMSettings, apiKey: string, signal?: AbortSignal, visionRequest = false): Promise<StructuredQuestionResult> {
  const formats: Array<object | undefined> = settings.structuredOutput === "unsupported" ? [{ type: "json_object" }, undefined] : [{ type: "json_schema", json_schema: questionSchema() }, { type: "json_object" }, undefined];
  let lastError: LlmError | undefined;
  for (const responseFormat of formats) {
    const body: Record<string, unknown> = { model: settings.model, temperature: 0, messages };
    if (responseFormat) body.response_format = responseFormat;
    const response = await call(settings, apiKey, body, signal);
    if (response.ok) {
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      return { ...parseJsonObject(Array.isArray(content) ? textContent(content) : (content ?? "{}")), structuredOutputDetected: (responseFormat as { type?: string } | undefined)?.type === "json_schema" ? "supported" : "unsupported" };
    }
    const responseText = await response.text().catch(() => "");
    const unsupportedVision = visionRequest && [400, 415, 422].includes(response.status) && (/image|vision|multimodal|image_url|content.*(?:type|image)|unsupported.*(?:input|content)|only.*text|text.?only|modalit/i.test(responseText) || response.status === 415 || !responseText.trim());
    if (unsupportedVision) throw new LlmError("当前模型不支持图像输入。", response.status, true, false);
    const formatRejected = [400, 422].includes(response.status) && (/response_format|json_schema|structured|schema|unsupported.*format|not.*support.*format/i.test(responseText) || !responseText.trim());
    lastError = new LlmError(`模型请求失败 (${response.status})${responseText ? `: ${responseText.slice(0, 160)}` : ""}`, response.status, false, response.status === 429 || response.status >= 500);
    if (!formatRejected || !responseFormat) break;
  }
  throw lastError ?? new LlmError("模型未返回有效题目结构。");
}
export async function recognizeWithVision(imageDataUrl: string, settings: LLMSettings, apiKey: string, signal?: AbortSignal): Promise<StructuredQuestionResult> {
  return structuredQuestion([{ role: "system", content: "从题目截图中忠实提取题干和选项。不要解题，不要补充看不见的内容。如果作答依赖图表、几何图、化学结构、公式排版或其他非文字视觉信息，visualDependency 必须为 true，visualDependencyReason 简述原因，并在 context 中客观、完整地描述解题所需的可见关系、标注和数值，供后续判断模型使用。只输出 JSON。" }, { role: "user", content: [{ type: "text", text: "提取这道题及作答所需的视觉信息。" }, { type: "image_url", image_url: { url: imageDataUrl } }] }], settings, apiKey, signal, true);
}
export async function structureOcrText(text: string, settings: LLMSettings, apiKey: string, signal?: AbortSignal, boxes: OcrTextBox[] = []): Promise<StructuredQuestionResult> {
  return structuredQuestion([{ role: "system", content: "将 OCR 文本及其坐标忠实整理为题目结构。按文本框的 y/x 坐标恢复阅读顺序，不要解题或改写内容。visualDependency 设为 false，visualDependencyReason 设为空字符串。只输出 JSON。" }, { role: "user", content: JSON.stringify({ text, boxes }) }], settings, apiKey, signal);
}
export async function explainAnswer(question: ExtractedQuestion, probability: ProbabilityResult, settings: LLMSettings, apiKey: string, signal?: AbortSignal): Promise<string> {
  const response = await call(settings, apiKey, { model: settings.model, temperature: 0.2, messages: explanationMessages(question, probability) }, signal);
  if (!response.ok) throw new LlmError(`答案解析失败 (${response.status})`, response.status, false, response.status === 429 || response.status >= 500);
  const data = await response.json();
  return textContent(data.choices?.[0]?.message?.content) || "模型未返回解析。";
}
export async function streamExplanation(question: ExtractedQuestion, probability: ProbabilityResult, settings: LLMSettings, apiKey: string, onChunk: (chunk: string) => void, signal?: AbortSignal): Promise<string> {
  const response = await call(settings, apiKey, { model: settings.model, temperature: 0.2, stream: true, messages: explanationMessages(question, probability) }, signal);
  if (!response.ok) throw new LlmError(`答案解析失败 (${response.status})`, response.status, false, response.status === 429 || response.status >= 500);
  if (!response.body) return explainAnswer(question, probability, settings, apiKey, signal);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "", complete = "";
  const consume = (raw: string) => {
    const line = raw.trim(); if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim(); if (!data || data === "[DONE]") return;
    try { const chunk = textContent(JSON.parse(data).choices?.[0]?.delta?.content); if (chunk) { complete += chunk; onChunk(chunk); } } catch { /* ignore non-JSON keepalive */ }
  };
  while (true) {
    const { done, value } = await reader.read(); buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const raw of lines) consume(raw.replace(/\r$/, ""));
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  return complete;
}
function explanationMessages(question: ExtractedQuestion, probability: ProbabilityResult) {
  const educationalQuestion = {
    questionType: question.questionType,
    stem: question.stem,
    context: question.context ?? "",
    options: question.options.map(({ id, label, text }) => ({ id, label, text })),
    warnings: question.warnings
  };
  return [{ role: "system", content: "你是学习辅导老师。给出推荐答案、逐项简析、核心知识点和不确定性。不要声称拥有隐藏推理，也不要鼓励考试作弊。" }, { role: "user", content: JSON.stringify({ question: educationalQuestion, probability }) }];
}
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => typeof part === "string" ? part : (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")).join("");
}
export function parseJsonObject(value: string | object): Partial<ExtractedQuestion> {
  if (typeof value === "object" && value !== null) return value;
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new LlmError("模型没有返回可解析的 JSON。");
  try { return JSON.parse(cleaned.slice(start, end + 1)); }
  catch { throw new LlmError("模型返回的题目 JSON 格式无效。"); }
}
