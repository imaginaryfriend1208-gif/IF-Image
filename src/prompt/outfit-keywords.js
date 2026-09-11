// IF Image - Pure lorebook-style outfit keyword matching.
// This module does not read settings, IndexedDB, DOM, or chat state.

/** Normalize for matching only; stored spelling and rendered text are retained. */
export function normalizeOutfitKeyword(value) {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .trim()
        .toLocaleLowerCase()
        .replace(/\s+/g, ' ');
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keyList(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(key => typeof key === 'string' && key.trim());
}

/** Diacritic-insensitive, Unicode-aware whole-key/phrase match. */
export function containsOutfitKeyword(text, key) {
    const haystack = normalizeOutfitKeyword(text);
    const needle = normalizeOutfitKeyword(key);
    if (!haystack || !needle) return false;
    const phrase = needle.split(' ').map(escapeRegex).join('\\s+');
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${phrase}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(haystack);
}

function isAutoMode(outfit) {
    // `keyword` is accepted as an import compatibility alias. Storage
    // normalizes it to the canonical `auto_keyword` value on save.
    return outfit?.triggerMode === 'auto_keyword' || outfit?.triggerMode === 'keyword';
}

function lexical(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pick exactly one deterministic auto outfit. Exclusion keys have NOT
 * semantics and always veto a candidate. Specific phrases win, then the
 * number of matched keys, then normalized name/id for stable tie-breaking.
 */
export function matchAutomaticOutfit(text, outfits = []) {
    if (typeof text !== 'string' || !text || !Array.isArray(outfits)) return null;
    const candidates = [];
    for (const outfit of outfits) {
        if (!isAutoMode(outfit)) continue;
        if (keyList(outfit.excludeKeys).some(key => containsOutfitKeyword(text, key))) continue;
        const matched = keyList(outfit.triggers).filter(key => containsOutfitKeyword(text, key));
        if (!matched.length) continue;
        candidates.push({
            outfit,
            longest: Math.max(...matched.map(key => normalizeOutfitKeyword(key).length)),
            count: matched.length,
            name: normalizeOutfitKeyword(outfit.name),
            id: String(outfit.id ?? ''),
        });
    }
    candidates.sort((a, b) => b.longest - a.longest
        || b.count - a.count
        || lexical(a.name, b.name)
        || lexical(a.id, b.id));
    return candidates[0]?.outfit ?? null;
}
