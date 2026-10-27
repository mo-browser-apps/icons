import { resolveProviderName } from "./image-provider";
import { getImageSettings } from "./generation-settings";
import { getCodexStatus } from "./codex-account";
import { isConnectionDisconnected } from "./generation-connection";
import { listImageModels, ProviderRequestError } from "./image-models";
import { getResolvedApiKey, hasApiKeyInPrefs } from "./openai-api-key";
import type { GetGenerationSettingsResponse } from "../gen/app";

export async function readGenerationSettings(refresh = false): Promise<GetGenerationSettingsResponse> {
  if (isConnectionDisconnected()) {
    return { provider: "", model: "", quality: "", models: [], hasApiKey: hasApiKeyInPrefs(), apiKeyRequired: false,
      ready: false, codex: undefined, error: "", errorCode: "" };
  }
  const provider = resolveProviderName();
  if (provider === "codex") {
    const codex = await getCodexStatus();
    return { provider, model: "", quality: "", models: [], hasApiKey: hasApiKeyInPrefs(), apiKeyRequired: false,
      ready: codex.state === "ready", codex, error: codex.error, errorCode: codex.state === "ready" ? "" : "codex_connection" };
  }
  const base = { provider, ...getImageSettings(provider), hasApiKey: hasApiKeyInPrefs(), apiKeyRequired: provider !== "mock", codex: undefined };
  if (base.apiKeyRequired && !base.hasApiKey) return { ...base, ready: false, models: [], error: "", errorCode: "" };
  try {
    const models = await listImageModels(provider, getResolvedApiKey(), refresh);
    return { ...base, ready: true, models, error: "", errorCode: "" };
  } catch (error) {
    return { ...base, ready: false, models: [], error: error instanceof Error ? error.message : "Could not connect to the image provider.",
      errorCode: error instanceof ProviderRequestError ? error.code : "" };
  }
}
