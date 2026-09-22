import type { ExtractedQuestion, OcrTextBox, QuestionOption, RecognitionWarning } from "../shared/types";

const OPTION_RE = /^\s*(?:(?:([A-Ha-h])(?:[.．、)）:]|\s+))|(?:([1-9]\d{0,2})[.．、)）:])|(?:([①②③④⑤⑥⑦⑧⑨])[.．、)）:]))\s*(.+)$/;
const MARKED_OPTION_RE = /^\s*(?:\[\s*[xX✓✔]?\s*\]|[☐☑□■○●◯◉◒✓✔])\s*(?:(?:([A-Ha-h])(?:[.．、)）:]|\s+))|(?:([1-9]\d{0,2})[.．、)）:])|(?:([①②③④⑤⑥⑦⑧⑨])[.．、)）:]))?\s*(.+)$/u;
const INLINE_OPTION_BOUNDARY_RE = /(?<![☐☑□■○●◯◉◒✓✔])\s+(?=(?:[（(]?[A-Ha-h][）)]?[.．、)）:]|[1-9]\d{0,2}[.．、)）:]|[①②③④⑤⑥⑦⑧⑨][.．、)）:]))/gu;
const FORMULA_RE = /[∑√∫≈≠≤≥±×÷∞∂∇∈∉∝→←↔^]|[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]|\b(?:sin|cos|tan|log|ln|lim)\b|\$[^$]+\$/i;
const DIAGRAM_RE = /(?:如图|下图|图中|曲线|折线|柱状|散点|阴影|面积|图表|统计图|几何|化学(?:结构|式)|结构式|分子|坐标(?:系|轴)?|示意图|diagram|graph|figure|chart|plot|axis|geometry|chemical\s+structure|molecule)/i;
const MULTIPLE_RE = /(?:多选|可多选|选择所有|所有正确|select all|multiple choice)/i;
const SINGLE_RE = /(?:单选|只能选择一项|判断题|single choice|true or false)/i;
const RESULT_ANNOTATION_RE = /(?:(?:正确答案|参考答案|答案解析|解析|得分|得分情况|你的答案|作答结果|提交结果|判定结果|correct\s+answer|reference\s+answer|answer\s+explanation|explanation|score|your\s+answer|submission\s+result|page\s+result)\s*(?:[:：]|是|为|is|was|=)|(?:我的答案|答案|my\s+answer|answer|result)\s*[:：=])/i;

export function stableOptionId(index: number): string { return `option_${index + 1}`; }
export function fallbackOptionLabel(index: number): string { return index < 26 ? String.fromCharCode(65 + index) : String(index + 1); }

/**
 * OCR engines frequently return two-column choices on one physical line, or
 * put a full-width parenthesized label in front of an option. Normalize those
 * cases before the structural parser sees the text.
 */
export function splitOptionLines(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const parts = line.split(INLINE_OPTION_BOUNDARY_RE).map((part) => part.trim()).filter(Boolean);
    return parts.length ? parts : [line.trim()];
  }).filter(Boolean);
}

/**
 * Parse one OCR/DOM line that may carry a conventional label or a checkbox /
 * radio glyph.  A glyph without an explicit label receives the next stable
 * fallback label so the caller can still present it for human confirmation.
 */
export function parseOptionLine(line: string, index: number): { label: string; text: string } | undefined {
  const normalized = line.replace(/^\s*[（(]([A-Ha-h])[）)]\s*/, "$1 ");
  const match = OPTION_RE.exec(normalized);
  const markedMatch = match ? undefined : MARKED_OPTION_RE.exec(normalized);
  if (match) return { label: match[1]?.toUpperCase() || match[2] || match[3]!, text: match[4] };
  if (markedMatch) return { label: markedMatch[1]?.toUpperCase() || markedMatch[2] || markedMatch[3] || fallbackOptionLabel(index), text: markedMatch[4] };
  return undefined;
}

export function parseQuestionText(text: string, rect = { x: 0, y: 0, width: 0, height: 0 }): ExtractedQuestion {
  const lines = splitOptionLines(text);
  const options: QuestionOption[] = [];
  let firstOption = lines.length;
  const stemLines: string[] = [];
  lines.forEach((line, index) => {
    const parsed = parseOptionLine(line, options.length);
    if (!parsed) {
      if (firstOption === lines.length) stemLines.push(line);
      else if (!RESULT_ANNOTATION_RE.test(line) && options.length) options[options.length - 1].text = `${options[options.length - 1].text} ${line}`.trim();
      return;
    }
    firstOption = Math.min(firstOption, index);
    options.push({ id: stableOptionId(options.length), label: parsed.label, text: parsed.text });
  });
  const hasAlphabeticLabel = options.some((option) => /^[A-H]$/i.test(option.label));
  if (hasAlphabeticLabel) options.forEach((option, index) => {
    if (option.label === "4" && index === 0) option.label = "A";
    if (option.label === "8" && index === 1) option.label = "B";
  });
  const stem = stemLines.join("\n");
  const warnings: RecognitionWarning[] = [];
  if (!stem || options.length < 2) warnings.push("INCOMPLETE_OPTIONS");
  if (FORMULA_RE.test(text)) warnings.push("POSSIBLE_FORMULA");
  if (DIAGRAM_RE.test(text)) warnings.push("POSSIBLE_DIAGRAM");
  const questionType = MULTIPLE_RE.test(text) ? "multiple" : SINGLE_RE.test(text) ? "single" : "unknown";
  return { source: "local-ocr", questionType, stem, options, sourceRect: rect, recognitionConfidence: options.length >= 2 && stem ? 0.8 : 0.4, warnings };
}

export interface OcrLine {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  boxes: OcrTextBox[];
}

/**
 * Reconstruct visual rows from PP-OCR boxes.  Passing each detected box as a
 * separate newline loses the distinction between a label and its option text
 * (for example, `A.` and `3`), which is the most common source of bad OCR
 * question boundaries.
 */
export function groupOcrBoxes(boxes: OcrTextBox[]): OcrLine[] {
  type Row = { boxes: OcrTextBox[]; top: number; bottom: number; center: number };
  const rows: Row[] = [];
  for (const box of [...boxes].filter((item) => item.text.trim()).sort((left, right) => left.y - right.y || left.x - right.x)) {
    const top = box.y, bottom = box.y + box.height, center = (top + bottom) / 2;
    let target: Row | undefined;
    let bestDistance = Infinity;
    for (const row of rows) {
      const overlap = Math.min(bottom, row.bottom) - Math.max(top, row.top);
      const minHeight = Math.min(box.height, row.bottom - row.top);
      const distance = Math.abs(center - row.center);
      if (overlap >= minHeight * 0.35 || distance <= Math.max(box.height, row.bottom - row.top) * 0.45) {
        if (distance < bestDistance) { target = row; bestDistance = distance; }
      }
    }
    if (!target) rows.push({ boxes: [box], top, bottom, center });
    else {
      target.boxes.push(box);
      target.top = Math.min(target.top, top);
      target.bottom = Math.max(target.bottom, bottom);
      target.center = (target.top + target.bottom) / 2;
    }
  }
  return rows.sort((left, right) => left.top - right.top).map((row, index) => {
    const ordered = row.boxes.sort((left, right) => left.x - right.x);
    const text = ordered.reduce((result, box, boxIndex) => {
      if (boxIndex === 0) return box.text.trim();
      const previous = ordered[boxIndex - 1].text.trim();
      return `${result}${ocrFragmentSeparator(previous, box.text, box.x - (ordered[boxIndex - 1].x + ordered[boxIndex - 1].width), Math.max(box.height, ordered[boxIndex - 1].height))}${box.text.trim()}`;
    }, "").trim();
    const x = Math.min(...ordered.map((box) => box.x)), right = Math.max(...ordered.map((box) => box.x + box.width));
    const confidence = ordered.reduce((sum, box) => sum + box.confidence, 0) / ordered.length;
    return { id: `line_${index + 1}`, text, x, y: row.top, width: right - x, height: row.bottom - row.top, confidence, boxes: ordered };
  });
}

function ocrFragmentSeparator(previous: string, next: string, gap: number, height: number): string {
  if (!previous || !next) return "";
  if (/^[.．、)）:：,，]$/.test(next) || /^[([{（「『]$/.test(next)) return "";
  if (/^[A-Ha-h]$|^\d{1,3}$/.test(previous) || /^[A-Ha-h]$|^\d{1,3}$/.test(next)) return " ";
  if (/[A-Za-z0-9]$/.test(previous) && /^[A-Za-z0-9]/.test(next)) return " ";
  if (gap > height * 0.65 && !/^[\u3400-\u9fff]/.test(next)) return " ";
  return "";
}

export function validateQuestion(question: ExtractedQuestion): string[] {
  const errors: string[] = [];
  if (!question.stem.trim()) errors.push("题干为空");
  if (question.questionType === "unknown") errors.push("请确认题目是单选还是多选");
  if (question.options.length < 2) errors.push("至少需要两个选项");
  if (question.options.length > 255) errors.push("选项不能超过 255 个");
  if (new Set(question.options.map((x) => x.id)).size !== question.options.length) errors.push("选项 ID 重复");
  if (question.options.some((x) => !x.label.trim())) errors.push("选项标签不能为空");
  if (new Set(question.options.map((x) => x.label.trim().toLocaleUpperCase())).size !== question.options.length) errors.push("选项标签重复");
  if (question.options.some((x) => !x.text.trim())) errors.push("选项内容不能为空");
  if (new Set(question.options.map((x) => x.text.trim().toLocaleLowerCase())).size !== question.options.length) errors.push("选项内容重复");
  return errors;
}

/**
 * Returns true when the text and option structure are sufficient to avoid a
 * screenshot/OCR pass.  The question type is deliberately not checked here:
 * a DOM-only question can be complete but still need the user to choose
 * single versus multiple choice in the correction editor.
 */
export function hasQuestionStructure(question: ExtractedQuestion): boolean {
  return validateQuestion(question).every((error) => error === "请确认题目是单选还是多选");
}

/**
 * Returns true when the DOM result is not safe to send directly to JEV.
 *
 * A complete DOM question can still contain a formula or a visual element
 * whose semantics are not represented by ordinary text.  Those cases must go
 * through the visual/OCR review path (or be explicitly corrected by the user)
 * instead of being treated as a plain-text question merely because it has two
 * labelled options.
 */
export function requiresRecognitionFallback(question: ExtractedQuestion): boolean {
  return !hasQuestionStructure(question) || question.warnings.some((warning) =>
    warning === "INCOMPLETE_OPTIONS" ||
    warning === "POSSIBLE_FORMULA" ||
    warning === "POSSIBLE_DIAGRAM" ||
    warning === "VISION_MODEL_REQUIRED"
  );
}

export function hasQuestionTextConflict(reference: ExtractedQuestion, candidate: ExtractedQuestion): boolean {
  if (reference.source !== "dom" || reference.options.length < 2 || candidate.options.length < 2) return false;
  const referenceStem = comparableText(reference.stem), candidateStem = comparableText(candidate.stem);
  if (referenceStem.length < 4 || candidateStem.length < 4) return false;
  const stemAgreement = textSimilarity(referenceStem, candidateStem);
  const matchingOptions = reference.options.filter((referenceOption) => candidate.options.some((candidateOption) => textSimilarity(comparableText(referenceOption.text), comparableText(candidateOption.text)) >= 0.45)).length;
  return stemAgreement < 0.8 && matchingOptions / Math.min(reference.options.length, candidate.options.length) < 0.5;
}

export function inferVisualWarnings(text: string, textAreaRatio: number): RecognitionWarning[] {
  const warnings: RecognitionWarning[] = [];
  if (FORMULA_RE.test(text)) warnings.push("POSSIBLE_FORMULA");
  if (DIAGRAM_RE.test(text) && textAreaRatio < 0.45) warnings.push("POSSIBLE_DIAGRAM");
  return warnings;
}

/**
 * Removes answer/result material from model-structured text while retaining a
 * valid question prefix when a page placed the result marker on the same line
 * as an option (for example, "B. 4 正确答案：B").
 */
export function stripExcludedText(value: string, ignoredText = ""): string {
  const ignored = ignoredText.split(/[\r\n；;]+/).map((fragment) => comparableModelText(fragment)).filter((fragment) => fragment.length >= 4);
  return value.split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    const resultMarker = RESULT_ANNOTATION_RE.exec(line);
    const questionPart = resultMarker ? line.slice(0, resultMarker.index).trim() : line;
    const comparable = comparableModelText(questionPart);
    if (!comparable) return false;
    return !ignored.some((fragment) => comparable.includes(fragment));
  }).map((line) => {
    const resultMarker = RESULT_ANNOTATION_RE.exec(line);
    return (resultMarker ? line.slice(0, resultMarker.index) : line).trim();
  }).filter(Boolean).join("\n").trim();
}

/**
 * Keep the DOM fast path from carrying review-page result annotations into
 * JEV. OCR and vision paths already pass through model-led normalization; this
 * conservative sanitizer gives complete DOM questions the same boundary while
 * leaving user-edited text untouched.
 */
export function sanitizeDomQuestion(question: ExtractedQuestion): ExtractedQuestion {
  if (question.source !== "dom") return question;
  const stem = stripExcludedText(question.stem);
  const context = question.context == null ? question.context : stripExcludedText(question.context);
  const options = question.options.map((option) => ({ ...option, text: stripExcludedText(option.text) }));
  return { ...question, stem, context, options };
}

function comparableText(value: string): string { return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); }
function comparableModelText(value: string): string { return value.toLocaleLowerCase().replace(/\s+/g, "").replace(/[，。！？、:：;；]+$/u, ""); }
function textSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left.includes(right) || right.includes(left)) return 1;
  const grams = (value: string) => new Set([...value].map((_, index) => value.slice(index, index + 2)).filter((gram) => gram.length === 2));
  const leftGrams = grams(left), rightGrams = grams(right); if (!leftGrams.size || !rightGrams.size) return left === right ? 1 : 0;
  let intersection = 0; for (const gram of leftGrams) if (rightGrams.has(gram)) intersection++;
  return (2 * intersection) / (leftGrams.size + rightGrams.size);
}
