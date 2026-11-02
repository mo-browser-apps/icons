import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mainLoader } from "./helpers/load-main.mjs";

const { IconHistoryStore } = mainLoader({})(path.resolve("src/main/lib/icon-history.ts"));
const directory = await mkdtemp(path.join(tmpdir(), "moicons-history-"));
const store = new IconHistoryStore(path.join(directory, "history"));
const fixtures = JSON.parse(await readFile(new URL("./fixtures/generated-images.json", import.meta.url), "utf8"));
const png = `data:image/png;base64,${fixtures.png}`;
const batch = (generationId = randomUUID()) => ({ generationId, prompt: "An alpine sunrise", parentId: "", variants: [0, 1, 2].map(variantIndex => ({ variantIndex, rawPng: png, preparedPng: png, thumbnailPng: png })) });
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS: ${name}`); }
try {
  await check("a fresh profile has empty history", async () => assert.equal((await store.list()).entries.length, 0));
  const input = batch();
  const entries = await store.record(input);
  await check("all variants and original PNGs survive a new store instance", async () => {
    const reopened = new IconHistoryStore(path.join(directory, "history"));
    assert.equal((await reopened.list()).entries.length, 3);
    for (const entry of entries) {
      const restored = await reopened.get(entry.id);
      assert.equal(restored.rawPng, png);
      assert.equal(restored.preparedPng, png);
      assert.equal(restored.entry.prompt, input.prompt);
    }
  });
  await check("concurrent retries cannot duplicate a generation", async () => {
    await Promise.all([store.record(input), store.record(input)]);
    assert.equal((await store.list()).entries.length, 3);
  });
  await check("a failed batch never exposes partial history", async () => {
    const broken = batch(); broken.variants[1].rawPng = "invalid";
    await assert.rejects(store.record(broken), /PNG artwork/);
    assert.equal((await store.list()).entries.length, 3);
    assert.ok(!(await readdir(path.join(directory, "history"))).some(name => name.startsWith(".pending-")));
  });
  await check("IDs cannot escape the history directory", async () => {
    for (const id of ["../../file:0", `${input.generationId}:../0`, `${input.generationId}:3`]) {
      await assert.rejects(store.get(id), /Invalid history/);
      await assert.rejects(store.remove(id), /Invalid history/);
    }
  });
  await check("removing one variant preserves siblings and exported files", async () => {
    const exported = path.join(directory, "exported.icns"); await writeFile(exported, "external export");
    await store.setExportPath(entries[0].id, exported);
    assert.equal((await store.get(entries[0].id)).entry.exportPath, exported);
    await store.remove(entries[0].id);
    assert.equal((await store.list()).entries.length, 2);
    await assert.rejects(store.get(entries[0].id), /no longer/);
    assert.equal(await readFile(exported, "utf8"), "external export");
    assert.equal((await store.get(entries[1].id)).rawPng, png);
  });
  await check("corrupt metadata does not hide healthy generations", async () => {
    const broken = batch(); await store.record(broken);
    await writeFile(path.join(directory, "history", broken.generationId, "manifest.json"), "{broken");
    const listed = await store.list();
    assert.equal(listed.entries.length, 2); assert.match(listed.warning, /could not be loaded/);
  });
  await check("history pages only thumbnails and keeps older results accessible", async () => {
    for (let index = 0; index < 9; index++) await store.record(batch());
    const first = await store.list(), second = await store.list(8);
    assert.equal(first.entries.length, 24); assert.equal(first.hasMore, true);
    assert.equal(second.entries.length, 5); assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.id)).size, 29);
    assert.ok(!("rawPng" in first.entries[0]));
    assert.ok(!first.entries.some(entry => second.entries.some(other => entry.generationId === other.generationId)), "never split a generation across pages");
  });
  console.log(`${passed} history storage checks passed.`);
} finally { await rm(directory, { recursive: true, force: true }); }
