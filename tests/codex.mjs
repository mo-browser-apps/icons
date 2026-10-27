import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, copyFile, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mainLoader } from "./helpers/load-main.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
async function fixture(t, scenario = "success", env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "moicons-protocol-test-"));
  const executable = path.join(dir, "codex");
  await copyFile(new URL("./fixtures/codex-server.mjs", import.meta.url), executable);
  await chmod(executable, 0o700);
  await symlink(process.execPath, path.join(dir, "node"));
  const logfile = path.join(dir, "events.jsonl");
  const load = mainLoader({ env: { ...process.env, ...env, OPENAI_API_KEY: "must-not-inherit", CODEX_API_KEY: "must-not-inherit",
    MOICONS_CODEX_PATH: executable, MOICONS_TEST_LOG: logfile, MOICONS_TEST_SCENARIO: scenario } });
  const { CodexImageProvider } = load(path.resolve("src/main/lib/providers/codex.ts"));
  const account = load(path.resolve("src/main/lib/codex-account.ts"));
  const { closeCodexSessions } = load(path.resolve("src/main/lib/codex-client.ts"));
  t.after(async () => { await account.cancelCodexLogin(); await closeCodexSessions(); await rm(dir, { recursive: true, force: true }); });
  return { provider: new CodexImageProvider(), account, dir, events: async () => (await readFile(logfile, "utf8")).trim().split("\n").map(JSON.parse) };
}
const request = { positivePrompt: "A ceramic fox", negativePrompt: "letters", count: 3 };

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
  for (const [scenario, message] of [["limit", /limit has been reached/], ["empty", /did not generate/], ["invalid", /usable image/]]) {
    const f = await fixture(t, scenario);
    await assert.rejects(f.provider.generate(request), message);
    assert.equal((await f.events()).filter((e) => e.method === "turn/start").length, 1);
  }
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
