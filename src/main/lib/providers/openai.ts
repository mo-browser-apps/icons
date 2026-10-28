import type { ImageProvider, GenerationRequest, GenerationResult } from "../image-provider";
import { requestImages } from "../image-request";
import { getResolvedOpenAIApiKey } from "../openai-api-key";
import { getImageSettings } from "../generation-settings";

const GENERATIONS_URL = "https://api.openai.com/v1/images/generations";
const EDITS_URL = "https://api.openai.com/v1/images/edits";

/** OpenAI returns all requested variants in one generation or edit request. */
export class OpenAIProvider implements ImageProvider {
  async generate(request: GenerationRequest): Promise<GenerationResult> {
    request.signal?.throwIfAborted();
    const apiKey = getResolvedOpenAIApiKey();
    if (!apiKey) {
      throw new Error("No OpenAI API key. Use the startup dialog or save a key in app preferences.");
    }
    const settings = getImageSettings("openai");
    const parameters = {
      model: settings.model,
      prompt: request.positivePrompt,
      n: request.count,
      size: "1024x1024",
      quality: settings.quality,
      output_format: "png",
      background: "opaque",
    };
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    let body: string | FormData;
    if (request.referenceImageB64) {
      const form = new FormData();
      for (const [key, value] of Object.entries(parameters)) form.append(key, String(value));
      form.append("image", new Blob([Buffer.from(request.referenceImageB64, "base64")], { type: "image/png" }), "reference.png");
      body = form;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(parameters);
    }
    const images = await requestImages(
      request.referenceImageB64 ? EDITS_URL : GENERATIONS_URL,
      { method: "POST", headers, body },
      "OpenAI",
      request.signal
    );
    return { images };
  }
}
