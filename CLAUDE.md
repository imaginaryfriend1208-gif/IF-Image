# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development and verification

IF-Image is a SillyTavern third-party extension written in plain browser ES modules. There is no package.json, dependency installation, build step, standalone development server, or configured lint command. Do not introduce npm dependencies or a framework.

Run commands from the repository root. The offline suite has been verified with Node.js v22.19.0:

```bash
# All test scripts; stop and return failure on the first failing script.
for f in scripts/test-*.mjs; do node "$f" || exit 1; done

# One test script.
node scripts/test-compiler.mjs

# One named test in a node:test-based script.
node --test --test-name-pattern="chat change" scripts/test-events.mjs
```

Tests mix `node:test` with custom assertion runners; run every `scripts/test-*.mjs` file rather than relying on automatic test discovery. The initial baseline is six scripts / 103 passing cases (the local plan's 96 count omits the seven unzip cases). The task suite deliberately emits an observer-failure warning while testing observer isolation.

For browser verification, install this directory as `public/scripts/extensions/third-party/IF-Image` in SillyTavern. SillyTavern loads `index.js` and `style.css` through `manifest.json`; the drawer appears in extension settings. There is no standalone app entry point. Offline tests do not establish that live backend generation or in-chat rendering works.

## Architecture and integration boundaries

`index.js` is the composition root: it obtains persisted settings, constructs three backend clients using configuration getter closures, mounts `renderDrawer`, and registers the marker runtime. SillyTavern imports use installation-relative paths; preserve their depth. The host supplies jQuery, `toastr`, the event bus, and chat context.

There are two persistence layers:

- `src/settings.js` owns the live `extension_settings.IF_Image` object. UI handlers mutate it and invoke the supplied save callback. Defaults are deep-merged without overwriting user values. `src/migration.js` applies sequential in-place migrations, with `CURRENT_VERSION` derived from the migrator array length.
- `src/storage/` owns IndexedDB `IF_Image_DB`, version 1. Its five stores hold characters, outfits, styles, personas, and images. Configuration does not belong in IndexedDB. The image store and `by_timestamp` index already exist; using them does not require a schema bump.

The prompt compiler is separate from backend transport. `parseTriggers` resolves roster/style references and returns characters, modifiers, styles, a dialect override, and residual scene text. `assemblePrompt` produces `{ prompt, negative, params }`. Profile keys are `krea2`, `anima`, and `illustrious`; compiler dialect keys are `krea`, `anima`, and `illus`. Profiles describe prompt style and generation defaults, not an actual server checkpoint.

The existing runtime has two independent, injected modules that must be reused:

- `src/runtime/events.js` reads eligible rendered message text, excludes code and other non-content regions, respects block boundaries, and suppresses streaming/system messages. It deduplicates by message-object identity, swipe/revision, and marker occurrence. Lifecycle hooks support chat cancellation and disposal. `MESSAGE_DELETED` carries the remaining chat length, not a deleted message ID.
- `src/runtime/tasks.js` is a backend-independent FIFO queue with concurrency, bounded admission/history, timeouts, cancellation, and defensive snapshots. Cancellation sets terminal state immediately, but an executing task retains its physical slot until its executor settles. **The actual executor call is `execute(taskSnapshot, signal)`, not `execute(taskSnapshot, { signal })`.** Adapt at the composition boundary if a new executor uses the latter signature. Task specs are projected into declared snapshot fields; do not assume arbitrary extra properties survive.

At the pre-Phase-A baseline, `index.js` supplies no `onMarker` consumer, and the queue has no production caller. Generation works through the drawer's Test Gen path, not through chat markers. Executor, image insertion, and image-record modules are planned, not existing functionality. LLM settings are scaffolding, not an implemented rewrite engine.

## Backend contracts

Generation requests go directly from the browser to the configured service; they do not use SillyTavern's secret store or server generation APIs. Clients use settings getters so configuration edits are reflected without rebuilding clients.

- `ComfyProxyClient` targets the custom comfy-cloud-forge proxy, not native ComfyUI workflow endpoints. It uses `/internal/*` discovery and `/sdapi/v1/*` generation. The requested `model` must identify a proxy model, not merely a profile family.
- `A1111Client` targets A1111-compatible `/sdapi/v1/*` endpoints. Authentication preserves the configured string verbatim before UTF-8 base64 encoding: no trimming, colon insertion, or Bearer conversion. Its `_safeDetail` pattern bounds and redacts error details. Requests reject redirects and distinguish discovery/generation timeouts.
- `NaiClient` uses NovelAI endpoints and extracts PNG bytes from the returned ZIP using native browser facilities. Do not assume its return shape matches either SD client.

A1111 checkpoints must resolve against fresh model discovery, never from a dialect name. Set checkpoints through per-request `override_settings` with restoration; do not mutate global server options. Never call the shared server's interrupt endpoint. Browser cancellation does not guarantee server-side job cancellation.

The UI uses discovery epochs and AbortControllers to prevent stale model lists from overwriting changed URL/auth/source settings. Preserve these guards and object-URL cleanup when extending generation UI. Backend errors must be sanitized before reaching queue snapshots, console output, or the DOM; never snapshot an entire settings object to supply executor configuration.

## Current work: Phase A only

`GAP-PLAN.html` is the local execution roadmap; `PLAN-CHINH.html`, `BACKEND-PLAN.html`, and `PROMPT-SPEC.html` provide broader context. These documents and `research/` are gitignored and may be absent in another checkout. Treat their inventories as plans to cross-check against code. The user's detailed Phase A instructions take precedence where they differ from the roadmap.

Do not read or copy implementation from `st-chatu8/` or another extension. The user explicitly prohibits copying that extension on licensing grounds. Implement required behavior independently using this repository's existing modules. Keep code and comments in English and match the plain ESM/JSDoc style.

Implement on `phase-a-wiring`, in A1–A8 order, preferably one commit per task:

1. Fix JSON-trigger modifier arrays (retain outfit separately), honor dialect overrides, show preview prompt/negative/params, derive the UI version from one source of truth, harden Comfy requests, and remove the unused `DIALECTS` export without removing its used helpers.
2. Add an abort-aware executor dispatching existing clients and returning image Blob plus generation metadata. Document the compiled prompt envelope carried through the queue.
3. Wire marker → cached roster/styles → parse → profile/dialect resolution → compile → queue. Use concurrency 1, maxQueued 20, and timeout 300000 ms. Refresh caches on chat changes, cancel the old chat's tasks, dispose on unload, and skip non-Direct modes.
4. Replace eligible rendered marker ranges with task slots, including markers split across inline text nodes. Keep detection and insertion occurrence semantics aligned. Render queued/running/succeeded/failed/cancelled states, support retry, and manage object-URL lifetime.
5. Persist image Blobs and metadata in the existing image store before swapping a successful slot. Restore images after message rerenders/swipes without relying on marker re-emission: known revisions are deduplicated.
6. Add the first Main tab for enable flags, validated marker delimiters, default backend/profile, and Direct mode; show Assist/Full as disabled Phase B options.
7. Add full-size click preview and 300 ms click/double-click disambiguation; regeneration reuses prompt/params with seed -1 and saves a new record.
8. Add mocked executor, compiler regression, and DOM-stub insertion tests; run every old and new test script. `scripts/test-events.mjs` provides the dependency-free DOM-stub pattern.

For Phase A implementation, the allowed changes are `index.js`, `style.css`, `src/ui.js`, `src/prompt/{triggers,render,dialects}.js`, `src/backends/{comfy,nai}.js`, new `src/runtime/{executor,insert}.js`, new `src/storage/images.js`, and tests under `scripts/`. Do not change `manifest.json` (including version), `src/settings.js`, or `src/migration.js`; reuse the existing runtime modules without creating a parallel pipeline. This guidance file is the separate `/init` documentation deliverable.

Defer LLM rewriting, new backends, full character/outfit/binding systems, gallery/export, long-press editing, and streaming pre-generation. Completion requires both passing offline tests and live SillyTavern checks for marker replacement, dialect override, chat-switch cancellation, and regeneration with a new image record. Report live checks as unverified unless actually performed.
