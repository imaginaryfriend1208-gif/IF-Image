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
