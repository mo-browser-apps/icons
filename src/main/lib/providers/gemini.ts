import type { GenerationRequest, GenerationResult, ImageProvider } from "../image-provider";
import { getResolvedApiKey } from "../openai-api-key";
import { getImageSettings } from "../generation-settings";
import { geminiModel, requestGeminiJSON, validateSettings } from "../image-models";

interface Interaction {
  status?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; data?: string; mime_type?: string }>;
  }>;
}

function imageFromInteraction(response: Interaction): string {
  if (!response || response.status !== "completed" || !Array.isArray(response.steps)) {
    throw new Error("Gemini did not complete the image. Try again or choose another model.");
  }
  // Only final model output is artwork. Ignore intermediate thinking and tools.
  for (const step of [...response.steps].reverse()) {
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const part of [...step.content].reverse()) {
      if (part?.type !== "image" || typeof part.data !== "string") continue;
      const bytes = Buffer.from(part.data, "base64");
      const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
          ? "image/jpeg"
          : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
            ? "image/webp" : null;
      if (mime && (!part.mime_type || part.mime_type === mime)) return part.data;
    }
  }
  throw new Error("Gemini returned no supported image. It may have declined the request. Try adjusting your prompt or reference image.");
}

export class GeminiImageProvider implements ImageProvider {
  async generate(request: GenerationRequest): Promise<GenerationResult> {
    request.signal?.throwIfAborted();
    const apiKey = getResolvedApiKey();
    if (!apiKey) throw new Error("Add a Google Gemini API key in generation settings to continue.");
    const settings = getImageSettings("gemini");
    const model = geminiModel(`models/${settings.model}`);
    if (!model) throw new Error("Choose a supported Gemini image model in generation settings.");
    validateSettings(settings, model);
    const input: Array<{ type: string; text?: string; mime_type?: string; data?: string }> = [
      { type: "text", text: request.positivePrompt },
    ];
    if (request.referenceImageB64) {
      input.push({ type: "image", mime_type: "image/png", data: request.referenceImageB64 });
    }
    const images: string[] = [];
    const count = Math.min(3, Math.max(1, Math.trunc(request.count) || 1));
    for (let i = 0; i < count; i++) {
      request.signal?.throwIfAborted();
      try {
        const result = await requestGeminiJSON<Interaction>("interactions", apiKey, {
          model: model.id,
          input,
          store: false,
          response_format: {
            type: "image", mime_type: "image/jpeg", delivery: "inline", aspect_ratio: "1:1", image_size: "1K",
          },
        }, request.signal);
        images.push(imageFromInteraction(result));
      } catch (error) {
        request.signal?.throwIfAborted();
        if (!images.length) throw error;
        // Keep completed variants, but don't continue spending after a failure.
        break;
      }
    }
    // No automatic retries: an interrupted request may already have been billed.
    request.signal?.throwIfAborted();
    return { images };
  }
}
