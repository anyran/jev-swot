export type QuestionType = "single" | "multiple" | "unknown";
export type QuestionSource = "dom" | "vision" | "local-ocr" | "user-edited";
export type RecognitionWarning =
  | "LOW_OCR_CONFIDENCE"
  | "POSSIBLE_FORMULA"
  | "POSSIBLE_DIAGRAM"
  | "INCOMPLETE_OPTIONS"
  | "VISION_MODEL_REQUIRED";

export interface DOMRectLike { x: number; y: number; width: number; height: number }
export interface QuestionOption { id: string; label: string; text: string; confidence?: number }
export interface ExtractedQuestion {
  source: QuestionSource;
  questionType: QuestionType;
  stem: string;
  options: QuestionOption[];
  context?: string;
  sourceRect: DOMRectLike;
  recognitionConfidence: number;
  warnings: RecognitionWarning[];
}
export interface ProbabilityResult {
  mode: "single-distribution" | "independent-selection";
  options: Array<{ id: string; label: string; probability: number }>;
  confidence?: number;
  model: string;
}
export type Capability = "auto" | "supported" | "unsupported";
export interface LLMSettings {
  baseUrl: string;
  model: string;
  vision: Capability;
  structuredOutput: Capability;
}
export interface PersistentSettings {
  llm: LLMSettings;
  ocrThreshold: number;
  useWebGpu: boolean;
  disabledHosts: string[];
}
export interface SessionSecrets { typeSafeApiKey?: string; llmApiKey?: string; visionDetected?: Capability }

export type WorkerRequest =
  | { type: "ANALYZE"; question: ExtractedQuestion; screenshot?: string; devicePixelRatio?: number }
  | { type: "EXPLAIN"; question: ExtractedQuestion; probability: ProbabilityResult }
  | { type: "OCR"; imageDataUrl: string; rect: DOMRectLike; devicePixelRatio: number }
  | { type: "CLEAR_SESSION" };

export type WorkerResponse =
  | { ok: true; question?: ExtractedQuestion; probability?: ProbabilityResult; explanation?: string }
  | { ok: false; code: string; message: string; recoverable: boolean };

export const DEFAULT_SETTINGS: PersistentSettings = {
  llm: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", vision: "auto", structuredOutput: "auto" },
  ocrThreshold: 0.72,
  useWebGpu: false,
  disabledHosts: []
};
