import { describe, expect, it } from "vitest";
import { parseQuestionText, validateQuestion } from "./question";

describe("question parsing", () => {
  it("parses labelled options", () => {
    const q = parseQuestionText("太阳系最大的行星是？\nA. 地球\nB. 木星\nC. 火星");
    expect(q.stem).toContain("最大的行星");
    expect(q.options.map((x) => x.label)).toEqual(["A", "B", "C"]);
    expect(validateQuestion(q)).toEqual([]);
  });
  it("flags diagrams", () => expect(parseQuestionText("如图所示\nA. 1\nB. 2").warnings).toContain("POSSIBLE_DIAGRAM"));
  it("rejects duplicate option labels", () => {
    const q = parseQuestionText("题目\nA. 一\nB. 二");
    q.options[1].label = "a";
    expect(validateQuestion(q)).toContain("选项标签重复");
  });
});
