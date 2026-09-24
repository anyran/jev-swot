import { validateJevEndpoint } from "../core/typesafe";
import { validateLlmBaseUrl } from "../core/llm";
import type { PersistentSettings, StoredSecrets } from "../shared/types";

export interface ModelPermissionOrigins {
  origins: string[];
  error?: string;
}

/** Returns only the configured model API origins that need optional host access. */
export function getModelPermissionOrigins(settings: PersistentSettings, secrets: StoredSecrets): ModelPermissionOrigins {
  const origins: string[] = [];
  if (secrets.typeSafeApiKey) {
    const endpoint = settings.jev.endpoint.trim();
    const invalidEndpoint = validateJevEndpoint(endpoint);
    if (invalidEndpoint) return { origins: [], error: invalidEndpoint };
    origins.push(`${new URL(endpoint).origin}/*`);
  }
  if (secrets.llmApiKey) {
    const baseUrl = settings.llm.baseUrl.trim();
    const invalidBaseUrl = validateLlmBaseUrl(baseUrl);
    if (invalidBaseUrl) return { origins: [], error: invalidBaseUrl };
    origins.push(`${new URL(baseUrl).origin}/*`);
  }
  return { origins: [...new Set(origins)] };
}
