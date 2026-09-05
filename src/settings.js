// IF Image - settings storage (namespace: extension_settings.IF_Image)
// Kept separate from ST secrets: this extension manages its own keys.

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';

export const SETTINGS_KEY = 'IF_Image';

export const defaultSettings = {
    enabled: true,
    backends: {
        nai: {
            apiKey: '',
            model: 'nai-diffusion-4-5-full',
        },
        comfy: {
            baseUrl: 'http://localhost:7861',
            username: '',
            password: '',
            profile: 'anima',
        },
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

export function getSettings() {
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = structuredClone(defaultSettings);
    }
    deepMerge(extension_settings[SETTINGS_KEY], defaultSettings);
    return extension_settings[SETTINGS_KEY];
}

export function saveSettings() {
    saveSettingsDebounced();
}
