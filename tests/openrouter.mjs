import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mainLoader } from "./helpers/load-main.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/generated-images.json", import.meta.url), "utf8"));

// Load the real provider and retry code without the native MōBrowser runtime.
// Preferences and HTTP are isolated; no keys or paid generation are used.
function providerWith(response) {
  let calls = 0;
  const prefs = {
    getString: () => "test-key",
    getObject: () => ({ model: "example/image", quality: "" }),
  };
  const fetch = async (url, options) => {
    if (url.endsWith("/endpoints")) return Response.json({ endpoints: [{
      provider_tag: "example",
      supported_parameters: {
        aspect_ratio: { type: "enum", values: ["1:1"] },
        input_references: { type: "range", min: 0, max: 1 },
      },
    }] });
    assert.equal(url, "https://openrouter.ai/api/v1/images");
    assert.equal(options.method, "POST");
    return response(++calls, JSON.parse(options.body));
  };
  const load = mainLoader({ prefs, fetch });
  const { OpenRouterProvider } = load(path.join(root, "src/main/lib/providers/openrouter.ts"));
  const provider = new OpenRouterProvider();
  return {
    generate: (count = 3) => provider.generate({ positivePrompt: "test icon", negativePrompt: "", count }),
    calls: () => calls,
  };
}

for (const format of ["png", "jpeg", "webp"]) {
  for (const advertised of [true, false]) {
    test(`${format} results survive with${advertised ? "" : "out"} MIME metadata and no extra requests`, async () => {
      const subject = providerWith(() => Response.json({ data: [{
        b64_json: fixtures[format], ...(advertised ? { media_type: `image/${format}` } : {}),
      }] }));
      const result = await subject.generate();
      assert.equal(result.images.length, 3);
      assert.ok(result.images.every((image) => image === fixtures[format]));
      assert.equal(subject.calls(), 3);
    });
  }
}

test("unusable successful responses never repeat completed generation", async () => {
  for (const body of [
    "not JSON", "null", JSON.stringify({ data: [] }),
    JSON.stringify({ data: [{ b64_json: "invalid base64" }] }),
    JSON.stringify({ data: [{ b64_json: Buffer.from("<svg/>").toString("base64"), media_type: "image/svg+xml" }] }),
    JSON.stringify({ data: [{ b64_json: fixtures.jpeg, media_type: "image/png" }] }),
  ]) {
    const subject = providerWith(() => new Response(body));
    await assert.rejects(subject.generate(), /OpenRouter returned/);
    assert.equal(subject.calls(), 3);
  }
});

test("a malformed variant does not discard successful raster variants", async () => {
  const subject = providerWith((call) => call === 1 ? new Response("bad JSON")
    : Response.json({ data: [{ b64_json: fixtures.webp, media_type: "image/webp" }] }));
  const result = await subject.generate();
  assert.equal(result.images.length, 2);
  assert.equal(subject.calls(), 3);
});

test("transient HTTP failures retry but permanent failures do not", async () => {
  for (const status of [429, 500, 503]) {
    const subject = providerWith((call) => call === 1 ? new Response("temporary", { status })
      : Response.json({ data: [{ b64_json: fixtures.png }] }));
    assert.equal((await subject.generate(1)).images.length, 1);
    assert.equal(subject.calls(), 2);
  }
  for (const status of [400, 401, 403]) {
    const subject = providerWith(() => new Response("rejected", { status }));
    await assert.rejects(subject.generate(1), new RegExp(String(status)));
    assert.equal(subject.calls(), 1);
  }
});
