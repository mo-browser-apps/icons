// Run with ICON_PROVIDER=mock npm run dev -- --automation.
// Uses local fixture artwork and the real history/export services; no image API calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const output = path.resolve(".mobrowser/history-review");
mkdirSync(output, { recursive: true });
const agent = (...args) => JSON.parse(execFileSync("npm", ["run", "--silent", "mobrowser", "--", "agent", ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 45000 }));
const evaluate = (fn, ...args) => agent("eval", "--expr", `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(",")})`).value;
const click = selector => agent("click", "--selector", selector);
const wait = selector => agent("wait-for", "--selector", selector, "--timeout", "10000");
const screenshot = name => agent("screenshot", "--out", path.join(output, name));
const kept = process.argv.includes("--keep-demo");
const baseline = evaluate(async () => {
  const url = performance.getEntriesByType("resource").find(entry => entry.name.includes("/gen/ipc.ts")).name;
  const { ipc } = await import(url);
  window.__historyTest = { ipc, originalGenerate: ipc.app.GenerateIcon, originalRecord: ipc.app.RecordIconHistory };
  return (await ipc.app.ListIconHistory({ offset: 0 })).entries.map(entry => entry.id);
});

const setup = () => evaluate(async svg => {
  const url = performance.getEntriesByType("resource").find(entry => entry.name.includes("/gen/ipc.ts")).name;
  const { ipc } = await import(url);
  const images = [];
  for (const colors of [null, ["#f4bacd", "#c2b5ef", "#c66d91", "#8168b9"], ["#f4bacd", "#f1d899", "#c66d91", "#c99c4d"]]) {
    let artwork = svg;
    if (colors) { artwork = artwork.replaceAll(colors[0], colors[1]).replaceAll(colors[2], colors[3]); }
    const image = new Image(); image.src = `data:image/svg+xml;base64,${btoa(artwork)}`; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024;
    canvas.getContext("2d").drawImage(image, 0, 0);
    images.push(canvas.toDataURL().split(",")[1]);
  }
  const state = window.__historyTest = { ipc, originalGenerate: ipc.app.GenerateIcon, originalRecord: ipc.app.RecordIconHistory, images, requests: [] };
  ipc.app.GenerateIcon = async request => { state.requests.push(request); return { images, error: "" }; };
  return true;
}, readFileSync("tests/fixtures/flower.svg", "utf8"));
const generate = prompt => {
  agent("fill", "--selector", "textarea", "--value", prompt);
  // Refine mode submits; a completed unselected generation refreshes.
  click('[aria-label="Submit"], [aria-label="Refresh"]');
  wait('[aria-label="Variant 3"]:not([disabled])');
};
const history = () => { click('button:has(svg.lucide-history)'); wait('.history-thumbnail'); };
const list = () => evaluate(async () => (await window.__historyTest.ipc.app.ListIconHistory({ offset: 0 })).entries.map(({ id, parentId }) => ({ id, parentId })));

try {
  // Reload from the app's own origin, then use its actual IPC client instance.
  evaluate(() => { location.reload(); return true; }); wait("textarea");
  setup();
  generate("A soft botanical icon with a pink flower and deep green leaves");
  const first = list().filter(entry => !baseline.includes(entry.id));
  assert.equal(first.length, 3);
  const saved = evaluate(async id => {
    const result = await window.__historyTest.ipc.app.GetIconHistory({ id });
    return { distinct: result.rawPng !== result.preparedPng };
  }, first[0].id);
  assert.ok(saved.distinct, "preserve original artwork separately from the export mask");
  console.log("PASS: generation automatically persists all original and prepared variants");

  // Exercise the visible autosave retry without changing the main-process service.
  evaluate(() => { window.__historyTest.ipc.app.RecordIconHistory = async () => { throw new Error("Simulated disk failure"); }; return true; });
  generate("A flower in gentle lavender for a mindfulness app");
  wait('[role="alert"]');
  assert.match(evaluate(() => document.querySelector('[role="alert"]').textContent), /couldn’t be kept/);
  assert.ok(evaluate(() => document.querySelector('[aria-label="Refresh"]').disabled));
  evaluate(() => { const state = window.__historyTest; state.ipc.app.RecordIconHistory = state.originalRecord; return true; });
  click('[role="alert"] button');
  wait('button:has(svg.lucide-history):not([disabled])');
  assert.equal(list().filter(entry => !baseline.includes(entry.id)).length, 6);
  console.log("PASS: failed autosave keeps artwork visible and retry saves once");

  // Recreate the renderer to prove history isn't just React state.
  evaluate(() => { location.reload(); return true; }); wait("textarea"); setup();
  history();
  assert.equal(evaluate(() => document.querySelectorAll('.history-thumbnail').length), baseline.length + 6);
  console.log("PASS: history survives a renderer reload");
  screenshot("02-history.png");

  agent("click", "--selector", ".history-thumbnail", "--button", "right");
  wait('[role="menu"]');
  assert.ok(evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent.includes("Continue editing"))));
  screenshot("03-context-actions.png");
  agent("press-key", "--key", "Escape");
  click('.history-thumbnail'); wait('.history-detail');
  const selectedId = list()[0].id;
  const exportPath = path.join(output, `Botanical-${Date.now()}.icns`);
  agent("answer-dialog", "--path", exportPath);
  click('.history-detail-buttons button:has(svg.lucide-download)');
  wait('button:has(svg.lucide-folder-open)');
  assert.ok(existsSync(exportPath));
  assert.equal(evaluate(async id => (await window.__historyTest.ipc.app.GetIconHistory({ id })).entry.exportPath, selectedId), exportPath);
  console.log("PASS: Save as exports a real .icns and records its path");
  // Dismiss the export confirmation without navigating to Finder.
  evaluate(() => { [...document.querySelectorAll('button')].find(button => button.textContent.trim() === "Close")?.click(); return true; });
  screenshot("04-icon-details.png");
  agent("click", "--selector", ".history-large-icon", "--button", "right"); wait('[role="menu"]');
  assert.ok(evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent.includes("Show in Finder") && !item.hasAttribute("data-disabled"))));
  screenshot("05-exported-actions.png");
  agent("press-key", "--key", "Escape");

  click('.history-detail-buttons .history-primary'); wait("textarea:not([disabled])");
  assert.ok(evaluate(() => !!document.querySelector('img') && document.querySelector('textarea').placeholder.includes('Make changes')));
  screenshot("06-continue-editing.png");
  generate("Give the petals a warmer golden glow");
  assert.ok(evaluate(async id => window.__historyTest.requests.at(-1).referenceImage === (await window.__historyTest.ipc.app.GetIconHistory({ id })).rawPng.split(",")[1], selectedId));
  assert.ok(list().slice(0, 3).every(entry => entry.parentId === selectedId));
  assert.ok(list().some(entry => entry.id === selectedId));
  console.log("PASS: continuing uses raw artwork and keeps its original in history");

  history(); click('.history-thumbnail'); wait('.history-detail');
  agent("click", "--selector", ".history-large-icon", "--button", "right"); wait('[role="menu"]');
  click('.history-menu-danger'); wait('dialog[open]');
  screenshot("07-remove-confirmation.png");
  click('.history-destructive');
  wait('.history-list');
  assert.ok(existsSync(exportPath), "removing history must preserve exported files");
  assert.equal(list().filter(entry => !baseline.includes(entry.id)).length, 8);
  console.log("PASS: context removal updates history and preserves exported files");
  screenshot("08-history-final.png");
  console.log(`Screenshots: ${output}`);
} finally {
  evaluate(async (baseline, keep) => {
    const state = window.__historyTest;
    if (!state) return true;
    state.ipc.app.GenerateIcon = state.originalGenerate;
    state.ipc.app.RecordIconHistory = state.originalRecord;
    if (!keep) {
      const entries = (await state.ipc.app.ListIconHistory({ offset: 0 })).entries;
      for (const entry of entries) if (!baseline.includes(entry.id)) await state.ipc.app.RemoveIconHistory({ id: entry.id });
    }
    return true;
  }, baseline, kept);
}
