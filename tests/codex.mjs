import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mainLoader } from "./helpers/load-main.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
async function fixture(t, scenario = "success") {
  const dir = await mkdtemp(path.join(tmpdir(), "moicons-protocol-test-"));
  const executable = path.join(dir, "codex");
  await copyFile(new URL("./fixtures/codex-server.mjs", import.meta.url), executable);
  await chmod(executable, 0o700);
  const logfile = path.join(dir, "events.jsonl");
  const load = mainLoader({ env: { ...process.env, OPENAI_API_KEY: "must-not-inherit", CODEX_API_KEY: "must-not-inherit",
    MOICONS_CODEX_PATH: executable, MOICONS_TEST_LOG: logfile, MOICONS_TEST_SCENARIO: scenario } });
  const { CodexImageProvider } = load(path.resolve("src/main/lib/providers/codex.ts"));
  const account = load(path.resolve("src/main/lib/codex-account.ts"));
  const { closeCodexSessions } = load(path.resolve("src/main/lib/codex-client.ts"));
  t.after(async () => { await account.cancelCodexLogin(); await closeCodexSessions(); await rm(dir, { recursive: true, force: true }); });
  return { provider: new CodexImageProvider(), account, events: async () => (await readFile(logfile, "utf8")).trim().split("\n").map(JSON.parse) };
}
const request = { positivePrompt: "A ceramic fox", negativePrompt: "letters", count: 3 };

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

test("unexpected permission requests are rejected", async (t) => {
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
