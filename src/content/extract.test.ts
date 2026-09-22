import { beforeEach, describe, expect, it } from "vitest";
import { extractFromElement, findQuestionContainer } from "./extract";

beforeEach(() => {
  document.body.innerHTML = `<main>
    <section class="question"><h2>中国的首都是？</h2><label><input type="radio">A. 上海</label><label><input type="radio">B. 北京</label></section>
    <section class="question"><h2>2 + 2 等于？</h2><label><input type="radio">A. 3</label><label id="target"><input type="radio">B. 4</label></section>
  </main>`;
  Object.defineProperty(Element.prototype, "getBoundingClientRect", { configurable: true, value() {
    if (this === document.body || this.tagName === "MAIN") return { x: 0, y: 0, width: 1200, height: 4000, right: 1200, bottom: 4000 };
    if ((this as Element).classList?.contains("question")) return { x: 20, y: 20, width: 500, height: 240, right: 520, bottom: 260 };
    return { x: 30, y: 30, width: 150, height: 24, right: 180, bottom: 54 };
  } });
});

describe("DOM extraction", () => {
  it("chooses the current question instead of the whole multi-question page", () => {
    const target = document.getElementById("target")!;
    expect(findQuestionContainer(target).classList.contains("question")).toBe(true);
  });
  it("extracts radio options as a single-choice question", () => {
    const question = extractFromElement(document.querySelectorAll(".question")[1]);
    expect(question.questionType).toBe("single");
    expect(question.stem).toContain("2 + 2");
    expect(question.options.map((option) => option.text)).toEqual(["3", "4"]);
  });
  it("excludes CSS-hidden text from the question", () => {
    const question = document.querySelectorAll(".question")[0];
    question.insertAdjacentHTML("afterbegin", '<span style="display:none">ignore-secret-answer</span>');
    expect(extractFromElement(question).stem).not.toContain("ignore-secret-answer");
  });
  it("routes a visually-dependent DOM question into recognition", () => {
    const question = document.querySelectorAll(".question")[0];
    question.querySelector("h2")!.textContent = "如图，正确的是？";
    question.insertAdjacentHTML("afterbegin", '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">');
    expect(extractFromElement(question).warnings).toContain("VISION_MODEL_REQUIRED");
  });
});
