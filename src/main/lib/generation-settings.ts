import { prefs } from "@mobrowser/api";
import {
  DEFAULT_OPENAI_MODEL, DEFAULT_OPENROUTER_MODEL,
  compatibleRouterProviders, listImageModels, validateSettings,
  type ImageService, type ImageSettings,
} from "./image-models";

export function getImageSettings(provider: ImageService): ImageSettings {
  const defaults = provider === "openai"
    ? { model: DEFAULT_OPENAI_MODEL, quality: "low" }
    : provider === "mock"
      ? { model: "mock", quality: "" }
      : { model: process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL, quality: "" };
  return prefs.getObject<ImageSettings>(`imageGeneration.${provider}`, defaults);
}

export async function saveImageSettings(provider: ImageService, apiKey: string, settings: ImageSettings): Promise<void> {
  const models = await listImageModels(provider, apiKey);
  const model = models.find((item) => item.id === settings.model);
  if (!model) throw new Error("The selected model is no longer available. Refresh the model list.");
  validateSettings(settings, model);
  if (provider === "openrouter") await compatibleRouterProviders(settings);
  const key = `imageGeneration.${provider}`;
  const previous = getImageSettings(provider);
  prefs.setObject(key, settings);
  if (!prefs.persist()) {
    prefs.setObject(key, previous);
    throw new Error("Could not save generation settings.");
  }
}
