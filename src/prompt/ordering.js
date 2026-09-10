// IF Image - Final prompt ordering (LoRA -> Style -> core prompt).
//
// Two jobs, both pure:
//
// 1. Protect LoRA tokens from the tag pipeline. `<lora:my_cool_lora:0.8>`
//    passes through normalizeBooruTags (dialects.js) and the anima branch of
//    cleanupEnvelope, both of which replace EVERY underscore with a space —
//    silently breaking the reference. dropTailByBudget can also cut a
//    trailing LoRA. So LoRAs are lifted out before those stages run and
//    re-emitted verbatim afterwards; no existing helper has to learn about
//    angle brackets.
//
// 2. Enforce the output order. LoRAs first (source order preserved), then
//    the style segment, then the core prompt with its internal order left
//    exactly as written — scene wording and character placement are the
//    LLM's to decide, and reordering them breaks sentences like
//    "a cat walking in front of $Carter while he is eating an ice cream".
//
// This runs as the LAST compile stage, after cleanup and after 'final'
// replace rules, because a prefix-head rule would otherwise displace a
// leading LoRA.

/**
 * A1111 LoRA syntax: <lora:NAME:WEIGHT> or <lora:NAME>.
 * NAME may hold anything but ':' and '>' (underscores, dots, dashes are all
 * common in filenames). WEIGHT is optional and may be negative or decimal.
 */
const LORA_PATTERN = /<lora:[^:>]+(?::[^>]*)?>/gi;

/** Placeholder shape: no underscores, parens, commas or angle brackets, so
 *  every downstream helper treats it as an ordinary opaque tag. */
const PLACEHOLDER_PREFIX = 'ifimageloraslot';
const PLACEHOLDER_PATTERN = new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)`, 'gi');

/**
 * Is this a syntactically valid A1111 LoRA token?
 * Used by the UI to validate what the user types into a LoRA field.
 * @param {string} text
 * @returns {boolean}
 */
export function isValidLora(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    const matches = trimmed.match(LORA_PATTERN);
    return matches?.length === 1 && matches[0] === trimmed;
}

/**
 * Pull every LoRA token out of a string.
 * Source order is preserved and each token is kept byte-for-byte.
 * @param {string} text
 * @returns {{ text: string, loras: string[] }} text with LoRAs removed
 */
export function extractLoras(text) {
    if (typeof text !== 'string' || !text) return { text: text || '', loras: [] };
    const loras = [];
    const stripped = text.replace(LORA_PATTERN, (match) => {
        loras.push(match);
        return '';
    });
    return { text: tidySeparators(stripped), loras };
}

/**
 * Replace LoRA tokens with opaque placeholders, so the tag pipeline can run
 * without seeing (or damaging) them.
 * @param {string} text
 * @returns {{ text: string, loras: string[] }}
 */
export function maskLoras(text) {
    if (typeof text !== 'string' || !text) return { text: text || '', loras: [] };
    const loras = [];
    const masked = text.replace(LORA_PATTERN, (match) => {
        const index = loras.push(match) - 1;
        return `${PLACEHOLDER_PREFIX}${index}`;
    });
    return { text: masked, loras };
}

/**
 * Drop every placeholder from a string, returning the indices that were
 * present. Unknown indices are dropped rather than restored, so a mangled
 * placeholder can never resurrect a LoRA that was not extracted here.
 * @param {string} text
 * @param {string[]} loras
 * @returns {{ text: string, found: string[] }} found = real LoRA strings, in
 *   the order their placeholders appeared
 */
export function stripPlaceholders(text, loras = []) {
    if (typeof text !== 'string' || !text) return { text: text || '', found: [] };
    const found = [];
    const cleaned = text.replace(PLACEHOLDER_PATTERN, (match, digits) => {
        const lora = loras[Number(digits)];
        if (lora) found.push(lora);
        return '';
    });
    return { text: tidySeparators(cleaned), found };
}

/**
 * Restore masked LoRAs in place (used when the user asked to keep them
 * wherever they were written).
 * @param {string} text
 * @param {string[]} loras
 * @returns {string}
 */
export function unmaskLoras(text, loras = []) {
    if (typeof text !== 'string' || !text) return text || '';
    return tidySeparators(text.replace(PLACEHOLDER_PATTERN, (match, digits) => loras[Number(digits)] ?? ''));
}

/**
 * Collect the LoRAs contributed by styles and characters.
 *
 * Style LoRAs come first, in style order; character LoRAs follow, in the
 * order the characters appear in the prompt. Duplicates are dropped, keeping
 * the earliest occurrence, so the same LoRA attached to two characters is
 * applied once at its first position.
 *
 * @param {{ styles?: Array<object>, characters?: Array<object> }} parsedTriggers
 * @returns {string[]}
 */
export function collectLoras({ styles = [], characters = [] } = {}) {
    const out = [];
    const push = (value) => {
        if (typeof value !== 'string') return;
        for (const token of value.match(LORA_PATTERN) ?? []) {
            if (!out.includes(token)) out.push(token);
        }
    };
    for (const style of styles) push(style?.lora);
    for (const item of characters) {
        // Persona and character are the same thing here, by design.
        push(item?.char?.lora);
        push(item?.persona?.lora);
    }
    return out;
}

/**
 * Assemble the final prompt in priority order.
 *
 * @param {string} prompt - the compiled prompt, possibly holding placeholders
 * @param {{
 *   loras?: string[],          // masked LoRAs, indexed by placeholder
 *   extraLoras?: string[],     // roster LoRAs (style + character slots)
 *   keepLoraPosition?: boolean,// leave inline LoRAs where they were written
 * }} [opts]
 * @returns {string}
 */
export function reorderPrompt(prompt, { loras = [], extraLoras = [], keepLoraPosition = false } = {}) {
    if (typeof prompt !== 'string') return '';

    if (keepLoraPosition) {
        // Inline LoRAs stay put; roster LoRAs still lead, since they were
        // never written into the prompt and have no position of their own.
        const restored = unmaskLoras(prompt, loras);
        const leading = extraLoras.filter(l => !restored.includes(l));
        return joinParts([...leading, restored]);
    }

    const { text, found } = stripPlaceholders(prompt, loras);
    // Roster LoRAs first, then the ones written inline, each kept once.
    const ordered = [];
    for (const lora of [...extraLoras, ...found]) {
        if (!ordered.includes(lora)) ordered.push(lora);
    }
    return joinParts([...ordered, text]);
}

/** Join non-empty parts with ', ' and tidy the result. */
function joinParts(parts) {
    return tidySeparators(parts.filter(p => typeof p === 'string' && p.trim()).join(', '));
}

/**
 * Collapse the doubled commas and stray whitespace left behind when a token
 * is removed from the middle of a list.
 * @param {string} text
 * @returns {string}
 */
function tidySeparators(text) {
    return String(text)
        .replace(/\s+/g, ' ')
        .replace(/\s*,(?:\s*,)+/g, ',')
        .replace(/,\s*/g, ', ')
        .replace(/^[\s,]+|[\s,]+$/g, '')
        .trim();
}
