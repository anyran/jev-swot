import { beforeEach, describe, expect, it } from "vitest";
import { extractFromElement, extractPageQuestions, findQuestionContainer } from "./extract";

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
  it("finds every question in the document, including questions below the viewport", () => {
    const questions = document.querySelectorAll(".question");
    Object.defineProperty(questions[0], "getBoundingClientRect", { configurable: true, value: () => ({ x: 20, y: 20, width: 500, height: 240, right: 520, bottom: 260 }) });
    Object.defineProperty(questions[1], "getBoundingClientRect", { configurable: true, value: () => ({ x: 20, y: 1800, width: 500, height: 240, right: 520, bottom: 2040 }) });

    const found = extractPageQuestions(document.body, { x: 0, y: 1800 });

    expect(found).toHaveLength(2);
    expect(found.map(({ question }) => question.stem)).toEqual(expect.arrayContaining(["中国的首都是？", "2 + 2 等于？"]));
    expect(found[1].question.sourceRect.y).toBe(3600);
    expect(found[0].question.coordinateSpace).toBe("document");
    expect(found[0].question.options[0].sourceRect?.y).toBe(1830);
    expect(found[0].question.options.map((option) => option.text)).toEqual(["上海", "北京"]);
  });
  it("keeps document coordinates stable while a nested scroll container is traversed", () => {
    document.body.innerHTML = `<div id="question-list" style="height:200px;overflow-y:auto"><section class="question"><h2>Which option is correct?</h2><label>A. No</label><label>B. Yes</label></section></div>`;
    const scroller = document.getElementById("question-list")!;
    const question = document.querySelector(".question")!;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(question, "getBoundingClientRect", { configurable: true, value: () => {
      const y = 250 - scroller.scrollTop;
      return { x: 20, y, width: 500, height: 120, right: 520, bottom: y + 120 };
    } });

    const before = extractPageQuestions()[0].question.sourceRect;
    scroller.scrollTop = 100;
    const after = extractPageQuestions()[0].question.sourceRect;

    expect(before.y).toBe(250);
    expect(after.y).toBe(250);
  });
  it("extracts question structure and text from nested open Shadow DOM", () => {
    document.body.innerHTML = "<quiz-question></quiz-question>";
    const card = document.querySelector("quiz-question")!;
    const cardRoot = card.attachShadow({ mode: "open" });
    cardRoot.innerHTML = `<section class="question"><h2><question-stem></question-stem></h2><label><input type="radio"><answer-copy></answer-copy></label><label><input type="radio"><answer-copy></answer-copy></label></section>`;
    const question = cardRoot.querySelector(".question")!;
    const stem = question.querySelector("question-stem")!;
    stem.attachShadow({ mode: "open" }).innerHTML = "Which option is correct?";
    const answerCopies = question.querySelectorAll("answer-copy");
    answerCopies[0].attachShadow({ mode: "open" }).innerHTML = "A. No";
    answerCopies[1].attachShadow({ mode: "open" }).innerHTML = "B. Yes";

    const found = extractPageQuestions();

    expect(found).toHaveLength(1);
    expect(found[0].question.stem).toBe("Which option is correct?");
    expect(found[0].question.options.map((option) => [option.label, option.text])).toEqual([["A", "No"], ["B", "Yes"]]);
    expect(found[0].question.questionType).toBe("single");
  });
  it("keeps identical questions at different page positions as separate candidates", () => {
    document.body.innerHTML = `<main><section class="question"><h2>相同题目？</h2><label>A. 是</label><label>B. 否</label></section><section class="question"><h2>相同题目？</h2><label>A. 是</label><label>B. 否</label></section></main>`;
    const questions = document.querySelectorAll(".question");
    Object.defineProperty(questions[0], "getBoundingClientRect", { configurable: true, value: () => ({ x: 20, y: 20, width: 500, height: 240, right: 520, bottom: 260 }) });
    Object.defineProperty(questions[1], "getBoundingClientRect", { configurable: true, value: () => ({ x: 20, y: 1800, width: 500, height: 240, right: 520, bottom: 2040 }) });

    expect(extractPageQuestions()).toHaveLength(2);
  });
  it("does not merge nested question groups into their page wrapper", () => {
    document.body.innerHTML = `<main><div class="quiz"><section class="question"><h2>Q1</h2><label>A. 1</label><label>B. 2</label></section><section class="question"><h2>Q2</h2><label>A. 3</label><label>B. 4</label></section></div></main>`;
    const found = extractPageQuestions();
    expect(found).toHaveLength(2);
    expect(found.map(({ question }) => question.stem)).toEqual(["Q1", "Q2"]);
  });
  it("keeps the nearest question when a realistic page has several option groups", () => {
    const main = document.querySelector("main")!;
    Object.defineProperty(main, "getBoundingClientRect", { configurable: true, value: () => ({ x: 0, y: 0, width: 900, height: 700, right: 900, bottom: 700 }) });
    const target = document.getElementById("target")!;
    expect(findQuestionContainer(target).classList.contains("question")).toBe(true);
  });
  it("extracts radio options as a single-choice question", () => {
    const question = extractFromElement(document.querySelectorAll(".question")[1]);
    expect(question.questionType).toBe("single");
    expect(question.stem).toContain("2 + 2");
    expect(question.options.map((option) => option.text)).toEqual(["3", "4"]);
  });
  it("limits a dragged selection to the intersecting question text and controls", () => {
    document.body.innerHTML = `<main><section class="question" data-y="20"><h2 data-y="20">第一题</h2><label data-y="60"><input data-y="60" type="radio">A. 甲</label><label data-y="90"><input data-y="90" type="radio">B. 乙</label></section><section class="question" data-y="300"><h2 data-y="300">第二题</h2><label data-y="340"><input data-y="340" type="radio">A. 丙</label><label data-y="370"><input data-y="370" type="radio">B. 丁</label></section></main>`;
    Object.defineProperty(Element.prototype, "getBoundingClientRect", { configurable: true, value() {
      const y = Number((this as HTMLElement).dataset.y ?? 0);
      const height = this.classList?.contains("question") ? 120 : 24;
      return { x: 20, y, width: 500, height, right: 520, bottom: y + height };
    } });
    const second = document.querySelectorAll(".question")[1];
    const question = extractFromElement(second, { x: 0, y: 280, width: 600, height: 180 });
    expect(question.stem).toContain("第二题");
    expect(question.stem).not.toContain("第一题");
    expect(question.options.map((option) => option.text)).toEqual(["丙", "丁"]);
    expect(question.sourceRect).toMatchObject({ x: 0, y: 280, width: 600, height: 180 });
  });
  it("excludes CSS-hidden text from the question", () => {
    const question = document.querySelectorAll(".question")[0];
    question.insertAdjacentHTML("afterbegin", '<span style="display:none">ignore-secret-answer</span>');
    expect(extractFromElement(question).stem).not.toContain("ignore-secret-answer");
  });
  it("excludes fully transparent text from the question", () => {
    const question = document.querySelectorAll(".question")[0];
    question.insertAdjacentHTML("afterbegin", '<span style="opacity:0">ignore-transparent-answer</span>');
    expect(extractFromElement(question).stem).not.toContain("ignore-transparent-answer");
  });
  it("routes a visually-dependent DOM question into recognition", () => {
    const question = document.querySelectorAll(".question")[0];
    question.querySelector("h2")!.textContent = "如图，正确的是？";
    question.insertAdjacentHTML("afterbegin", '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">');
    expect(extractFromElement(question).warnings).toContain("VISION_MODEL_REQUIRED");
  });
  it("keeps accessible image descriptions as question context", () => {
    const question = document.querySelectorAll(".question")[0];
    question.insertAdjacentHTML("afterbegin", '<img alt="三角形 ABC，底边为 4" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">');
    expect(extractFromElement(question).context).toContain("三角形 ABC");
  });
  it("uses ARIA labels when a question has no visible text nodes", () => {
    document.body.innerHTML = '<section aria-label="Which number is even?"><div role="radio" aria-label="A. 3"></div><div role="radio" aria-label="B. 4"></div></section>';
    const question = extractFromElement(document.querySelector("section")!);
    expect(question.stem).toBe("Which number is even?");
    expect(question.options.map((option) => option.text)).toEqual(["3", "4"]);
  });
  it("extracts table rows and infers explicit multi-select wording", () => {
    document.body.innerHTML = `<section class="question"><h2>多选题：选择所有正确项</h2><table><tbody><tr><td>A.</td><td>甲</td></tr><tr><td>B.</td><td>乙</td></tr></tbody></table></section>`;
    const question = extractFromElement(document.querySelector(".question")!);
    expect(question.questionType).toBe("multiple");
    expect(question.options.map((option) => option.text)).toEqual(["甲", "乙"]);
  });
  it("normalizes checkbox glyphs in DOM option labels", () => {
    document.body.innerHTML = `<section class="question"><h2>请选择所有偶数</h2><label><input type="checkbox">☐ A. 2</label><label><input type="checkbox">☑ B. 3</label></section>`;
    const question = extractFromElement(document.querySelector(".question")!);
    expect(question.options.map((option) => [option.label, option.text])).toEqual([["A", "2"], ["B", "3"]]);
    expect(question.questionType).toBe("multiple");
  });
  it("marks formula text without pretending it is image semantics", () => {
    const element = document.querySelectorAll(".question")[0];
    element.querySelector("h2")!.textContent = "sin(x) 的值是？";
    const question = extractFromElement(element);
    expect(question.warnings).toContain("POSSIBLE_FORMULA");
    expect(question.warnings).not.toContain("VISION_MODEL_REQUIRED");
  });
  it("detects formula markup that has no plain-text operator", () => {
    const element = document.querySelectorAll(".question")[0];
    element.querySelector("h2")!.innerHTML = "x<sup>2</sup> 的值是？";
    expect(extractFromElement(element).warnings).toContain("POSSIBLE_FORMULA");
  });
  it("excludes common advertisement containers from DOM text", () => {
    const element = document.querySelectorAll(".question")[0];
    element.insertAdjacentHTML("afterbegin", '<div class="advertisement">hidden sponsored answer</div><div data-ad="true">another ad</div>');
    expect(extractFromElement(element).stem).not.toContain("sponsored");
    expect(extractFromElement(element).stem).not.toContain("another ad");
  });
  it("marks chemistry and chart cues as visual dependencies when an image is present", () => {
    const element = document.querySelectorAll(".question")[0];
    element.querySelector("h2")!.textContent = "化学结构式对应的物质是？";
    element.insertAdjacentHTML("afterbegin", '<img alt="结构图" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">');
    expect(extractFromElement(element).warnings).toContain("VISION_MODEL_REQUIRED");
  });
  it("treats an unlabelled canvas as a visual dependency", () => {
    const element = document.querySelectorAll(".question")[0];
    element.insertAdjacentHTML("afterbegin", '<canvas width="200" height="100"></canvas>');
    expect(extractFromElement(element).warnings).toContain("VISION_MODEL_REQUIRED");
  });
  it("treats a selected visual root as a visual dependency", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    document.body.append(canvas);
    expect(extractFromElement(canvas).warnings).toContain("VISION_MODEL_REQUIRED");
  });
});
