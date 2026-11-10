export type ImageService = "openai" | "openrouter" | "gemini" | "mock";

export interface ImageModel {
  id: string;
  name: string;
  qualities: string[];
}

export interface ImageSettings {
  model: string;
  quality: string;
}

export const OPENAI_QUALITIES = ["low", "medium", "high", "auto"];
export const DEFAULT_OPENAI_MODEL = "gpt-image-2.5-flare";
export const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.1-flash-lite-image";
export const DEFAULT_GEMINI_MODEL = "gemini-nano-banana-2.1";

// Google's model catalog does not advertise image-input/output capabilities.
// Intersect it with documented models supporting generation AND refinement.
const GEMINI_IMAGE_MODELS = new Map([
  [DEFAULT_GEMINI_MODEL, "Nano Banana 2.1"],
  ["gemini-3.1-flash-lite-image", "Nano Banana 2 Lite"],
  ["gemini-3.1-flash-image", "Nano Banana 2"],
  ["gemini-3-pro-image", "Nano Banana Pro"],
]);

export function geminiModel(resourceName: unknown): ImageModel | undefined {
  if (typeof resourceName !== "string" || !resourceName.startsWith("models/")) return;
  const id = resourceName.slice("models/".length);
  const name = GEMINI_IMAGE_MODELS.get(id);
  // Keep Google's default thinking settings. OpenAI quality values don't apply.
  return name ? { id, name, qualities: [] } : undefined;
}

interface Capability {
  type: string;
  values?: string[];
  min?: number;
  max?: number;
}
type Parameters = Record<string, Capability | undefined>;

interface RouterModel {
  id: string;
  name: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: Parameters;
}

const values = (cap?: Capability): string[] =>
  cap?.type === "enum" && Array.isArray(cap.values) ? cap.values : [];

function supportsIconWorkflow(parameters: Parameters): boolean {
  const references = parameters.input_references;
  const formats = parameters.output_format?.values;
  return values(parameters.aspect_ratio).includes("1:1") &&
    (!Array.isArray(formats) || formats.includes("png")) &&
    references?.type === "range" && references.min === 0 &&
    (references.max ?? 0) >= 1;
}

// OpenAI's Models API does not expose parameter capabilities. Keep the common
// quality options here, including for snapshots.
export function openAIModel(id: string): ImageModel | undefined {
  if (!/^gpt-image-/.test(id) && id !== "chatgpt-image-latest") return;
  return {
    id,
    name: id === "chatgpt-image-latest" ? "ChatGPT Image Latest" : id
      .replace(/^gpt-image-/, "GPT Image ")
      .replace(/-(flare|sunburst|mini)/g, (_, tier: string) => ` ${tier[0].toUpperCase()}${tier.slice(1)}`)
      .replace(/-(\d{4}-\d{2}-\d{2})$/, " ($1)"),
    qualities: [...OPENAI_QUALITIES],
  };
}

export function routerModel(model: RouterModel): ImageModel | undefined {
  const parameters = model.supported_parameters ?? {};
  if (!model.architecture?.input_modalities?.includes("text") ||
      !model.architecture.output_modalities?.includes("image") ||
      !supportsIconWorkflow(parameters) || /vector/i.test(model.id)) return;
  const qualities = values(parameters.quality);
  return {
    id: model.id,
    name: model.name,
    // Keep OpenAI controls consistent whether used directly or via OpenRouter.
    qualities: model.id.startsWith("openai/")
      ? OPENAI_QUALITIES.filter((quality) => qualities.includes(quality))
      : qualities,
  };
}

export function validateSettings(settings: ImageSettings, model: ImageModel): void {
  if (settings.model !== model.id ||
      (model.qualities.length ? !model.qualities.includes(settings.quality) : settings.quality !== "")) {
    throw new Error("These settings are not supported by the selected model. Refresh the model list and try again.");
  }
}

export class ProviderRequestError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** Authenticated Gemini requests; never put keys in URLs or forward provider text. */
export async function requestGeminiJSON<T>(
  path: string, apiKey: string, body?: unknown, signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(body === undefined ? 15_000 : 180_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  let json;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-goog-api-key": apiKey,
        ...(body === undefined ? {} : { "Content-Type": "application/json", "Api-Revision": "2026-05-20" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: requestSignal,
    });
  } catch {
    signal?.throwIfAborted();
    throw new ProviderRequestError("Could not connect to Gemini. Check your connection and try again.", "connection");
  }
  try {
    json = await response.json();
  } catch {
    signal?.throwIfAborted();
    // Preserve the HTTP failure category even when Google returns an HTML error.
    if (response.ok) throw new ProviderRequestError("Gemini returned an incomplete or invalid response. Please try again.", "service");
  }
  signal?.throwIfAborted();
  if (!response.ok) {
    const reasons = Array.isArray(json?.error?.details)
      ? json.error.details.map((detail: { reason?: string } | null) => detail?.reason) : [];
    if (response.status === 401 || reasons.some((reason: string) => ["API_KEY_INVALID", "API_KEY_EXPIRED"].includes(reason))) {
      throw new ProviderRequestError("Gemini rejected this API key. Create or check the key in Google AI Studio.", "invalid_key");
    }
    if (response.status === 402 || json?.error?.status === "FAILED_PRECONDITION") {
      throw new ProviderRequestError("Gemini requires an eligible project with paid API billing and available credits. Check Google AI Studio billing.", "billing");
    }
    if (response.status === 403) throw new ProviderRequestError("This key cannot access Gemini. Check its API restrictions, project permissions, billing, and region in Google AI Studio.", "permissions");
    if (response.status === 429) throw new ProviderRequestError("Gemini's rate limit or quota has been reached. Check your project limits and billing in Google AI Studio, or try again later.", "rate_limit");
    if (response.status === 404) throw new ProviderRequestError("This Gemini model is unavailable. Refresh the model list and choose another model.", "model_unavailable");
    if (response.status === 400) throw new ProviderRequestError("Gemini could not accept this request. Check the key's restrictions or choose another supported image model.", "unsupported");
    throw new ProviderRequestError(`Gemini could not complete the request (${response.status}). Try again later.`, "service");
  }
  return json as T;
}

async function listGeminiModels(apiKey: string): Promise<ImageModel[]> {
  const models = new Map<string, ImageModel>();
  const pages = new Set<string>();
  let token = "";
  do {
    if (pages.has(token) || pages.size >= 100) throw new ProviderRequestError("Gemini returned an invalid model catalog. Try again later.", "service");
    pages.add(token);
    const response = await requestGeminiJSON<{ models?: Array<{ name?: unknown } | null>; nextPageToken?: string }>(
      `models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, apiKey
    );
    if (!response || (response.models !== undefined && !Array.isArray(response.models)) ||
        (response.nextPageToken !== undefined && typeof response.nextPageToken !== "string")) {
      throw new ProviderRequestError("Gemini returned an invalid model catalog. Try again later.", "service");
    }
    for (const item of response.models ?? []) {
      const model = geminiModel(item?.name);
      if (model) models.set(model.id, model);
    }
    token = response.nextPageToken ?? "";
  } while (token);
  return [...models.values()];
}

async function getJSON<T>(url: string, apiKey?: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch {
    signal?.throwIfAborted();
    throw new ProviderRequestError("Could not connect to the provider. Check your connection and try again.", "connection");
  }
  if (!response.ok) {
    // Do not forward provider response bodies that might include credentials.
    if (response.status === 401) throw new ProviderRequestError("The provider rejected this API key (401). Check the key and try again.", "invalid_key");
    if (response.status === 403) throw new ProviderRequestError("This key does not have permission to access the provider. Check its permissions and account access.", "permissions");
    if (response.status === 429) throw new ProviderRequestError("The provider is limiting requests. Wait a moment and try again.", "rate_limit");
    throw new ProviderRequestError(`The provider could not complete the request (${response.status}). Try again later.`, "service");
  }
  try {
    return await response.json() as T;
  } catch {
    signal?.throwIfAborted();
    throw new ProviderRequestError("The provider returned an unexpected response. Try again later.", "service");
  }
}

let cached: { provider: ImageService; key: string; expires: number; models: ImageModel[] } | undefined;

export async function listImageModels(provider: ImageService, apiKey: string, refresh = false): Promise<ImageModel[]> {
  if (provider === "mock") return [{ id: "mock", name: "Local preview", qualities: [] }];
  if (!apiKey) throw new Error("Add an API key to load models.");
  if (!refresh && cached?.provider === provider && cached.key === apiKey && cached.expires > Date.now()) {
    return cached.models;
  }
  // A failed refresh must not leave an older successful validation in use.
  cached = undefined;
  let models: ImageModel[];
  if (provider === "openai") {
    const response = await getJSON<{ data: Array<{ id: string }> }>("https://api.openai.com/v1/models", apiKey);
    models = response.data.map(({ id }) => openAIModel(id)).filter((model): model is ImageModel => !!model);
  } else if (provider === "gemini") {
    models = await listGeminiModels(apiKey);
  } else {
    // The model catalog is public, so it cannot establish that a key is valid.
    const key = await getJSON<{ data: { is_management_key?: boolean } }>("https://openrouter.ai/api/v1/key", apiKey);
    if (!key.data || key.data.is_management_key) {
      throw new ProviderRequestError("Use an OpenRouter inference API key with permission to generate images.", "permissions");
    }
    const response = await getJSON<{ data: RouterModel[] }>("https://openrouter.ai/api/v1/images/models");
    models = response.data.map(routerModel).filter((model): model is ImageModel => !!model);
  }
  const preferred = provider === "openai" ? DEFAULT_OPENAI_MODEL : provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_OPENROUTER_MODEL;
  models.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred) || a.name.localeCompare(b.name));
  if (!models.length) throw new Error("No compatible image models were found for this provider.");
  cached = { provider, key: apiKey, models, expires: Date.now() + 5 * 60_000 };
  return models;
}

/** Confirm quality and reference support on the same endpoint. */
export async function compatibleRouterProviders(settings: ImageSettings, signal?: AbortSignal): Promise<string[]> {
  const id = settings.model.split("/").map(encodeURIComponent).join("/");
  const response = await getJSON<{ endpoints: Array<{ provider_tag?: string | null; supported_parameters: Parameters }> }>(
    `https://openrouter.ai/api/v1/images/models/${id}/endpoints`, undefined, signal
  );
  const compatible = response.endpoints.filter(({ supported_parameters: parameters }) =>
    supportsIconWorkflow(parameters) &&
    (!settings.quality || values(parameters.quality).includes(settings.quality))
  );
  if (!compatible.length) throw new Error("No provider supports this quality for generation and editing. Choose a different quality.");
  // Some models have no provider-level routing. Otherwise pin eligible endpoints
  // so an unsupported option cannot be silently ignored by another provider.
  return compatible.some((endpoint) => !endpoint.provider_tag)
    ? [] : compatible.map((endpoint) => endpoint.provider_tag!);
}
