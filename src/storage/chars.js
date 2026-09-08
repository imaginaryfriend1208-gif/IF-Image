// IF Image - Character store management.
// Schema conforms to PROMPT-SPEC §4:
// - facts: dialect-free text
// - booru: tag string / booruDetail: matrix { face, hair, body, outfit, ... }
// - natural: prose description for Krea
// - id: stable UUID, name, aliases: string[]
// - bindings: { cards: string[], chats: string[] }
//
// Record migration (Phase C): records carry their own `presetVersion`,
// independent of extension_settings.settingsVersion. Migrators run
// sequentially on read via applyCharMigrations(); nothing is persisted until
// the caller explicitly saveCharacter()s again.

import { STORES, getAllItems, getItem, putItem, deleteItem } from './idb.js';

/** Regions x ratings x views matrix cell keys, all starting empty. */
export function emptyBooruDetail() {
    return {
        face: { sfw: { front: '', back: '' }, nsfw: { front: '', back: '' } },
        upper: { sfw: { front: '', back: '' }, nsfw: { front: '', back: '' } },
        lower: { sfw: { front: '', back: '' }, nsfw: { front: '', back: '' } },
    };
}

export function createDefaultCharacter(name = 'New Character') {
    return {
        id: crypto.randomUUID ? crypto.randomUUID() : 'char_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        name,
        aliases: [],
        countTag: '1girl',
        facts: '',
        booru: '',
        natural: '',
        views: {
            front: '',
            back: '',
            side: '',
        },
        booruDetail: emptyBooruDetail(),
        nsfwExtra: '',
        negative: '',
        outfits: [], // outfit record ids (src/storage/outfits.js)
        binding: {
            cardId: null,
            chatIds: [],
        },
        // Legacy field kept for backward compatibility with pre-C4 records;
        // binding (singular) above is the C4 shape actually read/written.
        bindings: {
            cards: [], // avatar filenames
            chats: [],
        },
        lock: {
            seed: -1,
            params: null,
        },
        meta: {
            version: 1,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            createdBy: 'user',
        },
        presetVersion: CHAR_CURRENT_VERSION,
    };
}

/**
 * Sequential in-place record migrators, index 0 = version 0 -> 1, etc.
 * Absent/undefined presetVersion is treated as 0. Non-destructive: existing
 * values are never overwritten, only missing fields are filled.
 * @type {Array<(char: object) => void>}
 */
const CHAR_MIGRATORS = [
    // 0 -> 1: add the booruDetail region x rating x view matrix. Cells stay
    // empty rather than being guessed from `booru`/`nsfwExtra` — render.js
    // falls back to the flat strings when a cell is empty, so existing
    // characters render byte-identical prompts until the user fills cells.
    (c) => {
        if (!c.booruDetail || typeof c.booruDetail !== 'object') {
            c.booruDetail = emptyBooruDetail();
        } else {
            const empty = emptyBooruDetail();
            for (const region of Object.keys(empty)) {
                if (!c.booruDetail[region]) c.booruDetail[region] = empty[region];
                for (const rating of Object.keys(empty[region])) {
                    if (!c.booruDetail[region][rating]) c.booruDetail[region][rating] = empty[region][rating];
                    for (const view of Object.keys(empty[region][rating])) {
                        if (typeof c.booruDetail[region][rating][view] !== 'string') {
                            c.booruDetail[region][rating][view] = '';
                        }
                    }
                }
            }
        }
        if (!Array.isArray(c.outfits)) c.outfits = [];
        if (!c.binding || typeof c.binding !== 'object') {
            c.binding = { cardId: null, chatIds: [] };
        } else {
            if (c.binding.cardId === undefined) c.binding.cardId = null;
            if (!Array.isArray(c.binding.chatIds)) c.binding.chatIds = [];
        }
        if (!c.lock || typeof c.lock !== 'object') c.lock = { seed: -1, params: null };
        if (typeof c.negative !== 'string') c.negative = '';
    },
];

export const CHAR_CURRENT_VERSION = CHAR_MIGRATORS.length;

/**
 * Apply pending record migrations to a character in place.
 * @param {object} char
 * @returns {object} the same object, mutated
 */
export function applyCharMigrations(char) {
    if (!char || typeof char !== 'object') return char;
    const from = Number.isInteger(char.presetVersion) ? char.presetVersion : 0;
    for (let v = from; v < CHAR_CURRENT_VERSION; v++) {
        CHAR_MIGRATORS[v](char);
    }
    char.presetVersion = CHAR_CURRENT_VERSION;
    return char;
}

export async function getAllCharacters() {
    const all = await getAllItems(STORES.CHARS);
    return all.map(applyCharMigrations);
}

export async function getCharacter(id) {
    const char = await getItem(STORES.CHARS, id);
    return char ? applyCharMigrations(char) : char;
}

export async function saveCharacter(char) {
    char.meta = char.meta || {};
    char.meta.updatedAt = Date.now();
    applyCharMigrations(char);
    return putItem(STORES.CHARS, char);
}

export async function removeCharacter(id) {
    return deleteItem(STORES.CHARS, id);
}
