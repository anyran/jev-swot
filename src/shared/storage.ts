import { DEFAULT_SETTINGS, type PersistentSettings, type SessionSecrets } from "./types";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}; }
function text(value: unknown, fallback: string): string { return typeof value === "string" && value.trim() ? value.trim() : fallback; }
function capability(value: unknown, fallback: "auto" | "supported" | "unsupported"): "auto" | "supported" | "unsupported" {
  return value === "supported" || value === "unsupported" || value === "auto" ? value : fallback;
}

export function normalizeSettings(value: unknown): PersistentSettings {
  const raw = record(value), llm = record(raw.llm), threshold = Number(raw.ocrThreshold);
  const disabledHosts = Array.isArray(raw.disabledHosts)
    ? raw.disabledHosts.map((host) => typeof host === "string" ? host.trim().toLowerCase().replace(/^\.+|\.+$/g, "") : "").filter(Boolean)
    : [...DEFAULT_SETTINGS.disabledHosts];
  return {
    llm: {
      baseUrl: text(llm.baseUrl, DEFAULT_SETTINGS.llm.baseUrl),
      model: text(llm.model, DEFAULT_SETTINGS.llm.model),
      vision: capability(llm.vision, DEFAULT_SETTINGS.llm.vision),
      structuredOutput: capability(llm.structuredOutput, DEFAULT_SETTINGS.llm.structuredOutput)
    },
    ocrThreshold: Number.isFinite(threshold) ? Math.min(0.95, Math.max(0.5, threshold)) : DEFAULT_SETTINGS.ocrThreshold,
    useWebGpu: raw.useWebGpu === true,
    confirmVisionUpload: raw.confirmVisionUpload !== false,
    disabledHosts
  };
}

export function normalizeSecrets(value: unknown): SessionSecrets {
  const raw = record(value), normalized: SessionSecrets = {};
  if (typeof raw.typeSafeApiKey === "string" && raw.typeSafeApiKey.trim()) normalized.typeSafeApiKey = raw.typeSafeApiKey.trim();
  if (typeof raw.llmApiKey === "string" && raw.llmApiKey.trim()) normalized.llmApiKey = raw.llmApiKey.trim();
  if (raw.visionDetected === "auto" || raw.visionDetected === "supported" || raw.visionDetected === "unsupported") normalized.visionDetected = raw.visionDetected;
  if (raw.structuredOutputDetected === "auto" || raw.structuredOutputDetected === "supported" || raw.structuredOutputDetected === "unsupported") normalized.structuredOutputDetected = raw.structuredOutputDetected;
  if (typeof raw.capabilityKey === "string" && raw.capabilityKey.trim()) normalized.capabilityKey = raw.capabilityKey.trim();
  return normalized;
}

export async function getSettings(): Promise<PersistentSettings> {
  const stored = await chrome.storage.local.get("settings");
  return normalizeSettings(stored.settings);
}
export async function setSettings(settings: PersistentSettings): Promise<void> {
  await chrome.storage.local.set({ settings: normalizeSettings(settings) });
}
export async function getSecrets(): Promise<SessionSecrets> {
  const stored = await chrome.storage.session.get("secrets");
  return normalizeSecrets(stored.secrets);
}
export async function setSecrets(secrets: SessionSecrets): Promise<void> {
  await chrome.storage.session.set({ secrets: normalizeSecrets(secrets) });
}
