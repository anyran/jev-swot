import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSecrets, getSettings, normalizeSecrets, normalizeSettings } from "./storage";

describe("storage normalization", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      storage: {
        local: { get: vi.fn(async () => ({ settings: {} })) },
        session: { get: vi.fn(async () => ({ secrets: {} })) }
      }
    });
  });

  it("repairs malformed settings without changing safe defaults", () => {
    const settings = normalizeSettings({ llm: { baseUrl: "  ", vision: "invalid" }, ocrThreshold: 10, useWebGpu: "yes", confirmVisionUpload: false, disabledHosts: [" Example.COM ", 7, "..."] });
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
        local: { get: vi.fn(async () => ({ settings: { disabledHosts: "not-an-array" } })) },
        session: { get: vi.fn(async () => ({ secrets: { typeSafeApiKey: "  jev  " } })) }
      }
    });
    expect((await getSettings()).disabledHosts).toEqual([]);
    expect((await getSecrets()).typeSafeApiKey).toBe("jev");
  });
});
