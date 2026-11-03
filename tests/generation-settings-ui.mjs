// Run against a development app: node tests/generation-settings-ui.mjs
// If the already-running app has CDP but no agent server, set MOBROWSER_CDP_URL=http://localhost:9222.
// Mounts the real settings component with fake IPC replies; never changes saved settings or calls a provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

let socket;
let command;
if (process.env.MOBROWSER_CDP_URL) {
  const pages = await (await fetch(`${process.env.MOBROWSER_CDP_URL}/json/list`)).json();
  const page = pages.find((page) => page.type === "page" && page.url.startsWith("http://localhost:"));
  assert.ok(page, "development app is running");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const reply = JSON.parse(data);
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    if (reply.error) request.reject(new Error(reply.error.message));
    else request.resolve(reply.result);
  };
  command = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}
const agent = (...args) => JSON.parse(execFileSync("npm", ["run", "--silent", "mobrowser", "--", "agent", ...args], { encoding: "utf8", timeout: 30000 }));
const evaluate = async (fn, ...args) => {
  const expression = `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(",")})`;
  if (!command) return agent("eval", "--expr", expression).value;
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
const wait = async (fn) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(fn)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${fn}`);
};
const click = async (name) => {
  const selector = await evaluate(async (name) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const button = [...document.querySelectorAll("#settings-test button, dialog[open] button")]
        .find((button) => (button.getAttribute("aria-label") || button.textContent.trim()) === name);
      if (button && !button.disabled) {
        button.dataset.testClick = "true";
        return '[data-test-click="true"]';
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`No enabled button: ${name}`);
  }, name);
  if (command) {
    const point = await evaluate((selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, selector);
    await command("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await command("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  } else agent("click", "--selector", selector);
  await evaluate(() => { document.querySelectorAll("[data-test-click]").forEach((button) => button.removeAttribute("data-test-click")); });
};
const openKey = async () => { await click("Generation settings"); await click("Change API key"); await wait(() => !!document.querySelector("dialog[open] #generation-api-key:not(:disabled)")); };
const keyMatches = (value) => evaluate((value) => document.querySelector("dialog[open] #generation-api-key")?.value === value, value);
const fillKey = async (value) => {
  if (!command) { agent("fill", "--selector", "dialog[open] #generation-api-key", "--value", value); return; }
  await evaluate(() => { const input = document.querySelector("dialog[open] #generation-api-key"); input.focus(); input.select(); });
  await command("Input.insertText", { text: value });
};
const screenshot = async (name) => {
  if (!process.env.UI_EVIDENCE_DIR) return;
  mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
  const file = path.join(process.env.UI_EVIDENCE_DIR, `${name}.png`);
  if (command) writeFileSync(file, Buffer.from((await command("Page.captureScreenshot")).data, "base64"));
  else agent("screenshot", "--out", file);
};
const check = (name) => console.log(`PASS: ${name}`);

try {
  if (command) await command("Page.bringToFront");
  await evaluate(async () => {
    const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
    const loaded = (part) => resources.findLast((url) => url.includes(part));
    const { ipc } = await import(loaded("/gen/ipc.ts"));
    const { default: React } = await import(loaded("/react.js"));
    const { default: { createRoot } } = await import(loaded("/react-dom_client.js"));
    const { GenerationSettings } = await import(loaded("/components/generation-settings.tsx"));
    const state = window.__settingsTest = {
      ipc, originals: { ...ipc.app }, savedKey: "sk-test-saved-key", mode: "success", writes: 0, reads: 0,
      settings: { provider: "openai", model: "gpt-image-1", quality: "high", models: [{ id: "gpt-image-1", name: "GPT Image 1", qualities: ["low", "medium", "high"] }], hasApiKey: true, apiKeyRequired: true, ready: true, error: "", errorCode: "" },
    };
    ipc.app.GetGenerationSettings = async () => ({ ...state.settings });
    ipc.app.GetStoredOpenAIApiKey = () => {
      state.reads++;
      if (state.mode === "delay") return new Promise((resolve) => { state.resolve = resolve; });
      if (state.mode === "read-error") return Promise.reject(new Error("test failure"));
      return Promise.resolve({ apiKey: state.savedKey });
    };
    ipc.app.SetOpenAIApiKey = async ({ apiKey }) => { state.writes++; state.savedKey = apiKey; return { error: "", settings: state.settings }; };
    ipc.app.SetGenerationConnection = async () => ({ ...state.settings, ready: false, error: "Check the saved key." });
    ipc.app.RemoveApiKey = async () => {
      state.writes++;
      if (state.mode === "remove-error") return { error: "Could not remove the API key. Try again." };
      state.savedKey = "";
      state.settings = { ...state.settings, hasApiKey: false, ready: false, models: [] };
      return { error: "" };
    };
    state.openDialogs = [...document.querySelectorAll("dialog[open]")];
    state.openDialogs.forEach((dialog) => dialog.close());
    state.app = document.querySelector("#root");
    state.display = state.app.style.display;
    state.app.style.display = "none";
    state.container = document.body.appendChild(document.createElement("div"));
    state.container.id = "settings-test";
    state.container.style.padding = "80px 24px";
    state.root = createRoot(state.container);
    state.root.render(React.createElement(GenerationSettings, { disabled: false, connectionRequest: 0, onReadyChange: () => {} }));
    state.mountCodex = () => {
      state.savedPath = "";
      state.pathWrites = [];
      state.statusReads = 0;
      state.connectionWrites = 0;
      state.settings = { ...state.settings, provider: "codex", ready: false, codex: { state: "not_installed", email: "", error: "" } };
      ipc.app.CancelCodexLogin = async () => ({});
      ipc.app.GetCodexStatus = async () => {
        state.statusReads++;
        return { state: state.savedPath ? "ready" : "not_installed", email: state.savedPath ? "test@example.com" : "", error: "" };
      };
      ipc.app.SetGenerationConnection = async ({ connection }) => {
        state.connectionWrites++;
        state.settings = { ...state.settings, ready: connection === "codex", codex: { state: "ready", email: "test@example.com", error: "" } };
        return state.settings;
      };
      state.pickMode = "cancel";
      state.externalUrls = [];
      ipc.app.OpenExternalUrl = async ({ url }) => { state.externalUrls.push(url); return {}; };
      ipc.app.GetCodexAppPath = async () => ({ appPath: state.savedPath, error: "" });
      ipc.app.PickCodexApp = async () => {
        if (state.pickMode === "delay") await new Promise((resolve) => { state.resolvePick = resolve; });
        return { appPath: state.pickedPath || "", canceled: state.pickMode === "cancel" };
      };
      ipc.app.SetCodexAppPath = async ({ appPath }) => {
        state.pathWrites.push(appPath);
        if (state.pathMode === "delay-save") await new Promise((resolve) => { state.resolvePathSave = resolve; });
        if (state.pathMode === "invalid") return { appPath: state.savedPath, error: "That app could not be found or accessed. Check its location in Finder and try again." };
        state.savedPath = appPath;
        return { appPath, error: "" };
      };
      state.root.render(React.createElement(GenerationSettings, { key: "codex", disabled: false, connectionRequest: 0, onReadyChange: () => {} }));
    };
  });
  await wait(() => !!document.querySelector('#settings-test button:not(:disabled)'));
  await openKey();
  assert.ok(await keyMatches("sk-test-saved-key"));
  assert.equal(await evaluate(() => document.querySelector("dialog[open] #generation-api-key").type), "password");
  await screenshot("api-key");
  await click("Show API key");
  assert.equal(await evaluate(() => document.querySelector("dialog[open] #generation-api-key").type), "text");
  await click("Hide API key");
  check("saved key is prefilled, masked, and can be revealed");

  await fillKey("sk-test-edited-draft");
  await click("Remove API key");
  await screenshot("remove-key");
  await click("Cancel");
  assert.ok(await keyMatches("sk-test-edited-draft"));
  assert.equal(await evaluate(() => window.__settingsTest.writes), 0);
  check("opening, revealing, and canceling deletion do not change the stored key");
  await fillKey("sk-test-saved-key");
  await click("Continue");
  await wait(() => !!document.querySelector("dialog[open] #generation-model"));
  await click("Close generation settings");

  await evaluate(() => { window.__settingsTest.mode = "delay"; });
  await click("Generation settings");
  await click("Change API key");
  assert.equal(await evaluate(() => document.querySelector("dialog[open] #generation-api-key").disabled), true);
  await click("Back");
  await evaluate(() => { window.__settingsTest.resolve({ apiKey: "sk-stale" }); window.__settingsTest.mode = "success"; });
  await click("Change API key");
  await wait(() => !!document.querySelector("dialog[open] #generation-api-key:not(:disabled)"));
  assert.ok(await keyMatches("sk-test-saved-key"));
  check("back navigation discards a late key read");
  await click("Close generation settings");

  await evaluate(() => { window.__settingsTest.mode = "delay"; });
  await click("Generation settings");
  await click("Change API key");
  await click("Close generation settings");
  await evaluate(() => { window.__settingsTest.mode = "success"; });
  await openKey();
  await evaluate(() => window.__settingsTest.resolve({ apiKey: "sk-stale" }));
  assert.ok(await keyMatches("sk-test-saved-key"));
  check("closing and reopening ignores an older pending read");
  await click("Close generation settings");

  await evaluate(() => { window.__settingsTest.mode = "read-error"; });
  await openKey();
  assert.ok(await keyMatches(""));
  assert.match(await evaluate(() => document.querySelector("dialog[open] [role=alert]").textContent), /Could not load/);
  assert.equal(await evaluate(() => document.querySelector("dialog[open] button[type=submit]").disabled), true);
  await fillKey("sk-test-saved-key");
  await click("Continue");
  await wait(() => !!document.querySelector("dialog[open] #generation-model"));
  check("failed reads show an error and allow entering and saving a key");
  await click("Close generation settings");
  await evaluate(() => { window.__settingsTest.mode = "success"; });

  await click("Generation settings");
  await click("Change method");
  await screenshot("connection");
  await click("API keyConnect OpenAI or OpenRouter.Usage is billed by your provider.");
  await wait(() => !!document.querySelector("dialog[open] #generation-api-key:not(:disabled)"));
  assert.ok(await keyMatches("sk-test-saved-key"));
  check("a failed connection also prefills the saved key for correction");
  await click("Continue");
  await wait(() => !!document.querySelector("dialog[open] #generation-model"));
  await click("Close generation settings");
  await openKey();

  await evaluate(() => { window.__settingsTest.mode = "remove-error"; });
  await click("Remove API key");
  await click("Remove key");
  await wait(() => !!document.querySelector("dialog[open] [role=alert]"));
  assert.equal(await evaluate(() => window.__settingsTest.savedKey), "sk-test-saved-key");
  await evaluate(() => { window.__settingsTest.mode = "success"; });
  await click("Remove key");
  await wait(() => document.querySelector("dialog[open] h2")?.textContent === "Connect to generate");
  const reads = await evaluate(() => window.__settingsTest.reads);
  await click("API keyConnect OpenAI or OpenRouter.Usage is billed by your provider.");
  assert.ok(await keyMatches(""));
  assert.equal(await evaluate(() => window.__settingsTest.reads), reads);
  assert.equal(await evaluate(() => !!document.querySelector('dialog[open] [aria-label="Remove API key"]')), false);
  check("deletion handles errors, requires confirmation, and returns to empty-key setup");
  await click("Close generation settings");

  await evaluate(() => window.__settingsTest.mountCodex());
  await wait(() => document.querySelector("dialog[open] [role=status]")?.textContent.includes("ChatGPT could not be found"));
  assert.equal(await evaluate(() => [...document.querySelectorAll("dialog[open] button")].filter((button) => button.textContent.trim() === "Check again").length), 1);
  assert.equal(await evaluate(() => !!document.querySelector('dialog[open] [aria-label="Disconnect from MōIcons"], dialog[open] #codex-disconnect-description')), false);
  assert.equal(await evaluate(() => document.querySelector("dialog[open]").textContent.includes("Install ChatGPT")), false);
  assert.equal(await evaluate(() => document.querySelector("dialog[open]").textContent.includes("Set app location")), false);
  const statusReads = await evaluate(() => window.__settingsTest.statusReads);
  await click("Check again");
  await wait(() => document.querySelector("dialog[open] [role=status]")?.textContent.includes("ChatGPT could not be found"));
  assert.equal(await evaluate(() => window.__settingsTest.statusReads), statusReads + 1);
  assert.equal(await evaluate(() => window.__settingsTest.connectionWrites), 0);
  check("missing-app card offers Browse and retries detection without disconnecting");
  await screenshot("chatgpt-not-found");

  await evaluate(() => { window.__settingsTest.pickMode = "delay"; });
  await click("Browse…");
  assert.ok(await evaluate(() => [...document.querySelectorAll("dialog[open] button")].every((button) => button.disabled)));
  await evaluate(() => { window.__settingsTest.pickMode = "cancel"; window.__settingsTest.resolvePick(); });
  await wait(() => !!document.querySelector("dialog[open] button[type=submit]:not(:disabled)"));
  assert.equal(await evaluate(() => window.__settingsTest.pathWrites.length), 0);
  assert.equal(await evaluate(() => document.querySelector("dialog[open] h2").textContent), "ChatGPT");
  check("canceling the native picker leaves settings unchanged and stays on the same screen");

  await evaluate(() => { const state = window.__settingsTest; state.pickMode = "success"; state.pickedPath = "/missing/ChatGPT.app"; state.pathMode = "invalid"; });
  await click("Browse…");
  await wait(() => !!document.querySelector("dialog[open] [role=alert]"));
  assert.equal(await evaluate(() => window.__settingsTest.savedPath), "");
  check("invalid selected apps show an inline error without saving");

  const customPath = "/Applications/ChatGPT.app";
  await evaluate((appPath) => { const state = window.__settingsTest; state.pickedPath = appPath; state.pathMode = "delay-save"; }, customPath);
  await click("Browse…");
  assert.ok(await evaluate(() => [...document.querySelectorAll("dialog[open] button")].every((button) => button.disabled)));
  await evaluate(() => { window.__settingsTest.pathMode = "success"; window.__settingsTest.resolvePathSave(); });
  await wait(() => document.querySelector("dialog[open]")?.textContent.includes("test@example.com"));
  assert.equal(await evaluate(() => window.__settingsTest.savedPath), customPath);
  assert.equal(await evaluate(() => document.querySelector("dialog[open] h2").textContent), "ChatGPT");
  await click("Use this account");
  await wait(() => !document.querySelector("dialog[open]"));
  await click("Generation settings");
  await wait(() => document.querySelector("dialog[open]")?.textContent.includes("Connected to MōIcons"));
  assert.equal(await evaluate(() => document.querySelector('[aria-label^="Selected app:"]')?.textContent), customPath);
  await screenshot("chatgpt-app-selected");
  check("selected app is validated, connects, and remains visible after reopening settings");

  await evaluate(() => { const state = window.__settingsTest; state.pathMode = "invalid"; state.pickedPath = "/Applications/Other.app"; });
  await click("Change…");
  await wait(() => !!document.querySelector("dialog[open] [role=alert]"));
  assert.equal(await evaluate(() => window.__settingsTest.savedPath), customPath);
  assert.equal(await evaluate(() => document.querySelector('[aria-label^="Selected app:"]')?.textContent), customPath);
  check("an invalid replacement keeps the previously selected app");

  const replacementPath = "/Users/test/Applications/ChatGPT Personal.app";
  await evaluate((appPath) => { const state = window.__settingsTest; state.pathMode = "success"; state.pickedPath = appPath; }, replacementPath);
  await click("Change…");
  await wait(() => document.querySelector('[aria-label^="Selected app:"]')?.textContent === window.__settingsTest.savedPath);
  assert.equal(await evaluate(() => window.__settingsTest.savedPath), replacementPath);
  check("Change opens the picker and replaces the saved app");

  await click("Use automatic detection");
  await wait(() => document.querySelector("dialog[open] [role=status]")?.textContent.includes("ChatGPT could not be found"));
  assert.equal(await evaluate(() => window.__settingsTest.savedPath), "");
  assert.equal(await evaluate(() => !!document.querySelector('[aria-label^="Selected app:"]')), false);
  assert.deepEqual(await evaluate(() => window.__settingsTest.pathWrites), ["/missing/ChatGPT.app", customPath, "/Applications/Other.app", replacementPath, ""]);
  check("clearing the selected app restores automatic detection");

  const connectionWrites = await evaluate(() => window.__settingsTest.connectionWrites);
  await click("Done");
  await wait(() => !document.querySelector("dialog[open]"));
  assert.equal(await evaluate(() => window.__settingsTest.connectionWrites), connectionWrites);
  assert.deepEqual(await evaluate(() => window.__settingsTest.externalUrls), []);
  check("Done closes a missing-app state without installing or changing the connection");

} finally {
  await evaluate(() => {
    const state = window.__settingsTest;
    if (!state) return;
    state.root?.unmount();
    state.container?.remove();
    if (state.app) state.app.style.display = state.display;
    Object.assign(state.ipc.app, state.originals);
    state.openDialogs?.forEach((dialog) => dialog.showModal());
    delete window.__settingsTest;
  });
  socket?.close();
}
