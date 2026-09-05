// IF Image - settings storage (namespace: extension_settings.IF_Image)
// Kept separate from ST secrets: this extension manages its own keys.

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { runMigrations, CURRENT_VERSION } from './migration.js';

export const SETTINGS_KEY = 'IF_Image';

export const defaultSettings = {
    settingsVersion: CURRENT_VERSION,
    enabled: true,
    backends: {
        nai: {
            apiKey: '',
            model: 'nai-diffusion-4-5-full',
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
        },
        a1111: {
            baseUrl: '',
            auth: '',
            // Discovered checkpoint title; set explicitly via Refresh Models.
            checkpoint: '',
        },
    },
    llm: {
        apiProfiles: [],
        contextProfiles: [],
        requestMapping: {},
        defaultMethod: 'direct',
    },
    generation: {
        mode: 'direct',       // direct | assist | full
        startTag: 'image###',
        endTag: '###',
        enabled: true,
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
