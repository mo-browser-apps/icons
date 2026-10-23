import { prefs } from "@mobrowser/api";
import { getImageSettings } from "./generation-settings";
import { listImageModels } from "./image-models";
import { API_KEY_PREFS_KEY, detectProviderFromKey } from "./openai-api-key";

/** Validate using read-only requests before replacing any saved preferences. */
export async function saveValidatedApiKey(input: string) {
  const apiKey = input.trim();
  if (!apiKey) throw new Error("Enter an API key to continue.");
  const provider = detectProviderFromKey(apiKey);
  const forced = process.env.ICON_PROVIDER?.trim();
  if ((forced === "openai" || forced === "openrouter") && forced !== provider) {
    throw new Error(`This app is configured to use ${forced === "openai" ? "OpenAI" : "OpenRouter"}. Enter a key for that provider.`);
  }
  const models = await listImageModels(provider, apiKey, true);
  const previousSettings = getImageSettings(provider);
  const model = models.find((item) => item.id === previousSettings.model) ?? models[0];
  const settings = {
    model: model.id,
    quality: model.qualities.includes(previousSettings.quality)
      ? previousSettings.quality : model.qualities[0] || "",
  };
  const settingsKey = `imageGeneration.${provider}`;
  const hadKey = prefs.hasString(API_KEY_PREFS_KEY);
  const previousKey = prefs.getString(API_KEY_PREFS_KEY);
  const hadSettings = prefs.hasObject(settingsKey);
  prefs.setString(API_KEY_PREFS_KEY, apiKey);
  prefs.setObject(settingsKey, settings);
  if (!prefs.persist()) {
    if (hadKey) prefs.setString(API_KEY_PREFS_KEY, previousKey);
    else prefs.remove(API_KEY_PREFS_KEY);
    if (hadSettings) prefs.setObject(settingsKey, previousSettings);
    else prefs.remove(settingsKey);
    throw new Error("Could not save preferences. Your previous API key has been kept. Try again.");
  }
  return { provider, ...settings, models, hasApiKey: true, apiKeyRequired: true, error: "", errorCode: "" };
}
