import { describe, expect, it } from "vitest";
import { summarizeAnswer } from "./overlay";
import type { ProbabilityResult } from "../shared/types";

describe("compact answer summary", () => {
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
});
