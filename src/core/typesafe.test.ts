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
  it("uses a configured OpenRouter-compatible endpoint, model ID, and API key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "typesafe/jev-1.13", answers: { answer: { type: "choice", probabilities: { option_1: .1, option_2: .9 } } } }), { status: 200 })));
    const endpoint = "https://openrouter.ai/api/alpha/decisions";
    const result = await askJev(base, "openrouter-secret", undefined, { endpoint, model: "typesafe/jev-1.13" });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const request = JSON.parse((init as RequestInit).body as string);
    expect(url).toBe(endpoint);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer openrouter-secret" });
    expect(request.model).toBe("typesafe/jev-1.13");
    expect(result.model).toBe("typesafe/jev-1.13");
  });
  it("sends OpenRouter Decisions API Noul questions and parses independent probabilities", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: "typesafe/jev-1.13-20260917",
      answers: {
        option_1: { type: "noul", noul: .96 },
        option_2: { type: "noul", noul: .04 }
      }
    }), { status: 200 })));
    const endpoint = "https://openrouter.ai/api/alpha/decisions";
    const result = await askJev({ ...base, questionType: "multiple" }, "openrouter-secret", undefined, { endpoint, model: "typesafe/jev-1.13" });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const request = JSON.parse((init as RequestInit).body as string);
    expect(url).toBe(endpoint);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer openrouter-secret" });
    expect(request).toMatchObject({
      model: "typesafe/jev-1.13",
      state: { options: { option_1: "A. 3", option_2: "B. 4" } },
      questions: {
        option_1: { type: "noul", instructions: { optionId: "option_1" } },
        option_2: { type: "noul", instructions: { optionId: "option_2" } }
      }
    });
    expect(result).toMatchObject({ mode: "independent-selection", options: [
      { id: "option_1", probability: .96 }, { id: "option_2", probability: .04 }
    ] });
    expect(result.model).toBe("typesafe/jev-1.13-20260917");
  });
  it("uses independent nouls for multiple choice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-test", answers: { option_1: { type: "noul", noul: .8 }, option_2: { type: "noul", noul: .6 } } }), { status: 200 })));
    const result = await askJev({ ...base, questionType: "multiple" }, "secret");
    expect(result.mode).toBe("independent-selection"); expect(result.options.map(x => x.probability)).toEqual([.8, .6]);
    const request = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(request.state.options.option_1).toContain("3");
    expect(request.questions.option_1.instructions.optionId).toBe("option_1");
    expect(JSON.stringify(request.questions.option_1.instructions)).not.toContain("3");
    expect(request.questions.option_2.instructions.optionId).toBe("option_2");
    expect(JSON.stringify(request.questions.option_2.instructions)).not.toContain("4");
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
  it("keeps omitted Choice confidence optional instead of inventing zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-test", answers: { answer: { type: "choice", probabilities: { option_1: .2, option_2: .8 } } } }), { status: 200 })));
    const result = await askJev(base, "secret");
    expect(result.confidence).toBeUndefined();
  });
  it("rejects incomplete Choice probabilities", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-test", answers: { answer: { type: "choice", probabilities: { option_1: .8 }, confidence: .8 } } }), { status: 200 })));
    await expect(askJev(base, "secret")).rejects.toThrow("未覆盖全部选项");
  });
  it("rejects a non-Choice answer that happens to contain probabilities", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "jev-test", answers: { answer: { type: "noul", probabilities: { option_1: .8, option_2: .2 }, confidence: .8 } } }), { status: 200 })));
    await expect(askJev(base, "secret")).rejects.toThrow("缺少 Choice 概率");
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
