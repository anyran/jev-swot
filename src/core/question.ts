import type { ExtractedQuestion, QuestionOption, RecognitionWarning } from "../shared/types";

const OPTION_RE = /^\s*(?:([A-Ha-h])|([1-9])|([①②③④⑤⑥⑦⑧⑨]))[.、)）:]\s*(.+)$/;
const FORMULA_RE = /[∑√∫≈≠≤≥^]|\b(?:sin|cos|tan|log)\b|\$[^$]+\$/i;
const DIAGRAM_RE = /(?:如图|下图|曲线|阴影|图表|diagram|graph|figure)/i;
const MULTIPLE_RE = /(?:多选|可多选|选择所有|所有正确|select all|multiple choice)/i;
const SINGLE_RE = /(?:单选|只能选择一项|判断题|single choice|true or false)/i;

export function stableOptionId(index: number): string { return `option_${index + 1}`; }

export function parseQuestionText(text: string, rect = { x: 0, y: 0, width: 0, height: 0 }): ExtractedQuestion {
  const lines = text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const options: QuestionOption[] = [];
  let firstOption = lines.length;
  lines.forEach((line, index) => {
    const match = OPTION_RE.exec(line);
    if (!match) return;
    firstOption = Math.min(firstOption, index);
    options.push({ id: stableOptionId(options.length), label: match[1]?.toUpperCase() || match[2] || match[3], text: match[4] });
  });
  const hasAlphabeticLabel = options.some((option) => /^[A-H]$/i.test(option.label));
  if (hasAlphabeticLabel) options.forEach((option, index) => {
    if (option.label === "4" && index === 0) option.label = "A";
    if (option.label === "8" && index === 1) option.label = "B";
  });
  const stem = lines.slice(0, firstOption).join("\n");
  const warnings: RecognitionWarning[] = [];
  if (!stem || options.length < 2) warnings.push("INCOMPLETE_OPTIONS");
  if (FORMULA_RE.test(text)) warnings.push("POSSIBLE_FORMULA");
  if (DIAGRAM_RE.test(text)) warnings.push("POSSIBLE_DIAGRAM");
  const questionType = MULTIPLE_RE.test(text) ? "multiple" : SINGLE_RE.test(text) ? "single" : "unknown";
  return { source: "local-ocr", questionType, stem, options, sourceRect: rect, recognitionConfidence: options.length >= 2 && stem ? 0.8 : 0.4, warnings };
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
  return errors;
}

export function inferVisualWarnings(text: string, textAreaRatio: number): RecognitionWarning[] {
  const warnings: RecognitionWarning[] = [];
  if (FORMULA_RE.test(text)) warnings.push("POSSIBLE_FORMULA");
  if (DIAGRAM_RE.test(text) && textAreaRatio < 0.45) warnings.push("POSSIBLE_DIAGRAM");
  return warnings;
}
