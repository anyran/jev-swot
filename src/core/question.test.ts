import { describe, expect, it } from "vitest";
import { parseQuestionText, validateQuestion } from "./question";

describe("question parsing", () => {
  it("parses labelled options", () => {
    const q = parseQuestionText("太阳系最大的行星是？\nA. 地球\nB. 木星\nC. 火星");
    expect(q.stem).toContain("最大的行星");
    expect(q.options.map((x) => x.label)).toEqual(["A", "B", "C"]);
    expect(validateQuestion(q)).toContain("请确认题目是单选还是多选");
  });
  it("flags diagrams", () => expect(parseQuestionText("如图所示\nA. 1\nB. 2").warnings).toContain("POSSIBLE_DIAGRAM"));
  it("rejects duplicate option labels", () => {
    const q = parseQuestionText("题目\nA. 一\nB. 二");
    q.options[1].label = "a";
    expect(validateQuestion(q)).toContain("选项标签重复");
  });
  it("infers explicit multiple-choice instructions", () => expect(parseQuestionText("多选题：选择所有正确项\nA. 一\nB. 二").questionType).toBe("multiple"));
  it("repairs isolated A/4 confusion only in a mixed alphabetic label sequence", () => {
    const q = parseQuestionText("题目\n4. 第一项\nB. 第二项\nC. 第三项");
    expect(q.options.map((option) => option.label)).toEqual(["A", "B", "C"]);
    expect(parseQuestionText("题目\n4. 四\n5. 五").options[0].label).toBe("4");
  });
});
