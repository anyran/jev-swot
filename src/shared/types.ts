export type QuestionType = "single" | "multiple" | "unknown";
export type QuestionSource = "dom" | "vision" | "local-ocr" | "user-edited";
export type RecognitionWarning =
  | "LOW_OCR_CONFIDENCE"
  | "POSSIBLE_FORMULA"
  | "POSSIBLE_DIAGRAM"
  | "INCOMPLETE_OPTIONS"
  | "VISION_MODEL_REQUIRED"
  | "VISION_SERVICE_UNAVAILABLE"
  | "DOM_OCR_CONFLICT";

export interface DOMRectLike { x: number; y: number; width: number; height: number }
export interface OcrTextBox extends DOMRectLike { text: string; confidence: number }
export interface RecognitionPreview { imageDataUrl: string; width: number; height: number; boxes: OcrTextBox[] }
export interface QuestionOption { id: string; label: string; text: string; confidence?: number; sourceRect?: DOMRectLike }
export interface ExtractedQuestion {
  source: QuestionSource;
  questionType: QuestionType;
  stem: string;
  options: QuestionOption[];
  context?: string;
  sourceRect: DOMRectLike;
  recognitionConfidence: number;
  warnings: RecognitionWarning[];
  visualDependency?: boolean;
  visualDependencyReason?: string;
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
  confirmVisionUpload: boolean;
  disabledHosts: string[];
}
export interface SessionSecrets { typeSafeApiKey?: string; llmApiKey?: string; visionDetected?: Capability; structuredOutputDetected?: Capability; capabilityKey?: string }

export type WorkerRequest =
  | { type: "ANALYZE"; requestId: string; question: ExtractedQuestion; screenshot?: string; devicePixelRatio?: number; visionConsent?: "allow" | "deny"; captureAuthorized: boolean }
  | { type: "EXPLAIN"; requestId: string; question: ExtractedQuestion; probability: ProbabilityResult }
  | { type: "CANCEL"; requestId: string }
  | { type: "OCR"; requestId?: string; imageDataUrl: string; rect: DOMRectLike; devicePixelRatio: number; useWebGpu?: boolean }
  | { type: "CANCEL_OCR"; requestId: string }
  | { type: "CROP_IMAGE"; imageDataUrl: string; rect: DOMRectLike; devicePixelRatio: number }
  | { type: "RELEASE_OCR" }
  | { type: "TEST_CONNECTIONS"; imageDataUrl: string }
  | { type: "CLEAR_SESSION" };

export type AnalysisProgressStage = "capture" | "vision" | "ocr-loading" | "ocr-running" | "jev";
export type RuntimeProgressMessage = { type: "ANALYZE_PROGRESS"; requestId: string; stage: AnalysisProgressStage; message: string };

export type WorkerResponse =
  | { ok: true; question?: ExtractedQuestion; probability?: ProbabilityResult; explanation?: string; diagnostic?: string; preview?: RecognitionPreview }
  | { ok: false; code: string; message: string; recoverable: boolean; question?: ExtractedQuestion; preview?: RecognitionPreview };

export const DEFAULT_SETTINGS: PersistentSettings = {
  llm: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", vision: "auto", structuredOutput: "auto" },
  ocrThreshold: 0.72,
  useWebGpu: false,
  confirmVisionUpload: true,
  disabledHosts: []
};
