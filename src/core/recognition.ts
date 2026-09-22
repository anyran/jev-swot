import type { StructuredQuestionResult } from "./llm";
import { fallbackOptionLabel, stableOptionId, stripExcludedText } from "./question";
import type { ExtractedQuestion } from "../shared/types";

export function normalizeParsed(parsed: Partial<ExtractedQuestion> & { ignoredText?: string }, base: ExtractedQuestion, source: "vision" | "local-ocr", confidence: number): ExtractedQuestion {
  const modelSuppliedOptions = Array.isArray(parsed.options);
  const candidateOptions = (Array.isArray(parsed.options) ? parsed.options : [])
    .filter((option) => option && typeof option === "object" && typeof option.text === "string")
    .map((option) => ({ ...option, text: stripExcludedText(option.text, parsed.ignoredText) }))
    .filter((option) => option.text);
  const options = (modelSuppliedOptions ? candidateOptions : base.options).map((option, index) => ({
    id: stableOptionId(index),
    label: typeof option.label === "string" && option.label.trim() ? option.label.trim().toUpperCase() : fallbackOptionLabel(index),
    text: option.text.trim(),
    confidence: option.confidence
  }));
  const visualDependency = parsed.visualDependency === true || base.visualDependency === true;
  const visualDependencyReason = typeof parsed.visualDependencyReason === "string" ? stripExcludedText(parsed.visualDependencyReason, parsed.ignoredText) || base.visualDependencyReason : base.visualDependencyReason;
  const modelContext = typeof parsed.context === "string" ? stripExcludedText(parsed.context, parsed.ignoredText) : "";
  const contextParts = [modelContext || base.context?.trim() || ""];
  if (visualDependencyReason && !contextParts[0].includes(visualDependencyReason)) contextParts.push(`视觉信息：${visualDependencyReason}`);
  const normalizedStem = typeof parsed.stem === "string" ? stripExcludedText(parsed.stem, parsed.ignoredText) : base.stem;
  const modelReplacedIncompleteStructure = modelSuppliedOptions && candidateOptions.length >= 2 && !!normalizedStem;
  const warnings = [...base.warnings.filter((warning) =>
    !(modelReplacedIncompleteStructure && warning === "INCOMPLETE_OPTIONS") &&
    !(source === "vision" && warning === "VISION_MODEL_REQUIRED")
  ), ...(Array.isArray(parsed.warnings) ? parsed.warnings.filter(isRecognitionWarning) : [])];
  if (modelSuppliedOptions && candidateOptions.length < 2) warnings.push("INCOMPLETE_OPTIONS");
  if (typeof parsed.stem === "string" && !parsed.stem.trim()) warnings.push("INCOMPLETE_OPTIONS");
  if (visualDependency) warnings.push("POSSIBLE_DIAGRAM");
  if (source === "local-ocr" && visualDependency) warnings.push("VISION_MODEL_REQUIRED");
  if (source === "vision" && visualDependency && !contextParts.some((part) => part.trim())) warnings.push("STRUCTURE_REVIEW_REQUIRED");
  const questionType = parsed.questionType === "single" || parsed.questionType === "multiple" || parsed.questionType === "unknown" ? parsed.questionType : base.questionType;
  return {
    ...base,
    source,
    questionType,
    stem: normalizedStem,
    context: contextParts.filter(Boolean).join("\n"),
    options,
    recognitionConfidence: confidence,
    warnings: [...new Set(warnings)],
    visualDependency,
    visualDependencyReason
  };
}

export function hasStructuredQuestionFields(parsed: StructuredQuestionResult): boolean {
  return (parsed.questionType === "single" || parsed.questionType === "multiple" || parsed.questionType === "unknown")
    && typeof parsed.stem === "string"
    && Array.isArray(parsed.options)
    && typeof parsed.context === "string"
    && typeof parsed.visualDependency === "boolean"
    && typeof parsed.visualDependencyReason === "string"
    // The fallback json_object/plain-JSON path does not enforce the schema.
    // Require the exclusion ledger explicitly so a successful HTTP response
    // cannot be mistaken for proof that answer/result text was separated.
    && typeof parsed.ignoredText === "string";
}

function isRecognitionWarning(value: unknown): value is ExtractedQuestion["warnings"][number] {
  return value === "LOW_OCR_CONFIDENCE" || value === "POSSIBLE_FORMULA" || value === "POSSIBLE_DIAGRAM" || value === "INCOMPLETE_OPTIONS" || value === "VISION_MODEL_REQUIRED" || value === "VISION_MODEL_UNSUPPORTED" || value === "VISION_SERVICE_UNAVAILABLE" || value === "DOM_OCR_CONFLICT" || value === "STRUCTURE_REVIEW_REQUIRED";
}
