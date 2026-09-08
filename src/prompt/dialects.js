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
 * Escaped-paren character groups (`\(...\)`, Phase C8 illus multi-char
 * grouping) are preserved verbatim: any tag that opens, closes, or sits
 * inside such a group is never deduplicated or dropped — deduping there
 * would delete a group boundary (e.g. the second `\(1girl` opener) and
 * corrupt the prompt.
 * @param {string} prompt
 * @returns {string}
 */
export function deduplicateTags(prompt) {
    if (!prompt || typeof prompt !== 'string') return '';
    const seen = new Set();
    const result = [];
    let depth = 0;
    for (const raw of prompt.split(',')) {
        const item = raw.trim();
        if (!item) continue;
        const opens = (item.match(/\\\(/g) || []).length;
        const closes = (item.match(/\\\)/g) || []).length;
        const inGroup = depth > 0 || opens > 0 || closes > 0;
        depth = Math.max(0, depth + opens - closes);
        if (inGroup) {
            result.push(item);
            continue;
        }
        const lower = item.toLowerCase();
        if (!seen.has(lower)) {
            seen.add(lower);
            result.push(item);
        }
    }
    return result.join(', ');
}
