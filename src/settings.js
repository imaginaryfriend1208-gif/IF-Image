// IF Image - settings storage (namespace: extension_settings.IF_Image)
// Kept separate from ST secrets: this extension manages its own keys.

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { runMigrations, CURRENT_VERSION } from './migration.js';

export const SETTINGS_KEY = 'IF_Image';

export const defaultSettings = {
    settingsVersion: CURRENT_VERSION,
    enabled: true,
    notifications: true,
    // Canonical SillyTavern-persisted user data. Kept JSON-only so it follows
    // the account through /api/settings/save and remains exportable.
    data: {
        characters: [],
        outfits: [],
        styles: [],
        personas: [],
    },
    dataMigration: {
        indexedDbImported: false,
        importedAt: null,
    },
    backends: {
        nai: {
            apiKey: '',
            model: 'nai-diffusion-4-5-full',
            // Phase D5: Variety+ (skip_cfg_above_sigma) toggle.
            variety: false,
        },
        comfy: {
            // 'legacy_proxy' = user's own comfy-cloud-forge-proxy (username/
            // password, /internal/* endpoints); 'a1111' = hosted
            // AUTOMATIC1111-compatible API (raw Authentication string,
            // /sdapi/v1/* endpoints). Never mixed.
            connection: 'legacy_proxy',
            baseUrl: 'http://localhost:7861',
            username: '',
            password: '',
            profile: 'anima',
            proxyModel: '',
        },
        a1111: {
            baseUrl: '',
            auth: '',
            // 'st-relay': requests go through SillyTavern's own /api/sd/*
            // server endpoints (no CORS needed on the backend — the same
            // path ST's Image Generation extension uses). 'direct': the
            // browser calls the backend itself (backend must send CORS).
            transport: 'st-relay',
            // Discovered checkpoint title; set explicitly via Refresh Models.
            checkpoint: '',
            // Phase R1: persisted discovery cache ({at: 0} = never ran).
            // Cleared on URL/auth change; never carries credentials.
            discovery: { at: 0, models: [], samplers: [], schedulers: [] },
            // D14: unique profile id -> { name, checkpoint, profile,
            // width?, height?, steps?, cfg?, sampler?, scheduler? }.
            // Rows are created only by "Save profile"; one checkpoint can
            // hold any number of profiles.
            checkpointProfiles: {},
            // D14: which saved profile drives generation ('' = none).
            activeProfileId: '',
        },
    },
    llm: {
        apiProfiles: [],
        contextProfiles: [],
        requestMapping: {},
        defaultMethod: 'direct',
        defaultApiProfileId: '',
        injectionStyle: 'compact',
        // User-tunable image_gen system prompt. Empty = use the built-in
        // default (renderDefaultSystemPrompt in src/llm/prompts.js), so an
        // update ships an improved default to anyone who never edited it.
        systemPromptOverride: '',
        // Phase CP: chat image placement (LLM plans N images across the chat).
        chatPlace: {
            // together: one LLM plan spanning the selected chat window.
            // separate: chronological per-message scenes/markers.
            planningMode: 'together',
            count: 3,
            onlyCharacter: true,
            maxChatWindow: 40,
            includeCharacterMessages: true,
            includeUserMessages: true,
            includeFirstMessage: false,
            includeCharacterCard: false,
            includeExtensionPrompts: false,
            // Second LLM pass: rewrite each planned prompt against the chat
            // text around its anchor, so the prompt matches what actually
            // happens there instead of the roster defaults. One extra call
            // for all N images; failures fall back to the raw prompts.
            rewrite: true,
        },
    },
    generation: {
        mode: 'direct',       // direct | assist | full
        startTag: 'image###',
        endTag: '###',
        enabled: true,
        backend: 'comfy',
        profile: 'anima',
        sceneWindow: 4,
        logLimit: 50,
        dryRun: false,
        // Phase R1: chat-generation checkpoint title (A1111-compatible SD
        // connection). Migrator v6 copies the old backends.a1111.checkpoint
        // here; that field remains as an executor fallback.
        checkpoint: '',
        // Phase C0: per-profile generation param overrides. Empty/absent
        // fields inherit the PROFILES[key] default; clamping happens on
        // read (src/ui.js / index.js), never here, so a value saved under
        // one clamp policy is never silently rewritten by a later one.
        params: {
            krea2: {},
            anima: {},
            illustrious: {},
        },
        // Phase D3: LLM <size> hint policy — 'auto' | 'ignore' | 'force'
        // ('auto' currently equals 'force'; see migrator v7 note).
        llmSize: 'auto',
        // Style applied to chats that have not chosen one of their own. A
        // per-chat choice lives in that chat's metadata, not here.
        defaultStyleId: '',
        // Final-stage output ordering: LoRA -> Style -> core prompt. The
        // core prompt's own order is never touched (scene wording and
        // character placement belong to the LLM).
        promptOrder: {
            enabled: true,
            // true = leave inline LoRAs wherever they were written, for
            // prompts whose structure depends on LoRA position.
            keepLoraPosition: false,
        },
    },
    // Per-user roster sync through SillyTavern's own file storage
    // Phase D6: image-store housekeeping (0 = off per knob).
    cache: {
        // Keep portable prompt metadata in downloaded PNG files. This is not
        // roster synchronization and does not store presets in the browser.
        embedPngMetadata: true,
        ttlDays: 0,
        maxMB: 0,
        jpegQuality: 0,
    },
    test: {
        prompt: '',
        negative: '',
        width: 832,
        height: 1216,
        steps: 16,
        cfg: 4,
        seed: -1,
        backend: 'comfy',
        // Profile selected in the Test tab (may differ from the Backends default).
        profile: 'anima',
    },
};

/**
 * Deep-merge missing default keys into the stored settings object.
 * Existing user values are never overwritten.
 */
function deepMerge(target, source) {
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
                target[key] = {};
            }
            deepMerge(target[key], source[key]);
        } else if (target[key] === undefined) {
            target[key] = source[key];
        }
    }
    return target;
}

/**
 * Load settings from extension_settings namespace.
 * Runs migrations if the stored version is behind, then deep-merges defaults.
 * @returns {object} live reference to extension_settings.IF_Image
 */
export function getSettings() {
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = structuredClone(defaultSettings);
    }
    const s = extension_settings[SETTINGS_KEY];

    // Migrate from older versions (v0.1.0 has no settingsVersion).
    const migrated = runMigrations(s);

    // Fill any new keys added by the current version's defaults.
    deepMerge(s, defaultSettings);

    if (migrated) {
        // Persist immediately so the migration stamp is saved.
        saveSettingsDebounced();
    }
    return s;
}

export function saveSettings() {
    saveSettingsDebounced();
}
