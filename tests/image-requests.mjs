import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mainLoader } from "./helpers/load-main.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/generated-images.json", import.meta.url), "utf8"));
const success = () => Response.json({ data: [{ b64_json: fixtures.png }] });
const endpoints = () => Response.json({ endpoints: [{ provider_tag: "example", supported_parameters: {
  aspect_ratio: { type: "enum", values: ["1:1"] }, input_references: { type: "range", min: 0, max: 1 },
} }] });

function subject(service, respond, { lookup = endpoints, timers } = {}) {
  const calls = [];
  let lookups = 0;
  const load = mainLoader({
    prefs: { getString: () => "test-key", getObject: () => ({ model: service === "openai" ? "gpt-image-1" : "example/image", quality: service === "openai" ? "low" : "" }) },
    fetch: async (url, options) => {
      if (url.endsWith("/endpoints")) { lookups++; return lookup(options); }
      calls.push({ url, ...options });
      return respond(options, calls.length);
    },
    timers,
  });
  const exports = load(path.join(root, `src/main/lib/providers/${service}.ts`));
  const Provider = exports[service === "openai" ? "OpenAIProvider" : "OpenRouterProvider"];
  return {
    generate: (options = {}) => new Provider().generate({ positivePrompt: "test icon", negativePrompt: "", count: 3, ...options }),
    calls,
    lookups: () => lookups,
  };
}

for (const service of ["openai", "openrouter"]) {
  for (const edit of [false, true]) {
    const reference = edit ? { referenceImageB64: fixtures.png } : {};
    const label = `${service} ${edit ? "editing" : "generation"}`;
    test(`${label}: an already canceled request performs no HTTP`, async () => {
      const controller = new AbortController(); controller.abort();
      const s = subject(service, success);
      await assert.rejects(s.generate({ ...reference, signal: controller.signal }), { name: "AbortError" });
      assert.equal(s.calls.length, 0);
      assert.equal(s.lookups(), 0);
    });

    test(`${label}: Stop aborts all running variants without retries`, async () => {
      const controller = new AbortController();
      const expected = service === "openai" ? 1 : 3;
      let started = 0;
      const s = subject(service, ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (++started === expected) queueMicrotask(() => controller.abort());
      }));
      await assert.rejects(s.generate({ ...reference, signal: controller.signal }), { name: "AbortError" });
      assert.equal(s.calls.length, expected);
      assert.ok(s.calls.every(({ signal }) => signal.aborted));
    });

    test(`${label}: late HTTP success after Stop is rejected`, async () => {
      const controller = new AbortController();
      const s = subject(service, () => { controller.abort(); return success(); });
      await assert.rejects(s.generate({ ...reference, signal: controller.signal }), { name: "AbortError" });
      assert.ok(s.calls.every(({ signal }) => signal.aborted));
    });

    test(`${label}: Stop interrupts retry back-off`, async () => {
      const controller = new AbortController();
      const s = subject(service, () => new Response("busy", { status: 503 }), { timers: {
        setTimeout: (callback, delay) => {
          if (delay === 1000) queueMicrotask(() => controller.abort());
          return setTimeout(callback, delay);
        },
      } });
      await assert.rejects(s.generate({ ...reference, count: 1, signal: controller.signal }), { name: "AbortError" });
      assert.equal(s.calls.length, 1);
    });

    test(`${label}: successful response body failures never repeat generation`, async () => {
      const s = subject(service, () => ({ ok: true, text: async () => { throw new Error("connection interrupted"); } }));
      await assert.rejects(s.generate({ ...reference, count: 1 }), /incomplete image response/);
      assert.equal(s.calls.length, 1);
    });

    test(`${label}: Stop interrupts successful response body reading`, async () => {
      const controller = new AbortController();
      const s = subject(service, ({ signal }) => ({ ok: true, text: () => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        queueMicrotask(() => controller.abort());
      }) }));
      await assert.rejects(s.generate({ ...reference, count: 1, signal: controller.signal }), { name: "AbortError" });
      assert.equal(s.calls.length, 1);
    });
  }
}

test("OpenRouter cancels endpoint discovery before starting any generation", async () => {
  const controller = new AbortController();
  const s = subject("openrouter", success, { lookup: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    queueMicrotask(() => controller.abort());
  }) });
  await assert.rejects(s.generate({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(s.calls.length, 0);
});

test("OpenRouter preserves cancellation while reading the endpoint response body", async () => {
  const controller = new AbortController();
  const s = subject("openrouter", success, { lookup: ({ signal }) => ({
    ok: true,
    json: () => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      queueMicrotask(() => controller.abort());
    }),
  }) });
  await assert.rejects(s.generate({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(s.calls.length, 0);
});

for (const edit of [false, true]) {
  const reference = edit ? { referenceImageB64: fixtures.png } : {};
  const label = `OpenAI ${edit ? "editing" : "generation"}`;
  test(`${label}: valid results and settings use one batch request`, async () => {
    const s = subject("openai", () => Response.json({ data: [null, { b64_json: "bad" }, ...["png", "jpeg", "webp"].map((format) => ({ b64_json: fixtures[format] }))] }));
    assert.deepEqual(Array.from((await s.generate(reference)).images), [fixtures.png, fixtures.jpeg, fixtures.webp]);
    assert.equal(s.calls.length, 1);
    const { url, body } = s.calls[0];
    const parameters = edit ? Object.fromEntries(body) : JSON.parse(body);
    assert.equal(url, `https://api.openai.com/v1/images/${edit ? "edits" : "generations"}`);
    assert.equal(parameters.model, "gpt-image-1");
    assert.equal(String(parameters.n), "3");
    assert.equal(parameters.quality, "low");
    if (edit) assert.equal(Buffer.from(await parameters.image.arrayBuffer()).toString("base64"), fixtures.png);
  });

  test(`${label}: permanent errors do not retry`, async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const s = subject("openai", () => new Response("permanent failure", { status }));
      await assert.rejects(s.generate(reference), new RegExp(String(status)));
      assert.equal(s.calls.length, 1);
    }
  });

  test(`${label}: malformed successful responses do not retry`, async () => {
    for (const body of ["not JSON", "null", "{}", '{"data":[]}', '{"data":[null,{"b64_json":"invalid"}]}']) {
      const s = subject("openai", () => new Response(body));
      await assert.rejects(s.generate(reference), /OpenAI returned/);
      assert.equal(s.calls.length, 1);
    }
  });

  test(`${label}: transient HTTP and network errors still retry`, async () => {
    for (const status of [408, 429, 500, 503, "network"]) {
      const s = subject("openai", (options, call) => {
        if (call > 1) return success();
        if (status === "network") throw new TypeError("fetch failed");
        return new Response("temporary", { status });
      });
      assert.equal((await s.generate(reference)).images.length, 1);
      assert.equal(s.calls.length, 2);
    }
  });
}

for (const service of ["openai", "openrouter"]) {
  test(`${service}: request timeouts abort HTTP and stop after three attempts`, async () => {
    const signals = [];
    const s = subject(service, ({ signal }) => new Promise((resolve, reject) => {
      signals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }), { timers: { setTimeout: (callback) => setTimeout(callback, 0) } });
    await assert.rejects(s.generate({ count: 1 }), { name: "AbortError" });
    assert.equal(signals.length, 3);
    assert.ok(signals.every((signal) => signal.aborted));
  });
}
