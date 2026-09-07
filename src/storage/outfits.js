// IF Image - Outfit store management (Phase C3).
// Outfit record: { id, name, tags, charId }. charId=null means a "common"
// outfit usable by any character. Two-way link with characters: the
// character keeps `outfits: [ids]`, the outfit keeps `charId`; both sides
// are kept consistent here so a save/delete never leaves either dangling.
// The `outfits` IndexedDB store already exists at DB version 1 — no bump.

import { STORES, getAllItems, getItem, putItem, deleteItem } from './idb.js';
import { getCharacter, saveCharacter } from './chars.js';

export function createDefaultOutfit(name = 'New Outfit', charId = null) {
    return {
        id: crypto.randomUUID ? crypto.randomUUID() : 'outfit_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        name,
        tags: '',
        charId: charId || null,
        meta: { updatedAt: Date.now() },
    };
}

export async function getAllOutfits() {
    return getAllItems(STORES.OUTFITS);
}

export async function getOutfit(id) {
    return getItem(STORES.OUTFITS, id);
}

/** Outfits usable by a character: its own outfits + every common outfit.
 * "Common" is falsy charId (null/undefined/''), matching triggers.js's
 * outfitsForChar check so records saved without the field behave the same. */
export async function getOutfitsForCharacter(charId) {
    const all = await getAllOutfits();
    return all.filter(o => o.charId === charId || !o.charId);
}

/**
 * Save (upsert) an outfit, keeping the two-way link with its owning
 * character consistent: attached to the new owner's `outfits` list,
 * detached from any previous owner's list if the outfit was reassigned.
 */
export async function saveOutfit(outfit) {
    outfit.meta = outfit.meta || {};
    outfit.meta.updatedAt = Date.now();
    const previous = outfit.id ? await getItem(STORES.OUTFITS, outfit.id) : null;
    const result = await putItem(STORES.OUTFITS, outfit);
    if (previous?.charId && previous.charId !== outfit.charId) {
        const prevChar = await getCharacter(previous.charId);
        if (prevChar && Array.isArray(prevChar.outfits) && prevChar.outfits.includes(outfit.id)) {
            prevChar.outfits = prevChar.outfits.filter(id => id !== outfit.id);
            await saveCharacter(prevChar);
        }
    }
    if (outfit.charId) {
        const char = await getCharacter(outfit.charId);
        if (char) {
            if (!Array.isArray(char.outfits)) char.outfits = [];
            if (!char.outfits.includes(outfit.id)) {
                char.outfits.push(outfit.id);
                await saveCharacter(char);
            }
        }
    }
    return result;
}

/** Delete an outfit and detach it from its owning character's outfits list. */
export async function removeOutfit(id) {
    const outfit = await getItem(STORES.OUTFITS, id);
    if (outfit?.charId) {
        const char = await getCharacter(outfit.charId);
        if (char && Array.isArray(char.outfits) && char.outfits.includes(id)) {
            char.outfits = char.outfits.filter(oid => oid !== id);
            await saveCharacter(char);
        }
    }
    return deleteItem(STORES.OUTFITS, id);
}
