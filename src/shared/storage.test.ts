import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSecrets, getSettings, normalizeSecrets, normalizeSettings, setSecrets } from "./storage";

describe("storage normalization", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: vi.fn(async (key: string) => key === "settings" ? { settings: {} } : { savedSecrets: {} }), set: vi.fn(), remove: vi.fn() },
        session: { get: vi.fn(async () => ({ secrets: {} })), set: vi.fn(), clear: vi.fn() }
      }
    });
  });

  it("repairs malformed settings without changing safe defaults", () => {
    const settings = normalizeSettings({ llm: { baseUrl: "  ", vision: "invalid" }, ocrThreshold: 10, useWebGpu: "yes", confirmVisionUpload: false, disabledHosts: [" Example.COM ", "example.com", 7, "..."] });
    expect(settings.llm.baseUrl).toBe("https://api.openai.com/v1");
    expect(settings.llm.vision).toBe("auto");
    expect(settings.ocrThreshold).toBe(0.95);
    expect(settings.useWebGpu).toBe(false);
    expect(settings.confirmVisionUpload).toBe(false);
    expect(settings.disabledHosts).toEqual(["example.com"]);
  });

  it("never exposes malformed session values as credentials", () => {
    expect(normalizeSecrets({ typeSafeApiKey: { value: "secret" }, llmApiKey: "  llm-key  ", capabilityKey: 3 })).toEqual({ llmApiKey: "llm-key" });
  });

  it("normalizes values loaded from Chrome storage", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: vi.fn(async (key: string) => key === "settings" ? { settings: { disabledHosts: "not-an-array" } } : { savedSecrets: {} }), set: vi.fn(), remove: vi.fn() },
        session: { get: vi.fn(async () => ({ secrets: { typeSafeApiKey: "  jev  " } })), set: vi.fn(), clear: vi.fn() }
      }
    });
    expect((await getSettings()).disabledHosts).toEqual([]);
    expect((await getSecrets()).typeSafeApiKey).toBe("jev");
  });

  it("restores persisted API keys after a browser restart", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: vi.fn(async (key: string) => key === "settings" ? { settings: {} } : { savedSecrets: { typeSafeApiKey: "saved-jev", llmApiKey: "saved-llm" } }), set: vi.fn(), remove: vi.fn() },
        session: { get: vi.fn(async () => ({ secrets: {} })), set: vi.fn(), clear: vi.fn() }
      }
    });
    await expect(getSecrets()).resolves.toMatchObject({ typeSafeApiKey: "saved-jev", llmApiKey: "saved-llm" });
  });

  it("writes API keys to local storage so they survive a browser restart", async () => {
    const localSet = vi.fn();
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: vi.fn(async () => ({ savedSecrets: {} })), set: localSet, remove: vi.fn() },
        session: { get: vi.fn(async () => ({ secrets: {} })), set: vi.fn(), clear: vi.fn() }
      }
    });
    await setSecrets({ typeSafeApiKey: "jev" });
    expect(localSet).toHaveBeenCalledWith({ savedSecrets: { typeSafeApiKey: "jev" } });
  });
});
