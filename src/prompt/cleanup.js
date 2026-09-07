// IF Image - Post-assembly cleanup stage (Phase C6).
// Runs AFTER assemblePrompt() and BEFORE replace.js's non-'final' rules;
// replace.js's 'final' rules run AFTER this stage (see the pipeline order
// documented in src/prompt/replace.js and index.js's compile()).
//
// Token budgets use a simple whitespace/comma-count estimate, NOT a real
// tokenizer — documented approximation, good enough to drop a tail of tags
// before a checkpoint's effective context window, not an exact CLIP count.

import { deduplicateTags } from './dialects.js';

/** Whitespace/comma-count token estimate — see file header. */
export function estimateTokens(text) {
    if (!text) return 0;
    return text.split(/[\s,]+/).filter(Boolean).length;
}

/**
 * Strip persona avoidTags from a comma-tag string, exact match after
 * normalize (trim + lowercase). Never touches `$name`/`${...}` tokens that
 * happen to survive into the string — those are compared as opaque whole
 * tags, same as any other tag, and only removed if they exactly match an
 * avoidTag (which would never legitimately be a macro placeholder).
 * Known limitation: tags inside a C8 `\(...\)` character group carry the
 * group delimiters (`1girl` arrives as `\(1girl`), so exact matching skips
 * them — intentional, since removing one would corrupt the group. The
 * per-character strings in envelope.characters ARE stripped (see
 * cleanupEnvelope), so NAI captions still honor avoidTags.
 */
export function stripAvoidTags(tagString, avoidTags) {
    if (!tagString || !avoidTags?.length) return tagString || '';
    const avoidSet = new Set(avoidTags.filter(Boolean).map(t => t.trim().toLowerCase()));
    if (!avoidSet.size) return tagString;
    return tagString.split(',').map(t => t.trim()).filter(t => t && !avoidSet.has(t.toLowerCase())).join(', ');
}

/** SFW mode: drop the literal 'nsfw' tag (nsfw-cell matrix tags are already excluded upstream by render.js when no character requested them). */
export function enforceRating(tagString, rating) {
    if (rating !== 'sfw' || !tagString) return tagString || '';
    return tagString.split(',').map(t => t.trim()).filter(t => t.toLowerCase() !== 'nsfw').join(', ');
}

/** Escape unescaped parens inside individual tags (danbooru convention: `\(`/`\)`). Tags already escaped are left alone. */
export function escapeParens(tagString) {
    if (!tagString) return tagString || '';
    return tagString.split(',').map(tag => {
        const t = tag.trim();
        if (/\\\(|\\\)/.test(t)) return t;
        return t.replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    }).join(', ');
}

/** Drop trailing tags (never mid-tag) once the running token estimate exceeds
 * `budget`. Always keeps at least the first tag. Never cuts inside a C8
 * `\(...\)` character group — once a group has been opened, its remaining
 * tags are kept through the closing `\)` even over budget, so the prompt
 * never ends with an unbalanced escaped paren. */
export function dropTailByBudget(tagString, budget) {
    if (!tagString) return tagString || '';
    const tags = tagString.split(',').map(t => t.trim()).filter(Boolean);
    const kept = [];
    let used = 0;
    let depth = 0;
    for (const tag of tags) {
        const cost = estimateTokens(tag) + 1; // +1 for the separating comma
        if (used + cost > budget && kept.length && depth === 0) break;
        const opens = (tag.match(/\\\(/g) || []).length;
        const closes = (tag.match(/\\\)/g) || []).length;
        depth = Math.max(0, depth + opens - closes);
        kept.push(tag);
        used += cost;
    }
    return kept.join(', ');
}

/** Strip `(tag:1.2)`-style weight syntax and stray negative-prompt words from krea prose (CFG 1 = no negative prompt; these words must not leak into the positive prompt). */
export function stripKreaArtifacts(text) {
    if (!text) return text || '';
    return text
        .replace(/\(([^():]+):[\d.]+\)/g, '$1')
        .replace(/\b(worst quality|low quality|bad anatomy|bad hands|lowres)\b,?\s*/gi, '')
        .replace(/,\s*,+/g, ',')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Run the post-assembly cleanup stage on an assembled envelope.
 * The optional `characters` array (Phase C8 per-character rendered strings,
 * consumed by NaiClient captions) gets the same avoidTags/rating/dedup
 * treatment per entry on tag dialects; krea leaves it untouched (prose).
 * @param {{ prompt: string, negative: string, params: object, characters?: string[] }} envelope - assemblePrompt() output
 * @param {string} dialect - 'krea' | 'anima' | 'illus'
 * @param {{ avoidTags?: string[], rating?: 'sfw'|'nsfw' }} [opts]
 * @returns {{ prompt: string, negative: string, params: object, characters?: string[] }}
 */
export function cleanupEnvelope(envelope, dialect, opts = {}) {
    const avoidTags = opts.avoidTags || [];
    const rating = opts.rating === 'sfw' ? 'sfw' : 'nsfw';
    let { prompt, negative, params } = envelope;

    if (dialect === 'krea') {
        prompt = stripKreaArtifacts(prompt);
        for (const tag of avoidTags) {
            if (!tag) continue;
            const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            prompt = prompt.replace(new RegExp(`\\b${escaped}\\b,?\\s*`, 'gi'), '');
        }
        prompt = prompt.replace(/,\s*,+/g, ',').replace(/\s{2,}/g, ' ').trim();
        return { ...envelope, prompt, negative, params };
    }

    prompt = stripAvoidTags(prompt, avoidTags);
    prompt = enforceRating(prompt, rating);
    prompt = deduplicateTags(prompt);

    if (dialect === 'illus') {
        prompt = escapeParens(prompt);
        prompt = dropTailByBudget(prompt, 225);
    } else if (dialect === 'anima') {
        prompt = prompt.replace(/_/g, ' ');
        prompt = dropTailByBudget(prompt, 200);
    }

    negative = enforceRating(negative, rating);
    negative = deduplicateTags(negative);

    const result = { ...envelope, prompt, negative, params };
    if (Array.isArray(envelope.characters)) {
        result.characters = envelope.characters.map(part =>
            deduplicateTags(enforceRating(stripAvoidTags(part, avoidTags), rating)));
    }
    return result;
}
