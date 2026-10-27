import type {
  ImageProvider,
  GenerationRequest,
  GenerationResult,
} from "../image-provider";
import { requestImages } from "../image-request";
import { getResolvedApiKey } from "../openai-api-key";
import { getImageSettings } from "../generation-settings";
import { compatibleRouterProviders, DEFAULT_OPENROUTER_MODEL, type ImageSettings } from "../image-models";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IMAGES_URL = "https://openrouter.ai/api/v1/images";

/** Optional attribution headers OpenRouter shows on its activity dashboard. */
const REFERER = "https://github.com/mo-browser-apps/icons";
const TITLE = "MoIcons";

/**
 * OpenRouter image generation provider.
 *
 * Uses OpenRouter's dedicated `/images` endpoint. Request
 * each variant separately so successful images survive a partial failure.
 *
 * API key: read from application preferences only (an `sk-or-…` key).
 */
export class OpenRouterProvider implements ImageProvider {
  async generate(request: GenerationRequest): Promise<GenerationResult> {
    request.signal?.throwIfAborted();
    const apiKey = getResolvedApiKey();
    if (!apiKey) {
      throw new Error(
        "No OpenRouter API key. Use the startup dialog or save a key in app preferences."
      );
    }

    const settings = getImageSettings("openrouter");
    const providers = await compatibleRouterProviders(settings, request.signal);
    request.signal?.throwIfAborted();
    const count = Math.max(1, request.count);

    // One image per request → fire `count` requests concurrently.
    const settled = await Promise.allSettled(
      Array.from({ length: count }, () =>
        this.generateOne(
          apiKey,
          settings,
          providers,
          request.positivePrompt,
          request.referenceImageB64,
          request.signal
        )
      )
    );

    request.signal?.throwIfAborted();
    const images = settled
      .filter(
        (r): r is PromiseFulfilledResult<string> => r.status === "fulfilled"
      )
      .map((r) => r.value);

    if (images.length === 0) {
      // Surface the first failure (preserves 401/403 so the UI can re-prompt
      // for the key).
      const firstRejection = settled.find((r) => r.status === "rejected") as
        | PromiseRejectedResult
        | undefined;
      const reason = firstRejection?.reason;
      throw reason instanceof Error
        ? reason
        : new Error(String(reason ?? "OpenRouter returned no image data."));
    }

    return { images };
  }

  /** Generate or refine a single raster image through the Images API. */
  private async generateOne(
    apiKey: string,
    settings: ImageSettings,
    providers: string[],
    prompt: string,
    referenceB64?: string,
    signal?: AbortSignal
  ): Promise<string> {
    const images = await requestImages(IMAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": REFERER,
        "X-Title": TITLE,
      },
      body: JSON.stringify({
        model: settings.model,
        prompt,
        n: 1,
        aspect_ratio: "1:1",
        output_format: "png",
        ...(settings.model === DEFAULT_OPENROUTER_MODEL ? { resolution: "1K" } : {}),
        ...(settings.quality ? { quality: settings.quality } : {}),
        ...(providers.length ? { provider: { only: providers } } : {}),
        ...(referenceB64 ? { input_references: [{
          type: "image_url",
          image_url: { url: `data:image/png;base64,${referenceB64}` },
        }] } : {}),
      }),
    }, "OpenRouter", signal);
    return images[0];
  }
}
