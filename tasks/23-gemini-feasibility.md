# Direct Gemini integration feasibility

Investigation date: November 9, 2026. Issue: [mo-browser-apps/icons#23](https://github.com/mo-browser-apps/icons/issues/23).

Direct Gemini API access is feasible for MōIcons. Implementing a user-supplied API key is the supported route. A consumer Gemini subscription cannot currently serve as a separate sign-in method that authorizes image generation in this app. Eligible subscription Cloud credits can help pay for API usage, subject to billing setup.

No paid image-generation prototype has run: no Gemini API key was provided, and neither `GEMINI_API_KEY` nor `GOOGLE_API_KEY` was present in the investigation environment. The issue's paid prototype and end-to-end completion criteria remain open.

## Implemented validation and model selection

The follow-up implementation adds Google Gemini to the API-provider picker. Continue validates the key through Google's authenticated model-list endpoint without generating an image. The picker intersects that catalog with the four documented image models below, supports refresh, and saves model choices independently for each provider. Failed validation or persistence keeps the previous connection. The existing single-key storage design is retained; selecting another provider clears the draft key, and a successful validation replaces the saved key and provider together.

Gemini generation and reference-based refinement are wired through the Interactions API with square 1K output, cancellation, sequential variants, and no automatic paid-request retries. Existing preview, history, and export handling receives the resulting artwork. Settings explain that key validation does not establish available paid image quota.

Validation completed on November 9, 2026:

- Production build and development build passed.
- The provider/connection regression run passed all 97 tests. A subsequently added model-persistence test also passed together with the full 21-test API-settings suite.
- The running-app settings suite passed, covering provider selection, invalid-key recovery, model selection and persistence, catalog refresh, and the existing API and ChatGPT setup flows. These checks used controlled responses without modifying saved user settings.
- Google's live model endpoint rejected a deliberately invalid test key, and the adapter returned the expected `invalid_key` category without disclosing the raw response.
- Successful authentication with a real Gemini key, paid artwork generation, and Gemini-specific export verification remain pending.

Follow-up review and validation completed on November 10, 2026:

- Checked the request fields, model identifiers, authentication header, output format, and response parsing against Google's current Interactions API specification and image-generation guide.
- Fixed generation-error recovery: invalid, expired, and restricted Gemini keys now offer the Generation settings button. The regression test uses actual adapter error messages; billing, quota, and service failures retain their existing behavior.
- All 137 automated provider, connection, discovery, startup, image-request, history, and error-recovery tests passed on the current `master` dependencies with `--test-concurrency=1`. A concurrent run hit the existing startup fixture's one-second timeout; the sequential run passed without changing that test.
- Production build, development build, and TypeScript checks passed.
- All 19 running-app settings checks passed with controlled responses, including clicking the Gemini recovery button and reopening the saved provider and masked key. No saved user settings were changed and no paid generation requests were made.

## Access methods

| Route | Finding | Product implication |
| --- | --- | --- |
| User-supplied Gemini API key | Supported developer interface for generating and editing images | Add Google Gemini to API connection setup |
| Consumer Gemini subscription sign-in | No supported third-party subscription access identified | Do not offer a Gemini subscription connection |
| Subscription Cloud credits | Eligible credits can offset billed API requests | Explain as a billing benefit of the API route |
| Google Cloud OAuth | Documented API authentication tied to a Cloud project | Possible future option; does not establish consumer subscription entitlement |

Google's October response to this precise third-party-app question states that consumer subscription pass-through is not offered and directs developers to Gemini API keys or Google Cloud. The Antigravity FAQ independently says wrapping its CLI inside third-party applications is unsupported under consumer plans. This rules out treating its CLI as a subscription bridge. [Google response](https://discuss.ai.google.dev/t/supported-gemini-subscription-access-for-a-third-party-vs-code-extension/189889), [Antigravity FAQ](https://antigravity.google/docs/faq).

Google AI Pro and Ultra do include AI Studio benefits. Those first-party benefits do not establish an API entitlement for MōIcons. Even the Nano Banana extension for Gemini CLI requires a separate Gemini API key. [AI Studio announcement](https://blog.google/innovation-and-ai/technology/developers-tools/google-one-ai-studio/), [extension prerequisites](https://github.com/gemini-cli-extensions/nanobanana#-prerequisites).

The Developer Program documents eligible Cloud credits and how they apply to Gemini API billing. Prepay accounts need an active prepaid balance before eligible credits can be consumed. OAuth is also documented for Cloud-project API access, but changes authentication rather than the billing model. [Developer Program FAQ](https://developers.google.com/profile/help/faq), [OAuth guide](https://ai.google.dev/gemini-api/docs/oauth).

## Models and costs

Current published standard image-output prices in USD:

| Model | API identifier | One 1K image | Three 1K variants |
| --- | --- | ---: | ---: |
| Nano Banana 2.1 | `gemini-nano-banana-2.1` | $0.0336 | $0.1008 |
| Nano Banana 2 Lite | `gemini-3.1-flash-lite-image` | $0.0336 | $0.1008 |
| Nano Banana 2 | `gemini-3.1-flash-image` | $0.067 | $0.201 |
| Nano Banana Pro | `gemini-3-pro-image` | $0.134 | $0.402 |

The three-variant figures are calculated as three times the published image-output price. Input, text/thinking output, and any optional tools add cost. These image models have no API free tier. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).

Nano Banana 2.1 is the strongest initial default to evaluate: its current model page lists a stable release with image input/output, reference images, conversational editing, and 1K–4K output. Lite is worth offering for fast drafts, but Google explicitly says it is not optimized for multi-turn sequential editing or multiple reference inputs. Refinement quality needs a real comparison. [Nano Banana 2.1](https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1), [image-generation guide](https://ai.google.dev/gemini-api/docs/image-generation).

Setup requires an AI Studio API key associated with a Cloud project and paid billing. New prepaid setups currently start at $5; the assigned billing plan determines the precise flow. New AI Studio keys are authorization keys, and unrestricted standard keys are rejected, so key-prefix guessing is unsuitable for provider selection. [Billing](https://ai.google.dev/gemini-api/docs/billing), [API keys](https://ai.google.dev/gemini-api/docs/api-key).

Quotas depend on the project, model, and usage tier, rather than on an individual key. The UI should link to the user's active limits instead of promising a fixed daily image allowance. Geographic availability also applies; Ukraine is on the published supported list. [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [available regions](https://ai.google.dev/gemini-api/docs/available-regions).

## Fit with the existing app

The existing [provider interface](../src/main/lib/image-provider.ts) accepts a prompt, optional PNG reference, variant count, and cancellation signal, and returns base64 artwork. Gemini can fit that interface without changes to Chromium or new native capabilities. The main process already has Node.js networking, documented in the installed MōBrowser SDK.

The [renderer pipeline](../src/renderer/lib/icon-pipeline.ts) normalizes artwork, applies the macOS contour, saves history, and retains untouched source images for refinement. These stages are independent of the provider. Existing preview and export code should be reusable; actual Gemini output still needs to pass through them in a live check.

The implementation covers:

1. Add a Gemini provider and its response parser. The existing image helper expects OpenAI-style `data[].b64_json`, so it cannot parse Gemini responses unchanged.
2. Add explicit API-provider selection and provider-specific credentials/settings. The current [key resolver](../src/main/lib/openai-api-key.ts) sends every non-OpenRouter key to OpenAI. Preserve existing saved connections during migration.
3. Add model selection with supported controls. Use square 1K output initially, which matches the prepared icon master. Avoid mapping OpenAI quality labels onto unsupported Gemini options.
4. Pass cancellation through requests, preserve successful variants on partial failures, and distinguish invalid credentials, billing/access failures, quota limits, safety refusals, and empty image responses. Avoid automatic repetition after an ambiguously completed paid request.
5. Extend setup copy, documentation, and provider regression checks.

Google recommends the generally available Interactions API for new projects; `generateContent` remains supported. The adapter uses Interactions with `store=false`, sending the selected raw artwork plus the new edit instruction on each refinement. This matches the app's current local history model without requiring server conversation IDs. Exact response parsing must be verified against a real response. [Interactions API](https://ai.google.dev/gemini-api/docs/interactions).

Request variants separately: Google does not guarantee that a prompt requesting a particular image count will produce that count. Generated images contain SynthID; no special transparent output is required because MōIcons prepares its own contour and transparency. [Image-generation guide](https://ai.google.dev/gemini-api/docs/image-generation).

## Next validation step

Before marking the integration verified end to end, use a billing-enabled Gemini API key for a small prototype:

1. Validate access without generating an image, then generate one square 1K icon with Nano Banana 2.1.
2. Send its original artwork back with a refinement instruction and inspect the result.
3. Pass the returned artwork through the existing preview, history, and ICNS export workflow.
4. Check cancellation and error handling with controlled responses, then run the existing ChatGPT, OpenAI, and OpenRouter regression coverage when integration changes are made.

Two successful 1K image outputs have a published output component of $0.0672, plus input and text/thinking usage. This is an estimate for the proposed prototype, not measured spending. Successful generation, refinement, exported output, and the actual usage returned by Google should be recorded before calling the route verified end to end.
