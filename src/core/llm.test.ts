import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmError, answerWithLlm, answerWithRawText, answerWithVision, parseJsonObject, recognizeWithVision, streamExplanation, structureOcrText, validateLlmBaseUrl } from "./llm";
import type { LLMSettings } from "../shared/types";

const settings: LLMSettings = { baseUrl: "https://example.test/v1", model: "model", vision: "auto", structuredOutput: "auto" };
afterEach(() => vi.restoreAllMocks());
describe("OpenAI-compatible structured output", () => {
  it("allows HTTPS providers and local HTTP development endpoints only", () => {
    expect(validateLlmBaseUrl("https://example.test/v1")).toBeUndefined();
    expect(validateLlmBaseUrl("http://localhost:8787/v1")).toBeUndefined();
    expect(validateLlmBaseUrl("http://192.168.1.8:8787/v1")).toContain("HTTPS");
    expect(validateLlmBaseUrl("https://user:pass@example.test/v1")).toContain("账号密码");
  });
  it("parses fenced JSON", () => expect(parseJsonObject("```json\n{\"stem\":\"q\"}\n```")).toMatchObject({ stem: "q" }));
  it("asks the structure model to separate question text from results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questionType: "single", stem: "q", context: "", ignoredText: "正确答案：B；解析：…", options: [{ label: "A", text: "x" }, { label: "B", text: "y" }] }) } }] }), { status: 200 })));
    await structureOcrText("题目\nA. x\nB. y\n正确答案：B\n解析：…", settings, "secret");
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format.json_schema.schema.required).toContain("ignoredText");
    expect(body.messages[0].content).toContain("正确答案");
    expect(body.messages[0].content).toContain("不能放进 stem、options、context");
  });
  it("keeps model-reported excluded OCR text separate from the question", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questionType: "single", stem: "q", context: "", ignoredText: "正确答案：B", options: [{ label: "A", text: "x" }, { label: "B", text: "y" }] }) } }] }), { status: 200 })));
    const result = await structureOcrText("q\nA. x\nB. y\n正确答案：B", settings, "secret");
    expect(result.ignoredText).toBe("正确答案：B");
    expect(result.stem).toBe("q");
    expect(result.options).toHaveLength(2);
  });
  it("can answer a confirmed question directly with the ordinary model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answerOptionIds: ["option_2"], explanation: "4 是偶数。", knowledgePoints: ["偶数可被 2 整除"], uncertainty: "题干信息充分。" }) } }] }), { status: 200 })));
    const result = await answerWithLlm({ source: "dom", questionType: "single", stem: "哪个数字是偶数？", options: [{ id: "option_1", label: "A", text: "3" }, { id: "option_2", label: "B", text: "4" }], sourceRect: { x: 0, y: 0, width: 1, height: 1 }, recognitionConfidence: 1, warnings: [] }, settings, "secret");
    expect(result).toMatchObject({ answerOptionIds: ["option_2"], answerLabels: ["B"], explanation: "4 是偶数。", structuredOutputDetected: "supported" });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format.json_schema.name).toBe("direct_answer");
  });
  it("lets a vision model answer first and keeps question extraction available for details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answerOptionLabels: ["B"], explanation: "4 是偶数。", knowledgePoints: ["偶数"], uncertainty: "题干信息充分。" }) } }] }), { status: 200 })));
    const result = await answerWithVision("data:image/png;base64,AA==", settings, "secret");
    expect(result.answerOptionLabels).toEqual(["B"]);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format.json_schema.name).toBe("vision_direct_answer");
    expect(body.messages[1].content.some((part: { type: string }) => part.type === "image_url")).toBe(true);
  });
  it("can answer from raw OCR text without inventing a prior split", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answerOptionLabels: ["B"], explanation: "4 是偶数。", knowledgePoints: ["偶数"], uncertainty: "OCR 清晰。" }) } }] }), { status: 200 })));
    const result = await answerWithRawText("Which number is even?\nA. 3\nB. 4", settings, "secret");
    expect(result).toMatchObject({ answerLabels: ["B"], answerOptionIds: [], explanation: "4 是偶数。" });
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format.json_schema.name).toBe("raw_text_answer");
    expect(body.messages[0].content).toContain("原始题目文字");
  });
  it("rejects a direct answer that references an unknown option", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answerOptionIds: ["option_9"], explanation: "不可靠", knowledgePoints: [], uncertainty: "不确定" }) } }] }), { status: 200 })));
    await expect(answerWithLlm({ source: "dom", questionType: "single", stem: "q", options: [{ id: "option_1", label: "A", text: "x" }, { id: "option_2", label: "B", text: "y" }], sourceRect: { x: 0, y: 0, width: 1, height: 1 }, recognitionConfidence: 1, warnings: [] }, settings, "secret")).rejects.toThrow("不存在的选项");
  });
  it("falls back from json_schema to json_object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("unsupported response_format json_schema", { status: 400 })).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questionType: "single", stem: "q", context: "", options: [{ label: "A", text: "x" }, { label: "B", text: "y" }] }) } }] }), { status: 200 })));
    const result = await structureOcrText("q A.x B.y", settings, "secret");
    expect(result.stem).toBe("q"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("falls back from json_schema on a provider's 422 schema rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("json_schema is not supported", { status: 422 })).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questionType: "single", stem: "q", context: "", options: [{ label: "A", text: "x" }, { label: "B", text: "y" }] }) } }] }), { status: 200 })));
    const result = await structureOcrText("q A.x B.y", settings, "secret");
    expect(result.stem).toBe("q"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("sends OCR text-box coordinates to the structure model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questionType: "single", stem: "q", context: "", options: [{ label: "A", text: "x" }, { label: "B", text: "y" }] }) } }] }), { status: 200 })));
    await structureOcrText("q\nA. x\nB. y", settings, "secret", undefined, [{ x: 1, y: 2, width: 20, height: 8, text: "q", confidence: .9 }]);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(JSON.parse(body.messages[1].content).boxes[0]).toMatchObject({ text: "q", x: 1, y: 2 });
  });
  it("rejects non-JSON text", () => expect(() => parseJsonObject("no object here")).toThrow(LlmError));
  it("decodes streamed explanation chunks", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"答案"}}]}\n\ndata: {"choices":[{"delta":{"content":"是 B"}}]}\n\ndata: [DONE]\n\n';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const chunks: string[] = [];
    const result = await streamExplanation({ source: "dom", questionType: "single", stem: "q", options: [], sourceRect: { x: 0, y: 0, width: 1, height: 1 }, recognitionConfidence: 1, warnings: [] }, { mode: "single-distribution", options: [], model: "jev" }, settings, "secret", (chunk) => chunks.push(chunk));
    expect(result).toBe("答案是 B"); expect(chunks).toEqual(["答案", "是 B"]);
  });
  it("flushes an SSE data line that has no trailing newline", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"最后一段"}}]}';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const chunks: string[] = [];
    const result = await streamExplanation({ source: "dom", questionType: "single", stem: "q", options: [], sourceRect: { x: 0, y: 0, width: 1, height: 1 }, recognitionConfidence: 1, warnings: [] }, { mode: "single-distribution", options: [], model: "jev" }, settings, "secret", (chunk) => chunks.push(chunk));
    expect(result).toBe("最后一段"); expect(chunks).toEqual(["最后一段"]);
  });
  it("classifies an image rejection as unsupported vision", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("image_url is not supported", { status: 400 })));
    await expect(recognizeWithVision("data:image/png;base64,AA==", settings, "secret")).rejects.toMatchObject({ unsupportedVision: true, retryable: false });
  });
  it("redacts an API key from provider error details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Authorization: Bearer secret; token=secret", { status: 500 })));
    await expect(structureOcrText("q", settings, "secret")).rejects.toThrow(/\[redacted\]/);
    await expect(structureOcrText("q", settings, "secret")).rejects.not.toThrow(/secret/);
  });
  it("classifies an OpenAI-compatible 415 image rejection as unsupported vision", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("content type image_url is unsupported", { status: 415 })));
    await expect(recognizeWithVision("data:image/png;base64,AA==", settings, "secret")).rejects.toMatchObject({ unsupportedVision: true, retryable: false });
  });
  it("classifies a provider's invalid image input response as unsupported vision", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid image input for this model", { status: 400 })));
    await expect(recognizeWithVision("data:image/png;base64,AA==", settings, "secret")).rejects.toMatchObject({ unsupportedVision: true, retryable: false });
  });
  it("does not cache an empty 400 response as unsupported vision", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 400 })));
    await expect(recognizeWithVision("data:image/png;base64,AA==", settings, "secret")).rejects.toMatchObject({ unsupportedVision: false });
  });
  it("keeps a transient vision 429 retryable instead of marking the model unsupported", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));
    await expect(recognizeWithVision("data:image/png;base64,AA==", settings, "secret")).rejects.toMatchObject({ unsupportedVision: false, retryable: true, status: 429 });
  });
  it("keeps network failures retryable for the vision fallback path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await expect(recognizeWithVision("data:image/png;base64,AA==", settings, "secret")).rejects.toMatchObject({ unsupportedVision: false, retryable: true });
  });
  it("does not retry when the caller already cancelled", async () => {
    const controller = new AbortController(); controller.abort();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(structureOcrText("ignored", settings, "secret", controller.signal)).rejects.toMatchObject({ retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("omits page geometry from explanation requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "解析" } }] }), { status: 200 })));
    await (await import("./llm")).explainAnswer({ source: "dom", questionType: "single", stem: "q", options: [{ id: "option_1", label: "A", text: "x", sourceRect: { x: 1, y: 2, width: 3, height: 4 } }], sourceRect: { x: 10, y: 20, width: 30, height: 40 }, recognitionConfidence: 1, warnings: [] }, { mode: "single-distribution", options: [], model: "jev" }, settings, "secret");
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[1].content).not.toContain("sourceRect");
  });
});
