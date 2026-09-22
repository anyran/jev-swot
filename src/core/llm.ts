import type { ExtractedQuestion, LLMSettings, ProbabilityResult } from "../shared/types";

function endpoint(baseUrl: string): string { return `${baseUrl.replace(/\/$/, "")}/chat/completions`; }
function questionSchema() {
  return { name: "question", strict: true, schema: { type: "object", additionalProperties: false, required: ["questionType", "stem", "options", "context"], properties: { questionType: { enum: ["single", "multiple", "unknown"] }, stem: { type: "string" }, context: { type: "string" }, options: { type: "array", minItems: 2, maxItems: 255, items: { type: "object", additionalProperties: false, required: ["label", "text"], properties: { label: { type: "string" }, text: { type: "string" } } } } } } };
}
async function call(settings: LLMSettings, apiKey: string, body: object, signal?: AbortSignal): Promise<Response> {
  return fetch(endpoint(settings.baseUrl), { method: "POST", signal, headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
export async function recognizeWithVision(imageDataUrl: string, settings: LLMSettings, apiKey: string): Promise<Partial<ExtractedQuestion>> {
  const response = await call(settings, apiKey, { model: settings.model, temperature: 0, messages: [{ role: "system", content: "从题目截图中忠实提取题干和选项。不要解题，不要补充看不见的内容。" }, { role: "user", content: [{ type: "text", text: "提取这道题。" }, { type: "image_url", image_url: { url: imageDataUrl } }] }], response_format: { type: "json_schema", json_schema: questionSchema() } });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`视觉识别失败 (${response.status}): ${text.slice(0, 160)}`) as Error & { unsupportedVision?: boolean; status?: number };
    error.status = response.status;
    error.unsupportedVision = response.status === 400 && /image|vision|multimodal|content/i.test(text);
    throw error;
  }
  const data = await response.json();
  return JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
}
export async function structureOcrText(text: string, settings: LLMSettings, apiKey: string): Promise<Partial<ExtractedQuestion>> {
  const response = await call(settings, apiKey, { model: settings.model, temperature: 0, messages: [{ role: "system", content: "将 OCR 文本忠实整理为题目结构。不要解题或改写内容。" }, { role: "user", content: text }], response_format: { type: "json_schema", json_schema: questionSchema() } });
  if (!response.ok) throw new Error(`题目结构化失败 (${response.status})`);
  const data = await response.json();
  return JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
}
export async function explainAnswer(question: ExtractedQuestion, probability: ProbabilityResult, settings: LLMSettings, apiKey: string): Promise<string> {
  const response = await call(settings, apiKey, { model: settings.model, temperature: 0.2, messages: [{ role: "system", content: "你是学习辅导老师。给出推荐答案、逐项简析、核心知识点和不确定性。不要声称拥有隐藏推理，也不要鼓励考试作弊。" }, { role: "user", content: JSON.stringify({ question, probability }) }] });
  if (!response.ok) throw new Error(`答案解析失败 (${response.status})`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "模型未返回解析。";
}
