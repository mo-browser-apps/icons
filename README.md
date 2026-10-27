# MōIcons — create app icons for macOS

A simple desktop app for generating **macOS app icons** in the `*.icns` format with AI. You describe what you want, optionally attach a reference image, pick from several variants, refine the chosen design, then save a proper `*.icns` bundle and the `*.iconset` folder with all standard sizes.

Choose **ChatGPT** or an **API key** in the setup wizard. You can change the connection later in generation settings beside the prompt.

For ChatGPT, check the account shown, then select **Use this account**. MōIcons finds your existing sign-in, or offers browser sign-in with ChatGPT. Install the current [ChatGPT desktop app](https://learn.chatgpt.com/docs/app) to connect. If the app is missing or needs updating, the wizard offers instructions and checks again when you return. Codex CLI installations are also supported.

Connecting does not generate images. Usage starts when you press **Generate** and uses your Codex allowance and available credits; account limits apply. ChatGPT manages image model and quality. In generation settings, **Change method** lets you choose an API key; **Disconnect from MōIcons** pauses generation until you choose a method again, keeping any saved API key. Neither action signs you out of ChatGPT.

The API option supports the [OpenAI API](https://openai.com/api/) and [OpenRouter](https://openrouter.ai/). Defaults favor fast iteration: GPT Image 2.5 Flare at low quality for OpenAI, and Nano Banana 2 Lite for OpenRouter. Open generation settings to load available image models and choose quality. Choices are saved separately for each provider. OpenAI offers Low, Medium, High, and Auto; OpenRouter controls follow the selected model's capabilities. `OPENROUTER_MODEL` sets the initial OpenRouter model until you save a selection in the app.

Here's a short video demonstrating the app in action:

https://github.com/user-attachments/assets/1c87f99d-993f-408b-bd32-a1eb6552eada

## What it does

- **Prompt-based generation.** Your text is wrapped in fixed system constraints, so outputs stay on-brand for macOS-style icons (centered subject, no text, squircle-friendly composition, etc.).
- **Up to three variants per run.** Compare images and choose your favorite. The ChatGPT connection generates variants in sequence and keeps completed artwork if a later variant fails.
- **Optional reference image.** Attach a PNG to steer the model (for example a sketch, logo, or earlier render).
- **Refine workflow.** After you confirm one variant, new generations use its original artwork as the reference. Export masks, margins and shadows are kept out of model edits so they do not accumulate.
- **Preview.** Generated artwork is prepared as a 1024×1024 PNG with a macOS 15 contour, transparent margins, smooth edges and a soft outer shadow. The UI displays this finished PNG without adding another mask or shadow.
- **Export & Save.** The same finished PNG is resized into all standard **`.iconset`** sizes and packed into **`.icns`**, including its transparency and shadow. The saved file carries its own shape for Finder, Dock and DMG windows.

Quitting with an unsaved icon triggers a confirmation dialog.

## Requirements

- macOS 14 (Apple Silicon) or later.
- [Node.js](https://nodejs.org/en/download/) 24.14.1 (LTS) or later.
- [MōBrowser](https://teamdev.com/mobrowser/) 2.19.0 or later.

## Setup

```bash
npm install
```

## Run

To run the app in development mode:

```bash
npm run dev
```

For local UI work without APIs:

```bash
npm run dev:mock
```

The ChatGPT connection uses Codex App Server internally: a private `codex app-server` process with ChatGPT authentication. It does not copy authentication tokens or change the user's Codex configuration. It disables shell, app, plugin, MCP, and subagent tools for image sessions, uses a temporary reference directory, and closes the process after the operation. Stop interrupts the active Codex turn and prevents further variants; generation already processed by the service may still count toward usage. Failed image requests are not automatically repeated.

MōIcons detects the Codex executable bundled with the ChatGPT desktop app, older Codex apps, and common CLI installations. For a custom installation, launch with `MOICONS_CODEX_PATH` set to the absolute executable path. A Codex version with the built-in image generation tool and app-server `imageGeneration` events is required. This integration was verified with `codex-cli 0.155.0-alpha.16.4`; older installations may need updating.

Run provider and connection tests without API calls:

```bash
node --test tests/api-key-settings.mjs tests/image-models.mjs tests/openrouter.mjs tests/codex.mjs
```

## Build

To build the app for production:

```bash
npm run build
```

Production Sentry telemetry is included only when `SENTRY_DSN` is set during the build.
Release builds read it from the `SENTRY_DSN` GitHub Actions secret.

## How to use the app

1. **Describe the icon** in the prompt field (short phrases work well: e.g. “blue clipboard with folded corner”).
2. **Optional:** attach a **reference image** to influence layout or style.
3. Press **Generate** (or **Enter**). Wait for **three** previews.
4. **Pick a variant** to move into refine mode, or generate again from scratch.
5. In **refine** mode, adjust the prompt and generate again; the confirmed icon's original artwork is used as reference for the next batch.
6. When satisfied, click **Save**. Choose a **`.icns`** path; the app writes **`YourName.icns`** and **`YourName.iconset`** in that folder (replacing existing files only if you confirm).
7. Use **Reveal in Finder** from the success UI if you want to open the save location.

## Project layout

- **`src/main/`** — window, IPC, prompt building, provider selection, **`icns`** assembly.
- **`src/renderer/`** — React UI, icon preparation, generation pipeline state.

## Icon preparation

The model supplies square artwork with an opaque background extending to the edges.
The app places that artwork inside an 824×824 body at (100, 100) on a transparent
1024×1024 canvas. The contour and dimensions were checked against Apple's
[macOS Sequoia production template](https://devimages-cdn.apple.com/design/resources/download/macOS-Sequoia-Production-Templates-Sketch.dmg)
(`Template - Icon - App.sketch`, `512x512@2x` artwork mask). The soft shadow is an
app-defined treatment (24px blur, 12px downward offset, 24% black), rendered with
the outline at 2× resolution before downsampling. Unexpected rectangular output
is center-cropped to a square without stretching.

Preview and export share one prepared PNG; refinement retains the untouched
source. Small icon representations are downsampled from this master rather than
redrawn individually. macOS 26 can apply additional system styling to legacy
icons, so appearance there must be checked separately from macOS 15.

The app's own macOS icon uses this same treatment: `assets/app-artwork.png` is
the untouched source, `assets/app-macos.png` is the prepared master, and
`assets/app.icns` is the bundled icon (also used for the DMG volume icon).

The 16px and 32px non-Retina ICNS entries are encoded with premultiplied color
channels to preserve translucent edges (the Sequoia `iconutil` conversion can
otherwise introduce bright fringes). Larger and Retina entries retain PNG data.

For a repeatable export check, start `ICON_PROVIDER=mock npm run dev -- --automation`
and run `node tests/icon-export.mjs` in another terminal. This checks the rendered
alpha mask and shadow, rectangular input, all ten exported sizes, and an ICNS
decode roundtrip without calling an image provider. `tests/fixtures/flower.svg`
is deterministic sample artwork for visual comparisons, not a model-quality test.

## Download

You can download the app from the [releases page](https://github.com/mo-browser-apps/icons/releases). All releases are signed and notarized by Apple.
