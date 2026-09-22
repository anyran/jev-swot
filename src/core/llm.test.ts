import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmError, parseJsonObject, structureOcrText } from "./llm";
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
  it("rejects non-JSON text", () => expect(() => parseJsonObject("no object here")).toThrow(LlmError));
});
