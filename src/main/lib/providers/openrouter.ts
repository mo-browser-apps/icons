import type {
  ImageProvider,
  GenerationRequest,
  GenerationResult,
} from "../image-provider";
import { withRetry } from "../image-provider";
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

/** Abort individual HTTP requests after this many milliseconds. */
const REQUEST_TIMEOUT_MS = 180_000;

/** How many times to retry a failed request before giving up. */
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Response shape (only the fields we read)
// ---------------------------------------------------------------------------

interface ImageResponse {
  data?: Array<{
    b64_json?: string;
    media_type?: string;
  }>;
}

class OpenRouterHttpError extends Error {
  constructor(
    readonly status: number,
    body: string
  ) {
    super(`OpenRouter API error ${status}: ${body}`);
    this.name = "OpenRouterHttpError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Retry network failures, throttling, timeouts, and server errors. */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof OpenRouterHttpError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

/** The renderer expects raw base64 PNG artwork from the Images API. */
function extractImageB64(json: ImageResponse): string | null {
  if (!Array.isArray(json.data)) return null;
  const image = json.data.find((item) =>
    typeof item?.b64_json === "string" && item.b64_json.startsWith("iVBORw0KGgo") &&
    (!item.media_type || item.media_type === "image/png")
  );
  return image?.b64_json ?? null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

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
    const apiKey = getResolvedApiKey();
    if (!apiKey) {
      throw new Error(
        "No OpenRouter API key. Use the startup dialog or save a key in app preferences."
      );
    }

    const settings = getImageSettings("openrouter");
    const providers = await compatibleRouterProviders(settings);
    const count = Math.max(1, request.count);

    // One image per request → fire `count` requests concurrently.
    const settled = await Promise.allSettled(
      Array.from({ length: count }, () =>
        this.generateOne(
          apiKey,
          settings,
          providers,
          request.positivePrompt,
          request.referenceImageB64
        )
      )
    );

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

  /** Generate or refine a single PNG through the Images API. */
  private generateOne(
    apiKey: string,
    settings: ImageSettings,
    providers: string[],
    prompt: string,
    referenceB64?: string
  ): Promise<string> {
    return withRetry(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(IMAGES_URL, {
          method: "POST",
          signal: controller.signal,
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
        });

        if (!res.ok) {
          const body = await res.text();
          throw new OpenRouterHttpError(res.status, body);
        }

        const json = (await res.json()) as ImageResponse;
        const image = extractImageB64(json);
        if (!image) {
          throw new Error(
            "OpenRouter returned no PNG image. Ensure the selected model supports PNG output."
          );
        }
        return image;
      } finally {
        clearTimeout(timeoutId);
      }
    }, MAX_RETRIES, 1_000, isRetryableError);
  }
}
