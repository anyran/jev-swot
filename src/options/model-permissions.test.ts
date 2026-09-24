import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/types";
import { getModelPermissionOrigins } from "./model-permissions";

describe("model API host permissions", () => {
  it("requests only the configured OpenRouter origin for a custom JEV endpoint", () => {
    const result = getModelPermissionOrigins({
      ...DEFAULT_SETTINGS,
      jev: { endpoint: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.13" }
    }, { typeSafeApiKey: "openrouter-key" });

    expect(result).toEqual({ origins: ["https://openrouter.ai/*"] });
  });

  it("deduplicates JEV and ordinary-model endpoints on the same provider origin", () => {
    const result = getModelPermissionOrigins({
      ...DEFAULT_SETTINGS,
      jev: { endpoint: "https://provider.example/alpha/decisions", model: "jev" },
      llm: { ...DEFAULT_SETTINGS.llm, baseUrl: "https://provider.example/v1" }
    }, { typeSafeApiKey: "jev-key", llmApiKey: "llm-key" });

    expect(result).toEqual({ origins: ["https://provider.example/*"] });
  });

  it("does not request model origins when neither API key is configured", () => {
    expect(getModelPermissionOrigins({
      ...DEFAULT_SETTINGS,
      jev: { endpoint: "not a URL", model: "jev" }
    }, {})).toEqual({ origins: [] });
  });

  it("blocks permission requests for an invalid configured JEV endpoint", () => {
    const result = getModelPermissionOrigins({
      ...DEFAULT_SETTINGS,
      jev: { endpoint: "http://provider.example/decisions", model: "jev" }
    }, { typeSafeApiKey: "jev-key" });

    expect(result.origins).toEqual([]);
    expect(result.error).toContain("HTTPS");
  });
});
