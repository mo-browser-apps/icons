import { resolveProviderName } from "./image-provider";
import { getImageSettings } from "./generation-settings";
import { isConnectionDisconnected } from "./generation-connection";
import { compatibleRouterProviders, geminiModel, openAIReferenceLimit, ProviderRequestError } from "./image-models";
import type { ReferenceSupportResponse } from "../gen/app";

/** Read-only capability check; never probes support by generating a billed image. */
export async function getReferenceSupport(): Promise<ReferenceSupportResponse> {
  if (isConnectionDisconnected()) return { status: "unknown", message: "Connect to a generation method to use this reference." };
  const provider = resolveProviderName();
  // The existing ChatGPT integration requires a version with built-in image editing.
  if (provider === "codex" || provider === "mock") return { status: "supported", message: "" };
  const settings = getImageSettings(provider);
  if (provider === "openrouter") {
    try {
      await compatibleRouterProviders(settings, undefined, 2);
      return { status: "supported", message: "" };
    } catch (error) {
      return error instanceof ProviderRequestError && error.code === "reference_unsupported"
        ? { status: "unsupported", message: "This model can edit your current icon, but can’t use an additional reference with these settings." }
        : { status: "error", message: "Couldn’t check whether this model supports an extra reference. Try again." };
    }
  }
  const limit = provider === "openai" ? openAIReferenceLimit(settings.model)
    : geminiModel(`models/${settings.model}`)?.maxReferenceImages ?? 0;
  return limit >= 2 ? { status: "supported", message: "" }
    : { status: "unknown", message: "Reference editing isn’t confirmed for this model. Choose a supported model or remove the reference." };
}
