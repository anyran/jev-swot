import { describe, expect, it } from "vitest";
import { hasStructuredQuestionFields, normalizeParsed } from "./recognition";
import type { ExtractedQuestion } from "../shared/types";

const base: ExtractedQuestion = {
  source: "local-ocr",
  questionType: "single",
  stem: "图中哪条线最长？",
  options: [
    { id: "option_1", label: "A", text: "甲" },
    { id: "option_2", label: "B", text: "乙" }
  ],
  context: "DOM alt：图中有三条带标注的线段",
  sourceRect: { x: 0, y: 0, width: 320, height: 180 },
  recognitionConfidence: 0.8,
  warnings: []
};

describe("recognition normalization", () => {
  it("keeps DOM context when a structure model returns an empty context", () => {
    const normalized = normalizeParsed({
      questionType: "single",
      stem: base.stem,
      options: base.options,
      context: "",
      visualDependency: false,
      visualDependencyReason: "",
      ignoredText: ""
    }, base, "local-ocr", 0.9);
    expect(normalized.context).toBe(base.context);
  });

  it("requires the exclusion ledger before treating model JSON as structured", () => {
    expect(hasStructuredQuestionFields({
      questionType: "single",
      stem: "题干",
      options: [],
      context: "",
      visualDependency: false,
      visualDependencyReason: ""
    })).toBe(false);
    expect(hasStructuredQuestionFields({
      questionType: "single",
      stem: "题干",
      options: [],
      context: "",
      visualDependency: false,
      visualDependencyReason: "",
      ignoredText: ""
    })).toBe(true);
  });
});
