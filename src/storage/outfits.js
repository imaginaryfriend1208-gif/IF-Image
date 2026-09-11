// IF Image - Outfit store management.
// Outfit record (additive, backwards compatible):
//   { id, name, tags, charId, triggers, triggerMode, excludeKeys, dialectHints }
// `charId=null` means a common outfit. Legacy records without the lorebook
// fields normalize to `explicit`, so merely upgrading never enables auto-match.
// The `outfits` IndexedDB store already exists at DB version 1 — no bump.

import { STORES, getAllItems, getItem, putItem, deleteItem } from './idb.js';
import { getCharacter, saveCharacter } from './chars.js';

export const OUTFIT_TRIGGER_MODES = Object.freeze({
    EXPLICIT: 'explicit',
    AUTO_KEYWORD: 'auto_keyword',
});

function newOutfitId() {
    return crypto.randomUUID
        ? crypto.randomUUID()
        : 'outfit_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function foldKey(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .trim()
        .toLocaleLowerCase();
}

/** Trim and de-duplicate keys while preserving the first spelling/order. */
export function normalizeOutfitKeys(value) {
    const source = Array.isArray(value)
        ? value
        : (typeof value === 'string' ? value.split(/[\n,]+/) : []);
    const result = [];
    const seen = new Set();
    for (const item of source) {
        if (typeof item !== 'string') continue;
        const clean = item.trim();
        const folded = foldKey(clean);
        if (!clean || !folded || seen.has(folded)) continue;
        seen.add(folded);
        result.push(clean);
    }
    return result;
}

/** `keyword` is accepted as a compatibility alias for the example schema. */
export function normalizeOutfitTriggerMode(value) {
    return value === OUTFIT_TRIGGER_MODES.AUTO_KEYWORD || value === 'keyword'
        ? OUTFIT_TRIGGER_MODES.AUTO_KEYWORD
        : OUTFIT_TRIGGER_MODES.EXPLICIT;
}

function normalizeDialectHints(value) {
    const hints = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        krea: typeof hints.krea === 'string' ? hints.krea.trim() : '',
        anima: typeof hints.anima === 'string' ? hints.anima.trim() : '',
        illus: typeof hints.illus === 'string' ? hints.illus.trim() : '',
    };
}

/**
 * Normalize an outfit without mutating the caller's object. Unknown fields are
 * retained for forward compatibility. This is intentionally a read-time
 * migration too: old records work without rewriting the database.
 */
export function normalizeOutfit(outfit = {}) {
    const source = outfit && typeof outfit === 'object' && !Array.isArray(outfit) ? outfit : {};
    return {
        ...source,
        id: typeof source.id === 'string' && source.id ? source.id : newOutfitId(),
        name: typeof source.name === 'string' ? source.name.trim() : '',
        tags: typeof source.tags === 'string' ? source.tags.trim() : '',
        charId: source.charId || null,
        triggers: normalizeOutfitKeys(source.triggers),
        triggerMode: normalizeOutfitTriggerMode(source.triggerMode),
        excludeKeys: normalizeOutfitKeys(source.excludeKeys),
        dialectHints: normalizeDialectHints(source.dialectHints),
        meta: source.meta && typeof source.meta === 'object' && !Array.isArray(source.meta)
            ? { ...source.meta }
            : {},
    };
}

export function createDefaultOutfit(name = 'New Outfit', charId = null) {
    return normalizeOutfit({ id: newOutfitId(), name, tags: '', charId: charId || null });
}

export async function getAllOutfits() {
    return (await getAllItems(STORES.OUTFITS)).map(normalizeOutfit);
}

export async function getOutfit(id) {
    const outfit = await getItem(STORES.OUTFITS, id);
    return outfit ? normalizeOutfit(outfit) : null;
}

/** Outfits usable by a character: its own outfits + every common outfit. */
export async function getOutfitsForCharacter(charId) {
    const all = await getAllOutfits();
    return all.filter(outfit => outfit.charId === charId || !outfit.charId);
}

/**
 * Save (upsert) an outfit, keeping the two-way link with its owning character
 * consistent. Reassignment detaches the old owner and attaches the new one.
 */
export async function saveOutfit(outfit) {
    if (!outfit || typeof outfit !== 'object' || Array.isArray(outfit)) {
        throw new TypeError('Outfit must be an object.');
    }
    const normalized = normalizeOutfit(outfit);
    normalized.meta.updatedAt = Date.now();
    const previous = normalized.id ? await getItem(STORES.OUTFITS, normalized.id) : null;
    const result = await putItem(STORES.OUTFITS, normalized);
    // Preserve the pre-existing API behavior where saveOutfit updates the
    // caller's live record (notably meta.updatedAt and a generated id).
    Object.assign(outfit, normalized);

    if (previous?.charId && previous.charId !== normalized.charId) {
        const prevChar = await getCharacter(previous.charId);
        if (prevChar && Array.isArray(prevChar.outfits) && prevChar.outfits.includes(normalized.id)) {
            prevChar.outfits = prevChar.outfits.filter(id => id !== normalized.id);
            await saveCharacter(prevChar);
        }
    }
    if (normalized.charId) {
        const char = await getCharacter(normalized.charId);
        if (char) {
            if (!Array.isArray(char.outfits)) char.outfits = [];
            if (!char.outfits.includes(normalized.id)) {
                char.outfits.push(normalized.id);
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
            char.outfits = char.outfits.filter(outfitId => outfitId !== id);
            await saveCharacter(char);
        }
    }
    return deleteItem(STORES.OUTFITS, id);
}
