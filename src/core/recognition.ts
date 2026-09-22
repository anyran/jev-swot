import type { StructuredQuestionResult } from "./llm";
import { fallbackOptionLabel, groupOcrBoxes, parseOptionLine, parseQuestionText, splitOptionLines, stableOptionId, stripExcludedText, type OcrLine } from "./question";
import type { ExtractedQuestion, OcrTextBox } from "../shared/types";

type StructuredOption = { id?: string; label?: unknown; text?: unknown; confidence?: unknown };
type StructuredWithEvidence = Omit<Partial<ExtractedQuestion>, "options"> & {
  options?: StructuredOption[];
  ignoredText?: string;
  stemLineIds?: string[];
  optionLineIds?: string[];
  ignoredLineIds?: string[];
};

type BoundaryEvidence = {
  lines: OcrLine[];
  stemLineIds: string[];
  optionLineIds: string[];
  ignoredLineIds: string[];
};

/**
 * Normalize model output without letting a text-only model invent a new
 * question boundary.  For local OCR, the model is only trusted to classify
 * OCR rows; the final stem/options are rebuilt from those rows below.
 */
export function normalizeParsed(parsed: StructuredWithEvidence, base: ExtractedQuestion, source: "vision" | "local-ocr", confidence: number, ocrBoxes: OcrTextBox[] = []): ExtractedQuestion {
  const evidence = source === "local-ocr" ? getBoundaryEvidence(parsed, ocrBoxes) : undefined;
  const useModelStructure = source !== "local-ocr" || !!evidence;
  const modelSuppliedOptions = Array.isArray(parsed.options);
  const candidateOptions = (Array.isArray(parsed.options) ? parsed.options : [])
    .filter((option): option is StructuredOption & { text: string } => !!option && typeof option === "object" && typeof option.text === "string")
    .map((option) => ({ ...option, text: stripExcludedText(option.text, parsed.ignoredText) }))
    .filter((option) => option.text);
  const modelBoundaryText = [typeof parsed.stem === "string" ? parsed.stem : "", ...candidateOptions.map((option) => `${typeof option.label === "string" ? option.label : ""}. ${option.text}`)].filter(Boolean).join("\n");
  const repaired = source === "local-ocr" && !evidence && modelBoundaryText ? parseQuestionText(modelBoundaryText) : undefined;
  const repairedOptions = repaired && repaired.options.length >= 2 && repaired.stem ? repaired.options : undefined;
  const evidenceQuestion = evidence ? rebuildFromOcrEvidence(parsed, evidence) : undefined;
  const optionsSource = evidenceQuestion?.options ?? (useModelStructure ? (repairedOptions ?? (modelSuppliedOptions ? candidateOptions : base.options)) : base.options);
  const options = optionsSource.map((option, index) => ({
    id: stableOptionId(index),
    label: typeof option.label === "string" && option.label.trim() ? option.label.trim().toUpperCase() : fallbackOptionLabel(index),
    text: option.text.trim(),
    confidence: "confidence" in option && typeof option.confidence === "number" ? option.confidence : undefined
  }));
  const visualDependency = parsed.visualDependency === true || base.visualDependency === true;
  const visualDependencyReason = typeof parsed.visualDependencyReason === "string" ? stripExcludedText(parsed.visualDependencyReason, parsed.ignoredText) || base.visualDependencyReason : base.visualDependencyReason;
  const modelContext = typeof parsed.context === "string" ? stripExcludedText(parsed.context, parsed.ignoredText) : "";
  const contextParts = [modelContext || base.context?.trim() || ""];
  if (visualDependencyReason && !contextParts[0].includes(visualDependencyReason)) contextParts.push(`视觉信息：${visualDependencyReason}`);
  const normalizedStem = evidenceQuestion?.stem || (!useModelStructure ? base.stem : repairedOptions ? repaired!.stem : typeof parsed.stem === "string" ? stripExcludedText(parsed.stem, parsed.ignoredText) : base.stem);
  const modelReplacedIncompleteStructure = (evidenceQuestion?.options ?? repairedOptions ?? (useModelStructure && modelSuppliedOptions ? candidateOptions : [])).length >= 2 && !!normalizedStem;
  const warnings = [...base.warnings.filter((warning) =>
    !(modelReplacedIncompleteStructure && warning === "INCOMPLETE_OPTIONS") &&
    !(source === "vision" && warning === "VISION_MODEL_REQUIRED")
  ), ...(Array.isArray(parsed.warnings) ? parsed.warnings.filter(isRecognitionWarning) : [])];
  if (useModelStructure && modelSuppliedOptions && candidateOptions.length < 2) warnings.push("INCOMPLETE_OPTIONS");
  if (useModelStructure && typeof parsed.stem === "string" && !parsed.stem.trim()) warnings.push("INCOMPLETE_OPTIONS");
  if (source === "local-ocr" && !evidence) warnings.push("STRUCTURE_REVIEW_REQUIRED");
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

function getBoundaryEvidence(parsed: StructuredWithEvidence, boxes: OcrTextBox[]): BoundaryEvidence | undefined {
  if (!Array.isArray(parsed.stemLineIds) || !Array.isArray(parsed.optionLineIds) || !Array.isArray(parsed.ignoredLineIds) || !boxes.length) return undefined;
  const lines = groupOcrBoxes(boxes);
  const validIds = new Set(lines.map((line) => line.id));
  const stemLineIds = parsed.stemLineIds.filter((id): id is string => typeof id === "string" && validIds.has(id));
  const optionLineIds = parsed.optionLineIds.filter((id): id is string => typeof id === "string" && validIds.has(id));
  const ignoredLineIds = parsed.ignoredLineIds.filter((id): id is string => typeof id === "string" && validIds.has(id));
  if (optionLineIds.length < 2 || optionLineIds.length !== (Array.isArray(parsed.options) ? parsed.options.length : 0)) return undefined;
  if (new Set(stemLineIds).size !== stemLineIds.length || new Set(ignoredLineIds).size !== ignoredLineIds.length) return undefined;
  if (!stemLineIds.length || optionLineIds.some((id) => stemLineIds.includes(id) || ignoredLineIds.includes(id)) || ignoredLineIds.some((id) => stemLineIds.includes(id))) return undefined;
  return { lines, stemLineIds, optionLineIds, ignoredLineIds };
}

/**
 * Rebuild the actual question from the visual line ledger.  This deliberately
 * prefers OCR text over the model's free-form stem/options strings.  The
 * model can still remove result text through ignoredText and classify rows,
 * but it cannot move an option into the stem by rewriting JSON.
 */
function rebuildFromOcrEvidence(parsed: StructuredWithEvidence, evidence: BoundaryEvidence): { stem: string; options: Array<{ label: string; text: string }> } {
  const lineById = new Map(evidence.lines.map((line) => [line.id, line]));
  const ignoredText = parsed.ignoredText;
  const stem = evidence.stemLineIds
    .map((id) => stripExcludedText(lineById.get(id)?.text ?? "", ignoredText))
    .filter(Boolean)
    .join("\n")
    .trim();
  const options: Array<{ label: string; text: string }> = [];
  const occurrences = new Map<string, number>();
  for (let index = 0; index < evidence.optionLineIds.length; index++) {
    const lineId = evidence.optionLineIds[index];
    const line = lineById.get(lineId);
    if (!line) continue;
    const sourceSegments = splitOptionLines(stripExcludedText(line.text, ignoredText));
    const occurrence = occurrences.get(lineId) ?? 0;
    occurrences.set(lineId, occurrence + 1);
    const segment = sourceSegments[occurrence] ?? sourceSegments[0] ?? "";
    const parsedSegment = parseOptionLine(segment, index);
    const modelOption = Array.isArray(parsed.options) && parsed.options[index] && typeof parsed.options[index] === "object" ? parsed.options[index] as { label?: unknown; text?: unknown } : undefined;
    const label = parsedSegment?.label ?? (typeof modelOption?.label === "string" ? modelOption.label : fallbackOptionLabel(index));
    let text = parsedSegment?.text ?? (typeof modelOption?.text === "string" ? stripExcludedText(modelOption.text, ignoredText) : "");
    // A line can wrap an option over one or more unclassified OCR rows.  Add
    // only rows between this option and the next option; never pull in an
    // ignored/result or stem row.
    const currentLineIndex = evidence.lines.findIndex((candidate) => candidate.id === lineId);
    const nextLineId = evidence.optionLineIds[index + 1];
    const nextLineIndex = nextLineId === lineId ? currentLineIndex : evidence.lines.findIndex((candidate) => candidate.id === nextLineId);
    if (nextLineId !== lineId && currentLineIndex >= 0 && nextLineIndex > currentLineIndex) {
      const assigned = new Set([...evidence.stemLineIds, ...evidence.optionLineIds, ...evidence.ignoredLineIds]);
      const continuation = evidence.lines.slice(currentLineIndex + 1, nextLineIndex).filter((candidate) => !assigned.has(candidate.id)).map((candidate) => stripExcludedText(candidate.text, ignoredText)).filter(Boolean);
      if (continuation.length) text = [text, ...continuation].filter(Boolean).join(" ").trim();
    }
    if (text.trim()) options.push({ label, text: text.trim() });
  }
  return { stem, options };
}

/**
 * A text-only structure response is accepted only when it returns a complete
 * line ledger.  This prevents a model from returning a plausible-looking
 * stem/options object without showing which OCR rows it used.
 */
export function hasOcrBoundaryEvidence(parsed: StructuredQuestionResult, boxes: OcrTextBox[]): boolean {
  return !!getBoundaryEvidence(parsed, boxes);
}

export function hasStructuredQuestionFields(parsed: StructuredQuestionResult, requireLineEvidence = false): boolean {
  const base = (parsed.questionType === "single" || parsed.questionType === "multiple" || parsed.questionType === "unknown")
    && typeof parsed.stem === "string"
    && Array.isArray(parsed.options)
    && typeof parsed.context === "string"
    && typeof parsed.visualDependency === "boolean"
    && typeof parsed.visualDependencyReason === "string"
    // The fallback json_object/plain-JSON path does not enforce the schema.
    // Require the exclusion ledger explicitly so a successful HTTP response
    // cannot be mistaken for proof that answer/result text was separated.
    && typeof parsed.ignoredText === "string";
  if (!base || !requireLineEvidence) return base;
  return Array.isArray(parsed.stemLineIds) && Array.isArray(parsed.optionLineIds) && Array.isArray(parsed.ignoredLineIds);
}

function isRecognitionWarning(value: unknown): value is ExtractedQuestion["warnings"][number] {
  return value === "LOW_OCR_CONFIDENCE" || value === "POSSIBLE_FORMULA" || value === "POSSIBLE_DIAGRAM" || value === "INCOMPLETE_OPTIONS" || value === "VISION_MODEL_REQUIRED" || value === "VISION_MODEL_UNSUPPORTED" || value === "VISION_SERVICE_UNAVAILABLE" || value === "DOM_OCR_CONFLICT" || value === "STRUCTURE_REVIEW_REQUIRED";
}
