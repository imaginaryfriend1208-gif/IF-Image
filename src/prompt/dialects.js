// IF Image - Dialect helpers.
// Conforms to PROMPT-SPEC §7. The DIALECTS table was removed: it duplicated
// PROFILES in src/profiles.js and nothing imported it. Only the two helpers
// below are used (by render.js and the offline tests).

/**
 * Normalizes booru tags: replace underscores with spaces, trim, drop empty tags.
 * (Except special score_* tags if any).
 * @param {string} tagString
 * @returns {string}
 */
export function normalizeBooruTags(tagString) {
    if (!tagString || typeof tagString !== 'string') return '';
    return tagString
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
        .map(t => {
            if (t.startsWith('score_')) return t;
            return t.replace(/_/g, ' ');
        })
        .join(', ');
}

/**
 * Deduplicates comma-separated tags while preserving order.
 * @param {string} prompt
 * @returns {string}
 */
export function deduplicateTags(prompt) {
    if (!prompt || typeof prompt !== 'string') return '';
    const seen = new Set();
    const result = [];
    for (const raw of prompt.split(',')) {
        const item = raw.trim();
        if (!item) continue;
        const lower = item.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            result.push(item);
        }
    }
    return result.join(', ');
}
