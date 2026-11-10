import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mainLoader } from "./helpers/load-main.mjs";

const source = (file) => fileURLToPath(new URL(`../src/${file}`, import.meta.url));
const { generationErrorSuggestsConnectionIssue } = mainLoader({})(source("renderer/lib/generation-errors.ts"));

test("Gemini authentication failures offer generation settings using the adapter's actual messages", async () => {
  for (const [status, details] of [
    [400, [{ reason: "API_KEY_INVALID" }]],
    [400, [{ reason: "API_KEY_EXPIRED" }]],
    [401, []],
    [403, []],
    [403, null],
  ]) {
    const load = mainLoader({ fetch: async () => details === null
      ? new Response("provider-secret", { status })
      : Response.json({ error: { details, message: "provider-secret" } }, { status }) });
    const { requestGeminiJSON } = load(source("main/lib/image-models.ts"));
    await assert.rejects(requestGeminiJSON("interactions", "test-key", {}), (error) => {
      assert.ok(["invalid_key", "permissions"].includes(error.code));
      assert.equal(generationErrorSuggestsConnectionIssue(error.message), true, error.message);
      assert.ok(!error.message.includes("provider-secret"));
      return true;
    });
  }
});

test("Gemini billing, quota and service failures do not suggest replacing the API key", async () => {
  for (const status of [402, 429, 503]) {
    const load = mainLoader({ fetch: async () => Response.json({ error: {} }, { status }) });
    const { requestGeminiJSON } = load(source("main/lib/image-models.ts"));
    await assert.rejects(requestGeminiJSON("interactions", "test-key", {}), (error) => {
      assert.equal(generationErrorSuggestsConnectionIssue(error.message), false, error.message);
      return true;
    });
  }
});

test("existing provider connection errors still offer settings, while generation failures do not", () => {
  for (const message of [
    "The provider rejected this API key (401). Check the key and try again.",
    "This key does not have permission (403).",
    "Incorrect API key provided.",
    "Your API key has expired.",
    "Sign in to ChatGPT to continue.",
    "Codex could not connect.",
  ]) assert.equal(generationErrorSuggestsConnectionIssue(message), true, message);
  for (const message of [
    "Gemini returned no supported image. It may have declined the request.",
    "Could not connect to Gemini. Check your connection and try again.",
    "No usable images were returned. Please try again.",
  ]) assert.equal(generationErrorSuggestsConnectionIssue(message), false, message);
});
