import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mainLoader } from "./helpers/load-main.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/generated-images.json", import.meta.url), "utf8"));
const source = file => path.resolve(`src/main/lib/${file}.ts`);
const request = { positivePrompt: "Keep the shape, use the reference colors", negativePrompt: "", count: 1,
  referenceImageB64: fixtures.png, additionalReferenceImageB64: fixtures.jpeg };
const endpoint = (provider_tag, max, qualities = ["low"]) => ({ provider_tag, supported_parameters: {
  aspect_ratio: { type: "enum", values: ["1:1"] }, output_format: { type: "enum", values: ["png"] },
  input_references: { type: "range", min: 0, max }, quality: { type: "enum", values: qualities },
} });
function subject(provider, model, fetch, quality = "") {
  const load = mainLoader({ env: { ICON_PROVIDER: provider }, fetch,
    prefs: { getString: () => "test-key", getObject: () => ({ model, quality }) } });
  return { load, support: () => load(source("reference-support")).getReferenceSupport() };
}

test("OpenAI multipart edits contain both distinct inputs in base-first order", async () => {
  let calls = 0;
  const s = subject("openai", "gpt-image-2.5-flare", async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/images/edits");
    const images = options.body.getAll("image[]");
    assert.equal(images.length, 2);
    assert.deepEqual(await Promise.all(images.map(async image => Buffer.from(await image.arrayBuffer()).toString("base64"))), [fixtures.png, fixtures.jpeg]);
    assert.equal(options.body.get("image"), null);
    return Response.json({ data: [{ b64_json: fixtures.png }] });
  });
  await new (s.load(source("providers/openai")).OpenAIProvider)().generate(request);
  assert.equal(calls, 1);
});

test("Gemini sends the current icon and reference together with the instruction", async () => {
  const s = subject("gemini", "gemini-nano-banana-2.1", async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.input[0].text, request.positivePrompt);
    assert.deepEqual(body.input.filter(item => item.type === "image").map(item => item.data), [fixtures.png, fixtures.jpeg]);
    return Response.json({ status: "completed", steps: [{ type: "model_output", content: [{ type: "image", data: fixtures.png }] }] });
  });
  await new (s.load(source("providers/gemini")).GeminiImageProvider)().generate(request);
});

test("OpenRouter restricts two-image edits to an endpoint supporting both count and quality", async () => {
  let posts = 0;
  const s = subject("openrouter", "example/image", async (url, options) => {
    if (url.endsWith("/endpoints")) return Response.json({ endpoints: [endpoint("one", 1), endpoint("two-high", 2, ["high"]), endpoint("two", 2)] });
    posts++;
    const body = JSON.parse(options.body);
    assert.deepEqual(body.provider, { only: ["two"], allow_fallbacks: false });
    assert.deepEqual(body.input_references.map(image => image.image_url.url), [fixtures.png, fixtures.jpeg].map(data => `data:image/png;base64,${data}`));
    return Response.json({ data: [{ b64_json: fixtures.png }] });
  }, "low");
  assert.equal((await s.support()).status, "supported");
  await new (s.load(source("providers/openrouter")).OpenRouterProvider)().generate(request);
  assert.equal(posts, 1);
});

test("single-reference and unsafe untagged routing are blocked before billed requests", async () => {
  for (const endpoints of [[endpoint("one", 1)], [endpoint(null, 2), endpoint("one", 1)]]) {
    let posts = 0;
    const s = subject("openrouter", "example/image", async (url) => {
      if (url.endsWith("/endpoints")) return Response.json({ endpoints });
      posts++; throw new Error("Must not generate");
    }, "low");
    assert.equal((await s.support()).status, "unsupported");
    await assert.rejects(new (s.load(source("providers/openrouter")).OpenRouterProvider)().generate(request), /additional reference/);
    assert.equal(posts, 0);
  }
});

test("catalog failure stays retryable and is not reported as unsupported", async () => {
  for (const response of [() => { throw new Error("offline") }, () => Response.json({}), () => new Response("unavailable", { status: 503 })]) {
    const s = subject("openrouter", "example/image", response);
    assert.equal((await s.support()).status, "error");
  }
});

test("direct providers use documented families and future models remain unknown", async () => {
  for (const [provider, model, expected] of [
    ["openai", "gpt-image-2.5-flare", "supported"], ["openai", "gpt-image-2.6-sunburst-2026-11-04", "supported"],
    ["openai", "gpt-image-future", "unknown"], ["gemini", "gemini-nano-banana-2.1", "supported"],
    ["gemini", "gemini-future-image", "unknown"], ["codex", "", "supported"], ["mock", "", "supported"],
  ]) {
    const s = subject(provider, model, () => { throw new Error("No network request expected") });
    assert.equal((await s.support()).status, expected, model);
  }
});

test("the prompt assigns roles to both inputs without replacing the user's instruction", () => {
  const { buildPrompt } = subject("mock", "mock").load(source("prompt-builder"));
  const result = buildPrompt("Use the colors, keep the shape.", true);
  assert.match(result.positive, /Image 1 is the current icon to edit/);
  assert.match(result.positive, /Image 2 is an additional reference/);
  assert.ok(result.positive.endsWith("User instruction: Use the colors, keep the shape."));
  assert.ok(!buildPrompt("New icon").positive.includes("Image 2"));
});
