import type { ExtractedQuestion, QuestionOption, RecognitionWarning } from "../shared/types";

const EXCLUDED = "script,style,noscript,nav,header,footer,aside,iframe,[role='banner'],[role='navigation'],[role='complementary'],[hidden],[aria-hidden='true'],[data-jev-swot-root],[data-ad],[data-advertisement],[aria-label*='advertisement' i],[aria-label*='广告'],[class~='ad'],[class*=' ad-'],[class^='ad-'],[class*='advertisement' i],[id*='advertisement' i]";
const VISUAL_CUE = /(?:如图|下图|图中|曲线|折线|柱状|散点|阴影|面积|图表|统计图|几何|化学(?:结构|式)|结构式|分子|坐标(?:系|轴)?|示意图|diagram|graph|figure|chart|plot|axis|geometry|chemical\s+structure|molecule)/i;
const FORMULA_CUE = /[∑√∫≈≠≤≥±×÷∞∂∇∈∉∝→←↔^]|[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]|\b(?:sin|cos|tan|log|ln|lim)\b|\$[^$]+\$/i;
const MULTIPLE_CUE = /(?:多选|可多选|选择所有|所有正确|select all|multiple choice)/i;
const SINGLE_CUE = /(?:单选|只能选择一项|判断题|single choice|true or false)/i;
// Keep this tiny parser local: the content entry must remain a classic,
// self-contained MV3 script.  It mirrors core/question.ts, which is used by
// OCR and the background worker.
const OPTION_RE = /^\s*(?:(?:([A-Ha-h])(?:[.．、)）:]|\s+))|(?:([1-9]\d{0,2})[.．、)）:])|(?:([①②③④⑤⑥⑦⑧⑨])[.．、)）:]))\s*(.+)$/;
const MARKED_OPTION_RE = /^\s*(?:\[\s*[xX✓✔]?\s*\]|[☐☑□■○●◯◉◒✓✔])\s*(?:(?:([A-Ha-h])(?:[.．、)）:]|\s+))|(?:([1-9]\d{0,2})[.．、)）:])|(?:([①②③④⑤⑥⑦⑧⑨])[.．、)）:]))?\s*(.+)$/u;
function fallbackOptionLabel(index: number): string { return index < 26 ? String.fromCharCode(65 + index) : String(index + 1); }
function parseOptionLine(line: string, index: number): { label: string; text: string } | undefined {
  const normalized = line.replace(/^\s*[（(]([A-Ha-h])[）)]\s*/, "$1 ");
  const match = OPTION_RE.exec(normalized), markedMatch = match ? undefined : MARKED_OPTION_RE.exec(normalized);
  if (match) return { label: match[1]?.toUpperCase() || match[2] || match[3]!, text: match[4] };
  if (markedMatch) return { label: markedMatch[1]?.toUpperCase() || markedMatch[2] || markedMatch[3] || fallbackOptionLabel(index), text: markedMatch[4] };
  return undefined;
}
function visible(element: Element): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
}
function rectOf(element: Element) { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }
function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}
function composedTextParent(node: Text): Element | null {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}
function composedContains(ancestor: Element, node: Element): boolean {
  for (let current: Element | null = node; current; current = composedParent(current)) if (current === ancestor) return true;
  return false;
}
function isExcluded(element: Element): boolean {
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (current.matches(EXCLUDED)) return true;
  }
  return false;
}
function queryComposedAll<T extends Element>(root: Element, selector: string): T[] {
  const results = new Set<Element>();
  const visit = (container: Element | ShadowRoot) => {
    container.querySelectorAll(selector).forEach((element) => results.add(element));
    const hosts = [...container.querySelectorAll<Element>("*")];
    if (container instanceof Element) hosts.unshift(container);
    for (const host of hosts) if (host.shadowRoot) visit(host.shadowRoot);
  };
  visit(root);
  return [...results] as T[];
}
function textNodesIncludingOpenShadowRoots(root: Element): Text[] {
  const results: Text[] = [];
  const visit = (container: Element | ShadowRoot) => {
    const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) if (node instanceof Text) results.push(node);
    const hosts = [...container.querySelectorAll<Element>("*")];
    if (container instanceof Element) hosts.unshift(container);
    for (const host of hosts) if (host.shadowRoot) visit(host.shadowRoot);
  };
  visit(root);
  return results;
}
function isScrollable(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  const vertical = /^(auto|scroll|overlay)$/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
  const horizontal = /^(auto|scroll|overlay)$/.test(style.overflowX) && element.scrollWidth > element.clientWidth;
  return vertical || horizontal;
}
function pageRectOf(element: Element, scrollOffset: { x: number; y: number }) {
  const rect = rectOf(element);
  let x = rect.x + scrollOffset.x, y = rect.y + scrollOffset.y;
  // Overflow descendants move in viewport coordinates as they are traversed.
  // Add ancestor offsets back so page-space coordinates remain stable.
  for (let parent = composedParent(element); parent; parent = composedParent(parent)) {
    if (isScrollable(parent)) { x += parent.scrollLeft; y += parent.scrollTop; }
  }
  return { ...rect, x, y };
}
function cleanText(text: string): string { return text.replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(); }
function isOptionNode(node: Element): boolean {
  if (!visible(node)) return false;
  if (!node.matches("tr")) return true;
  const cells = node.querySelectorAll("td,th");
  return cells.length >= 2 && !node.querySelector("th:first-child");
}
function intersects(element: Element, clip?: { x: number; y: number; width: number; height: number }): boolean {
  if (!clip) return true;
  const rect = element.getBoundingClientRect();
  const right = Number.isFinite(rect.right) ? rect.right : rect.x + rect.width;
  const bottom = Number.isFinite(rect.bottom) ? rect.bottom : rect.y + rect.height;
  return right > clip.x && rect.x < clip.x + clip.width && bottom > clip.y && rect.y < clip.y + clip.height;
}

function textIntersects(node: Node, clip?: { x: number; y: number; width: number; height: number }): boolean {
  if (!clip) return true;
  const parent = node.parentElement ?? (node instanceof Text ? composedTextParent(node) : null);
  if (!parent) return false;
  try {
    const range = (node.ownerDocument ?? document).createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width || rect.height) {
      const right = Number.isFinite(rect.right) ? rect.right : rect.x + rect.width;
      const bottom = Number.isFinite(rect.bottom) ? rect.bottom : rect.y + rect.height;
      return right > clip.x && rect.x < clip.x + clip.width && bottom > clip.y && rect.y < clip.y + clip.height;
    }
  } catch {
    // Some browser-generated text nodes do not expose a measurable Range.
  }
  return intersects(parent, clip);
}

function visibleText(element: Element, clip?: { x: number; y: number; width: number; height: number }): string {
  const pieces: string[] = [];
  const debugNodes = textNodesIncludingOpenShadowRoots(element);
  for (const node of debugNodes) {
    const parent = composedTextParent(node);
    if (!parent || isExcluded(parent) || !visible(parent) || !textIntersects(node, clip)) continue;
    const value = node.textContent?.trim(); if (value) pieces.push(value);
  }
  if (pieces.length) return cleanText(pieces.join("\n"));
  if (clip && !intersects(element, clip)) return "";
  return cleanText(element.getAttribute("aria-label") || element.getAttribute("title") || "");
}

function visibleTextExcept(element: Element, excluded: Element[], clip?: { x: number; y: number; width: number; height: number }): string {
  const pieces: string[] = [];
  for (const node of textNodesIncludingOpenShadowRoots(element)) {
    const parent = composedTextParent(node);
    if (!parent || excluded.some((candidate) => candidate !== element && composedContains(candidate, parent)) || isExcluded(parent) || !visible(parent) || !textIntersects(node, clip)) continue;
    const value = node.textContent?.trim(); if (value) pieces.push(value);
  }
  return cleanText(pieces.join("\n"));
}

export function findQuestionContainer(start: Element): Element {
  let current: Element | null = start;
  let best = start;
  let bestScore = -Infinity;
  for (let depth = 0; current && depth < 8; depth++, current = composedParent(current)) {
    if (isExcluded(current)) continue;
    const text = visibleText(current);
    const controls = queryComposedAll(current, "input[type=radio],input[type=checkbox]").length;
    const lists = queryComposedAll(current, "li,label").length;
    const semanticOptions = queryComposedAll(current, "[role=radio],[role=checkbox],[role=option],tr").length;
    const images = queryComposedAll(current, "img,canvas,svg").length;
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

export interface PageQuestionCandidate {
  element: Element;
  question: ExtractedQuestion;
}

const PAGE_QUESTION_SELECTORS = [
  "[data-question]", "[data-question-id]", "[data-testid*='question' i]",
  "[class*='question' i]", "[id*='question' i]", "[class*='problem' i]", "[id*='problem' i]",
  "[role='radiogroup']", "fieldset", "form", "section", "article"
].join(",");
const PAGE_OPTION_SELECTORS = "input[type=radio],input[type=checkbox],[role=radio],[role=checkbox],[role=option],li,label,tr";

/**
 * Finds every independently identifiable question in the current document,
 * including rendered DOM nodes outside the viewport. It deliberately returns
 * the smallest valid question roots so a page wrapper containing several
 * questions is never flattened into one probability distribution.
 */
export function extractPageQuestions(root: Element = document.body, scrollOffset = { x: 0, y: 0 }): PageQuestionCandidate[] {
  const candidates = new Set<Element>();
  if (root.matches(PAGE_QUESTION_SELECTORS)) candidates.add(root);
  queryComposedAll(root, PAGE_QUESTION_SELECTORS).forEach((element) => candidates.add(element));
  queryComposedAll(root, PAGE_OPTION_SELECTORS).forEach((anchor) => {
    if (!visible(anchor) || isExcluded(anchor)) return;
    const questionRoot = findQuestionContainer(anchor);
    if (questionRoot !== root && !composedContains(root, questionRoot)) return;
    candidates.add(questionRoot);
  });

  const extracted = [...candidates]
    .filter((element) => !isExcluded(element) && visible(element))
    .map((element) => ({ element, question: extractFromElement(element) }))
    .filter(({ question }) => question.stem.trim().length > 0 && question.options.length >= 2);

  const roots = extracted.filter((candidate) => !extracted.some((other) =>
    other.element !== candidate.element && composedContains(candidate.element, other.element)
  ));
  const seen = new Set<string>();
  const results: PageQuestionCandidate[] = [];
  for (const candidate of roots) {
    const question = candidate.question;
    const pageRect = pageRectOf(candidate.element, scrollOffset);
    const offsetX = pageRect.x - question.sourceRect.x, offsetY = pageRect.y - question.sourceRect.y;
    const fingerprint = [normalizeFingerprint(question.stem), ...question.options.map((option) => `${option.label}:${normalizeFingerprint(option.text)}`)].join("|");
    const key = `${fingerprint}|${Math.round(pageRect.x)}|${Math.round(pageRect.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      element: candidate.element,
      question: {
        ...question,
        coordinateSpace: "document",
        sourceRect: pageRect,
        options: question.options.map((option) => option.sourceRect ? {
          ...option,
          sourceRect: { ...option.sourceRect, x: option.sourceRect.x + offsetX, y: option.sourceRect.y + offsetY }
        } : option)
      }
    });
  }

  if (results.length) return results.sort((left, right) => left.question.sourceRect.y - right.question.sourceRect.y || left.question.sourceRect.x - right.question.sourceRect.x);

  const fallback = extractFromElement(root);
  return fallback.stem.trim().length > 0 && fallback.options.length >= 2
    ? (() => {
      const pageRect = pageRectOf(root, scrollOffset);
      const offsetX = pageRect.x - fallback.sourceRect.x, offsetY = pageRect.y - fallback.sourceRect.y;
      return [{ element: root, question: {
        ...fallback,
        coordinateSpace: "document",
        sourceRect: pageRect,
        options: fallback.options.map((option) => option.sourceRect ? {
          ...option,
          sourceRect: { ...option.sourceRect, x: option.sourceRect.x + offsetX, y: option.sourceRect.y + offsetY }
        } : option)
      } }];
    })()
    : [];
}

function normalizeFingerprint(value: string): string {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "").toLocaleLowerCase();
}

export function extractFromElement(element: Element, clip?: { x: number; y: number; width: number; height: number }): ExtractedQuestion {
  const controls = queryComposedAll<HTMLInputElement>(element, "input[type=radio],input[type=checkbox]").filter((input) => visible(input) && intersects(input, clip));
  const optionElements = controls.length
    ? controls.map((input) => input.closest("label") ?? (input.id ? queryComposedAll(element, `label[for='${CSS.escape(input.id)}']`).find((label) => label.ownerDocument === input.ownerDocument) : null) ?? composedParent(input)).filter(Boolean) as Element[]
    : queryComposedAll(element, "li,label,[role=radio],[role=checkbox],[role=option],tr").filter((node) => isOptionNode(node) && intersects(node, clip));
  const dedup = [...new Set(optionElements)];
  const options: QuestionOption[] = dedup.map((node, index) => {
    const raw = cleanText(visibleText(node, clip) || node.getAttribute("aria-label") || node.getAttribute("title") || queryComposedAll(node, "input, [role=radio], [role=checkbox], [role=option]")[0]?.getAttribute("aria-label") || "");
    const parsed = parseOptionLine(raw, index);
    return { id: `option_${index + 1}`, label: parsed?.label ?? fallbackOptionLabel(index), text: parsed?.text || raw, sourceRect: rectOf(node) };
  }).filter((x) => x.text);
  const allText = visibleText(element, clip);
  let stem = visibleTextExcept(element, dedup, clip) || allText;
  if (stem === allText) for (const option of options) {
    const position = stem.indexOf(option.text);
    if (position > 0) { stem = stem.slice(0, position); break; }
  }
  stem = cleanText(stem.replace(/\s*[A-H][.、)）:]?\s*$/, ""));
  const hasCheckbox = controls.some((input) => input.type === "checkbox");
  const hasRadio = controls.some((input) => input.type === "radio");
  const hasCheckboxRole = queryComposedAll(element, "[role=checkbox]").length > 0;
  const hasRadioRole = queryComposedAll(element, "[role=radio]").length > 0;
  const questionType = hasCheckbox || hasCheckboxRole ? "multiple" : hasRadio || hasRadioRole ? "single" : MULTIPLE_CUE.test(allText) ? "multiple" : SINGLE_CUE.test(allText) ? "single" : "unknown";
  const visualElements = (element.matches("img,canvas,svg") ? [element, ...queryComposedAll(element, "img,canvas,svg")] : queryComposedAll(element, "img,canvas,svg")).filter((image) => visible(image) && intersects(image, clip));
  const imageContext = visualElements.map((image) => image.getAttribute("alt") || image.getAttribute("aria-label") || image.getAttribute("title") || "").map(cleanText).filter(Boolean).join("\n");
  const hasUnlabelledVisual = visualElements.some((image) => !cleanText(image.getAttribute("alt") || image.getAttribute("aria-label") || image.getAttribute("title") || ""));
  const hasRelevantVisual = visualElements.length > 0 && (VISUAL_CUE.test(`${allText}\n${imageContext}`) || hasUnlabelledVisual);
  const hasFormulaMarkup = element.matches("math,msup,msub,sup,sub,[class*='katex' i],[class*='mathjax' i]") || queryComposedAll(element, "math,msup,msub,sup,sub,[class*='katex' i],[class*='mathjax' i]").length > 0;
  const warnings: RecognitionWarning[] = stem && options.length >= 2 ? [] : ["INCOMPLETE_OPTIONS"];
  if (FORMULA_CUE.test(allText) || hasFormulaMarkup) warnings.push("POSSIBLE_FORMULA");
  if (hasRelevantVisual) warnings.push("POSSIBLE_DIAGRAM", "VISION_MODEL_REQUIRED");
  return {
    source: "dom", questionType,
    stem, options, context: imageContext || undefined, sourceRect: clip ?? rectOf(element), recognitionConfidence: stem && options.length >= 2 ? 0.95 : 0.45,
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
