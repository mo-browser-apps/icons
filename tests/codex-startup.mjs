import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mainLoader } from "./helpers/load-main.mjs";

async function subject(t, scenarios) {
  const root = await mkdtemp(path.join(tmpdir(), "moicons-startup-"));
  const log = path.join(root, "events.jsonl");
  const candidates = [];
  for (let index = 0; index < scenarios.length; index++) {
    const dir = path.join(root, String(index));
    await mkdir(dir);
    await symlink(process.execPath, path.join(dir, "node"));
    const executable = path.join(dir, "codex");
    await writeFile(executable, `#!/usr/bin/env node\nprocess.env.MOICONS_TEST_SCENARIO = ${JSON.stringify(scenarios[index])};\nawait import(${JSON.stringify(new URL("./fixtures/codex-server.mjs", import.meta.url).href)});\n`, { mode: 0o700 });
    candidates.push(executable);
  }
  const load = mainLoader({ env: { PATH: "/usr/bin:/bin", MOICONS_TEST_LOG: log }, timers: {
    setTimeout: (callback, delay) => setTimeout(callback, delay === 10_000 ? 1000 : delay),
  } });
  let discoveries = 0;
  load(path.resolve("src/main/lib/codex-discovery.ts")).findCodexCandidates = async () => { discoveries++; return candidates; };
  const client = load(path.resolve("src/main/lib/codex-client.ts"));
  t.after(async () => { await client.closeCodexSessions(); await rm(root, { recursive: true, force: true }); });
  return { ...client, candidates, discoveries: () => discoveries,
    events: async () => (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse) };
}

test("startup skips incompatible, crashing, malformed, and unresponsive candidates and cleans them up", async (t) => {
  for (const scenario of ["old", "start-crash", "start-malformed", "start-hang"]) {
    const f = await subject(t, [scenario, "success"]);
    const client = await f.CodexClient.start();
    const events = await f.events();
    const sessions = events.filter((event) => event.cwd);
    assert.equal(sessions.length, 2, scenario);
    await assert.rejects(stat(sessions[0].cwd), { code: "ENOENT" });
    assert.equal(await realpath(client.cwd), await realpath(sessions[1].cwd));
    assert.equal(f.discoveries(), 1);
    assert.ok(!events.some((event) => ["account/login/start", "turn/start"].includes(event.method)));
    assert.equal((await client.request("account/read", { refreshToken: false })).account.type, "chatgpt");
    await client.dispose();
  }
});

test("an explicit executable never falls back to automatic candidates", async (t) => {
  const f = await subject(t, ["old", "success"]);
  await assert.rejects(f.CodexClient.start(f.candidates[0]), f.CodexCompatibilityError);
  assert.equal(f.discoveries(), 0);
  assert.equal((await f.events()).filter((event) => event.cwd).length, 1);
});

test("all failing candidates report the final startup error and leave no sessions behind", async (t) => {
  const f = await subject(t, ["start-crash", "old"]);
  await assert.rejects(f.CodexClient.start(), f.CodexCompatibilityError);
  for (const event of (await f.events()).filter((event) => event.cwd)) {
    await assert.rejects(stat(event.cwd), { code: "ENOENT" });
  }
});

test("account errors after initialization do not trigger a different installation", async (t) => {
  const f = await subject(t, ["account-error", "success"]);
  const client = await f.CodexClient.start();
  await assert.rejects(client.request("account/read", { refreshToken: false }));
  assert.equal((await f.events()).filter((event) => event.cwd).length, 1);
  await client.dispose();
});
