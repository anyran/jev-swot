import { afterEach, describe, expect, it, vi } from "vitest";
import { askJev } from "./typesafe";
import type { ExtractedQuestion } from "../shared/types";

const base: ExtractedQuestion = { source: "dom", questionType: "single", stem: "2+2=?", options: [{ id: "option_1", label: "A", text: "3" }, { id: "option_2", label: "B", text: "4" }], sourceRect: { x: 0, y: 0, width: 100, height: 80 }, recognitionConfidence: 1, warnings: [] };
afterEach(() => vi.restoreAllMocks());
describe("JEV request mapping", () => {
  it("maps Choice probabilities back to labels", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-test", answers: { answer: { type: "choice", choice: "option_2", confidence: .9, probabilities: { option_1: .1, option_2: .9 } } } }), { status: 200 })));
    const result = await askJev(base, "secret");
    expect(result.mode).toBe("single-distribution"); expect(result.options[1]).toMatchObject({ label: "B", probability: .9 });
    const request = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(request.questions.answer.type).toBe("choice");
  });
  it("uses independent nouls for multiple choice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-test", answers: { option_1: { type: "noul", noul: .8 }, option_2: { type: "noul", noul: .6 } } }), { status: 200 })));
    const result = await askJev({ ...base, questionType: "multiple" }, "secret");
    expect(result.mode).toBe("independent-selection"); expect(result.options.map(x => x.probability)).toEqual([.8, .6]);
  });
});
