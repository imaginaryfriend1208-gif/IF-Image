// IF Image - Persona and Style store management.
// Follows PROMPT-SPEC §6 (Persona & POV) and §9 (Style presets).

import { STORES, getAllItems, getItem, putItem, deleteItem } from './idb.js';

export function createDefaultPersona(name = 'Default User') {
    return {
        id: crypto.randomUUID ? crypto.randomUUID() : 'persona_' + Date.now(),
        name,
        isDefault: true,
        gender: 'male',
        countTag: '1boy',
        povMode: 'auto', // auto | hidden | hands | full | third_person
        facts: '',
        booru: '',
        natural: '',
        avoidTags: [],
        autoSync: false,
        meta: {
            version: 1,
            updatedAt: Date.now(),
        },
    };
}

export function createDefaultStyle(name = 'New Style') {
    return {
        id: crypto.randomUUID ? crypto.randomUUID() : 'style_' + Date.now(),
        name,
        dialectHints: {
            krea: {
                stylePhrase: '',
                lighting: '',
                camera: '',
            },
            anima: {
                booruTags: '',
                artists: '',
            },
            illus: {
                artists: '',
                qualityPrefix: '',
                negativeTags: '',
            },
        },
        meta: {
            version: 1,
            updatedAt: Date.now(),
        },
    };
}

export async function getAllPersonas() {
    return getAllItems(STORES.PERSONAS);
}

export async function savePersona(persona) {
    persona.meta = persona.meta || {};
    persona.meta.updatedAt = Date.now();
    return putItem(STORES.PERSONAS, persona);
}

export async function removePersona(id) {
    return deleteItem(STORES.PERSONAS, id);
}

export async function getAllStyles() {
    return getAllItems(STORES.STYLES);
}

export async function saveStyle(style) {
    style.meta = style.meta || {};
    style.meta.updatedAt = Date.now();
    return putItem(STORES.STYLES, style);
}

export async function removeStyle(id) {
    return deleteItem(STORES.STYLES, id);
}
