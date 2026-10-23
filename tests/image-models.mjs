import assert from "node:assert/strict";
import { test } from "node:test";
import { openAIModel, routerModel, validateSettings, compatibleRouterProviders, listImageModels } from "../src/main/lib/image-models.ts";

const parameters = {
  aspect_ratio: { type: "enum", values: ["1:1"] },
  input_references: { type: "range", min: 0, max: 4 },
};
const model = (overrides = {}) => ({
  id: "example/image", name: "Example Image",
  architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
  supported_parameters: parameters,
  ...overrides,
});

test("OpenAI excludes text models and limits every image model to the four common quality options", () => {
  assert.equal(openAIModel("gpt-6"), undefined);
  for (const id of ["gpt-image-1", "gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst-2026-09-08"]) {
    assert.deepEqual(openAIModel(id).qualities, ["low", "medium", "high", "auto"]);
  }
});

test("the icon catalog excludes text-only, vector, edit-only and non-square models", () => {
  assert.equal(routerModel(model({ architecture: { input_modalities: ["text"], output_modalities: ["text"] } })), undefined);
  assert.equal(routerModel(model({ id: "example/vector" })), undefined);
  assert.equal(routerModel(model({ supported_parameters: { ...parameters, input_references: { type: "range", min: 1, max: 4 } } })), undefined);
  assert.equal(routerModel(model({ supported_parameters: { ...parameters, aspect_ratio: { type: "enum", values: ["16:9"] } } })), undefined);
});

test("OpenRouter controls use advertised quality values", () => {
  assert.deepEqual(routerModel(model()).qualities, []);
  const result = routerModel(model({ id: "openai/gpt-image-2.5-flare", supported_parameters: {
    ...parameters, quality: { type: "enum", values: ["auto", "low", "high", "xhigh", "max"] },
  } }));
  assert.deepEqual(result.qualities, ["low", "high", "auto"]);
});

test("unsupported settings are rejected before generation", () => {
  const flare = openAIModel("gpt-image-2.5-flare");
  const settings = { model: flare.id, quality: "low" };
  validateSettings(settings, flare);
  for (const invalid of [{ quality: "max" }, { model: "another-model" }]) {
    assert.throws(() => validateSettings({ ...settings, ...invalid }, flare));
  }
  assert.throws(() => validateSettings({ model: "example/image", quality: "low" }, routerModel(model())));
});

test("quality and editing support must coexist on one OpenRouter endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ endpoints: [
    { provider_tag: "fast", supported_parameters: { ...parameters, quality: { type: "enum", values: ["low"] } } },
    { provider_tag: "text-only", supported_parameters: { aspect_ratio: parameters.aspect_ratio, quality: { type: "enum", values: ["high"] } } },
  ] });
  try {
    assert.deepEqual(await compatibleRouterProviders({ model: "example/image", quality: "low" }), ["fast"]);
    await assert.rejects(compatibleRouterProviders({ model: "example/image", quality: "high" }), /No provider supports/);
  } finally { globalThis.fetch = originalFetch }
});

test("changing API keys reloads account models and catalog errors do not become empty success", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(options.headers.Authorization);
    return Response.json({ data: [{ id: calls.length === 1 ? "gpt-image-1" : "gpt-image-2" }] });
  };
  try {
    const first = await listImageModels("openai", "test-key-one", true);
    const cached = await listImageModels("openai", "test-key-one");
    assert.deepEqual(first, cached);
    const second = await listImageModels("openai", "test-key-two");
    assert.equal(second[0].id, "gpt-image-2");
    assert.equal(calls.length, 2);
    globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
    await assert.rejects(listImageModels("openai", "test-key-two", true), /401/);
  } finally { globalThis.fetch = originalFetch }
});
