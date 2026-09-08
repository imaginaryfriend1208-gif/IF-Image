// IF Image - settings migrations.
// Each migrator takes the raw settings object and mutates it in place.
// Migrators run sequentially: version 1 → 2 → 3 → ...
// Version 0 = legacy v0.1.0 shape (no settingsVersion field).

/**
 * @type {Array<(settings: object) => void>}
 * Index 0 = migrate from version 0 → 1, index 1 = from 1 → 2, etc.
 */
export const migrators = [
    // 0 → 1: add settingsVersion field (v0.1.0 → v0.2.0 transition).
    // No structural changes needed — deepMerge already fills new keys.
    // This migrator just stamps the version so future migrations can run.
    (s) => {
        // Nothing to transform; the version stamp is set by runMigrations().
    },

    // 1 → 2: add LLM config stub + generation section.
    (s) => {
        if (!s.llm) {
            s.llm = {
                apiProfiles: [],
                contextProfiles: [],
                requestMapping: {},
                defaultMethod: 'direct',
            };
        }
        if (!s.generation) {
            s.generation = {
                mode: 'direct',
                startTag: 'image###',
                endTag: '###',
                enabled: true,
            };
        }
    },

    // 2 → 3: add the AUTOMATIC1111-compatible API connection section.
    // The legacy Comfy Cloud Proxy credentials/URL are never read, moved or
    // overwritten: comfy.* stays exactly as-is, a1111.* starts blank.
    (s) => {
        if (!s.backends) s.backends = {};
        if (!s.backends.a1111) {
            s.backends.a1111 = {
                baseUrl: '',
                auth: '',
                // Checkpoint is discovered + selected explicitly; never
                // inferred from the dialect/profile.
                checkpoint: '',
            };
        }
        // Connection source for the SD-side "comfy" slot: 'legacy_proxy'
        // keeps the existing proxy config as the active default.
        if (!s.backends.comfy || typeof s.backends.comfy !== 'object') {
            s.backends.comfy = {};
        }
        if (s.backends.comfy.connection === undefined) {
            s.backends.comfy.connection = 'legacy_proxy';
        }
    },

    // 3 → 4: promote runtime-only fields (written by the UI/pipeline in Phase
    // A but absent from defaultSettings) into persisted defaults, and add the
    // Phase B LLM settings. Non-destructive: existing user values always win,
    // only missing keys are stamped.
    (s) => {
        // Generation runtime defaults promoted from index.js.
        if (!s.generation) s.generation = {};
        if (s.generation.backend === undefined) s.generation.backend = 'comfy';
        if (s.generation.profile === undefined) s.generation.profile = 'anima';
        if (s.generation.sceneWindow === undefined) s.generation.sceneWindow = 4;
        else {
            const n = Number(s.generation.sceneWindow);
            s.generation.sceneWindow = Number.isFinite(n) ? Math.min(8, Math.max(2, n)) : 4;
        }
        if (s.generation.logLimit === undefined) s.generation.logLimit = 50;
        else {
            const n = Number(s.generation.logLimit);
            s.generation.logLimit = Number.isFinite(n) ? Math.max(1, n) : 50;
        }
        if (s.generation.dryRun === undefined) s.generation.dryRun = false;
        if (s.backends?.comfy && s.backends.comfy.proxyModel === undefined) {
            s.backends.comfy.proxyModel = '';
        }
        // Phase B LLM settings.
        if (!s.llm) {
            s.llm = {
                apiProfiles: [],
                contextProfiles: [],
                requestMapping: {},
                defaultMethod: 'direct',
            };
        }
        if (s.llm.defaultApiProfileId === undefined) s.llm.defaultApiProfileId = '';
        if (s.llm.injectionStyle === undefined) s.llm.injectionStyle = 'compact';
        else if (!['compact', 'xml', 'full'].includes(s.llm.injectionStyle)) s.llm.injectionStyle = 'compact';
    },

    // 4 -> 5: add the Phase C0 per-profile generation param overrides
    // structure. Values are clamped on read (never here) so this migrator
    // stays a pure structural stamp — see src/settings.js's comment.
    (s) => {
        if (!s.generation) s.generation = {};
        if (!s.generation.params || typeof s.generation.params !== 'object') {
            s.generation.params = { krea2: {}, anima: {}, illustrious: {} };
        } else {
            for (const key of ['krea2', 'anima', 'illustrious']) {
                if (!s.generation.params[key] || typeof s.generation.params[key] !== 'object') {
                    s.generation.params[key] = {};
                }
            }
        }
    },

    // 5 -> 6 (Phase R1): persisted A1111 discovery cache + per-checkpoint
    // profile map, and the generation-level checkpoint selection.
    // - discovery: last successful discover() result ({at: 0} = never ran);
    //   cleared on URL/auth change, so it is a cache, not configuration.
    // - checkpointProfiles: title -> { profile, width?, height?, steps?,
    //   cfg?, sampler?, scheduler? }; user edits live here and survive
    //   re-discovery (seedCheckpointProfiles only adds missing titles).
    // - generation.checkpoint: copied from backends.a1111.checkpoint; the
    //   old field is kept as-is (executor fallback + rollback safety).
    (s) => {
        if (!s.backends) s.backends = {};
        if (!s.backends.a1111 || typeof s.backends.a1111 !== 'object') {
            s.backends.a1111 = { baseUrl: '', auth: '', checkpoint: '' };
        }
        const a1111 = s.backends.a1111;
        if (!a1111.discovery || typeof a1111.discovery !== 'object') {
            a1111.discovery = { at: 0, models: [], samplers: [], schedulers: [] };
        }
        if (!a1111.checkpointProfiles || typeof a1111.checkpointProfiles !== 'object') {
            a1111.checkpointProfiles = {};
        }
        if (!s.generation) s.generation = {};
        if (s.generation.checkpoint === undefined) {
            s.generation.checkpoint = typeof a1111.checkpoint === 'string' ? a1111.checkpoint : '';
        }
    },

    // 6 -> 7 (Phase D): every new Phase D settings key in ONE migrator.
    // - generation.llmSize: how an LLM <size> hint interacts with a marker
    //   JSON size — 'auto' (current behavior: LLM wins), 'ignore' (LLM size
    //   discarded), 'force' (LLM wins even over marker size; equals 'auto'
    //   today, kept distinct so 'auto' can later mean "only when the marker
    //   has no size").
    // - cache: image-store housekeeping; 0 = feature off for each knob
    //   (ttlDays prune-by-age, maxMB prune-by-size, jpegQuality convert
    //   new saves to JPEG when > 0).
    // - backends.nai.variety: NAI Variety+ toggle (skip_cfg_above_sigma).
    (s) => {
        if (!s.generation) s.generation = {};
        if (s.generation.llmSize === undefined) s.generation.llmSize = 'auto';
        if (!s.cache || typeof s.cache !== 'object') {
            s.cache = { ttlDays: 0, maxMB: 0, jpegQuality: 0 };
        }
        if (!s.backends) s.backends = {};
        if (!s.backends.nai || typeof s.backends.nai !== 'object') {
            s.backends.nai = { apiKey: '', model: 'nai-diffusion-4-5-full' };
        }
        if (s.backends.nai.variety === undefined) s.backends.nai.variety = false;
    },

    // 7 -> 8 (D9): checkpoint profiles become explicit. Up to v7 the
    // Backends tab auto-seeded one checkpointProfiles row per discovered
    // checkpoint (machine-generated from server hints), which made the map
    // indistinguishable from user intent. From v8 a row exists only when the
    // user clicked "Save profile", so the auto-seeded rows are dropped here;
    // the checkpoint selection itself and the discovery cache are untouched.
    // Also stamps backends.a1111.transport for pre-relay settings.
    (s) => {
        if (!s.backends) s.backends = {};
        if (!s.backends.a1111 || typeof s.backends.a1111 !== 'object') {
            s.backends.a1111 = { baseUrl: '', auth: '', checkpoint: '' };
        }
        s.backends.a1111.checkpointProfiles = {};
        if (s.backends.a1111.transport !== 'direct') s.backends.a1111.transport = 'st-relay';
    },

    // 8 -> 9 (D11): the A1111 checkpoint selection becomes ONE value.
    // generation.checkpoint (Main tab, read first by compile()) and
    // backends.a1111.checkpoint (Backends tab, written by Save profile /
    // Use / Test Gen) were separate keys, so a checkpoint chosen in the
    // Backends tab did not drive marker generation when the Main tab still
    // pointed elsewhere. From v9 the UI writes both keys through a single
    // setter; this migrator reconciles settings that already diverged. The
    // Backends-tab value wins when present — it is where discovery,
    // profile-saving, and test generation all operate.
    (s) => {
        if (!s.backends) s.backends = {};
        if (!s.backends.a1111 || typeof s.backends.a1111 !== 'object') {
            s.backends.a1111 = { baseUrl: '', auth: '', checkpoint: '' };
        }
        if (!s.generation) s.generation = {};
        const backend = typeof s.backends.a1111.checkpoint === 'string' ? s.backends.a1111.checkpoint : '';
        const main = typeof s.generation.checkpoint === 'string' ? s.generation.checkpoint : '';
        const unified = backend || main;
        s.backends.a1111.checkpoint = unified;
        s.generation.checkpoint = unified;
    },
];

/** Current schema version = number of migrators applied from zero. */
export const CURRENT_VERSION = migrators.length;

/**
 * Run all pending migrations on a raw settings object.
 * @param {object} settings - the live extension_settings.IF_Image object
 * @returns {boolean} true if any migration ran (caller should persist)
 */
export function runMigrations(settings) {
    const from = settings.settingsVersion ?? 0;
    if (from >= CURRENT_VERSION) return false;

    for (let v = from; v < CURRENT_VERSION; v++) {
        migrators[v](settings);
    }
    settings.settingsVersion = CURRENT_VERSION;
    return true;
}
