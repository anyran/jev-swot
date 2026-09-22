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
    const request = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(request.state.options.option_1).toContain("3");
    expect(request.questions.option_1.instructions).not.toContain("3");
  });
  it("retries one transient service failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("busy", { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify({ model: "jev-test", answers: { answer: { type: "choice", confidence: .8, probabilities: { option_1: .2, option_2: .8 } } } }), { status: 200 })));
    await askJev(base, "secret"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("normalizes malformed Choice totals before display", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-test", answers: { answer: { type: "choice", confidence: 2, probabilities: { option_1: .2, option_2: .2 } } } }), { status: 200 })));
    const result = await askJev(base, "secret");
    expect(result.options.reduce((sum, item) => sum + item.probability, 0)).toBeCloseTo(1);
    expect(result.confidence).toBe(1);
  });
  it("rejects incomplete Choice probabilities", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-test", answers: { answer: { type: "choice", probabilities: { option_1: .8 }, confidence: .8 } } }), { status: 200 })));
    await expect(askJev(base, "secret")).rejects.toThrow("未覆盖全部选项");
  });
  it("rejects missing independent Noul results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-test", answers: { option_1: { type: "noul", noul: .8 } } }), { status: 200 })));
    await expect(askJev({ ...base, questionType: "multiple" }, "secret")).rejects.toThrow("缺少选项 B 的 Noul");
  });
  it("redacts an API key from JEV error details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Bearer secret", { status: 400 })));
    await expect(askJev(base, "secret")).rejects.toThrow(/\[redacted\]/);
    await expect(askJev(base, "secret")).rejects.not.toThrow(/secret/);
  });
  it("aborts an in-flight JEV request", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })));
    const pending = askJev(base, "secret", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
