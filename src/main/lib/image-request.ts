import { withRetry } from "./image-provider";

class ImageHttpError extends Error {
  constructor(readonly status: number, provider: string) {
    super(`${provider} API error ${status}. Check your connection settings and try again.`);
  }
}

class ImageResponseError extends Error {}

/** Cancel both the HTTP request and back-off, without repeating a completed generation. */
export async function requestImages(
  url: string,
  options: RequestInit,
  provider: string,
  signal?: AbortSignal
): Promise<string[]> {
  const body = await withRetry(async () => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal!.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 180_000);
    try {
      signal?.throwIfAborted();
      const response = await fetch(url, { ...options, signal: controller.signal });
      signal?.throwIfAborted();
      if (!response.ok) {
        // Release the body without forwarding potentially sensitive provider text.
        await response.body?.cancel().catch(() => {});
        throw new ImageHttpError(response.status, provider);
      }
      // A 2xx request may already be billed. Body/decode failures must never
      // cause another generation, even if the connection fails during reading.
      try {
        return await response.text();
      } catch {
        throw new ImageResponseError(`${provider} returned an incomplete image response. Please try again.`);
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }, 3, 1_000, (error) => {
    if (error instanceof ImageResponseError) return false;
    if (error instanceof ImageHttpError) {
      return error.status === 408 || error.status === 429 || error.status >= 500;
    }
    return true;
  }, signal);

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`${provider} returned an invalid image response.`);
  }
  // Keep usable variants when another entry is missing or has an unsupported format.
  const images: string[] = [];
  if (Array.isArray(json?.data)) {
    for (const item of json.data) {
      if (typeof item?.b64_json !== "string") continue;
      const bytes = Buffer.from(item.b64_json, "base64");
      const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
          ? "image/jpeg"
          : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
            ? "image/webp" : null;
      if (mime && (!item.media_type || item.media_type === mime)) images.push(item.b64_json);
    }
  }
  if (!images.length) throw new Error(`${provider} returned no supported image. Choose a model that outputs PNG, JPEG, or WebP.`);
  return images;
}
