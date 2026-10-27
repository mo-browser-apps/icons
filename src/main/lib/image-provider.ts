import { OpenAIProvider } from "./providers/openai";
import { OpenRouterProvider } from "./providers/openrouter";
import { MockImageProvider } from "./providers/mock";
import { getResolvedApiKey, detectProviderFromKey } from "./openai-api-key";
import { usesCodex, isConnectionDisconnected } from "./generation-connection";
import { CodexImageProvider } from "./providers/codex";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface GenerationRequest {
  positivePrompt: string;
  negativePrompt: string;
  /** Base64-encoded PNG, no data URL prefix.  Omit for text-to-image. */
  referenceImageB64?: string;
  /** Number of icon variants to generate. */
  count: number;
  signal?: AbortSignal;
}

export interface GenerationResult {
  /**
   * Base64-encoded PNG, JPEG, or WebP artwork, with no data URL prefix.
   * The renderer normalizes to PNG and prepares the macOS mask, inset and shadow.
   */
  images: string[];
}

/** Common interface implemented by every image generation back-end. */
export interface ImageProvider {
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

// ---------------------------------------------------------------------------
// Supported providers
// ---------------------------------------------------------------------------

export type ProviderName = "openai" | "openrouter" | "mock" | "codex";

// ---------------------------------------------------------------------------
// Provider resolution — one cached instance per provider name
// ---------------------------------------------------------------------------

const _instances: Partial<Record<ProviderName, ImageProvider>> = {};

/**
 * Resolve the active provider name.
 *
 * An explicit `ICON_PROVIDER` environment variable always wins (handy for
 * `mock` during development, or to pin a provider). Otherwise the provider is
 * resolved from the saved connection choice, falling back to the stored API key
 * for existing installations. An `sk-or-…` key selects OpenRouter, and anything
 * else selects OpenAI. Re-evaluated on every call so switching takes effect immediately.
 */
export function resolveProviderName(): ProviderName {
  const forced = process.env.ICON_PROVIDER?.trim() as ProviderName | undefined;
  if (forced === "mock" || forced === "openai" || forced === "openrouter" || forced === "codex") {
    return forced;
  }
  if (usesCodex()) return "codex";
  return detectProviderFromKey(getResolvedApiKey());
}

/**
 * Return the active provider, instantiating it on first use per name.
 *
 * Required configuration:
 *   - codex:     installed Codex with a ChatGPT sign-in
 *   - openai:     `sk-…` key in app preferences
 *   - openrouter: `sk-or-…` key in app preferences (model via OPENROUTER_MODEL)
 *   - mock:       none (placeholder images only, for local testing)
 */
export function getProvider(): ImageProvider {
  if (isConnectionDisconnected()) throw new Error("Choose a generation method in settings to continue.");
  const name = resolveProviderName();
  const existing = _instances[name];
  if (existing) return existing;

  let created: ImageProvider;
  switch (name) {
    case "codex":
      created = new CodexImageProvider();
      break;
    case "mock":
      created = new MockImageProvider();
      break;
    case "openrouter":
      created = new OpenRouterProvider();
      break;
    default:
      created = new OpenAIProvider();
  }
  _instances[name] = created;
  return created;
}

// ---------------------------------------------------------------------------
// Shared retry utility
// ---------------------------------------------------------------------------

/**
 * Run `fn` up to `maxAttempts` times.  On failure before the last attempt,
 * retries errors accepted by `shouldRetry` after a linear back-off.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  initialDelayMs = 1_000,
  shouldRetry: (error: unknown) => boolean = () => true
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && shouldRetry(err)) {
        await new Promise<void>((r) => setTimeout(r, initialDelayMs * attempt));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}
