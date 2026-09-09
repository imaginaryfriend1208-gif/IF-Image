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

Tests mix `node:test` with custom assertion runners; run every `scripts/test-*.mjs` file rather than relying on automatic test discovery. Current baseline: 21 scripts / 407 passing cases (the unzip script prints `PASS` lines for its seven cases). The task suite deliberately emits an observer-failure warning while testing observer isolation. `scripts/mock-proxy.mjs` and `scripts/cors-forward.mjs` are dev helpers, not tests. Report the per-script case counts in the final commit of a phase; never claim live checks that were not actually performed.

For browser verification, install this directory as `public/scripts/extensions/third-party/IF-Image` in SillyTavern (a junction works). SillyTavern loads `index.js` and `style.css` through `manifest.json`; the drawer appears in extension settings. There is no standalone app entry point. Offline tests do not establish that live backend generation or in-chat rendering works.

## Architecture and integration boundaries

`index.js` is the composition root: it obtains persisted settings, constructs three backend clients using configuration getter closures, builds the executor and task queue, mounts `renderDrawer`, registers the marker runtime and pipeline, the `<ifimage>` → marker transform on message receipt, restore listeners, the `/ifimg` command, and the LLM engine. SillyTavern imports use installation-relative paths; preserve their depth. The host supplies jQuery, `toastr`, the event bus, `getContext()` (chat context, request headers, popups), and the `/api/sd/*` relay.

There are two persistence layers:

- `src/settings.js` owns the live `extension_settings.IF_Image` object. UI handlers mutate it and invoke the supplied save callback. Defaults are deep-merged without overwriting user values, so a new key with a plain default does not need a migrator. `src/migration.js` applies sequential in-place migrations (currently v9; v8 clears pre-v8 auto-seeded `checkpointProfiles` and stamps `backends.a1111.transport`; v9 unifies `generation.checkpoint` and `backends.a1111.checkpoint` into one selection, Backends value winning), with `CURRENT_VERSION` derived from the migrator array length; add a migrator only when an existing value must be rewritten.
- `src/storage/` owns IndexedDB `IF_Image_DB`, version 1. Its five stores hold characters, outfits, styles, personas, and images (`images.js`: save/list/delete, storage stats, prune, optional JPEG conversion). Configuration does not belong in IndexedDB. Do not bump the IDB version or add stores without an explicit decision.

Pipeline (all modules exist and are wired): `src/runtime/events.js` detects markers in eligible rendered text → `src/runtime/marker-pipeline.js` (restore-from-IDB check first, then optional LLM rewrite in Assist/Full mode, then compile) → `src/runtime/tasks.js` FIFO queue (concurrency 1, maxQueued 20, timeout 300000 ms) → `src/runtime/executor.js` dispatches to a backend client → `src/runtime/insert.js` renders slot states, overlay (View/Regen/Repro/Edit/Delete), and the lightbox → `src/storage/images.js` persists the record before the slot swaps. Invariants: slot/entry identity is the rendered marker text, never the post-rewrite prompt; known revisions are deduplicated on restore; **the executor call is `execute(taskSnapshot, signal)`, not `execute(taskSnapshot, { signal })`**; task specs are projected into declared snapshot fields, so do not assume arbitrary extra properties survive; `MESSAGE_DELETED` carries the remaining chat length, not a deleted message ID.

Prompt side: `parseTriggers` resolves roster/style references and returns characters, modifiers, styles, a dialect override, param overrides (size/steps/cfg/seed, size keywords), and residual scene text. `assemblePrompt` produces `{ prompt, negative, params }`. Profile keys are `krea2`, `anima`, and `illustrious`; compiler dialect keys are `krea`, `anima`, and `illus`. Profiles describe prompt style and generation defaults, not an actual server checkpoint. `src/backends/checkpoint-profiles.js` is pure. A `checkpointProfiles[title]` row exists only when the user clicks "Save profile" in the Settings tab (rows may carry an optional display `name`) — discovery never seeds rows. `suggestCheckpointProfile` fills the editor's starting values (server per-model defaults when `/internal/models` enrichment ran, else PROFILES numbers; sampler/scheduler spelling aligned with the discovered lists), `normalizeCheckpointProfile` clamps the saved row, `SIZE_PRESETS`/`matchSizePreset` back the size preset select, and `mergeParams` applies the five-layer precedence PROFILES < generation.params[profile] < checkpointProfiles[title] < marker overrides < LLM overrides.

`src/llm/` is the rewrite engine (client with four call methods — only `direct_fetch` is live-verified — context window, prompts, two-format parser, engine). It is invoked by the pipeline only after the restore check.

## Backend contracts

Clients use settings getters so configuration edits are reflected without rebuilding clients. Generation never uses SillyTavern's secret store or the server's LLM generation APIs.

- `A1111Client` targets A1111-compatible `/sdapi/v1/*` endpoints and has two transports selected by `backends.a1111.transport`:
  - `st-relay` (default): requests go through SillyTavern's own `/api/sd/*` relay (`get-model`, `models`, `samplers`, `schedulers`, `generate`) with `getContext().getRequestHeaders()` for CSRF; the body carries `{ url, auth, ... }` and the ST server adds the Basic header, so the browser never sends `Authorization` and the backend needs no CORS. The relayed `/generate` route calls the backend's `/sdapi/v1/interrupt` if the browser socket closes, so **a relayed txt2img request must never be aborted mid-flight**: an external abort waits for settlement and then throws `A1111_ABORTED` with the result discarded. Discovery requests keep abort/timeout. A relayed generate that fails is followed by one model-list probe so the error can say whether the URL/key work and the backend refused the job (typical for a ComfyUI proxy whose workflow references missing checkpoint/LoRA files) or the connection itself is broken. The backend URL must be the final `https://` URL — Node drops `Authorization` on a cross-origin redirect and the relay returns 500; the UI warns for non-local `http://` URLs. `/internal/models` enrichment is direct-only. Note that the ST server logs relay request bodies (including auth) with `console.debug`.
  - `direct`: browser → backend. Authentication preserves the configured string verbatim before UTF-8 base64 encoding: no trimming, colon insertion, or Bearer conversion. Requests reject redirects and distinguish discovery/generation timeouts. `_safeDetail` bounds and redacts error details.
- `ComfyProxyClient` targets the custom comfy-cloud-forge proxy, not native ComfyUI workflow endpoints. It uses `/internal/*` discovery and `/sdapi/v1/*` generation, directly from the browser. The requested `model` must identify a proxy model, not merely a profile family.
- `NaiClient` uses NovelAI endpoints and extracts PNG bytes from the returned ZIP using native browser facilities. Variety+ (`skip_cfg_above_sigma`) is sent only when `backends.nai.variety` is on; the payload is unchanged otherwise. Do not assume its return shape matches either SD client.

A1111 checkpoints must resolve against fresh model discovery, never from a dialect or profile name. Set checkpoints through per-request `override_settings` with `override_settings_restore_afterwards`; do not mutate global server options. Never call the shared server's interrupt endpoint, directly or by aborting a relayed generate. Browser cancellation does not guarantee server-side job cancellation.

The UI uses discovery epochs and AbortControllers to prevent stale model lists from overwriting changed URL/auth/source/transport settings. Preserve these guards and object-URL cleanup when extending generation UI. Backend errors must be sanitized before reaching queue snapshots, console output, or the DOM; never snapshot an entire settings object to supply executor configuration; never print, log, or echo credentials (including in tests, commit messages, or shell commands).

## Working rules

`GAP-PLAN.html` is the local execution roadmap; `PLAN-CHINH.html`, `BACKEND-PLAN.html`, and `PROMPT-SPEC.html` provide broader context. These documents and `research/` are gitignored and may be absent in another checkout. Treat their inventories as plans to cross-check against code. The user's explicit instructions take precedence where they differ from the roadmap.

Do not read or copy implementation from `st-chatu8/` or another extension. The user explicitly prohibits copying that extension on licensing grounds; it may be used only as a behavioral reference described by the user. Implement required behavior independently using this repository's existing modules. Keep code and comments in English and match the plain ESM/JSDoc style.

Each phase is implemented on its own branch (`phase-a-wiring`, `phase-b-llm`, `phase-c-chars`, `phase-r-fix`, `phase-d-polish` are complete; the next phase branches from main after merge), one commit per task where practical, with commit messages that state the script/case count. Do not change `manifest.json` (including version) without an explicit request. Reuse the existing runtime modules rather than creating a parallel pipeline; do not add npm dependencies, a build step, or Markdown files.

Deferred to later phases: streaming pre-generation, Anima variant parameters, new backends, long-press editing (replaced by the Edit dialog). Completion of any phase requires both passing offline tests and live SillyTavern checks; report live checks as unverified unless actually performed.
