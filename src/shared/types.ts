export type QuestionType = "single" | "multiple" | "unknown";
export type QuestionSource = "dom" | "vision" | "local-ocr" | "user-edited";
export type RecognitionWarning =
  | "LOW_OCR_CONFIDENCE"
  | "POSSIBLE_FORMULA"
  | "POSSIBLE_DIAGRAM"
  | "INCOMPLETE_OPTIONS"
  | "VISION_MODEL_REQUIRED"
  | "VISION_MODEL_UNSUPPORTED"
  | "VISION_SERVICE_UNAVAILABLE"
  | "DOM_OCR_CONFLICT"
  | "STRUCTURE_REVIEW_REQUIRED";

export interface DOMRectLike { x: number; y: number; width: number; height: number }
export interface OcrTextBox extends DOMRectLike { text: string; confidence: number }
export interface RecognitionPreview { imageDataUrl: string; width: number; height: number; boxes: OcrTextBox[]; excludedText?: string }
export interface QuestionOption { id: string; label: string; text: string; confidence?: number; sourceRect?: DOMRectLike }
export interface ExtractedQuestion {
  source: QuestionSource;
  questionType: QuestionType;
  stem: string;
  options: QuestionOption[];
  context?: string;
  sourceRect: DOMRectLike;
  coordinateSpace?: "document";
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
export interface DirectAnswerResult {
  answerOptionIds: string[];
  answerLabels: string[];
  explanation: string;
  knowledgePoints: string[];
  uncertainty: string;
  model: string;
  structuredOutputDetected?: Exclude<Capability, "auto">;
}
export type Capability = "auto" | "supported" | "unsupported";
export interface LLMSettings {
  baseUrl: string;
  model: string;
  vision: Capability;
  structuredOutput: Capability;
}
export interface JevSettings {
  endpoint: string;
  model: string;
}
export interface PersistentSettings {
  jev: JevSettings;
  llm: LLMSettings;
  ocrThreshold: number;
  useWebGpu: boolean;
  confirmVisionUpload: boolean;
  disabledHosts: string[];
}
/** Credentials and cached capability results persisted locally; typeSafeApiKey is retained as a legacy field name for any JEV API key. */
export interface StoredSecrets { typeSafeApiKey?: string; llmApiKey?: string; visionDetected?: Capability; structuredOutputDetected?: Capability; capabilityKey?: string }

export type WorkerRequest =
  | { type: "ANALYZE"; requestId: string; question: ExtractedQuestion; screenshot?: string; screenshotRect?: DOMRectLike; devicePixelRatio?: number; visionConsent?: "allow" | "deny"; captureAuthorized: boolean }
  | { type: "SCAN_EMBEDDED_FRAMES"; requestId: string }
  | { type: "CANCEL_EMBEDDED_FRAME_SCAN"; requestId: string }
  | { type: "START_TOP_PAGE_SCAN" }
  | { type: "EXPLAIN"; requestId: string; question: ExtractedQuestion; probability: ProbabilityResult }
  | { type: "DIRECT_ANSWER"; requestId: string; question: ExtractedQuestion }
  | { type: "LOAD_DETAILS"; requestId: string; detailToken: string }
  | { type: "CANCEL"; requestId: string }
  | { type: "OCR"; requestId?: string; imageDataUrl: string; rect: DOMRectLike; devicePixelRatio: number; useWebGpu?: boolean }
  | { type: "CANCEL_OCR"; requestId: string }
  | { type: "CROP_IMAGE"; imageDataUrl: string; rect: DOMRectLike; devicePixelRatio: number }
  | { type: "RELEASE_OCR" }
  | { type: "TEST_CONNECTIONS"; imageDataUrl: string }
  | { type: "CAPTURE_VISIBLE_TAB" }
  | { type: "GET_SETTINGS" }
  | { type: "CLEAR_SESSION" }
  | { type: "CLEAR_API_KEYS" };

export type AnalysisProgressStage = "capture" | "vision" | "ocr-loading" | "ocr-running" | "jev";
export type RuntimeProgressMessage = { type: "ANALYZE_PROGRESS"; requestId: string; stage: AnalysisProgressStage; message: string };

export type WorkerResponse =
  | { ok: true; question?: ExtractedQuestion; probability?: ProbabilityResult; directAnswer?: DirectAnswerResult; explanation?: string; diagnostic?: string; detailToken?: string; preview?: RecognitionPreview; settings?: PersistentSettings; imageDataUrl?: string; frames?: EmbeddedFrameScanResult[] }
  | { ok: false; code: string; message: string; recoverable: boolean; question?: ExtractedQuestion; preview?: RecognitionPreview };

export interface EmbeddedFrameScanResult {
  frameId: number;
  url?: string;
  ok: boolean;
  questions?: ExtractedQuestion[];
  warning?: string;
  message?: string;
}

export const DEFAULT_SETTINGS: PersistentSettings = {
  jev: { endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" },
  llm: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", vision: "auto", structuredOutput: "auto" },
  ocrThreshold: 0.72,
  useWebGpu: false,
  confirmVisionUpload: true,
  disabledHosts: []
};
