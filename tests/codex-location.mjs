import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { mainLoader } from "./helpers/load-main.mjs";

const key = "imageGeneration.chatgptAppPath";
async function subject(t, { initial = "", persist = true, startError, accountError, account = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "moicons-location-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "ChatGPT 'personal' ✨.app");
  const executable = path.join(app, "Contents/Resources/codex");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fixture", { mode: 0o700 });
  const values = new Map(initial ? [[key, initial]] : []);
  let writes = 0;
  const prefs = {
    getString: (name) => values.get(name) ?? "",
    setString: (name, value) => values.set(name, value),
    remove: (name) => values.delete(name),
    persist: () => { writes++; return persist; },
  };
  const load = mainLoader({ prefs, env: { MOICONS_CODEX_PATH: "/unusable/environment/codex" } });
  const { CodexClient } = load(path.resolve("src/main/lib/codex-client.ts"));
  const calls = [];
  CodexClient.start = async (candidate) => {
    calls.push(["start", candidate]);
    if (startError) throw startError;
    return {
      request: async (method, params) => {
        calls.push([method, params]);
        if (accountError) throw accountError;
        return { account };
      },
      dispose: async () => { calls.push(["dispose"]); },
    };
  };
  return { app, executable, root, values, calls, load, prefs, writes: () => writes,
    ...load(path.resolve("src/main/lib/codex-account.ts")),
    ...load(path.resolve("src/main/lib/codex-location.ts")),
  };
}

test("validates, saves, and reuses a manual bundle path ahead of the environment override", async (t) => {
  const f = await subject(t);
  assert.equal((await f.setCodexAppPath(` '${f.app}/' `)).error, "");
  assert.equal(f.getCodexAppPath(), f.app);
  assert.equal(f.writes(), 1);
  assert.equal(f.calls[0][1], f.executable);
  assert.deepEqual(f.calls.map(([method]) => method), ["start", "account/read", "dispose"]);
  assert.equal(f.calls[1][1].refreshToken, false);
  const discovery = f.load(path.resolve("src/main/lib/codex-discovery.ts"));
  assert.equal(await discovery.findCodex(), f.executable);
  const reopened = mainLoader({ prefs: f.prefs })(path.resolve("src/main/lib/codex-location.ts"));
  assert.equal(reopened.getCodexAppPath(), f.app);
});

test("accepts Finder paths, file URLs, and home-relative paths without invoking a shell", async (t) => {
  const f = await subject(t);
  assert.equal(await f.validateCodexAppPath(pathToFileURL(f.app).href), f.app);
  // A filesystem stub keeps the home-relative case inside the test.
  const load = mainLoader({ modules: { "node:fs/promises": {
    stat: async () => ({ isDirectory: () => true, isFile: () => true }), access: async () => {},
  } } });
  const location = load(path.resolve("src/main/lib/codex-location.ts"));
  assert.equal(await location.validateCodexAppPath('"~/Applications/ChatGPT.app"'), path.join(homedir(), "Applications/ChatGPT.app"));
});

test("invalid locations leave the previous selection intact", async (t) => {
  const previous = "/previous/ChatGPT.app";
  const f = await subject(t, { initial: previous });
  const wrongApp = path.join(f.root, "Wrong.app");
  await mkdir(wrongApp);
  for (const input of ["relative/ChatGPT.app", f.root, "/missing/ChatGPT.app", f.executable, wrongApp, "file://remote/ChatGPT.app", "bad\0.app"]) {
    const result = await f.setCodexAppPath(input);
    assert.ok(result.error, input);
    assert.equal(result.appPath, previous);
    assert.equal(f.getCodexAppPath(), previous);
  }
  await chmod(f.executable, 0o600);
  assert.ok((await f.setCodexAppPath(f.app)).error);
  assert.equal(f.writes(), 0);
  assert.equal(f.calls.length, 0);
});

test("an unavailable saved location does not silently fall back to a different app", async (t) => {
  const f = await subject(t, { initial: "/missing/ChatGPT.app" });
  const load = mainLoader({ prefs: f.prefs, env: { MOICONS_CODEX_PATH: f.executable } });
  assert.equal(await load(path.resolve("src/main/lib/codex-discovery.ts")).findCodex(), undefined);
});

test("startup and account-protocol failures never replace a saved path", async (t) => {
  for (const option of ["startError", "accountError"]) {
    const f = await subject(t, { initial: "/previous/ChatGPT.app", [option]: new Error("Connection is incompatible") });
    assert.match((await f.setCodexAppPath(f.app)).error, /incompatible/);
    assert.equal(f.getCodexAppPath(), "/previous/ChatGPT.app");
    assert.equal(f.writes(), 0);
    if (option === "accountError") assert.equal(f.calls.at(-1)[0], "dispose");
  }
});

test("failed persistence rolls back both setting and clearing a manual location", async (t) => {
  for (const initial of ["", "/previous/ChatGPT.app"]) {
    const f = await subject(t, { initial, persist: false });
    assert.match((await f.setCodexAppPath(f.app)).error, /previous setting/);
    assert.equal(f.getCodexAppPath(), initial);
    assert.match((await f.setCodexAppPath("")).error, /previous setting/);
    assert.equal(f.getCodexAppPath(), initial);
  }
});

test("restoring automatic detection clears only the manual path without starting a client", async (t) => {
  const f = await subject(t, { initial: "/previous/ChatGPT.app" });
  f.values.set("unrelated", "keep");
  assert.equal((await f.setCodexAppPath("")).error, "");
  assert.equal(f.getCodexAppPath(), "");
  assert.equal(f.values.get("unrelated"), "keep");
  assert.equal(f.writes(), 1);
  assert.equal(f.calls.length, 0);
});

test("generation blocks location changes before validation and before committing", async (t) => {
  const f = await subject(t);
  assert.match((await f.setCodexAppPath(f.app, () => true)).error, /generation/);
  assert.equal(f.calls.length, 0);
  let checks = 0;
  assert.match((await f.setCodexAppPath(f.app, () => ++checks === 2)).error, /generation/);
  assert.equal(f.getCodexAppPath(), "");
  assert.equal(f.writes(), 0);
});
