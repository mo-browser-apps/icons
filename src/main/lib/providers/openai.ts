import type {
  ImageProvider,
  GenerationRequest,
  GenerationResult,
} from "../image-provider";
import { withRetry } from "../image-provider";
import { getResolvedOpenAIApiKey } from "../openai-api-key";
import { getImageSettings } from "../generation-settings";
import type { ImageSettings } from "../image-models";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GENERATIONS_URL = "https://api.openai.com/v1/images/generations";
const EDITS_URL = "https://api.openai.com/v1/images/edits";

/** Abort individual HTTP requests after this many milliseconds. */
const REQUEST_TIMEOUT_MS = 180_000;

/** How many times to retry a failed request before giving up. */
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

interface ImageResponse {
  data: Array<{ b64_json: string }>;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * OpenAI image provider, using the model and quality saved in settings.
 *
 * The model supports n=1..10 per request, so all variants are fetched in
 * a single API call.
 *
 * API key: read from application preferences only.
 */
export class OpenAIProvider implements ImageProvider {
  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const apiKey = getResolvedOpenAIApiKey();
    if (!apiKey) {
      throw new Error(
        "No OpenAI API key. Use the startup dialog or save a key in app preferences."
      );
    }

    const settings = getImageSettings("openai");
    const images = request.referenceImageB64
      ? await this.editBatch(
          apiKey,
          request.positivePrompt,
          request.referenceImageB64,
          request.count,
          settings
        )
      : await this.generateBatch(apiKey, request.positivePrompt, request.count, settings);
    return { images };
  }

  /** Text-to-image via /v1/images/generations. */
  private generateBatch(
    apiKey: string,
    prompt: string,
    n: number,
    settings: ImageSettings
  ): Promise<string[]> {
    return withRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS
      );

      try {
        const res = await fetch(GENERATIONS_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: settings.model,
            prompt,
            n,
            size: "1024x1024",
            quality: settings.quality,
            output_format: "png",
            background: "opaque",
          }),
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`OpenAI API error ${res.status}: ${body}`);
        }

        const json = (await res.json()) as ImageResponse;
        const images = json.data.map((item) => item.b64_json).filter(Boolean);
        if (images.length === 0) throw new Error("OpenAI returned no image data.");

        return images;
      } finally {
        clearTimeout(timeoutId);
      }
    }, MAX_RETRIES);
  }

  /** Image-to-image edit via /v1/images/edits. Sends the reference as multipart. */
  private editBatch(
    apiKey: string,
    prompt: string,
    referenceB64: string,
    n: number,
    settings: ImageSettings
  ): Promise<string[]> {
    return withRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS
      );

      try {
        const imageBuffer = Buffer.from(referenceB64, "base64");
        const form = new FormData();
        form.append("model", settings.model);
        form.append("prompt", prompt);
        form.append("n", String(n));
        form.append("size", "1024x1024");
        form.append("quality", settings.quality);
        form.append("output_format", "png");
        form.append("background", "opaque");
        form.append(
          "image",
          new Blob([imageBuffer], { type: "image/png" }),
          "reference.png"
        );

        const res = await fetch(EDITS_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          body: form,
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`OpenAI API error ${res.status}: ${body}`);
        }

        const json = (await res.json()) as ImageResponse;
        const images = json.data.map((item) => item.b64_json).filter(Boolean);
        if (images.length === 0) throw new Error("OpenAI returned no image data.");

        return images;
      } finally {
        clearTimeout(timeoutId);
      }
    }, MAX_RETRIES);
  }
}
