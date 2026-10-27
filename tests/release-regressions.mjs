// Run with a development app already open: ICON_PROVIDER=mock npm run dev -- --automation
// Then: node tests/release-regressions.mjs
// Resets the renderer. Generation replies are isolated; no paid API calls or settings changes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/generated-images.json", import.meta.url), "utf8"));
const output = mkdtempSync(path.join(tmpdir(), "moicons-release-regressions-"));
const agent = (...args) => JSON.parse(execFileSync("npm", ["run", "--silent", "mobrowser", "--", "agent", ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 45000 }));
const evaluate = (fn, ...args) => agent("eval", "--expr", `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")})`).value;
const click = (label) => agent("click", "--selector", `[aria-label="${label}"]`);
const wait = (selector) => agent("wait-for", "--selector", selector, "--timeout", "10000");
const ready = () => wait('[aria-label="Attach reference image"]:not([disabled])');
// Compare compact image digests, not large data URLs over the automation channel.
const variants = (selector = '[aria-label^="Variant "] img') => evaluate(async (selector) => Promise.all(
  [...document.querySelectorAll(selector)].map(async (image) => Array.from(new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(image.src)))).join("-"))
), selector);
const reference = () => evaluate(() => document.querySelector('img[alt="Reference"]')?.src ?? null);
const check = (name, fn) => { fn(); console.log(`PASS: ${name}`); };
const mode = (value) => evaluate((mode) => { window.__regression.mode = mode; return true; }, value);
const fill = () => agent("fill", "--selector", "textarea", "--value", "Test icon");
const attach = (file) => { agent("answer-dialog", "--path", file); click("Attach reference image"); ready(); };
const event = (kind, format = "png", count = 1) => evaluate(async (kind, format, count, fixtures) => {
  const transfer = new DataTransfer();
  const blob = await (await fetch(`data:image/${format};base64,${fixtures[format]}`)).blob();
  for (let i = 0; i < count; i++) transfer.items.add(new File([blob], `reference.${format}`, { type: `image/${format}` }));
  const target = document.querySelector("textarea");
  if (kind === "drop") target.dispatchEvent(new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true }));
  const e = kind === "paste" ? new ClipboardEvent(kind, { clipboardData: transfer, bubbles: true, cancelable: true })
    : new DragEvent(kind, { dataTransfer: transfer, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return e.defaultPrevented;
}, kind, format, count, fixtures);

for (const [format, base64] of Object.entries({ ...fixtures, gif: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" })) {
  writeFileSync(path.join(output, `reference.${format}`), Buffer.from(base64, "base64"));
}
writeFileSync(path.join(output, "corrupt.png"), "not an image");
evaluate(() => { location.reload(); return true; });
wait("textarea");
ready();

// Use the same IPC module instance as the live UI, including Vite's cache key.
evaluate(async (fixtures) => {
  const moduleURL = performance.getEntriesByType("resource").find((entry) => entry.name.includes("/gen/ipc.ts")).name;
  const { ipc } = await import(moduleURL);
  const state = window.__regression = {
    ipc, fixtures, mode: "success", calls: [], pending: [], cancels: [],
    originals: { GenerateIcon: ipc.app.GenerateIcon, CancelGeneration: ipc.app.CancelGeneration, PickReferenceImage: ipc.app.PickReferenceImage },
  };
  ipc.app.GenerateIcon = (request) => {
    state.calls.push(request);
    if (state.mode === "pause") return new Promise((resolve) => state.pending.push(resolve));
    if (state.mode === "error") return Promise.resolve({ images: [], error: "Simulated provider failure" });
    if (state.mode === "empty") return Promise.resolve({ images: [], error: "" });
    if (state.mode === "corrupt") return Promise.resolve({ images: ["iVBORw0KGgo="], error: "" });
    if (state.mode === "partial") return Promise.resolve({ images: ["iVBORw0KGgo=", fixtures.webp], error: "" });
    return Promise.resolve({ images: [fixtures.png, fixtures.jpeg, fixtures.webp], error: "" });
  };
  ipc.app.CancelGeneration = async (request) => { state.cancels.push(request); return {}; };
  return true;
}, fixtures);

try {
  for (const format of ["png", "jpeg", "webp", "gif"]) {
    attach(path.join(output, `reference.${format}`));
    check(`native picker accepts ${format} and replaces the previous reference`, () => {
      assert.equal(evaluate(() => document.querySelectorAll('img[alt="Reference"]').length), 1);
      assert.ok(reference().startsWith(`data:image/${format};`));
      assert.ok(evaluate(() => document.querySelector('img[alt="Reference"]').naturalWidth > 0));
    });
  }
  const before = reference();
  agent("answer-dialog", "--cancel"); click("Attach reference image"); ready();
  check("canceling the picker preserves the current reference", () => assert.equal(reference(), before));
  for (const file of ["corrupt.png", "missing.png"]) {
    attach(path.join(output, file));
    check(`${file} displays an error and preserves the current reference`, () => {
      assert.ok(evaluate(() => document.querySelector('[role="alert"]')?.textContent));
      assert.equal(reference(), before);
    });
  }
  check("paste attaches one image", () => { assert.ok(event("paste")); ready(); assert.ok(reference().startsWith("data:image/png;")); });
  check("drop replaces the reference and prevents navigation", () => { assert.ok(event("drop", "webp")); ready(); assert.ok(reference().startsWith("data:image/webp;")); });
  const dropped = reference();
  check("multiple dropped images are rejected without silently picking one", () => {
    assert.ok(event("drop", "png", 2)); ready();
    assert.match(evaluate(() => document.querySelector('[role="alert"]').textContent), /one reference/);
    assert.equal(reference(), dropped);
  });
  click("Remove reference image");
  check("remove clears the reference", () => assert.equal(reference(), null));

  // Two pending selections complete in reverse order; only the latest may win.
  evaluate(() => {
    const state = window.__regression;
    state.pickers = [];
    state.ipc.app.PickReferenceImage = () => new Promise((resolve) => state.pickers.push(resolve));
    return true;
  });
  click("Attach reference image");
  fill();
  check("generation is disabled while an attachment is loading", () => assert.ok(evaluate(() => document.querySelector('[aria-label="Submit"]').disabled)));
  event("paste", "jpeg"); ready();
  evaluate(() => { window.__regression.pickers[0]({ imageB64: window.__regression.fixtures.png, mime: "image/png", error: "", canceled: false }); return true; });
  ready();
  check("a late picker response cannot replace a newer pasted reference", () => assert.ok(reference().startsWith("data:image/jpeg;")));
  evaluate(() => { const s = window.__regression; s.ipc.app.PickReferenceImage = s.originals.PickReferenceImage; return true; });

  fill(); click("Submit"); wait('[aria-label="Variant 3"]:not([disabled])');
  check("generation receives exactly the visible reference as PNG", () => assert.ok(evaluate(async () => {
    const { imageUrlToPngBase64 } = await import("/lib/image-normalization.ts");
    return window.__regression.calls.at(-1).referenceImage === await imageUrlToPngBase64(document.querySelector('img[alt="Reference"]').src);
  })));
  const previous = variants(); assert.equal(previous.length, 3);
  mode("pause"); click("Refresh");
  const attachedBeforeStop = reference();
  check("attachments are disabled for keyboard, paste and drop during generation", () => {
    assert.ok(evaluate(() => document.querySelector('[aria-label="Attach reference image"]').disabled));
    // A disabled control cannot take focus. Avoid sending Enter to the Stop
    // button that still has focus from Refresh.
    assert.ok(evaluate(() => {
      document.body.tabIndex = -1; document.body.focus();
      const button = document.querySelector('[aria-label="Attach reference image"]');
      button.focus(); return document.activeElement !== button;
    }));
    agent("press-key", "--key", "Enter");
    assert.ok(evaluate(() => !!document.querySelector('[aria-label="Stop"]')));
    assert.ok(event("drop")); assert.ok(event("paste")); assert.equal(reference(), attachedBeforeStop);
  });
  click("Stop");
  check("Stop restores all prior variants", () => assert.deepEqual(variants(), previous));
  evaluate(() => { const s = window.__regression; s.pending.shift()({ images: [s.fixtures.webp], error: "" }); return true; });
  check("late responses after Stop cannot replace the restored variants", () => assert.deepEqual(variants(), previous));

  click("Variant 2"); mode("pause"); click("Regenerate"); click("Stop");
  check("Stop also restores the selected variant", () => {
    assert.deepEqual(variants(), previous);
    assert.ok(evaluate(() => !!document.querySelector('[aria-label="Select"]')));
  });
  // Start a newer generation before completing the canceled one.
  mode("pause"); click("Regenerate");
  evaluate(() => { const s = window.__regression; s.pending.shift()({ images: [s.fixtures.png], error: "" }); return true; });
  check("a stale response cannot finish a newer generation", () => assert.ok(evaluate(() => !!document.querySelector('[aria-label="Stop"]'))));
  click("Stop");
  for (const failure of ["error", "empty", "corrupt"]) {
    mode(failure); click("Regenerate");
    agent("wait-for", "--text", "Generation failed", "--timeout", "10000");
    check(`${failure} response preserves existing variants and selection`, () => {
      assert.deepEqual(variants(), previous);
      assert.ok(evaluate(() => !!document.querySelector('[aria-label="Select"]')));
    });
    agent("press-key", "--key", "Escape");
  }
  mode("partial"); click("Regenerate"); wait('[aria-label="Variant 2"]:not([disabled])');
  check("one corrupt image does not discard a usable new variant", () => assert.equal(variants().length, 1));
  click("Variant 2"); click("Select");
  check("refinement clearly uses the selected icon and disables attachments", () => {
    assert.ok(evaluate(() => document.body.textContent.includes("Using the selected icon as the reference.")));
    assert.ok(evaluate(() => document.querySelector('[aria-label="Attach reference image"]').disabled));
    assert.ok(event("paste")); assert.ok(event("drop")); assert.equal(reference(), null);
  });
  const base = variants("img");
  fill(); mode("pause"); click("Submit"); click("Stop");
  check("Stop during refinement preserves the selected base", () => assert.deepEqual(variants("img"), base));
  mode("success"); click("Submit"); wait('[aria-label="Variant 3"]:not([disabled])');
  check("refinement sends original artwork without the export mask", () => assert.ok(evaluate(async () => {
    const { generatedImageToPngDataURL } = await import("/lib/image-normalization.ts");
    const s = window.__regression;
    return s.calls.at(-1).referenceImage === (await generatedImageToPngDataURL(s.fixtures.webp)).split(",")[1];
  })));
} finally {
  evaluate(() => { const s = window.__regression; Object.assign(s.ipc.app, s.originals); location.reload(); return true; });
  wait("textarea");
}
console.log(`PASS: release UI regressions. Picker fixtures: ${output}`);
