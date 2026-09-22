import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmError, parseJsonObject, recognizeWithVision, streamExplanation, structureOcrText } from "./llm";
import type { LLMSettings } from "../shared/types";

const settings: LLMSettings = { baseUrl: "https://example.test/v1", model: "model", vision: "auto", structuredOutput: "auto" };
afterEach(() => vi.restoreAllMocks());
describe("OpenAI-compatible structured output", () => {
  it("parses fenced JSON", () => expect(parseJsonObject("```json\n{\"stem\":\"q\"}\n```")).toMatchObject({ stem: "q" }));
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
  it("classifies an OpenAI-compatible 415 image rejection as unsupported vision", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("content type image_url is unsupported", { status: 415 })));
    await expect(recognizeWithVision("data:image/png;base64,AA==", settings, "secret")).rejects.toMatchObject({ unsupportedVision: true, retryable: false });
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
