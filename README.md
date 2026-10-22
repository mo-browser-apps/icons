# MōIcons — create app icons for macOS

A simple desktop app for generating **macOS app icons** in the `*.icns` format with AI. You describe what you want, optionally attach a reference image, pick from several variants, refine the chosen design, then save a proper `*.icns` bundle and the `*.iconset` folder with all standard sizes.

This app uses the [OpenAI API](https://openai.com/api/) for image generation.

Here's a short video demonstrating the app in action:

https://github.com/user-attachments/assets/1c87f99d-993f-408b-bd32-a1eb6552eada

## What it does

- **Prompt-based generation.** Your text is wrapped in fixed system constraints, so outputs stay on-brand for macOS-style icons (centered subject, no text, squircle-friendly composition, etc.).
- **Three variants per run.** Each generation returns three images, so you can compare quickly.
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
