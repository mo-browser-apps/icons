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
  const apiKeys = load(fileURLToPath(new URL("../src/main/lib/api-key-settings.ts", import.meta.url)));
  const connection = load(fileURLToPath(new URL("../src/main/lib/generation-connection.ts", import.meta.url)));
  const provider = load(fileURLToPath(new URL("../src/main/lib/image-provider.ts", import.meta.url)));
  const settings = load(fileURLToPath(new URL("../src/main/lib/read-generation-settings.ts", import.meta.url)));
  return {
    save: apiKeys.saveValidatedApiKey,
    remove: apiKeys.removeStoredApiKey,
    useConnection: connection.saveConnection,
    provider: provider.resolveProviderName,
    getProvider: provider.getProvider,
    readSettings: settings.readGenerationSettings,
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

test("existing API users retain their provider; Codex selection persists without removing their key", () => {
  for (const [key, expected] of [["sk-test", "openai"], ["sk-or-test", "openrouter"]]) {
    const app = subject(async () => catalog(), { [keyPref]: key });
    assert.equal(app.provider(), expected);
    app.useConnection("codex");
    assert.equal(app.provider(), "codex");
    assert.equal(app.values.get(keyPref), key);
    app.useConnection("api");
    assert.equal(app.provider(), expected);
    assert.equal(app.values.get(keyPref), key);
  }
});

test("failed connection persistence restores the previous provider", () => {
  for (const initial of [{}, { "imageGeneration.connection": "api" }]) {
    const app = subject(async () => catalog(), initial, false);
    assert.throws(() => app.useConnection("codex"), /Could not save/);
    assert.equal(app.provider(), "openai");
    assert.deepEqual(Object.fromEntries(app.values), initial);
  }
});

test("disconnecting Codex persists across launch and never falls back to a saved API key", async () => {
  const noRequest = async () => { throw new Error("disconnect must not contact any provider"); };
  const initial = { [keyPref]: "sk-test", "imageGeneration.connection": "codex" };
  const app = subject(noRequest, initial);
  app.useConnection("none");
  assert.equal(app.values.get(keyPref), initial[keyPref]);
  for (const instance of [app, subject(noRequest, Object.fromEntries(app.values))]) {
    const settings = await instance.readSettings();
    assert.equal(settings.ready, false);
    assert.equal(settings.provider, "");
    assert.equal(settings.hasApiKey, true);
    assert.throws(() => instance.getProvider(), /Choose a generation method/);
  }
  app.useConnection("codex");
  assert.equal(app.provider(), "codex");
});

test("a failed disconnect keeps Codex selected", () => {
  const initial = { [keyPref]: "sk-test", "imageGeneration.connection": "codex" };
  const app = subject(async () => catalog(), initial, false);
  assert.throws(() => app.useConnection("none"), /Could not save/);
  assert.deepEqual(Object.fromEntries(app.values), initial);
  assert.equal(app.provider(), "codex");
});

test("removing a key disconnects locally while preserving model choices and other preferences", () => {
  for (const key of ["sk-test", "sk-or-test"]) {
    const remaining = {
      "imageGeneration.openai": { model: defaultModel, quality: "high" },
      "imageGeneration.openrouter": { model: "example/image", quality: "" },
      "ui.theme": "dark",
    };
    const app = subject(async () => { throw new Error("removal must not contact the provider"); }, { ...remaining, [keyPref]: key });
    app.remove();
    assert.deepEqual(Object.fromEntries(app.values), remaining);
    assert.equal(app.writes(), 1);
    app.remove();
    assert.equal(app.writes(), 1);
  }
});

test("failed key removal restores the saved key and model choices", () => {
  const initial = { [keyPref]: "sk-test", "imageGeneration.openai": { model: defaultModel, quality: "high" } };
  const app = subject(async () => { throw new Error("no request expected"); }, initial, false);
  assert.throws(() => app.remove(), /Could not remove the API key/);
  assert.deepEqual(Object.fromEntries(app.values), initial);
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
  for (const initial of [{}, { [keyPref]: "previous-key", "imageGeneration.connection": "codex", "imageGeneration.openai": { model: "retired", quality: "high" } }]) {
    const app = subject(async () => catalog(), initial, false);
    await assert.rejects(app.save("sk-test"), /Could not save preferences/);
    assert.deepEqual(Object.fromEntries(app.values), initial);
  }
});

test("validating a new key selects the API connection; a rejected key keeps Codex active", async () => {
  const initial = { "imageGeneration.connection": "codex", [keyPref]: "previous-key" };
  const accepted = subject(async () => catalog(), initial);
  await accepted.save("sk-test");
  assert.equal(accepted.values.get("imageGeneration.connection"), "api");
  const rejected = subject(async () => new Response("invalid", { status: 401 }), initial);
  await assert.rejects(rejected.save("sk-test"));
  assert.deepEqual(Object.fromEntries(rejected.values), initial);
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
