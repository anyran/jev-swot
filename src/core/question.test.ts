import { describe, expect, it } from "vitest";
import { fallbackOptionLabel, hasQuestionStructure, hasQuestionTextConflict, parseQuestionText, requiresRecognitionFallback, stripExcludedText, validateQuestion } from "./question";

describe("question parsing", () => {
  it("parses labelled options", () => {
    const q = parseQuestionText("太阳系最大的行星是？\nA. 地球\nB. 木星\nC. 火星");
    expect(q.stem).toContain("最大的行星");
    expect(q.options.map((x) => x.label)).toEqual(["A", "B", "C"]);
    expect(validateQuestion(q)).toContain("请确认题目是单选还是多选");
  });
  it("accepts OCR letter labels separated by whitespace", () => {
    const q = parseQuestionText("哪个数字是偶数？\nA 3\nB 4");
    expect(q.stem).toBe("哪个数字是偶数？");
    expect(q.options.map((x) => x.text)).toEqual(["3", "4"]);
  });
  it("flags diagrams", () => expect(parseQuestionText("如图所示\nA. 1\nB. 2").warnings).toContain("POSSIBLE_DIAGRAM"));
  it("flags geometry and chemistry visual cues", () => {
    expect(parseQuestionText("几何图中阴影面积是多少？\nA. 1\nB. 2").warnings).toContain("POSSIBLE_DIAGRAM");
    expect(parseQuestionText("化学结构式对应的物质是？\nA. 甲\nB. 乙").warnings).toContain("POSSIBLE_DIAGRAM");
    expect(parseQuestionText("x² 的值是多少？\nA. 1\nB. 2").warnings).toContain("POSSIBLE_FORMULA");
  });
  it("rejects duplicate option labels", () => {
    const q = parseQuestionText("题目\nA. 一\nB. 二");
    q.options[1].label = "a";
    expect(validateQuestion(q)).toContain("选项标签重复");
  });
  it("rejects duplicate option text", () => {
    const q = parseQuestionText("题目\nA. 正确\nB. 正确");
    expect(validateQuestion(q)).toContain("选项内容重复");
  });
  it("infers explicit multiple-choice instructions", () => expect(parseQuestionText("多选题：选择所有正确项\nA. 一\nB. 二").questionType).toBe("multiple"));
  it("repairs isolated A/4 confusion only in a mixed alphabetic label sequence", () => {
    const q = parseQuestionText("题目\n4. 第一项\nB. 第二项\nC. 第三项");
    expect(q.options.map((option) => option.label)).toEqual(["A", "B", "C"]);
    expect(parseQuestionText("题目\n4. 四\n5. 五").options[0].label).toBe("4");
  });
  it("detects a strong DOM/OCR text conflict", () => {
    const reference = parseQuestionText("法国首都是哪里？\nA. 巴黎\nB. 伦敦"); reference.source = "dom";
    const candidate = parseQuestionText("日本首都是哪里？\nA. 东京\nB. 大阪"); candidate.source = "local-ocr";
    expect(hasQuestionTextConflict(reference, candidate)).toBe(true);
  });
  it("accepts OCR formatting differences when the question and options agree", () => {
    const reference = parseQuestionText("法国首都是哪里？\nA. 巴黎\nB. 伦敦"); reference.source = "dom";
    const candidate = parseQuestionText("法国 首都是哪里\nA. 巴黎\nB. 伦敦"); candidate.source = "local-ocr";
    expect(hasQuestionTextConflict(reference, candidate)).toBe(false);
  });
  it("supports numeric labels beyond single digits", () => {
    const q = parseQuestionText("按顺序选择\n10. 第十项\n11. 第十一项");
    expect(q.options.map((option) => option.label)).toEqual(["10", "11"]);
  });
  it("recognizes complete text even when the user must confirm the question type", () => {
    const q = parseQuestionText("哪个数字是偶数？\nA. 3\nB. 4");
    expect(q.questionType).toBe("unknown");
    expect(hasQuestionStructure(q)).toBe(true);
  });
  it("does not send formula-marked DOM questions directly to JEV", () => {
    const q = parseQuestionText("x² 的值是多少？\nA. 1\nB. 2");
    q.source = "dom";
    expect(hasQuestionStructure(q)).toBe(true);
    expect(requiresRecognitionFallback(q)).toBe(true);
    q.warnings = [];
    q.source = "user-edited";
    expect(requiresRecognitionFallback(q)).toBe(false);
  });
  it("keeps generated labels unique for high-cardinality choices", () => {
    expect(fallbackOptionLabel(0)).toBe("A");
    expect(fallbackOptionLabel(25)).toBe("Z");
    expect(fallbackOptionLabel(26)).toBe("27");
  });
  it("removes standalone result lines from model text", () => {
    expect(stripExcludedText("题干\nA. 3\nB. 4\n正确答案：B\n解析：偶数可被二整除", "正确答案：B\n解析：偶数可被二整除")).toBe("题干\nA. 3\nB. 4");
  });
  it("keeps an option prefix when a result marker shares its OCR line", () => {
    expect(stripExcludedText("B. 4 正确答案：B", "正确答案：B")).toBe("B. 4");
  });
  it("handles English result markers without deleting the option prefix", () => {
    expect(stripExcludedText("B. 4 Correct answer: B", "Correct answer: B")).toBe("B. 4");
    expect(stripExcludedText("Explanation: even numbers are divisible by two", "Explanation: even numbers are divisible by two")).toBe("");
  });
  it("removes bare answer/result annotations without deleting the question text", () => {
    expect(stripExcludedText("哪个数字是偶数？\nA. 3\nB. 4\n答案：B")).toBe("哪个数字是偶数？\nA. 3\nB. 4");
    expect(stripExcludedText("Which number is even?\nA. 3\nB. 4\nAnswer: B")).toBe("Which number is even?\nA. 3\nB. 4");
    expect(stripExcludedText("答案是什么？\nA. 3\nB. 4")).toBe("答案是什么？\nA. 3\nB. 4");
  });
});
