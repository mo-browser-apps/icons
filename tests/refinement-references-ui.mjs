// Run against ICON_PROVIDER=mock npm run dev -- --automation.
// Uses real UI and preview windows with isolated provider/settings/history replies.
// No paid requests, saved-key changes, or History writes. Screenshots use fixture artwork.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const output = path.resolve("tasks/evidence/refinement-references");
mkdirSync(output, { recursive: true });
const agent = (...args) => JSON.parse(execFileSync("npm", ["--silent", "run", "mobrowser", "--", "agent", ...args], {
  encoding: "utf8", maxBuffer: 24 * 1024 * 1024, timeout: 30000, stdio: ["pipe", "pipe", "pipe"],
}));
const evaluate = (fn, ...args) => agent("eval", `(${fn.toString()})(${args.map(x => JSON.stringify(x)).join(",")})`).value;
const click = label => agent("click", "--selector", `[aria-label="${label}"]`);
const wait = selector => agent("wait-for", "--selector", selector, "--timeout", "10000");
const fill = text => agent("fill", "--selector", "textarea", "--value", text);
const ready = () => wait('[aria-label="Submit"]:not(:disabled)');
const screenshot = name => agent("screenshot", "--out", path.join(output, name));
const results = [];
const check = (name, fn) => { fn(); results.push(name); console.log(`PASS: ${name}`); };
const until = (fn, message) => {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (fn()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
  }
  assert.fail(message);
};
const reference = () => evaluate(() => document.querySelector('img[alt="Reference"]')?.src ?? null);
const base = () => evaluate(() => document.querySelector('[aria-label="Preview icon"] img')?.src ?? null);
const state = mode => evaluate(mode => { window.__references.mode = mode; return true; }, mode);
const event = (kind = "drop", count = 1) => evaluate(async (kind, count) => {
  const transfer = new DataTransfer();
  const blob = await (await fetch(window.__references.reference)).blob();
  for (let i = 0; i < count; i++) transfer.items.add(new File([blob], "color-reference.png", { type: "image/png" }));
  const target = document.querySelector("textarea");
  const evt = kind === "paste" ? new ClipboardEvent(kind, { clipboardData: transfer, bubbles: true, cancelable: true })
    : new DragEvent(kind, { dataTransfer: transfer, bubbles: true, cancelable: true });
  target.dispatchEvent(evt);
  return evt.defaultPrevented;
}, kind, count);
const changeModel = id => {
  click("Generation settings");
  agent("select-option", "--selector", "#generation-model", "--value", id);
  agent("click", "--selector", 'dialog button[type="submit"]');
  wait('dialog:not([open])');
};

evaluate(() => { location.reload(); return true; });
wait('textarea'); wait('[aria-label="Generation settings"]:not(:disabled)');
evaluate(async svg => {
  const url = performance.getEntriesByType("resource").find(e => e.name.includes("/gen/ipc.ts")).name;
  const { ipc } = await import(url);
  const realSupport = await ipc.app.GetReferenceSupport({});
  if (realSupport.status !== "supported") throw new Error("Start this test with ICON_PROVIDER=mock");
  const png = async markup => {
    const image = new Image(); image.src = "data:image/svg+xml;base64," + btoa(markup); await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024;
    canvas.getContext("2d").drawImage(image, 0, 0, 1024, 1024);
    return canvas.toDataURL("image/png");
  };
  const artwork = await png(svg);
  const reference = await png('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#f8ede1"/><circle cx="512" cy="400" r="270" fill="#d87c5a"/><circle cx="340" cy="660" r="190" fill="#809b87"/><circle cx="680" cy="670" r="170" fill="#e7bb71"/></svg>');
  const originals = Object.fromEntries(["GenerateIcon", "CancelGeneration", "RecordIconHistory", "GetGenerationSettings", "SetGenerationSettings", "GetReferenceSupport"].map(key => [key, ipc.app[key]]));
  const test = window.__references = { ipc, originals, artwork, reference, mode: "success", calls: [], records: [], pending: [], checks: [], supportMode: "normal", held: [],
    settings: { provider: "openrouter", model: "openai/gpt-image-2.5-flare", quality: "low", ready: true, hasApiKey: true, apiKeyRequired: true,
      error: "", errorCode: "", models: [
        { id: "openai/gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", qualities: ["low", "high"], maxReferenceImages: 16 },
        { id: "recraft/recraft-v4", name: "Recraft V4", qualities: ["low"], maxReferenceImages: 1 },
      ] },
  };
  ipc.app.GetGenerationSettings = async () => test.settings;
  ipc.app.SetGenerationSettings = async request => { Object.assign(test.settings, request); return { error: "" }; };
  ipc.app.GetReferenceSupport = async () => {
    test.checks.push(test.settings.model);
    if (test.supportMode === "held") return new Promise(resolve => test.held.push(resolve));
    if (test.supportMode === "error") return { status: "error", message: "Couldn’t check whether this model supports an extra reference. Try again." };
    return test.settings.model.startsWith("recraft/")
      ? { status: "unsupported", message: "This model can edit your current icon, but can’t use an additional reference with these settings." }
      : { status: "supported", message: "" };
  };
  ipc.app.GenerateIcon = async request => {
    test.calls.push(request);
    if (test.mode === "pause") return new Promise(resolve => test.pending.push(resolve));
    if (test.mode === "error") return { images: [], error: "Simulated provider failure" };
    return { images: [artwork.split(",")[1], reference.split(",")[1], artwork.split(",")[1]], error: "" };
  };
  ipc.app.CancelGeneration = async () => ({});
  ipc.app.RecordIconHistory = async request => {
    test.records.push(request);
    return { entries: request.variants.map(v => ({ id: `${request.generationId}-${v.variantIndex}`, variantIndex: v.variantIndex })), hasMore: false, warning: "" };
  };
  return true;
}, readFileSync("tests/fixtures/flower.svg", "utf8"));

try {
  click("Generation settings"); click("Refresh models"); wait('#generation-model option[value="recraft/recraft-v4"]'); click("Close generation settings");
  fill("A botanical icon for a quiet garden app"); ready(); click("Submit");
  wait('[aria-label="Variant 3"]:not(:disabled)'); click("Variant 1"); click("Select");
  const originalBase = base();
  check("refinement has no extra attachment button", () => assert.equal(evaluate(() => !!document.querySelector('[aria-label="Attach reference image"]')), false));
  event("dragover"); wait('[role="status"]'); screenshot("01-drop-reference.png");
  check("drop adds a reference while keeping the current icon", () => { assert.ok(event()); wait('img[alt="Reference"]'); assert.equal(base(), originalBase); });
  fill("Use the reference’s warm colors. Keep the flower’s shape."); ready(); screenshot("02-reference-ready.png");
  const attached = reference();
  click("Preview reference image");
  until(() => agent("list-windows").windows.length === 3, "reference preview opens");
  let windows = agent("list-windows").windows;
  agent("select-window", "--index", String(windows.find(w => w.url.endsWith("#icon-preview-toolbar")).index));
  wait('output');
  check("reference opens in the existing full-size viewer", () => assert.match(agent("snapshot").snapshot, /Reference image/));
  try { click("Close preview"); } catch (e) { assert.match(String(e.stdout) + String(e.stderr), /closed/); }
  until(() => agent("list-windows").windows.length === 1, "preview closes");
  agent("select-window", "--index", "0");
  assert.equal(reference(), attached); assert.equal(base(), originalBase);

  changeModel("recraft/recraft-v4"); wait('[role="alert"]'); screenshot("03-model-warning.png");
  check("unsupported model blocks submission and keeps the prompt and both images", () => {
    assert.ok(evaluate(() => document.querySelector('[aria-label="Submit"]').disabled));
    assert.equal(reference(), attached); assert.equal(base(), originalBase);
    assert.match(evaluate(() => document.querySelector("textarea").value), /warm colors/);
    assert.ok(evaluate(() => document.querySelector('[aria-label="Submit"]').getBoundingClientRect().bottom <= innerHeight));
    assert.ok(evaluate(() => {
      const editor = document.querySelector(".overflow-y-auto:not(textarea)");
      return editor.scrollHeight <= editor.clientHeight;
    }), "warning fits without scrolling the default window");
  });
  click("Remove reference image"); ready();
  check("removing an unsupported reference restores ordinary refinement", () => { assert.equal(reference(), null); assert.equal(base(), originalBase); });
  event("paste"); wait('[role="alert"]');
  agent("click", "--selector", '[role="alert"] button'); wait('dialog[open] #generation-model');
  screenshot("04-choose-model.png");
  check("Choose model opens model settings and identifies compatible choices", () => {
    assert.match(evaluate(() => document.querySelector('#generation-model option[value="openai/gpt-image-2.5-flare"]').textContent), /Extra reference/);
  });
  agent("select-option", "--selector", "#generation-model", "--value", "openai/gpt-image-2.5-flare");
  agent("click", "--selector", 'dialog button[type="submit"]'); ready();
  check("switching models rechecks support without losing the attachment", () => assert.equal(reference(), attached));

  // Removing and replacing an attachment while a check is pending must ignore stale replies.
  click("Remove reference image");
  evaluate(() => { window.__references.supportMode = "held"; return true; }); event("paste");
  wait('[role="status"]');
  check("generation waits for capability checks", () => assert.ok(evaluate(() => document.querySelector('[aria-label="Submit"]').disabled)));
  click("Remove reference image"); ready();
  evaluate(() => { const t = window.__references; t.supportMode = "normal"; t.held.shift()({ status: "unsupported", message: "Stale reply" }); return true; });
  event("paste"); ready(); assert.equal(evaluate(() => document.body.textContent.includes("Stale reply")), false);
  click("Remove reference image");
  evaluate(() => { window.__references.supportMode = "error"; return true; }); event(); wait('[role="alert"]');
  check("network errors offer retry instead of claiming the model is unsupported", () => assert.match(evaluate(() => document.querySelector('[role="alert"]').textContent), /Try again/));
  evaluate(() => { window.__references.supportMode = "normal"; return true; });
  click("Try again"); ready();

  const dropBytes = (data, mime, name) => evaluate((data, mime, name) => {
    const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, { type: mime }));
    document.querySelector("textarea").dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    return true;
  }, data, mime, name);
  dropBytes(Buffer.from("not an image").toString("base64"), "image/png", "broken.png"); wait('[role="alert"]');
  check("a corrupt image shows a useful error and preserves the existing reference", () => {
    assert.match(evaluate(() => document.querySelector('[role="alert"]').textContent), /could not be opened/);
    assert.equal(reference(), attached); assert.equal(base(), originalBase);
  });
  const formats = JSON.parse(readFileSync("tests/fixtures/generated-images.json", "utf8"));
  formats.gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  for (const format of ["jpeg", "webp", "gif"]) {
    dropBytes(formats[format], `image/${format}`, `reference.${format}`); ready();
    state("pause"); click("Submit"); wait('[aria-label="Stop"]');
    until(() => evaluate(() => window.__references.pending.length > 0), "normalized reference reaches generation");
    const sentPng = evaluate(() => window.__references.calls.at(-1).additionalReferenceImage.startsWith("iVBORw0KGgo"));
    click("Stop"); ready();
    check(`${format.toUpperCase()} attachments reach generation as PNG without changing the current icon`, () => {
      assert.ok(sentPng);
      assert.ok(base() === originalBase);
    });
    evaluate(() => { window.__references.pending.shift()({ images: [], error: "Generation stopped." }); return true; });
  }
  dropBytes(formats.png, "", "reference.png"); ready();
  check("a PNG file without a MIME label is accepted", () => assert.ok(reference()));
  event("paste"); ready();

  event("drop", 2); wait('[role="alert"]');
  check("multiple dropped files do not replace the existing reference", () => assert.equal(reference(), attached));
  event("paste"); ready();
  state("pause"); click("Submit"); wait('[aria-label="Stop"]'); event("paste");
  check("generation locks attachment changes", () => assert.ok(evaluate(() => document.querySelector('[aria-label="Remove reference image"]').disabled)));
  click("Stop"); ready();
  check("Stop preserves current icon, reference and prompt", () => { assert.equal(base(), originalBase); assert.equal(reference(), attached); });
  evaluate(() => { const t = window.__references; t.pending.shift()({ images: [t.reference.split(",")[1]], error: "" }); return true; });
  assert.equal(base(), originalBase);
  state("error"); click("Submit"); agent("wait-for", "--text", "Generation failed", "--timeout", "10000"); agent("press-key", "--key", "Escape"); ready();
  check("provider failure preserves the complete edit for retry", () => { assert.equal(base(), originalBase); assert.equal(reference(), attached); });

  state("success"); click("Submit"); wait('[aria-label="Variant 3"]:not(:disabled)');
  check("both original artwork and new reference are sent and history retains its parent", () => assert.ok(evaluate(() => {
    const t = window.__references, call = t.calls.at(-1);
    return call.referenceImage === t.artwork.split(",")[1] && call.additionalReferenceImage === t.reference.split(",")[1]
      && t.records.at(-1).parentId === `${t.records[0].generationId}-0`;
  })));
  click("Refresh"); wait('[aria-label="Variant 3"]:not(:disabled)');
  check("regenerating a refinement retains the same two inputs", () => assert.ok(evaluate(() => {
    const calls = window.__references.calls;
    return calls.at(-1).referenceImage === calls.at(-2).referenceImage && calls.at(-1).additionalReferenceImage === calls.at(-2).additionalReferenceImage;
  })));
  click("Variant 2"); click("Select");
  check("selecting an updated icon clears only the completed edit's reference and prompt", () => {
    assert.equal(reference(), null); assert.equal(evaluate(() => document.querySelector("textarea").value), ""); assert.notEqual(base(), originalBase);
  });
  event("paste"); fill("Use a little more green."); ready(); click("Submit"); wait('[aria-label="Variant 3"]:not(:disabled)');
  check("later refinement uses the newly selected artwork and continues the history chain", () => assert.ok(evaluate(() => {
    const t = window.__references;
    return t.calls.at(-1).referenceImage === t.reference.split(",")[1] && t.records.at(-1).parentId === `${t.records.at(-2).generationId}-1`;
  })));
  click("Variant 1"); click("Select"); event("paste"); fill("Use the reference’s warm colors. Keep the flower’s shape."); ready();
  screenshot("05-later-refinement.png");
  check("composer stays inside the default window", () => assert.ok(evaluate(() => {
    const textarea = document.querySelector("textarea").getBoundingClientRect();
    const submit = document.querySelector('[aria-label="Submit"]').getBoundingClientRect();
    return textarea.top >= 0 && submit.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth;
  })));
  writeFileSync(path.join(output, "checks.json"), JSON.stringify({ passed: results, fixtureArtwork: true }, null, 2) + "\n");
} finally {
  evaluate(() => { const t = window.__references; if (t) Object.assign(t.ipc.app, t.originals); location.reload(); return true; });
  wait("textarea");
}
console.log(`Screenshots: ${output}`);
