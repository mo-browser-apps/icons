import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, copyFile, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mainLoader } from "./helpers/load-main.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
async function fixture(t, scenario = "success", env = {}, prefs) {
  const dir = await mkdtemp(path.join(tmpdir(), "moicons-protocol-test-"));
  const executable = path.join(dir, "codex");
  await copyFile(new URL("./fixtures/codex-server.mjs", import.meta.url), executable);
  await chmod(executable, 0o700);
  await symlink(process.execPath, path.join(dir, "node"));
  const logfile = path.join(dir, "events.jsonl");
  const load = mainLoader({ prefs, env: { ...process.env, ...env, OPENAI_API_KEY: "must-not-inherit", CODEX_API_KEY: "must-not-inherit",
    MOICONS_CODEX_PATH: executable, MOICONS_TEST_LOG: logfile, MOICONS_TEST_SCENARIO: scenario } });
  const { CodexImageProvider } = load(path.resolve("src/main/lib/providers/codex.ts"));
  const account = load(path.resolve("src/main/lib/codex-account.ts"));
  const models = load(path.resolve("src/main/lib/codex-models.ts"));
  const { closeCodexSessions } = load(path.resolve("src/main/lib/codex-client.ts"));
  t.after(async () => { await account.cancelCodexLogin(); await closeCodexSessions(); await rm(dir, { recursive: true, force: true }); });
  return { provider: new CodexImageProvider(), account, models, dir, events: async () => (await readFile(logfile, "utf8")).trim().split("\n").map(JSON.parse) };
}
const request = { positivePrompt: "A ceramic fox", negativePrompt: "letters", count: 3 };

function modelPrefs() {
  const values = new Map();
  const prefs = { getString: key => values.get(key) || "", setString: (key, value) => values.set(key, value),
    remove: key => values.delete(key), persist: () => true };
  return { prefs, values };
}

test("generation uses the catalog's Astra for Pro and Sol for other plans instead of inherited model, effort, and speed", async t => {
  for (const plan of ["pro", "prolite", "pro_200", "plus", "go", "unknown"]) {
    const f = await fixture(t, "success", { MOICONS_TEST_PLAN: plan, MOICONS_TEST_PAGE_SIZE: "1" });
    await f.provider.generate({ ...request, count: 1 });
    const events = await f.events();
    const start = events.find(e => e.method === "thread/start").params;
    const pro = plan.startsWith("pro");
    assert.equal(start.model, pro ? "gpt-6.2-astra" : "gpt-6.2-sol");
    assert.equal(start.config.model_reasoning_effort, pro ? "medium" : "low");
    assert.equal(start.config.service_tier, "default");
    assert.equal(events.filter(e => e.method === "model/list").length, 2);
    assert.ok(events.filter(e => e.method === "model/list").every(e => e.params.modelProvider === "openai"));
  }
});

test("a saved model is revalidated, used for every variant, and scoped to its account and plan", async t => {
  const { prefs, values } = modelPrefs();
  const f = await fixture(t, "success", {}, prefs);
  await f.models.saveCodexModel("gpt-6.2-astra", "test@example.com");
  assert.equal((await f.models.readCodexModelSettings("test@example.com")).model, "gpt-6.2-astra");
  await f.provider.generate(request);
  assert.ok((await f.events()).filter(e => e.method === "thread/start").every(e => e.params.model === "gpt-6.2-astra"));
  const other = await fixture(t, "success", { MOICONS_TEST_EMAIL: "other@example.com" }, prefs);
  assert.equal((await other.models.readCodexModelSettings("other@example.com")).model, "gpt-6.2-sol");
  const changedPlan = await fixture(t, "success", { MOICONS_TEST_PLAN: "go" }, prefs);
  assert.equal((await changedPlan.models.readCodexModelSettings("test@example.com")).model, "gpt-6.2-sol");
  assert.ok([...values.keys()].every(key => !key.includes("example.com")));
});

test("removed saved models use a listed default; hidden and text-only models never enter the selector", async t => {
  const { prefs } = modelPrefs();
  const f = await fixture(t, "success", {}, prefs);
  await f.models.saveCodexModel("gpt-6.2-astra", "test@example.com");
  const catalog = [
    { model: "gpt-6.2-astra", displayName: "Hidden", hidden: true },
    { model: "gpt-6.2-sol", displayName: "Text only", inputModalities: ["text"] },
    { model: "account-default", displayName: "Account default", isDefault: true,
      defaultReasoningEffort: "xhigh", supportedReasoningEfforts: [{ reasoningEffort: "low" }], inputModalities: ["text", "image"] },
  ];
  const restricted = await fixture(t, "success", { MOICONS_TEST_MODELS: JSON.stringify(catalog) }, prefs);
  const settings = await restricted.models.readCodexModelSettings("test@example.com");
  assert.deepEqual(Array.from(settings.models, model => model.id), ["account-default"]);
  await restricted.provider.generate({ ...request, count: 1 });
  const start = (await restricted.events()).find(e => e.method === "thread/start").params;
  assert.equal(start.model, "account-default");
  assert.equal(start.config.model_reasoning_effort, "low");
});

test("empty or failed catalogs stop before any thread or generation starts", async t => {
  for (const scenario of ["success", "model-list-error"]) {
    const f = await fixture(t, scenario, { MOICONS_TEST_MODELS: "[]" });
    await assert.rejects(f.provider.generate(request), /No compatible ChatGPT models|could not complete/);
    assert.ok(!(await f.events()).some(e => ["thread/start", "turn/start"].includes(e.method)));
  }
});

test("model saves reject stale accounts and missing models, and roll back persistence failures without generating", async t => {
  const { prefs, values } = modelPrefs();
  const f = await fixture(t, "success", {}, prefs);
  await assert.rejects(f.models.saveCodexModel("unlisted", "test@example.com"), /no longer listed/);
  await assert.rejects(f.models.saveCodexModel("gpt-6.2-sol", "previous@example.com"), /account changed/);
  assert.equal(values.size, 0);
  prefs.persist = () => false;
  await assert.rejects(f.models.saveCodexModel("gpt-6.2-astra", "test@example.com"), /Could not save/);
  assert.equal(values.size, 0);
  prefs.persist = () => true;
  await f.models.saveCodexModel("gpt-6.2-astra", "test@example.com");
  prefs.persist = () => false;
  await assert.rejects(f.models.saveCodexModel("gpt-6.2-sol", "test@example.com"), /Could not save/);
  assert.equal((await f.models.readCodexModelSettings("test@example.com")).model, "gpt-6.2-astra");
  assert.ok(!(await f.events()).some(e => e.method === "turn/start"));
});

test("two-image refinement passes distinct ordered files and cleans them up", async t => {
  const f = await fixture(t);
  const second = Buffer.concat([Buffer.from(png, "base64"), Buffer.from("reference")]).toString("base64");
  const result = await f.provider.generate({ ...request, referenceImageB64: png, additionalReferenceImageB64: second });
  assert.equal(result.images.length, 3);
  const events = await f.events();
  for (const event of events.filter(event => event.method === "turn/start")) {
    const prompt = event.params.input.find(item => item.type === "text").text;
    assert.match(prompt, /Preserve the current icon's composition/);
    assert.doesNotMatch(prompt, /distinct composition/);
  }
  const inputs = events.filter(event => event.referenceImages).map(event => event.referenceImages);
  assert.equal(inputs.length, 3);
  for (const images of inputs) {
    assert.deepEqual(images.map(image => image.data), [png, second]);
    assert.notEqual(images[0].path, images[1].path);
    for (const image of images) await assert.rejects(stat(image.path), { code: "ENOENT" });
  }
});

test("an env-node CLI starts with a sparse Finder-style PATH", async (t) => {
  const inherited = "/moicons-test/no-node-bin";
  const f = await fixture(t, "success", { PATH: inherited });
  assert.equal((await f.account.getCodexStatus()).state, "ready");
  const info = (await f.events())[0];
  const search = info.path.split(path.delimiter);
  assert.equal(search[0], f.dir);
  for (const directory of [inherited, "/opt/homebrew/bin", "/usr/local/bin"]) assert.ok(search.includes(directory));
  assert.deepEqual(info.envKeys, []);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function loginSubject() {
  const load = mainLoader({});
  const { CodexClient } = load(path.resolve("src/main/lib/codex-client.ts"));
  return { CodexClient, account: load(path.resolve("src/main/lib/codex-account.ts")) };
}

function loginClient() {
  return {
    disposed: false, calls: [],
    async request(method) {
      this.calls.push(method);
      return { type: "chatgpt", authUrl: "https://auth.openai.com/authorize?test=1", loginId: "test-login" };
    },
    subscribe() { return () => {}; },
    async dispose() { this.disposed = true; },
  };
}

test("canceling during client startup disposes the late client without starting browser sign-in", async () => {
  const { CodexClient, account } = loginSubject();
  const start = deferred();
  const client = loginClient();
  CodexClient.start = () => start.promise;
  const urls = [];
  const pending = account.startCodexLogin(url => urls.push(url));
  await account.cancelCodexLogin();
  start.resolve(client);
  assert.equal((await pending).state, "signed_out");
  assert.equal(client.disposed, true);
  assert.deepEqual(client.calls, []);
  assert.deepEqual(urls, []);
});

test("canceling while a login response is pending closes the client and ignores the late URL", async () => {
  const { CodexClient, account } = loginSubject();
  const response = deferred();
  const requested = deferred();
  const client = loginClient();
  client.request = () => { requested.resolve(); return response.promise; };
  CodexClient.start = async () => client;
  const urls = [];
  const pending = account.startCodexLogin(url => urls.push(url));
  await requested.promise;
  await account.cancelCodexLogin();
  assert.equal(client.disposed, true);
  response.resolve({ type: "chatgpt", authUrl: "https://auth.openai.com/authorize?late=1", loginId: "late" });
  assert.equal((await pending).state, "signed_out");
  assert.deepEqual(urls, []);
});

test("a canceled startup cannot clear or cancel a newer login attempt", async (t) => {
  const { CodexClient, account } = loginSubject();
  t.after(() => account.cancelCodexLogin());
  const starts = [deferred(), deferred()];
  let calls = 0;
  CodexClient.start = () => starts[calls++].promise;
  const oldClient = loginClient();
  const newClient = loginClient();
  const urls = [];
  const oldLogin = account.startCodexLogin(url => urls.push(url));
  await account.cancelCodexLogin();
  const newLogin = account.startCodexLogin(url => urls.push(url));
  starts[0].resolve(oldClient);
  await oldLogin;
  assert.equal((await account.getCodexStatus()).state, "waiting");
  starts[1].resolve(newClient);
  assert.equal((await newLogin).state, "waiting");
  assert.equal(oldClient.disposed, true);
  assert.equal(newClient.disposed, false);
  assert.equal(urls.length, 1);
  assert.equal(calls, 2);
});

test("subscription generation handles chunked and early events, returns three images, and isolates credentials and tools", async (t) => {
  const f = await fixture(t);
  const result = await f.provider.generate({ ...request, referenceImageB64: png });
  assert.equal(result.images.length, 3);
  const events = await f.events();
  const processInfo = events[0];
  assert.deepEqual(processInfo.envKeys, []);
  assert.ok(processInfo.args.includes("features.shell_tool=false"));
  assert.ok(processInfo.args.includes("features.apps=false"));
  assert.equal(events.filter((e) => e.method === "turn/start").length, 3);
  const start = events.find((e) => e.method === "thread/start").params;
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.config["mcp_servers.test.enabled"], false);
  assert.equal(start.ephemeral, true);
  assert.equal(events.filter((e) => e.referenceExists && e.referenceMatches).length, 3);
  await assert.rejects(stat(processInfo.cwd), { code: "ENOENT" });
});

test("API-key Codex sessions cannot silently spend API credits", async (t) => {
  const f = await fixture(t, "api");
  await assert.rejects(f.provider.generate(request), /Sign in with ChatGPT/);
  assert.ok(!(await f.events()).some((e) => e.method === "turn/start"));
});

test("limits, missing images and malformed output never repeat a generation", async (t) => {
  for (const [scenario, message] of [["limit", /limit has been reached/], ["empty", /without returning an image/], ["invalid", /usable image/]]) {
    const f = await fixture(t, scenario);
    await assert.rejects(f.provider.generate(request), message);
    assert.equal((await f.events()).filter((e) => e.method === "turn/start").length, 1);
  }
});

test("turn failures report their cause instead of blaming image access or the description", async (t) => {
  for (const [scenario, message] of [
    ["turn-outdated", /ChatGPT copy.*too old/],
    ["turn-limit", /usage limit has been reached/],
    ["turn-rate-limit", /usage limit has been reached/],
    ["turn-unauthorized", /sign-in has expired/],
    ["turn-model", /model is not available/],
    ["turn-error-only", /request failed/],
    ["turn-notification-only", /request failed/],
    ["turn-failed-empty", /request failed/],
    ["turn-interrupted", /Generation stopped/],
  ]) {
    const f = await fixture(t, scenario);
    await assert.rejects(f.provider.generate(request), error => {
      assert.match(error.message, message);
      assert.ok(!error.message.includes("private server detail"));
      assert.ok(!error.message.includes("different description"));
      return true;
    });
    const events = await f.events();
    assert.equal(events.filter(e => e.method === "turn/start").length, 1);
    await assert.rejects(stat(events[0].cwd), { code: "ENOENT" });
  }
});

test("a recovered server error does not discard a successfully generated image", async (t) => {
  const f = await fixture(t, "retry-then-success");
  assert.equal((await f.provider.generate({ ...request, count: 1 })).images[0], png);
  assert.equal((await f.events()).filter(e => e.method === "turn/start").length, 1);
});

test("a later usage limit preserves already generated artwork", async (t) => {
  const f = await fixture(t, "partial");
  const result = await f.provider.generate(request);
  assert.equal(result.images.length, 1);
  assert.equal((await f.events()).filter((e) => e.method === "turn/start").length, 2);
});

test("cancel interrupts the active turn and never starts another variant", async (t) => {
  const f = await fixture(t, "wait");
  const controller = new AbortController();
  const generation = f.provider.generate({ ...request, signal: controller.signal });
  const rejection = assert.rejects(generation, /stopped/);
  for (let i = 0; i < 100; i++) {
    const events = await f.events().catch(() => []);
    if (events.some((e) => e.method === "turn/start")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort();
  await rejection;
  assert.equal((await f.events()).filter((e) => e.method === "turn/start").length, 1);
  const interrupt = (await f.events()).find((e) => e.method === "turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "thread-1", turnId: "turn-1" });
});

test("missing installations return an installation state, without starting a login", async () => {
  const load = mainLoader({ env: { MOICONS_CODEX_PATH: "/not-installed/moicons-test/codex" } });
  const account = load(path.resolve("src/main/lib/codex-account.ts"));
  assert.equal((await account.getCodexStatus()).state, "not_installed");
  const status = await account.startCodexLogin(() => { throw new Error("must not open browser"); });
  assert.equal(status.state, "error");
  assert.match(status.error, /Install the ChatGPT desktop app/);
});

test("process crashes and unsupported versions return a readable error without raw server details", async (t) => {
  for (const scenario of ["old", "crash"]) {
    const f = await fixture(t, scenario);
    await assert.rejects(f.provider.generate(request), (error) => /ChatGPT/.test(error.message) && !error.message.includes("private server detail"));
  }
});

test("unsupported Codex protocol offers an update; other errors stay retryable", async (t) => {
  for (const [scenario, expected] of [["old", "update_required"], ["old-account", "update_required"], ["account-error", "error"]]) {
    const f = await fixture(t, scenario);
    const status = await f.account.getCodexStatus();
    assert.equal(status.state, expected);
    assert.equal(status.email, "");
    assert.ok(!status.error.includes("private server detail"));
    assert.ok(!(await f.events()).some((e) => e.method === "turn/start" || e.method === "account/login/start"));
  }
});

test("unexpected permission requests are rejected before the fixture completes", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, "approval");
  await f.provider.generate({ ...request, count: 1 });
  const events = await f.events();
  assert.ok(events.some((e) => e.id === "server-request" && e.error?.code === -32601));
});

test("managed login completes without returning credentials or logging out the user's Codex", async (t) => {
  const f = await fixture(t, "login-success");
  assert.equal((await f.account.getCodexStatus()).state, "signed_out");
  const urls = [];
  assert.equal((await f.account.startCodexLogin((url) => urls.push(url))).state, "waiting");
  assert.match(urls[0], /^https:\/\/auth.openai.com\//);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await f.account.getCodexStatus()).state, "ready");
  await f.account.cancelCodexLogin();
  assert.ok(!(await f.events()).some((e) => e.method === "account/logout"));
});

test("canceling login releases its private session and keeps the user signed out", async (t) => {
  const f = await fixture(t, "login-wait");
  await f.account.startCodexLogin(() => {});
  await f.account.cancelCodexLogin();
  assert.equal((await f.account.getCodexStatus()).state, "signed_out");
  assert.ok((await f.events()).some((e) => e.method === "account/login/cancel"));
});
