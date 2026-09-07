// IF Image - Trigger-based tag replace rules (Phase C7).
// Rule: { trigger: 'a|b', mode, replacement, condition? }. `trigger` may
// hold multiple alternatives separated by '|' — the rule fires if ANY
// alternative exact-matches a tag in the prompt (after normalize).
//
// Modes (all operate on the comma-tag prompt string; krea's prose is not
// rule-eligible today — CFG 1 prose has no discrete tag list to match against):
//   prefix-head   - insert `replacement` once at the very start of the list
//   prefix-tail   - insert `replacement` immediately BEFORE the matched tag
//   replace       - replace the matched tag with `replacement`
//   delete        - remove the matched tag
//   suffix-head   - insert `replacement` immediately AFTER the matched tag
//   suffix-tail   - insert `replacement` once at the very end of the list
//   final         - same edit as `replace`, but scheduled to run AFTER the
//                   cleanup stage instead of before it
//
// Pipeline order (see index.js's compile()): compile -> non-final rules ->
// cleanup -> final rules.

function normalizeTag(t) {
    return (t || '').trim().toLowerCase();
}

/**
 * Parse the compact one-line rule syntax: "trigger1|trigger2=replacement".
 * Mode defaults to 'replace'; edit the `mode` field on the returned object
 * for the other 6 modes — the compact syntax only covers the common case
 * of "swap this tag for that".
 * @param {string} line
 * @returns {{ trigger: string, mode: string, replacement: string }|null}
 */
export function parseCompactRule(line) {
    if (typeof line !== 'string') return null;
    const eq = line.indexOf('=');
    if (eq < 0) return null;
    const trigger = line.slice(0, eq).trim();
    const replacement = line.slice(eq + 1).trim();
    if (!trigger) return null;
    return { trigger, mode: 'replace', replacement };
}

/**
 * A tiny SAFE condition evaluator: "@if dialect==illus", "@if nsfw",
 * "@if !nsfw". No eval/Function — string comparison only. Unknown/malformed
 * conditions return false (rule skipped) with a console warning, so a
 * hostile or broken condition string can never execute code or crash.
 * @param {string} condition
 * @param {{ dialect: string, nsfw: boolean, back: boolean, full: boolean }} ctx
 * @returns {boolean}
 */
export function evaluateCondition(condition, ctx) {
    if (!condition) return true;
    if (typeof condition !== 'string') return false;
    const trimmed = condition.trim().replace(/^@if\s+/i, '');
    const negated = trimmed.startsWith('!');
    const body = (negated ? trimmed.slice(1) : trimmed).trim();

    const eqMatch = body.match(/^([a-zA-Z_]+)\s*==\s*([a-zA-Z0-9_]+)$/);
    let result;
    if (eqMatch) {
        const [, key, value] = eqMatch;
        result = String(ctx?.[key] ?? '') === value;
    } else if (/^[a-zA-Z_]+$/.test(body)) {
        result = Boolean(ctx?.[body]);
    } else {
        console.warn(`[IF Image] Replace rule: unrecognized condition "${condition}" — rule skipped.`);
        return false;
    }
    return negated ? !result : result;
}

/** Apply one rule to a comma-tag prompt string. A rule whose trigger is absent is a no-op. */
function applyRuleToTagString(tagString, rule) {
    if (typeof rule.trigger !== 'string' || !rule.trigger) return tagString;
    const triggers = new Set(rule.trigger.split('|').map(normalizeTag).filter(Boolean));
    if (!triggers.size) return tagString;
    const tags = (tagString || '').split(',').map(t => t.trim()).filter(Boolean);
    const idx = tags.findIndex(t => triggers.has(normalizeTag(t)));

    if (rule.mode === 'prefix-head') {
        if (idx < 0) return tagString;
        return [rule.replacement, ...tags].filter(Boolean).join(', ');
    }
    if (rule.mode === 'suffix-tail') {
        if (idx < 0) return tagString;
        return [...tags, rule.replacement].filter(Boolean).join(', ');
    }
    if (idx < 0) return tagString;

    if (rule.mode === 'prefix-tail') {
        tags.splice(idx, 0, rule.replacement);
    } else if (rule.mode === 'suffix-head') {
        tags.splice(idx + 1, 0, rule.replacement);
    } else if (rule.mode === 'delete') {
        tags.splice(idx, 1);
    } else {
        // 'replace' and 'final' (final's stage timing is handled by the caller)
        tags[idx] = rule.replacement;
    }
    return tags.filter(Boolean).join(', ');
}

/**
 * Apply a set of rules to an envelope's prompt/negative.
 * @param {{ prompt: string, negative: string, params: object }} envelope
 * @param {Array<object>} rules
 * @param {'pre'|'final'} stage - which rules to run: non-final ('pre'
 *   — before cleanup) or 'final'-mode rules only (after cleanup)
 * @param {{ dialect: string, nsfw: boolean, back: boolean, full: boolean }} ctx
 * @returns {{ prompt: string, negative: string, params: object }}
 */
export function applyReplaceRules(envelope, rules, stage, ctx) {
    let { prompt, negative, params } = envelope;
    for (const rule of rules || []) {
        const isFinal = rule.mode === 'final';
        if (stage === 'pre' && isFinal) continue;
        if (stage === 'final' && !isFinal) continue;
        if (!evaluateCondition(rule.condition, ctx)) continue;
        prompt = applyRuleToTagString(prompt, rule);
        // Krea has no negative prompt at CFG 1 (negativeDisabled) — leave it untouched.
        if (ctx?.dialect !== 'krea') negative = applyRuleToTagString(negative, rule);
    }
    return { ...envelope, prompt, negative, params };
}
