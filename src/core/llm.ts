import type { ExtractedQuestion, LLMSettings, ProbabilityResult } from "../shared/types";

export class LlmError extends Error {
  constructor(message: string, public status?: number, public unsupportedVision = false, public retryable = false) { super(message); }
}
function endpoint(baseUrl: string): string { return `${baseUrl.replace(/\/$/, "")}/chat/completions`; }
function questionSchema() {
  return { name: "question", strict: true, schema: { type: "object", additionalProperties: false, required: ["questionType", "stem", "options", "context"], properties: { questionType: { enum: ["single", "multiple", "unknown"] }, stem: { type: "string" }, context: { type: "string" }, options: { type: "array", minItems: 2, maxItems: 255, items: { type: "object", additionalProperties: false, required: ["label", "text"], properties: { label: { type: "string" }, text: { type: "string" } } } } } } };
}
async function call(settings: LLMSettings, apiKey: string, body: object, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("模型请求超时", "TimeoutError")), 45_000);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(endpoint(settings.baseUrl), { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    if (controller.signal.aborted) throw new LlmError("模型请求超时或已取消。", undefined, false, true);
    throw new LlmError(error instanceof Error ? error.message : "模型网络请求失败。", undefined, false, true);
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}
type Message = { role: string; content: unknown };
async function structuredQuestion(messages: Message[], settings: LLMSettings, apiKey: string): Promise<Partial<ExtractedQuestion>> {
  const formats: Array<object | undefined> = settings.structuredOutput === "unsupported" ? [{ type: "json_object" }, undefined] : [{ type: "json_schema", json_schema: questionSchema() }, { type: "json_object" }, undefined];
  let lastError: LlmError | undefined;
  for (const responseFormat of formats) {
    const body: Record<string, unknown> = { model: settings.model, temperature: 0, messages };
    if (responseFormat) body.response_format = responseFormat;
    const response = await call(settings, apiKey, body);
    if (response.ok) {
      const data = await response.json();
      return parseJsonObject(data.choices?.[0]?.message?.content ?? "{}");
    }
    const responseText = await response.text().catch(() => "");
    const unsupportedVision = response.status === 400 && /image|vision|multimodal|image_url/i.test(responseText);
    if (unsupportedVision) throw new LlmError("当前模型不支持图像输入。", response.status, true, false);
    const formatRejected = response.status === 400 && /response_format|json_schema|structured|schema/i.test(responseText);
    lastError = new LlmError(`模型请求失败 (${response.status})${responseText ? `: ${responseText.slice(0, 160)}` : ""}`, response.status, false, response.status === 429 || response.status >= 500);
    if (!formatRejected || !responseFormat) break;
  }
  throw lastError ?? new LlmError("模型未返回有效题目结构。");
}
export async function recognizeWithVision(imageDataUrl: string, settings: LLMSettings, apiKey: string): Promise<Partial<ExtractedQuestion>> {
  return structuredQuestion([{ role: "system", content: "从题目截图中忠实提取题干和选项。不要解题，不要补充看不见的内容。只输出 JSON。" }, { role: "user", content: [{ type: "text", text: "提取这道题。" }, { type: "image_url", image_url: { url: imageDataUrl } }] }], settings, apiKey);
}
export async function structureOcrText(text: string, settings: LLMSettings, apiKey: string): Promise<Partial<ExtractedQuestion>> {
  return structuredQuestion([{ role: "system", content: "将 OCR 文本忠实整理为题目结构。不要解题或改写内容。只输出 JSON。" }, { role: "user", content: text }], settings, apiKey);
}
export async function explainAnswer(question: ExtractedQuestion, probability: ProbabilityResult, settings: LLMSettings, apiKey: string): Promise<string> {
  const response = await call(settings, apiKey, { model: settings.model, temperature: 0.2, messages: [{ role: "system", content: "你是学习辅导老师。给出推荐答案、逐项简析、核心知识点和不确定性。不要声称拥有隐藏推理，也不要鼓励考试作弊。" }, { role: "user", content: JSON.stringify({ question, probability }) }] });
  if (!response.ok) throw new LlmError(`答案解析失败 (${response.status})`, response.status, false, response.status === 429 || response.status >= 500);
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "模型未返回解析。";
}
export function parseJsonObject(value: string | object): Partial<ExtractedQuestion> {
  if (typeof value === "object" && value !== null) return value;
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new LlmError("模型没有返回可解析的 JSON。");
  try { return JSON.parse(cleaned.slice(start, end + 1)); }
  catch { throw new LlmError("模型返回的题目 JSON 格式无效。"); }
}
