import { describe, expect, it } from "vitest";
import { hasOcrBoundaryEvidence, hasStructuredQuestionFields, normalizeParsed } from "./recognition";
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

  it("rebuilds local OCR boundaries from visual line evidence instead of model prose", () => {
    const boxes = [
      { x: 0, y: 0, width: 120, height: 10, text: "哪个数字是偶数？", confidence: .95 },
      { x: 0, y: 24, width: 14, height: 10, text: "A.", confidence: .9 },
      { x: 20, y: 24, width: 12, height: 10, text: "3", confidence: .9 },
      { x: 0, y: 48, width: 14, height: 10, text: "B.", confidence: .9 },
      { x: 20, y: 48, width: 12, height: 10, text: "4", confidence: .9 },
      { x: 0, y: 72, width: 140, height: 10, text: "正确答案：B", confidence: .9 }
    ];
    const parsed = normalizeParsed({
      questionType: "single",
      // Deliberately put an option in the model stem and a result annotation
      // in the model option; the line ledger must override those boundaries.
      stem: "哪个数字是偶数？ A. 3",
      options: [{ label: "A", text: "3" }, { label: "B", text: "4 正确答案：B" }],
      context: "",
      visualDependency: false,
      visualDependencyReason: "",
      ignoredText: "正确答案：B",
      stemLineIds: ["line_1"],
      optionLineIds: ["line_2", "line_3"],
      ignoredLineIds: ["line_4"]
    }, { ...base, stem: "本地初始题干", options: [], warnings: ["INCOMPLETE_OPTIONS"] }, "local-ocr", .9, boxes);
    expect(parsed.stem).toBe("哪个数字是偶数？");
    expect(parsed.options.map(({ label, text }) => [label, text])).toEqual([["A", "3"], ["B", "4"]]);
    expect(parsed.warnings).not.toContain("STRUCTURE_REVIEW_REQUIRED");
    expect(hasOcrBoundaryEvidence({
      questionType: "single", stem: parsed.stem, options: [{ id: "option_1", label: "A", text: "3" }, { id: "option_2", label: "B", text: "4" }], context: "", visualDependency: false, visualDependencyReason: "", ignoredText: "正确答案：B", stemLineIds: ["line_1"], optionLineIds: ["line_2", "line_3"], ignoredLineIds: ["line_4"]
    }, boxes)).toBe(true);
  });

  it("keeps deterministic OCR text and requires review when the line ledger is invalid", () => {
    const parsed = normalizeParsed({
      questionType: "single", stem: "模型拼接了选项", options: [{ id: "option_1", label: "A", text: "错误" }, { id: "option_2", label: "B", text: "边界" }], context: "", visualDependency: false, visualDependencyReason: "", ignoredText: ""
    }, { ...base, stem: "题干", options: [{ id: "option_1", label: "A", text: "一" }, { id: "option_2", label: "B", text: "二" }], warnings: [] }, "local-ocr", .8, [{ x: 0, y: 0, width: 20, height: 10, text: "题干", confidence: .8 }]);
    expect(parsed.stem).toBe("题干");
    expect(parsed.options.map((option) => option.text)).toEqual(["一", "二"]);
    expect(parsed.warnings).toContain("STRUCTURE_REVIEW_REQUIRED");
  });
});
