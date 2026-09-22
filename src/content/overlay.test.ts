import { describe, expect, it, vi } from "vitest";
import { overlayPaletteForLuminance, ResultOverlay, summarizeAnswer } from "./overlay";
import type { ExtractedQuestion, ProbabilityResult } from "../shared/types";

const question: ExtractedQuestion = {
  source: "dom",
  questionType: "single",
  stem: "Which number is even?",
  options: [{ id: "option_1", label: "A", text: "3" }, { id: "option_2", label: "B", text: "4" }],
  sourceRect: { x: 0, y: 0, width: 1, height: 1 },
  recognitionConfidence: 1,
  warnings: []
};
function shadow(overlay: ResultOverlay): ShadowRoot { return (overlay as unknown as { root: ShadowRoot }).root; }
function close(overlay: ResultOverlay) { shadow(overlay).querySelector<HTMLElement>('[data-action="close"]')?.click(); }

describe("compact answer summary", () => {
  it("uses a subtle dark palette on light pages and a light palette on dark pages", () => {
    expect(overlayPaletteForLuminance(0.9)).toMatchObject({
      text: "rgba(17,24,39,.52)",
      strong: "rgba(0,0,0,.66)"
    });
    expect(overlayPaletteForLuminance(0.08)).toMatchObject({
      text: "rgba(255,255,255,.58)",
      strong: "rgba(255,255,255,.78)"
    });
  });

  it("shows the highest-probability single answer", () => {
    const probability: ProbabilityResult = {
      mode: "single-distribution",
      options: [
        { id: "option_1", label: "A", probability: 0.27 },
        { id: "option_2", label: "B", probability: 0.73 }
      ],
      confidence: 0.82,
      model: "jev-test"
    };
    expect(summarizeAnswer(probability)).toEqual({ label: "B", uncertain: false, detail: "73%" });
  });

  it("marks a low-confidence single answer as a tendency", () => {
    const probability: ProbabilityResult = {
      mode: "single-distribution",
      options: [{ id: "option_1", label: "A", probability: 0.55 }, { id: "option_2", label: "B", probability: 0.45 }],
      confidence: 0.4,
      model: "jev-test"
    };
    expect(summarizeAnswer(probability)).toMatchObject({ label: "A", uncertain: true, detail: "55%" });
  });

  it("marks an uncertain compact answer without adding visible label text", () => {
    const overlay = new ResultOverlay(vi.fn(), vi.fn(), vi.fn(), vi.fn());
    overlay.show({ ok: true, question, probability: { mode: "single-distribution", options: [{ id: "option_1", label: "A", probability: 0.55 }, { id: "option_2", label: "B", probability: 0.45 }], confidence: 0.4, model: "jev-test" } });
    const compact = shadow(overlay).querySelector<HTMLElement>(".answer-compact");
    expect(compact?.textContent).toBe("A");
    expect(compact?.dataset.uncertain).toBe("true");
    expect(compact?.getAttribute("title")).toContain("不确定");
    close(overlay);
  });

  it("stays conservative when the provider omits confidence", () => {
    expect(summarizeAnswer({
      mode: "single-distribution",
      options: [{ id: "option_1", label: "A", probability: 0.55 }, { id: "option_2", label: "B", probability: 0.45 }],
      model: "jev-test"
    })).toMatchObject({ label: "A", uncertain: true });
  });

  it("does not present an empty single distribution as a confirmed answer", () => {
    expect(summarizeAnswer({ mode: "single-distribution", options: [], model: "jev-test" })).toEqual({ label: "待确认", uncertain: true, detail: "" });
  });

  it("shows all multiple-choice options above the selection threshold", () => {
    const probability: ProbabilityResult = {
      mode: "independent-selection",
      options: [
        { id: "option_1", label: "A", probability: 0.8 },
        { id: "option_2", label: "B", probability: 0.2 },
        { id: "option_3", label: "C", probability: 0.6 }
      ],
      model: "jev-test"
    };
    expect(summarizeAnswer(probability)).toEqual({ label: "A、C", uncertain: false, detail: "选择倾向" });
  });

  it("falls back to the two strongest multiple-choice options when none exceeds 50%", () => {
    const probability: ProbabilityResult = {
      mode: "independent-selection",
      options: [
        { id: "option_1", label: "A", probability: 0.42 },
        { id: "option_2", label: "B", probability: 0.38 },
        { id: "option_3", label: "C", probability: 0.1 }
      ],
      model: "jev-test"
    };
    expect(summarizeAnswer(probability)).toEqual({ label: "A、B", uncertain: true, detail: "暂无过半概率" });
  });

  it("marks a multiple-choice probability near the selection threshold as uncertain", () => {
    const probability: ProbabilityResult = {
      mode: "independent-selection",
      options: [{ id: "option_1", label: "A", probability: 0.51 }, { id: "option_2", label: "B", probability: 0.2 }],
      model: "jev-test"
    };
    expect(summarizeAnswer(probability)).toMatchObject({ label: "A", uncertain: true, detail: "选择倾向" });
  });

  it("offers ordinary-model direct answering from expanded probability details", () => {
    const overlay = new ResultOverlay(vi.fn(), vi.fn(), vi.fn(), vi.fn());
    overlay.show({ ok: true, question, probability: { mode: "single-distribution", options: [{ id: "option_1", label: "A", probability: 0.1 }, { id: "option_2", label: "B", probability: 0.9 }], confidence: 0.9, model: "jev-test" } });
    expect(shadow(overlay).querySelector(".answer-compact")?.textContent).toBe("B");
    expect(shadow(overlay).querySelector(".answer-compact span")).toBeNull();
    shadow(overlay).querySelector<HTMLElement>('[data-action="toggle-details"]')?.click();
    expect(shadow(overlay).querySelector('[data-action="direct-answer"]')).not.toBeNull();
    close(overlay);
  });

  it("attaches adaptive palette variables to the compact overlay", () => {
    const overlay = new ResultOverlay(vi.fn(), vi.fn(), vi.fn(), vi.fn());
    overlay.show({ ok: true, question, probability: { mode: "single-distribution", options: [{ id: "option_1", label: "A", probability: 0.1 }, { id: "option_2", label: "B", probability: 0.9 }], confidence: 0.9, model: "jev-test" } });
    const section = shadow(overlay).querySelector("section");
    expect(section?.getAttribute("style")).toContain("--jev-text:");
    expect(section?.getAttribute("style")).toContain("--jev-shadow:");
    close(overlay);
  });

  it("samples a dark page background before choosing the compact palette", () => {
    const pageSurface = document.createElement("div");
    pageSurface.style.backgroundColor = "rgb(0, 0, 0)";
    document.body.append(pageSurface);
    const previous = (document as Document & { elementsFromPoint?: unknown }).elementsFromPoint;
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: vi.fn(() => [pageSurface]) });
    const overlay = new ResultOverlay(vi.fn(), vi.fn(), vi.fn(), vi.fn());
    try {
      overlay.show({ ok: true, question, probability: { mode: "single-distribution", options: [{ id: "option_1", label: "A", probability: 0.1 }, { id: "option_2", label: "B", probability: 0.9 }], confidence: 0.9, model: "jev-test" } });
      expect(shadow(overlay).querySelector("section")?.getAttribute("style")).toContain("--jev-text:rgba(255,255,255,.58)");
    } finally {
      close(overlay);
      pageSurface.remove();
      if (previous) Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: previous });
      else Reflect.deleteProperty(document, "elementsFromPoint");
    }
  });

  it("keeps an unknown question type unknown until the user chooses one", () => {
    const overlay = new ResultOverlay(vi.fn(), vi.fn(), vi.fn(), vi.fn());
    overlay.show({ ok: false, code: "STRUCTURE_REVIEW_REQUIRED", message: "请校正", recoverable: true, question: { ...question, questionType: "unknown" } });
    const select = shadow(overlay).querySelector<HTMLSelectElement>("#type");
    expect(select?.value).toBe("unknown");
    close(overlay);
  });

  it("keeps the shortcut capture grant when retrying vision consent", () => {
    const retry = vi.fn();
    const overlay = new ResultOverlay(retry, vi.fn(), vi.fn(), vi.fn());
    overlay.loading(question, true);
    overlay.show({ ok: false, code: "VISION_CONSENT_REQUIRED", message: "允许上传？", recoverable: true });
    shadow(overlay).querySelector<HTMLElement>('[data-action="allow-vision"]')?.click();
    expect(retry).toHaveBeenCalledWith(question, "allow", true);

    overlay.loading(question, true);
    overlay.show({ ok: false, code: "VISION_CONSENT_REQUIRED", message: "允许上传？", recoverable: true });
    shadow(overlay).querySelector<HTMLElement>('[data-action="local-only"]')?.click();
    expect(retry).toHaveBeenLastCalledWith(question, "deny", true);
    close(overlay);
  });
});
