/**
 * System-level design constraints prepended to every icon generation request.
 * Users should never directly control the full prompt — these constraints drive
 * the majority of output quality.  Reducing prompt entropy (fewer adjectives,
 * stricter rules) keeps output consistent across generations.
 */
const SYSTEM_PREFIX =
  "Premium macOS app icon artwork, centered composition, single object only, " +
  "no text, no letters, no UI mockup, " +
  "clean cohesive background, " +
  "opaque square artwork with background extending to every edge, " +
  "keep the complete subject comfortably inside the central 80 percent of the canvas, " +
  "keep important details out of the corners for later masking, " +
  "NO rounded rectangle container, NO squircle, NO icon plate, " +
  "NO app icon frame, NO border, NO bezel, NO tile background, " +
  "NO outer drop shadow, NO transparent padding, NO empty margins, " +
  "the app will add the icon silhouette, margins and outer shadow after generation, " +
  "background is part of the artwork itself, not a separate shape or container, " +
  "balanced full-canvas composition, " +
  "minimalistic, clean, high contrast, " +
  "3D depth with soft studio lighting, " +
  "premium material rendering, subtle gradients, " +
  "SF Symbols inspired simplicity, " +
  "macOS native aesthetic";

/**
 * Concepts to steer the model away from.  The active image provider may or may
 * not use this string; OpenAI image models rely mainly on the positive prompt.
 */
export const NEGATIVE_PROMPT =
  "rounded rectangle, squircle, icon container, app icon frame, " +
  "border, bezel, tile, plate, inset shape, background card, " +
  "floating tile, glossy badge, app store icon style, " +
  "UI frame, rounded corners, framed object, " +
  "outer drop shadow, transparent padding, empty margins, " +
  "text, letters, watermark, multiple objects, clutter, " +
  "blurry, noisy, distorted, photorealistic photo";

export interface BuiltPrompt {
  positive: string;
  negative: string;
}

/**
 * Wrap the user's intent in system-level macOS icon design constraints.
 *
 * The caller provides the raw user intent (e.g. "clipboard manager icon") and
 * receives a fully-formed prompt pair ready to send to any image provider.
 */
export function buildPrompt(userIntent: string): BuiltPrompt {
  const intent = userIntent.trim();
  return {
    positive: `${SYSTEM_PREFIX}, ${intent}`,
    negative: NEGATIVE_PROMPT,
  };
}
