import { stableOptionId } from "../core/question";
import type { ExtractedQuestion, QuestionOption } from "../shared/types";

const EXCLUDED = "script,style,noscript,nav,header,footer,[hidden],[aria-hidden='true'],[data-jevanswer-root]";
function visible(element: Element): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}
function rectOf(element: Element) { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }
function cleanText(text: string): string { return text.replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(); }

export function findQuestionContainer(start: Element): Element {
  let current: Element | null = start;
  let best = start;
  let bestScore = -Infinity;
  for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
    if (current.matches(EXCLUDED)) continue;
    const text = cleanText((current as HTMLElement).innerText || current.textContent || "");
    const controls = current.querySelectorAll("input[type=radio],input[type=checkbox]").length;
    const lists = current.querySelectorAll("li,label").length;
    const images = current.querySelectorAll("img,canvas,svg").length;
    const rect = current.getBoundingClientRect();
    const oversize = rect.height > innerHeight * 1.8 || text.length > 5000 ? 20 : 0;
    const score = Math.min(text.length, 1000) / 100 + controls * 8 + Math.min(lists, 8) * 2 + images * 2 - depth - oversize;
    if (text.length >= 10 && score > bestScore) { best = current; bestScore = score; }
  }
  return best;
}

export function extractFromElement(element: Element): ExtractedQuestion {
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(EXCLUDED).forEach((node) => node.remove());
  const controls = [...element.querySelectorAll<HTMLInputElement>("input[type=radio],input[type=checkbox]")].filter(visible);
  const optionElements = controls.length
    ? controls.map((input) => input.closest("label") ?? (input.id ? element.querySelector(`label[for='${CSS.escape(input.id)}']`) : null) ?? input.parentElement).filter(Boolean) as Element[]
    : [...element.querySelectorAll("li,label,[role=radio],[role=checkbox]")].filter(visible);
  const dedup = [...new Set(optionElements)];
  const options: QuestionOption[] = dedup.map((node, index) => {
    const raw = cleanText((node as HTMLElement).innerText || node.textContent || "");
    const match = /^\s*([A-Ha-h]|[1-9]|[①②③④⑤⑥⑦⑧⑨])[.、)）:]?\s*(.*)$/.exec(raw);
    return { id: stableOptionId(index), label: match?.[1]?.toUpperCase() ?? String.fromCharCode(65 + index), text: match?.[2] || raw };
  }).filter((x) => x.text);
  const allText = cleanText(clone.innerText || clone.textContent || "");
  let stem = allText;
  for (const option of options) {
    const position = stem.indexOf(option.text);
    if (position > 0) { stem = stem.slice(0, position); break; }
  }
  stem = cleanText(stem.replace(/\s*[A-H][.、)）:]?\s*$/, ""));
  const hasCheckbox = controls.some((input) => input.type === "checkbox");
  const hasRadio = controls.some((input) => input.type === "radio");
  return {
    source: "dom", questionType: hasCheckbox ? "multiple" : hasRadio ? "single" : "unknown",
    stem, options, sourceRect: rectOf(element), recognitionConfidence: stem && options.length >= 2 ? 0.95 : 0.45,
    warnings: stem && options.length >= 2 ? [] : ["INCOMPLETE_OPTIONS"]
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
