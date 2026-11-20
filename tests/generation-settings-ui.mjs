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
const click = async (name, scope = "#settings-test button, dialog[open] button") => {
  const selector = await evaluate(async (name, scope) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const button = [...document.querySelectorAll(scope)]
        .find((button) => (button.getAttribute("aria-label") || button.textContent.trim()) === name);
      if (button && !button.disabled) {
        button.dataset.testClick = "true";
        return '[data-test-click="true"]';
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`No enabled button: ${name}`);
  }, name, scope);
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
const openChatGPTConnection = async () => {
  await click("Change method");
  await click("ChatGPTUse your ChatGPT account through the desktop app. No API key needed.");
  await wait(() => !!document.querySelector("dialog[open] [role=status]"));
};
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
    const { ErrorModal, generationErrorSuggestsConnectionIssue } = await import(loaded("/components/error-modal.tsx"));
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
    state.mountGemini = () => {
      state.savedKey = "sk-existing";
      state.mode = "invalid-gemini";
      state.keyChecks = [];
      state.modelWrites = [];
      state.externalUrls = [];
      state.geminiModels = [
        { id: "gemini-nano-banana-2.1", name: "Nano Banana 2.1", qualities: [] },
        { id: "gemini-3-pro-image", name: "Nano Banana Pro", qualities: [] },
        { id: "gemini-3.1-flash-lite-image", name: "Nano Banana 2 Lite", qualities: [] },
      ];
      state.settings = { provider: "openai", model: "gpt-image-1", quality: "high", models: [{ id: "gpt-image-1", name: "GPT Image 1", qualities: ["low", "high"] }], hasApiKey: true, apiKeyRequired: true, ready: true, error: "", errorCode: "" };
      ipc.app.GetStoredOpenAIApiKey = async () => ({ apiKey: state.savedKey, provider: state.settings.provider });
      ipc.app.SetOpenAIApiKey = async (request) => {
        state.keyChecks.push(request);
        if (state.mode === "invalid-gemini") return { error: "Gemini rejected this API key. Create or check the key in Google AI Studio." };
        state.savedKey = request.apiKey;
        state.settings = { ...state.settings, provider: request.provider, model: state.geminiModels[0].id, quality: "", models: state.geminiModels };
        return { error: "", settings: state.settings };
      };
      ipc.app.SetGenerationSettings = async (request) => {
        state.modelWrites.push(request);
        state.settings = { ...state.settings, ...request };
        return { error: "" };
      };
      ipc.app.OpenExternalUrl = async ({ url }) => { state.externalUrls.push(url); return {}; };
      state.root.render(React.createElement(GenerationSettings, { key: "gemini", disabled: false, connectionRequest: 0, onReadyChange: () => {} }));
    };
    state.mountGeminiError = (message) => {
      const onReadyChange = () => {};
      function Recovery() {
        const [error, setError] = React.useState(message);
        const [connectionRequest, setConnectionRequest] = React.useState(0);
        return React.createElement(React.Fragment, null,
          React.createElement(GenerationSettings, { disabled: false, connectionRequest, onReadyChange }),
          error && React.createElement(ErrorModal, {
            message: error,
            onClose: () => setError(""),
            onOpenSettings: generationErrorSuggestsConnectionIssue(error)
              ? () => { setError(""); setConnectionRequest((value) => value + 1); } : undefined,
          }));
      }
      state.root.render(React.createElement(Recovery));
    };
    state.mountCodex = () => {
      state.savedPath = "";
      state.pathWrites = [];
      state.statusReads = 0;
      state.connectionWrites = 0;
      state.loginStarts = 0;
      state.loginMode = "delay";
      state.loginState = null;
      state.accountEmail = "test@example.com";
      state.accountPlan = "plus";
      state.selectionId = () => `fixture-${state.accountEmail}-${state.accountPlan}`;
      state.savedModels = new Map();
      state.modelForAccount = () => state.savedModels.get(state.selectionId()) || (state.accountPlan === "pro" ? "gpt-6.2-astra" : "gpt-6.2-sol");
      state.readyChanges = [];
      state.modelWrites = [];
      state.modelSaveError = false;
      state.modelLoadError = false;
      state.codexModels = [
        { id: "gpt-6.2-sol", name: "GPT-6.2 Sol", qualities: [], maxReferenceImages: 2 },
        { id: "gpt-6.2-astra", name: "GPT-6.2 Astra", qualities: [], maxReferenceImages: 2 },
      ];
      state.settings = { ...state.settings, provider: "codex", apiKeyRequired: false, model: "gpt-6.2-sol", quality: "", models: state.codexModels, error: "", errorCode: "", ready: false, codex: { state: "not_installed", email: "", error: "" } };
      ipc.app.StartCodexLogin = async () => {
        state.loginStarts++;
        if (state.loginMode === "delay") await new Promise((resolve) => { state.resolveLoginStart = resolve; });
        if (state.loginMode === "error") return { state: "error", email: "", error: "Could not start sign-in. Try again." };
        state.loginState = { state: "waiting", email: "", error: "" };
        return state.loginState;
      };
      ipc.app.CancelCodexLogin = async () => { state.loginState = null; return {}; };
      ipc.app.GetCodexStatus = async () => {
        state.statusReads++;
        return state.loginState || { state: state.savedPath ? "ready" : "not_installed", email: state.savedPath ? state.accountEmail : "", error: "" };
      };
      ipc.app.GetGenerationSettings = async () => {
        if (state.accountOnSettingsRead) { state.accountEmail = state.accountOnSettingsRead; state.accountOnSettingsRead = ""; }
        const codex = await ipc.app.GetCodexStatus({});
        return { ...state.settings,
          ready: state.settings.ready && codex.state === "ready" && !state.modelLoadError,
          codexSelectionId: state.modelLoadError ? "" : state.selectionId(),
          model: state.codexModels.some(m => m.id === state.modelForAccount()) ? state.modelForAccount() : state.codexModels[0]?.id || "",
          models: state.modelLoadError ? [] : state.codexModels, codex,
          error: state.modelLoadError ? "Could not load ChatGPT models. Try again." : "",
          errorCode: state.modelLoadError ? "codex_models" : "" };
      };
      ipc.app.SetGenerationSettings = async request => {
        if (state.modelSaveError || request.expectedCodexEmail !== state.accountEmail) return { error: "Your ChatGPT account changed. Refresh generation settings before choosing a model." };
        if (request.expectedCodexSelectionId !== state.selectionId()) return { error: "Your ChatGPT account or plan changed. Refresh generation settings before choosing a model." };
        state.modelWrites.push(request);
        state.savedModels.set(state.selectionId(), request.model);
        state.settings = { ...state.settings, model: request.model };
        return { error: "" };
      };
      ipc.app.SetGenerationConnection = async ({ connection }) => {
        state.connectionWrites++;
        state.settings = { ...state.settings, ready: connection === "codex", model: state.modelForAccount(), codexSelectionId: state.selectionId(), codex: { state: "ready", email: state.accountEmail, error: "" } };
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
      const onReadyChange = (ready) => { state.readyChanges.push(ready); };
      const key = `codex-${state.codexMount = (state.codexMount || 0) + 1}`;
      state.renderCodex = (requests = {}) => state.root.render(React.createElement(GenerationSettings, {
        key, disabled: false, connectionRequest: 0, modelRequest: 0, onReadyChange, ...requests,
      }));
      state.renderCodex();
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
  await click("API keyConnect OpenAI, OpenRouter, or Google Gemini.Usage is billed by your provider.");
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
  await click("API keyConnect OpenAI, OpenRouter, or Google Gemini.Usage is billed by your provider.");
  assert.ok(await keyMatches(""));
  assert.equal(await evaluate(() => window.__settingsTest.reads), reads);
  assert.equal(await evaluate(() => !!document.querySelector('dialog[open] [aria-label="Remove API key"]')), false);
  check("deletion handles errors, requires confirmation, and returns to empty-key setup");
  await click("Close generation settings");

  await evaluate(() => window.__settingsTest.mountGemini());
  await wait(() => document.querySelector("#settings-test button")?.textContent.includes("GPT Image 1"));
  await openKey();
  await evaluate(() => {
    const select = document.querySelector("#generation-api-provider");
    select.value = "gemini";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.ok(await keyMatches(""));
  await click("Get API key");
  assert.deepEqual(await evaluate(() => window.__settingsTest.externalUrls), ["https://aistudio.google.com/api-keys"]);
  await fillKey("gemini-invalid-test");
  await click("Continue");
  await wait(() => document.querySelector("dialog[open] [role=alert]")?.textContent.includes("Gemini rejected"));
  assert.equal(await evaluate(() => window.__settingsTest.savedKey), "sk-existing");
  assert.equal(await evaluate(() => window.__settingsTest.keyChecks[0].provider), "gemini");
  await screenshot("gemini-invalid-key");
  check("Gemini selection clears the old key, links to AI Studio, and keeps validation failures editable");

  await evaluate(() => { window.__settingsTest.mode = "success"; });
  await fillKey("gemini-valid-test");
  await click("Continue");
  await wait(() => !!document.querySelector("dialog[open] #generation-model"));
  assert.deepEqual(await evaluate(() => [...document.querySelector("#generation-model").options].map((option) => option.textContent)), ["Nano Banana 2.1", "Nano Banana Pro", "Nano Banana 2 Lite"]);
  assert.equal(await evaluate(() => !!document.querySelector("dialog[open] fieldset")), false);
  assert.match(await evaluate(() => document.querySelector("dialog[open]").textContent), /does not confirm available image quota/);
  await screenshot("gemini-models");
  await evaluate(() => {
    const select = document.querySelector("#generation-model");
    select.value = "gemini-3-pro-image";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Done");
  await click("Generation settings");
  assert.equal(await evaluate(() => document.querySelector("#generation-model").value), "gemini-3-pro-image");
  assert.deepEqual(await evaluate(() => window.__settingsTest.modelWrites[0]), { provider: "gemini", model: "gemini-3-pro-image", quality: "", expectedCodexEmail: "", expectedCodexSelectionId: "" });
  check("Gemini models are selectable and saved without unsupported OpenAI effort controls");

  await evaluate(() => {
    const state = window.__settingsTest;
    state.settings.models = state.geminiModels.filter((model) => model.id !== "gemini-3-pro-image");
  });
  await click("Refresh models");
  await wait(() => document.querySelector("#generation-model")?.value === "gemini-nano-banana-2.1");
  await click("Done");
  await openKey();
  assert.equal(await evaluate(() => document.querySelector("#generation-api-provider").value), "gemini");
  assert.ok(await keyMatches("gemini-valid-test"));
  await screenshot("gemini-key");
  await click("Close generation settings");
  check("refresh handles a removed model and reopening retains the Gemini provider and masked key");

  for (const message of [
    "Gemini rejected this API key. Create or check the key in Google AI Studio.",
    "This key cannot access Gemini. Check its API restrictions, project permissions, billing, and region in Google AI Studio.",
  ]) {
    await evaluate((message) => window.__settingsTest.mountGeminiError(message), message);
    await wait(() => !![...document.querySelectorAll("#settings-test button")].find((button) => button.textContent.trim() === "Generation settings"));
    await screenshot(message.startsWith("Gemini") ? "gemini-key-recovery" : "gemini-permission-recovery");
    await click("Generation settings", "#settings-test .fixed button");
    await wait(() => document.querySelector("dialog[open] h2")?.textContent === "Connect to generate");
    await click("API keyConnect OpenAI, OpenRouter, or Google Gemini.Usage is billed by your provider.");
    await wait(() => !!document.querySelector("dialog[open] #generation-api-key:not(:disabled)"));
    assert.equal(await evaluate(() => document.querySelector("#generation-api-provider").value), "gemini");
    assert.ok(await keyMatches("gemini-valid-test"));
    await click("Close generation settings");
  }
  check("Gemini authentication and permission errors open settings and return to the saved provider and key");

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
  await wait(() => !!document.querySelector("dialog[open] #generation-model:not(:disabled)"));
  assert.equal(await evaluate(() => document.querySelector("dialog[open] h2").textContent), "Generation settings");
  assert.equal(await evaluate(() => !!document.querySelector("dialog[open] [role=status]")), false);
  await click("Back");
  await wait(() => document.querySelector("dialog[open] [role=status]")?.textContent.includes("Connected to MōIcons"));
  assert.equal(await evaluate(() => !!document.querySelector("dialog[open] select")), false);
  await click("Continue");
  await click("Done");
  await wait(() => !document.querySelector("dialog[open]"));
  await click("Generation settings");
  await openChatGPTConnection();
  await wait(() => document.querySelector("dialog[open]")?.textContent.includes("Connected to MōIcons"));
  assert.equal(await evaluate(() => document.querySelector('[aria-label^="Selected app:"]')?.textContent), customPath);
  await screenshot("chatgpt-app-selected");
  check("selected app is validated, connects, and remains visible after reopening settings");

  const connectionsBeforeLogin = await evaluate(() => window.__settingsTest.connectionWrites);
  await click("Sign in again");
  assert.equal(await evaluate(() => window.__settingsTest.loginStarts), 1);
  assert.ok(await evaluate(() => [...document.querySelectorAll("dialog[open] button")].every((button) => button.disabled)));
  await evaluate(() => window.__settingsTest.resolveLoginStart());
  await wait(() => document.querySelector("dialog[open] [role=status]")?.textContent.includes("Finish signing in"));
  assert.equal(await evaluate(() => window.__settingsTest.readyChanges.at(-1)), false);
  assert.equal(await evaluate(() => [...document.querySelectorAll("dialog[open] button")].some((button) => button.textContent.trim() === "Sign in again")), false);
  await screenshot("chatgpt-signing-in-again");
  await click("Cancel sign-in");
  await wait(() => document.querySelector("dialog[open] [role=status]")?.textContent.includes("Connected to MōIcons"));
  assert.equal(await evaluate(() => window.__settingsTest.readyChanges.at(-1)), true);
  assert.equal(await evaluate(() => window.__settingsTest.connectionWrites), connectionsBeforeLogin);
  check("a connected account can sign in again; pending login blocks duplicate actions and cancellation keeps the connection");

  await evaluate(() => { window.__settingsTest.loginMode = "error"; });
  await click("Sign in again");
  await wait(() => document.querySelector("dialog[open] [role=alert]")?.textContent.includes("Could not start sign-in"));
  await click("Try again");
  await wait(() => document.querySelector("dialog[open] [role=status]")?.textContent.includes("Connected to MōIcons"));
  assert.equal(await evaluate(() => window.__settingsTest.connectionWrites), connectionsBeforeLogin);
  check("failed reauthentication stays recoverable without disconnecting the saved account");

  await evaluate(() => { window.__settingsTest.loginMode = "success"; });
  await click("Sign in again");
  await wait(() => document.querySelector("dialog[open] [role=status]")?.textContent.includes("Finish signing in"));
  await evaluate(() => { window.__settingsTest.accountEmail = "renewed@example.com"; window.__settingsTest.loginState = null; });
  await wait(() => document.querySelector("dialog[open] [role=status]")?.textContent.includes("renewed@example.com"));
  assert.equal(await evaluate(() => window.__settingsTest.readyChanges.at(-1)), false);
  assert.equal(await evaluate(() => window.__settingsTest.connectionWrites), connectionsBeforeLogin);
  await click("Use this account");
  await wait(() => !!document.querySelector("dialog[open] #generation-model:not(:disabled)"));
  await click("Done");
  await wait(() => !document.querySelector("dialog[open]"));
  await click("Generation settings");
  await openChatGPTConnection();
  await wait(() => document.querySelector("dialog[open] [role=status]")?.textContent.includes("Connected to MōIcons"));
  assert.equal(await evaluate(() => window.__settingsTest.readyChanges.at(-1)), true);
  assert.equal(await evaluate(() => window.__settingsTest.settings.codex.email), "renewed@example.com");
  assert.equal(await evaluate(() => window.__settingsTest.loginStarts), 3);
  check("reauthentication polls for completion and requires confirmation before connecting a different account");

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

  await evaluate(() => { window.__settingsTest.savedPath = "/Applications/ChatGPT.app"; });
  await click("Generation settings");
  await wait(() => document.querySelector("dialog[open] [role=status]")?.textContent.includes("Connected to MōIcons"));
  await click("Continue");
  await wait(() => !!document.querySelector("dialog[open] #generation-model:not(:disabled)"));
  await click("Done");
  await wait(() => !document.querySelector("dialog[open]"));
  await evaluate(() => {
    const state = window.__settingsTest;
    state.mountCodex();
    state.savedPath = "/Applications/ChatGPT.app";
    state.settings.ready = true;
    state.settings.codex = { state: "ready", email: "test@example.com", error: "" };
  });
  await wait(() => document.querySelector('#settings-test [aria-label="Generation settings"]')?.textContent === "GPT-6.2 Sol");
  await evaluate(() => window.__settingsTest.renderCodex({ modelRequest: 1 }));
  await wait(() => !!document.querySelector("#generation-model:not(:disabled)"));
  assert.equal(await evaluate(() => document.querySelector("dialog[open] h2").textContent), "Generation settings");
  assert.equal(await evaluate(() => document.activeElement.id), "generation-model");
  assert.equal(await evaluate(() => !!document.querySelector("dialog[open] [role=status]")), false);
  assert.deepEqual(await evaluate(() => [...document.querySelector("#generation-model").options].map(o => o.textContent)), ["GPT-6.2 Sol", "GPT-6.2 Astra"]);
  assert.equal(await evaluate(() => !!document.querySelector("dialog[open] fieldset")), false);
  check("ChatGPT uses the shared model screen for setup, the prompt button, and model requests; connection controls remain separate");
  await evaluate(() => {
    const select = document.querySelector("#generation-model");
    select.value = "gpt-6.2-astra";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await screenshot("chatgpt-model-selector");
  await click("Done");
  await wait(() => !document.querySelector("dialog[open]"));
  assert.deepEqual(await evaluate(() => window.__settingsTest.modelWrites.at(-1)), {
    provider: "codex", model: "gpt-6.2-astra", quality: "", expectedCodexEmail: "test@example.com",
    expectedCodexSelectionId: "fixture-test@example.com-plus",
  });
  await click("Generation settings");
  await wait(() => document.querySelector("#generation-model:not(:disabled)")?.value === "gpt-6.2-astra");
  assert.equal(await evaluate(() => document.querySelector('#settings-test [aria-label="Generation settings"]').textContent), "GPT-6.2 Astra");
  check("ChatGPT model selection saves with the expected account and survives reopening");

  await evaluate(() => { window.__settingsTest.codexModels = window.__settingsTest.codexModels.slice(0, 1); });
  await click("Refresh models");
  await wait(() => document.querySelector("#generation-model:not(:disabled)")?.value === "gpt-6.2-sol");
  check("refresh removes unavailable ChatGPT models and selects the new default");

  await evaluate(() => {
    const state = window.__settingsTest;
    state.codexModels.push({ id: "gpt-6.2-astra", name: "GPT-6.2 Astra", qualities: [], maxReferenceImages: 2 });
    state.modelSaveError = true;
  });
  await click("Refresh models");
  await wait(() => !!document.querySelector("#generation-model:not(:disabled)"));
  await click("Done");
  await wait(() => document.querySelector("dialog[open] [role=alert]")?.textContent.includes("account changed"));
  await screenshot("chatgpt-model-save-error");
  await click("Close generation settings");
  check("a rejected model save keeps the settings open with an actionable error");

  await evaluate(() => { window.__settingsTest.modelSaveError = false; window.__settingsTest.modelLoadError = true; });
  await click("Generation settings");
  await click("Refresh models");
  await wait(() => document.querySelector("dialog[open] [role=alert]")?.textContent.includes("Could not load ChatGPT models"));
  assert.equal(await evaluate(() => document.querySelector("dialog[open] h2").textContent), "Generation settings");
  assert.ok(await evaluate(() => document.querySelector("#generation-model").disabled));
  assert.equal(await evaluate(() => window.__settingsTest.readyChanges.at(-1)), false);
  await click("Close generation settings");
  await click("Generation settings");
  assert.equal(await evaluate(() => document.querySelector("dialog[open] h2").textContent), "Generation settings");
  await evaluate(() => { window.__settingsTest.modelLoadError = false; });
  await click("Refresh models");
  await wait(() => !!document.querySelector("#generation-model:not(:disabled)"));
  assert.equal(await evaluate(() => window.__settingsTest.readyChanges.at(-1)), true);
  check("catalog errors stay on the model screen and recover through Refresh without reconnecting");
  await click("Close generation settings");

  const confirmationsBeforeRefresh = await evaluate(() => window.__settingsTest.connectionWrites);
  const savesBeforeRefresh = await evaluate(() => window.__settingsTest.modelWrites.length);
  await click("Generation settings");
  await evaluate(() => { window.__settingsTest.accountEmail = "other@example.com"; });
  await click("Refresh models");
  await wait(() => document.querySelector("dialog[open] [role=status]")?.textContent.includes("other@example.com"));
  assert.equal(await evaluate(() => window.__settingsTest.readyChanges.at(-1)), false);
  assert.equal(await evaluate(() => window.__settingsTest.connectionWrites), confirmationsBeforeRefresh);
  assert.equal(await evaluate(() => window.__settingsTest.modelWrites.length), savesBeforeRefresh);
  assert.equal(await evaluate(() => !!document.querySelector("dialog[open] #generation-model")), false);
  await screenshot("chatgpt-account-confirmation");
  await click("Close generation settings");
  assert.equal(await evaluate(() => window.__settingsTest.readyChanges.at(-1)), false);
  await click("Generation settings");
  await click("Use this account");
  await wait(() => !!document.querySelector("dialog[open] #generation-model:not(:disabled)"));
  assert.equal(await evaluate(() => window.__settingsTest.readyChanges.at(-1)), true);
  assert.equal(await evaluate(() => window.__settingsTest.connectionWrites), confirmationsBeforeRefresh + 1);
  await click("Done");
  await wait(() => !document.querySelector("dialog[open]"));
  assert.equal(await evaluate(() => window.__settingsTest.modelWrites.at(-1).expectedCodexEmail), "other@example.com");
  check("Refresh requires confirmation of a changed account, including after closing and reopening settings");

  await click("Generation settings");
  await evaluate(() => {
    const state = window.__settingsTest;
    state.accountPlan = "pro";
    state.savedModels.set(state.selectionId(), "gpt-6.2-astra");
  });
  const savesBeforePlanChange = await evaluate(() => window.__settingsTest.modelWrites.length);
  await click("Done");
  await wait(() => document.querySelector("dialog[open] [role=alert]")?.textContent.includes("account or plan changed"));
  assert.equal(await evaluate(() => window.__settingsTest.modelWrites.length), savesBeforePlanChange);
  assert.equal(await evaluate(() => window.__settingsTest.savedModels.get(window.__settingsTest.selectionId())), "gpt-6.2-astra");
  await click("Refresh models");
  await wait(() => document.querySelector("#generation-model:not(:disabled)")?.value === "gpt-6.2-astra");
  assert.equal(await evaluate(() => window.__settingsTest.connectionWrites), confirmationsBeforeRefresh + 1);
  await click("Done");
  await wait(() => !document.querySelector("dialog[open]"));
  assert.equal(await evaluate(() => window.__settingsTest.modelWrites.at(-1).expectedCodexSelectionId), "fixture-other@example.com-pro");
  check("a changed plan rejects the stale draft and Refresh restores that plan's saved choice");

  await evaluate(() => window.__settingsTest.renderCodex({ modelRequest: 2, requiresExtraReference: true }));
  await wait(() => !!document.querySelector("#generation-model:not(:disabled)"));
  assert.ok(await evaluate(() => [...document.querySelector("#generation-model").options].every(option => option.textContent.endsWith(" · Extra reference"))));
  assert.ok(await evaluate(() => document.querySelector("dialog[open]").textContent.includes("Choose a model marked “Extra reference”")));
  check("ChatGPT options have the Extra reference marker requested by the refinement instructions");
  await click("Close generation settings");

  await click("Generation settings");
  await evaluate(() => { window.__settingsTest.accountOnSettingsRead = "third@example.com"; });
  await openChatGPTConnection();
  await wait(() => document.querySelector("dialog[open] [role=status]")?.textContent.includes("third@example.com"));
  assert.equal(await evaluate(() => window.__settingsTest.readyChanges.at(-1)), false);
  assert.equal(await evaluate(() => window.__settingsTest.connectionWrites), confirmationsBeforeRefresh + 1);
  await click("Use this account");
  await wait(() => !!document.querySelector("dialog[open] #generation-model:not(:disabled)"));
  assert.equal(await evaluate(() => window.__settingsTest.readyChanges.at(-1)), true);
  check("an account change between status and model reads also requires confirmation");
  await click("Close generation settings");

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
