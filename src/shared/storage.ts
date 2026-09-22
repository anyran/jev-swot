import { DEFAULT_SETTINGS, type PersistentSettings, type SessionSecrets } from "./types";

export async function getSettings(): Promise<PersistentSettings> {
  const stored = await chrome.storage.local.get("settings");
  const settings = (stored.settings ?? {}) as Partial<PersistentSettings>;
  return { ...DEFAULT_SETTINGS, ...settings, llm: { ...DEFAULT_SETTINGS.llm, ...(settings.llm ?? {}) } };
}
export async function setSettings(settings: PersistentSettings): Promise<void> {
  await chrome.storage.local.set({ settings });
}
export async function getSecrets(): Promise<SessionSecrets> {
  const stored = await chrome.storage.session.get("secrets");
  return stored.secrets ?? {};
}
export async function setSecrets(secrets: SessionSecrets): Promise<void> {
  await chrome.storage.session.set({ secrets });
}
