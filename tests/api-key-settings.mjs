import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mainLoader } from "./helpers/load-main.mjs";

const keyPref = "openai.apiKey";
const defaultModel = "gpt-image-2.5-flare";
const catalog = () => Response.json({ data: [{ id: defaultModel }, { id: "gpt-image-1" }] });
const routerCatalog = () => Response.json({ data: [{
  id: "example/image", name: "Example Image",
  architecture: { input_modalities: ["text"], output_modalities: ["image"] },
  supported_parameters: {
    aspect_ratio: { type: "enum", values: ["1:1"] },
    input_references: { type: "range", min: 0, max: 1 },
  },
}] });

function subject(fetch, initial = { [keyPref]: "previous-key" }, persist = true, env = {}) {
  const values = new Map(Object.entries(initial));
  let writes = 0;
  const prefs = {
    getString: (key) => values.get(key) ?? "",
    getObject: (key, fallback) => values.get(key) ?? fallback,
    hasString: (key) => values.has(key),
    hasObject: (key) => values.has(key),
    setString: (key, value) => values.set(key, value),
    setObject: (key, value) => values.set(key, value),
    remove: (key) => values.delete(key),
    persist: () => { writes++; return persist; },
  };
  const load = mainLoader({ prefs, fetch, env });
  return {
    save: load(fileURLToPath(new URL("../src/main/lib/api-key-settings.ts", import.meta.url))).saveValidatedApiKey,
    values, writes: () => writes,
  };
}

test("OpenAI validates through the authenticated model list, then preserves a supported saved choice", async () => {
  const saved = { model: "gpt-image-1", quality: "high" };
  const app = subject(async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/models");
    assert.equal(options.headers.Authorization, "Bearer sk-test");
    assert.equal(app.values.get(keyPref), "previous-key");
    return catalog();
  }, { [keyPref]: "previous-key", "imageGeneration.openai": saved });
  const result = await app.save("  sk-test  ");
  assert.equal(result.model, saved.model);
  assert.equal(result.quality, saved.quality);
  assert.equal(result.hasApiKey, true);
  assert.equal(app.values.get(keyPref), "sk-test");
  assert.equal(app.writes(), 1);
});

test("authentication, permission, rate-limit, service and connection failures keep the old key", async () => {
  for (const [status, code] of [[401, "invalid_key"], [403, "permissions"], [429, "rate_limit"], [500, "service"], [503, "service"]]) {
    const app = subject(async () => new Response("secret provider response", { status }));
    await assert.rejects(app.save("sk-test"), (error) => error.code === code && !error.message.includes("secret"));
    assert.equal(app.values.get(keyPref), "previous-key");
    assert.equal(app.writes(), 0);
  }
  const app = subject(async () => { throw new Error("network secret"); });
  await assert.rejects(app.save("sk-test"), (error) => error.code === "connection" && !error.message.includes("secret"));
  assert.equal(app.values.get(keyPref), "previous-key");
  assert.equal(app.writes(), 0);
});

test("OpenRouter authenticates before reading its public model catalog and switches provider", async () => {
  const calls = [];
  const app = subject(async (url, options) => {
    calls.push(url);
    if (url.endsWith("/key")) {
      assert.equal(options.headers.Authorization, "Bearer sk-or-test");
      return Response.json({ data: { is_management_key: false } });
    }
    assert.equal(url, "https://openrouter.ai/api/v1/images/models");
    assert.equal(options.headers.Authorization, undefined);
    return routerCatalog();
  });
  const result = await app.save("sk-or-test");
  assert.equal(calls.length, 2);
  assert.equal(result.provider, "openrouter");
  assert.equal(result.model, "example/image");
  assert.equal(result.quality, "");
  assert.equal(app.values.get(keyPref), "sk-or-test");
});

test("invalid and management-only OpenRouter keys cannot pass via the public catalog", async () => {
  for (const response of [() => new Response("rejected", { status: 401 }), () => Response.json({ data: { is_management_key: true } })]) {
    let calls = 0;
    const app = subject(async (url) => {
      calls++;
      assert.equal(url, "https://openrouter.ai/api/v1/key");
      return response();
    });
    await assert.rejects(app.save("sk-or-test"));
    assert.equal(calls, 1);
    assert.equal(app.values.get(keyPref), "previous-key");
    assert.equal(app.writes(), 0);
  }
});

test("failed persistence rolls back key and model preferences, including first setup", async () => {
  for (const initial of [{}, { [keyPref]: "previous-key", "imageGeneration.openai": { model: "retired", quality: "high" } }]) {
    const app = subject(async () => catalog(), initial, false);
    await assert.rejects(app.save("sk-test"), /Could not save preferences/);
    assert.deepEqual(Object.fromEntries(app.values), initial);
  }
});

test("empty keys, forced-provider mismatch, malformed replies and empty catalogs never save", async () => {
  const app = subject(async () => { throw new Error("must not request"); }, {}, true, { ICON_PROVIDER: "openai" });
  await assert.rejects(app.save(" "), /Enter an API key/);
  await assert.rejects(app.save("sk-or-test"), /configured to use OpenAI/);
  assert.equal(app.writes(), 0);
  for (const response of [() => new Response("invalid JSON"), () => Response.json({ data: [] })]) {
    const app = subject(async () => response());
    await assert.rejects(app.save("sk-test"));
    assert.equal(app.values.get(keyPref), "previous-key");
    assert.equal(app.writes(), 0);
  }
});
