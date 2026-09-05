// IF Image - Dialect definitions and rendering rules.
// Conforms to PROMPT-SPEC §7.

export const DIALECTS = {
    krea: {
        id: 'krea',
        label: 'Krea 2 (Prose)',
        format: 'prose',
        defaultParams: {
            steps: 8,
            cfg: 1,
            width: 1344,
            height: 768,
        },
        hasNegative: false,
    },
    anima: {
        id: 'anima',
        label: 'rdbt Anima (Hybrid)',
        format: 'hybrid',
        defaultParams: {
            steps: 16,
            cfg: 2,
            width: 832,
            height: 1216,
        },
        hasNegative: true,
    },
    illus: {
        id: 'illus',
        label: 'Illustrious / NoobAI (Booru Tags)',
        format: 'tags',
        defaultParams: {
            steps: 20,
            cfg: 5,
            width: 832,
            height: 1216,
        },
        hasNegative: true,
    },
};

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
