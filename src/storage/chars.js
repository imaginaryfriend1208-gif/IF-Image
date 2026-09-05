// IF Image - Character store management.
// Schema conforms to PROMPT-SPEC §4:
// - facts: dialect-free text
// - booru: tag string / booruDetail: matrix { face, hair, body, outfit, ... }
// - natural: prose description for Krea
// - id: stable UUID, name, aliases: string[]
// - bindings: { cards: string[], chats: string[] }

import { STORES, getAllItems, getItem, putItem, deleteItem } from './idb.js';

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
        nsfwExtra: '',
        negative: '',
        outfits: [], // inline outfits or references
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
    };
}

export async function getAllCharacters() {
    return getAllItems(STORES.CHARS);
}

export async function getCharacter(id) {
    return getItem(STORES.CHARS, id);
}

export async function saveCharacter(char) {
    char.meta = char.meta || {};
    char.meta.updatedAt = Date.now();
    return putItem(STORES.CHARS, char);
}

export async function removeCharacter(id) {
    return deleteItem(STORES.CHARS, id);
}
