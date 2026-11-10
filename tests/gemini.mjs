import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mainLoader } from "./helpers/load-main.mjs";

const source = (file) => fileURLToPath(new URL(`../src/main/lib/${file}.ts`, import.meta.url));
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/generated-images.json", import.meta.url), "utf8"));
const model = "gemini-nano-banana-2.1";
const catalog = (names) => ({ models: names.map((name) => ({ name: `models/${name}` })) });
const result = (format = "jpeg") => ({ status: "completed", steps: [{ type: "model_output", content: [
  { type: "image", data: fixtures[format], mime_type: `image/${format}` },
] }] });
const subject = (fetch, settings = { model, quality: "" }) => {
  const load = mainLoader({ fetch, prefs: { getString: () => "test-gemini-key", getObject: () => settings } });
  const models = load(source("image-models"));
  const { GeminiImageProvider } = load(source("providers/gemini"));
  return { ...models, provider: new GeminiImageProvider() };
};
const request = (overrides = {}) => ({ positivePrompt: "A blue flower icon", negativePrompt: "", count: 3, ...overrides });

test("Gemini follows model pagination, authenticates each page, and includes only documented image models", async () => {
  const calls = [];
  const app = subject(async (url, options) => {
    calls.push(url);
    assert.equal(options.method, "GET");
    assert.equal(options.headers["x-goog-api-key"], "key-one");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.body, undefined);
    assert.ok(!url.includes("key-one"));
    return Response.json(calls.length === 1
      ? { ...catalog(["gemini-3.8-flash", "gemini-2.5-flash-image", "gemini-3-pro-image"]), nextPageToken: "next +/" }
      : catalog([model, "gemini-3.1-flash-lite-image", "gemini-3.1-flash-image", "gemini-3-pro-image"]));
  });
  const models = await app.listImageModels("gemini", "key-one", true);
  assert.equal(models.length, 4);
  assert.equal(models[0].id, model);
  assert.ok(models.every((model) => model.qualities.length === 0));
  assert.equal(calls[1], "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=next%20%2B%2F");
  assert.equal(await app.listImageModels("gemini", "key-one"), models);
  assert.equal(calls.length, 2);
});

test("Gemini catalog changes and failed refreshes never reuse stale validation", async () => {
  let mode = "valid";
  let calls = 0;
  const app = subject(async (_url, options) => {
    calls++;
    if (mode === "rejected") return new Response("secret", { status: 403 });
    return Response.json(catalog([options.headers["x-goog-api-key"] === "first" ? model : "gemini-3-pro-image"]));
  });
  assert.equal((await app.listImageModels("gemini", "first"))[0].id, model);
  assert.equal((await app.listImageModels("gemini", "second"))[0].id, "gemini-3-pro-image");
  mode = "rejected";
  await assert.rejects(app.listImageModels("gemini", "second", true));
  await assert.rejects(app.listImageModels("gemini", "second"));
  assert.equal(calls, 4);
});

test("empty, malformed, and looping Gemini catalogs fail instead of offering guessed models", async () => {
  for (const response of [null, {}, { models: "broken" }, { models: [], nextPageToken: 42 }, catalog(["gemini-3.8-flash"])]) {
    const app = subject(async () => Response.json(response));
    await assert.rejects(app.listImageModels("gemini", "key"));
  }
  let calls = 0;
  const app = subject(async () => { calls++; return Response.json({ ...catalog([model]), nextPageToken: "same" }); });
  await assert.rejects(app.listImageModels("gemini", "key"), /invalid model catalog/);
  assert.equal(calls, 2);
});

test("Gemini maps credential, billing and quota errors without disclosing provider response text", async () => {
  for (const [status, error, code] of [
    [400, { details: [{ reason: "API_KEY_INVALID" }] }, "invalid_key"],
    [400, { details: [null, { reason: "API_KEY_EXPIRED" }] }, "invalid_key"],
    [400, { status: "FAILED_PRECONDITION" }, "billing"],
    [400, {}, "unsupported"], [401, {}, "invalid_key"], [402, {}, "billing"],
    [403, {}, "permissions"], [404, {}, "model_unavailable"], [429, {}, "rate_limit"], [503, {}, "service"],
  ]) {
    let calls = 0;
    const app = subject(async () => { calls++; return Response.json({ error: { ...error, message: "secret-provider-body" } }, { status }); });
    await assert.rejects(app.listImageModels("gemini", "key"), (failure) => failure.code === code && !failure.message.includes("secret"));
    assert.equal(calls, 1);
  }
  const app = subject(async () => new Response("secret-html", { status: 429 }));
  await assert.rejects(app.listImageModels("gemini", "key"), (error) => error.code === "rate_limit");
});

test("generation and refinement send square 1K inline requests with the chosen model", async () => {
  for (const referenceImageB64 of [undefined, fixtures.png]) {
    const calls = [];
    const app = subject(async (url, options) => {
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/interactions");
      assert.equal(options.headers["x-goog-api-key"], "test-gemini-key");
      assert.equal(options.headers["Api-Revision"], "2026-05-20");
      assert.equal(options.method, "POST");
      calls.push(JSON.parse(options.body));
      return Response.json(result());
    }, { model: "gemini-3-pro-image", quality: "" });
    const generated = await app.provider.generate(request({ referenceImageB64 }));
    assert.equal(generated.images.length, 3);
    assert.equal(calls.length, 3);
    for (const body of calls) {
      assert.equal(body.model, "gemini-3-pro-image");
      assert.equal(body.store, false);
      assert.equal(body.input[0].text, "A blue flower icon");
      assert.equal(body.input.length, referenceImageB64 ? 2 : 1);
      if (referenceImageB64) assert.deepEqual(body.input[1], { type: "image", mime_type: "image/png", data: fixtures.png });
      assert.deepEqual(body.response_format, { type: "image", mime_type: "image/jpeg", delivery: "inline", aspect_ratio: "1:1", image_size: "1K" });
      assert.equal(body.quality, undefined);
    }
  }
});

test("only final supported raster images enter the icon pipeline", async () => {
  for (const format of ["png", "jpeg", "webp"]) {
    const response = result(format);
    response.steps.unshift({ type: "thought", content: [{ type: "image", data: "not-artwork" }] });
    const app = subject(async () => Response.json(response));
    assert.equal((await app.provider.generate(request({ count: 1 }))).images[0], fixtures[format]);
  }
  for (const body of ["not json", null, { status: "failed" }, { status: "completed", steps: [] },
    { status: "completed", steps: [{ type: "model_output", content: [{ type: "image", data: fixtures.jpeg, mime_type: "image/png" }] }] },
    { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "declined" }] }] },
  ]) {
    let calls = 0;
    const app = subject(async () => { calls++; return typeof body === "string" ? new Response(body) : Response.json(body); });
    await assert.rejects(app.provider.generate(request()), /Gemini/);
    assert.equal(calls, 1, "never repeat a potentially billed request");
  }
});

test("partial success survives a later failure and stops further paid requests", async () => {
  let calls = 0;
  const app = subject(async () => ++calls === 1 ? Response.json(result()) : new Response("quota", { status: 429 }));
  assert.equal((await app.provider.generate(request())).images.length, 1);
  assert.equal(calls, 2);
});

test("Stop cancels the active Gemini request and prevents later variants", async () => {
  const controller = new AbortController();
  let calls = 0;
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  const app = subject((_url, { signal }) => {
    calls++;
    started();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("transport secret")), { once: true }));
  });
  const generating = app.provider.generate(request({ signal: controller.signal }));
  await pending;
  controller.abort(new Error("Stopped by user"));
  await assert.rejects(generating, /Stopped by user/);
  assert.equal(calls, 1);
  await assert.rejects(app.provider.generate(request({ signal: controller.signal })), /Stopped by user/);
  assert.equal(calls, 1);
});

test("unsupported model or quality cannot reach Gemini generation", async () => {
  const noRequest = () => { throw new Error("must not fetch"); };
  for (const settings of [{ model: "gemini-3.8-flash", quality: "" }, { model, quality: "high" }]) {
    await assert.rejects(subject(noRequest, settings).provider.generate(request()), /supported/);
  }
});
