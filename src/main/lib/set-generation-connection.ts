import { getCodexStatus, cancelCodexLogin } from "./codex-account";
import { saveConnection } from "./generation-connection";
import { listImageModels } from "./image-models";
import { detectProviderFromKey, getResolvedApiKey, hasApiKeyInPrefs } from "./openai-api-key";
import { readGenerationSettings } from "./read-generation-settings";

export async function setGenerationConnection(connection: string, generationRunning: boolean) {
  const forced = process.env.ICON_PROVIDER?.trim();
  if (forced) {
    // Confirming a forced account refreshes readiness without changing preferences.
    if (forced === "codex" && connection === "codex") return readGenerationSettings();
    throw new Error("The image provider is fixed by the development configuration.");
  }
  if (connection === "codex") {
    const status = await getCodexStatus();
    if (status.state !== "ready") throw new Error(status.error || "Connect ChatGPT before continuing.");
    saveConnection("codex");
  } else if (connection === "api") {
    if (!hasApiKeyInPrefs()) throw new Error("Add an API key before continuing.");
    await listImageModels(detectProviderFromKey(getResolvedApiKey()), getResolvedApiKey(), true);
    saveConnection("api");
  } else if (connection === "none") {
    if (generationRunning) throw new Error("Stop generation before disconnecting.");
    saveConnection("none");
    await cancelCodexLogin();
  } else throw new Error("Choose ChatGPT or an API key.");
  return readGenerationSettings();
}
