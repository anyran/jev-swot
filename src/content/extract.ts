import type { ExtractedQuestion, QuestionOption, RecognitionWarning } from "../shared/types";

const EXCLUDED = "script,style,noscript,nav,header,footer,aside,iframe,[role='banner'],[role='navigation'],[role='complementary'],[hidden],[aria-hidden='true'],[data-jev-swot-root],[data-ad],[data-advertisement],[aria-label*='advertisement' i],[aria-label*='广告'],[class~='ad'],[class*=' ad-'],[class^='ad-'],[class*='advertisement' i],[id*='advertisement' i]";
const VISUAL_CUE = /(?:如图|下图|图中|曲线|折线|柱状|散点|阴影|面积|图表|统计图|几何|化学(?:结构|式)|结构式|分子|坐标(?:系|轴)?|示意图|diagram|graph|figure|chart|plot|axis|geometry|chemical\s+structure|molecule)/i;
const FORMULA_CUE = /[∑√∫≈≠≤≥±×÷∞∂∇∈∉∝→←↔^]|[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]|\b(?:sin|cos|tan|log|ln|lim)\b|\$[^$]+\$/i;
const MULTIPLE_CUE = /(?:多选|可多选|选择所有|所有正确|select all|multiple choice)/i;
const SINGLE_CUE = /(?:单选|只能选择一项|判断题|single choice|true or false)/i;
function visible(element: Element): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}
function rectOf(element: Element) { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }
function cleanText(text: string): string { return text.replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(); }
function isOptionNode(node: Element): boolean {
  if (!visible(node)) return false;
  if (!node.matches("tr")) return true;
  const cells = node.querySelectorAll("td,th");
  return cells.length >= 2 && !node.querySelector("th:first-child");
}
function visibleText(element: Element): string {
  const pieces: string[] = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest(EXCLUDED) || !visible(parent)) continue;
    const value = node.textContent?.trim(); if (value) pieces.push(value);
  }
  return cleanText(pieces.join("\n") || element.getAttribute("aria-label") || element.getAttribute("title") || "");
}

export function findQuestionContainer(start: Element): Element {
  let current: Element | null = start;
  let best = start;
  let bestScore = -Infinity;
  for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
    if (current.matches(EXCLUDED)) continue;
    const text = cleanText((current as HTMLElement).innerText || current.textContent || "");
    const controls = current.querySelectorAll("input[type=radio],input[type=checkbox]").length;
    const lists = current.querySelectorAll("li,label").length;
    const semanticOptions = current.querySelectorAll("[role=radio],[role=checkbox],[role=option],tr").length;
    const images = current.querySelectorAll("img,canvas,svg").length;
    const rect = current.getBoundingClientRect();
    const oversize = current === document.body || current === document.documentElement || rect.height > innerHeight * 1.8 || rect.width > innerWidth * 1.2 || text.length > 5000 ? 100 : 0;
    // Prefer the nearest self-contained question group.  A page with several
    // questions should not win merely because its aggregate option count is
    // larger than the group under the pointer.
    if (depth > 0 && text.length >= 10 && oversize === 0 && (controls >= 2 || lists >= 2 || semanticOptions >= 2)) return current;
    const score = Math.min(text.length, 1000) / 100 + Math.min(controls, 8) * 8 + Math.min(lists, 8) * 2 + Math.min(images, 4) * 2 - depth - oversize;
    if (text.length >= 10 && score > bestScore) { best = current; bestScore = score; }
  }
  return best;
}

export function extractFromElement(element: Element): ExtractedQuestion {
  const controls = [...element.querySelectorAll<HTMLInputElement>("input[type=radio],input[type=checkbox]")].filter(visible);
  const optionElements = controls.length
    ? controls.map((input) => input.closest("label") ?? (input.id ? element.querySelector(`label[for='${CSS.escape(input.id)}']`) : null) ?? input.parentElement).filter(Boolean) as Element[]
    : [...element.querySelectorAll("li,label,[role=radio],[role=checkbox],[role=option],tr")].filter(isOptionNode);
  const dedup = [...new Set(optionElements)];
  const options: QuestionOption[] = dedup.map((node, index) => {
    const raw = cleanText(visibleText(node) || node.getAttribute("aria-label") || node.getAttribute("title") || node.querySelector("input, [role=radio], [role=checkbox], [role=option]")?.getAttribute("aria-label") || "");
    const match = /^\s*([A-Ha-h]|[1-9]\d{0,2}|[①②③④⑤⑥⑦⑧⑨])(?:[.、)）:]|\s+)\s*(.*)$/.exec(raw);
    return { id: `option_${index + 1}`, label: match?.[1]?.toUpperCase() ?? String.fromCharCode(65 + index), text: match?.[2] || raw };
  }).filter((x) => x.text);
  const allText = visibleText(element);
  let stem = allText;
  for (const option of options) {
    const position = stem.indexOf(option.text);
    if (position > 0) { stem = stem.slice(0, position); break; }
  }
  stem = cleanText(stem.replace(/\s*[A-H][.、)）:]?\s*$/, ""));
  const hasCheckbox = controls.some((input) => input.type === "checkbox");
  const hasRadio = controls.some((input) => input.type === "radio");
  const hasCheckboxRole = !!element.querySelector("[role=checkbox]");
  const hasRadioRole = !!element.querySelector("[role=radio]");
  const questionType = hasCheckbox || hasCheckboxRole ? "multiple" : hasRadio || hasRadioRole ? "single" : MULTIPLE_CUE.test(allText) ? "multiple" : SINGLE_CUE.test(allText) ? "single" : "unknown";
  const visualElements = [...element.querySelectorAll("img,canvas,svg")].filter(visible);
  const imageContext = visualElements.map((image) => image.getAttribute("alt") || image.getAttribute("aria-label") || image.getAttribute("title") || "").map(cleanText).filter(Boolean).join("\n");
  const hasUnlabelledVisual = visualElements.some((image) => !cleanText(image.getAttribute("alt") || image.getAttribute("aria-label") || image.getAttribute("title") || ""));
  const hasRelevantVisual = visualElements.length > 0 && (VISUAL_CUE.test(`${allText}\n${imageContext}`) || hasUnlabelledVisual);
  const hasFormulaMarkup = !!element.querySelector("math,msup,msub,sup,sub,[class*='katex' i],[class*='mathjax' i]");
  const warnings: RecognitionWarning[] = stem && options.length >= 2 ? [] : ["INCOMPLETE_OPTIONS"];
  if (FORMULA_CUE.test(allText) || hasFormulaMarkup) warnings.push("POSSIBLE_FORMULA");
  if (hasRelevantVisual) warnings.push("POSSIBLE_DIAGRAM", "VISION_MODEL_REQUIRED");
  return {
    source: "dom", questionType,
    stem, options, context: imageContext || undefined, sourceRect: rectOf(element), recognitionConfidence: stem && options.length >= 2 ? 0.95 : 0.45,
    warnings
  };
}

export function elementFromRect(rect: { x: number; y: number; width: number; height: number }): Element {
  const center = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  if (!center) return document.body;
  let current: Element = center;
  while (current.parentElement) {
    const r = current.getBoundingClientRect();
    if (r.x <= rect.x && r.y <= rect.y && r.right >= rect.x + rect.width && r.bottom >= rect.y + rect.height) return current;
    current = current.parentElement;
  }
  return center;
}
