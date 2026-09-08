// IF Image - Prompt rendering and assembly per dialect.
// Implements PROMPT-SPEC §7 & §8.

import { normalizeBooruTags, deduplicateTags } from './dialects.js';

// ------------------------------------------------------------------
// Phase C0: generation param overrides (settings + marker JSON). These
// functions are pure — the caller (index.js) supplies the override object
// (from settings.generation.params[profileKey] or parseTriggers's
// paramOverrides) so this module never imports settings.js.
// Precedence: profile < settings.generation.params < marker JSON <
// LLM <size>/<negative> (the last is applied later, in marker-pipeline.js,
// after compile() returns — see index.js).
// ------------------------------------------------------------------

/** Coerce to a finite number, or undefined for null/undefined/''/NaN. Number(null)
 *  and Number('') are both 0 (finite) — those must be treated as "absent",
 *  not as an explicit zero override. */
function toFiniteOrUndefined(value) {
    if (value === null || value === undefined || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

/** Snap to a 64px multiple and clamp to [256, 2048]; undefined if not a finite number. */
export function clampDim(value) {
    const n = toFiniteOrUndefined(value);
    if (n === undefined) return undefined;
    const snapped = Math.round(n / 64) * 64;
    return Math.min(2048, Math.max(256, snapped));
}

/** Clamp to [1, 150]; undefined if not a finite number. */
export function clampSteps(value) {
    const n = toFiniteOrUndefined(value);
    if (n === undefined) return undefined;
    return Math.min(150, Math.max(1, Math.round(n)));
}

/** Clamp to [0, 30]; undefined if not a finite number. */
export function clampCfg(value) {
    const n = toFiniteOrUndefined(value);
    if (n === undefined) return undefined;
    return Math.min(30, Math.max(0, n));
}

/**
 * Merge a settings-level {width,height,steps,cfg} override onto a PROFILES
 * entry, clamped. Absent/blank fields inherit the profile default —
 * `override` is typically settings.generation.params[profileKey].
 * @param {object} baseProfile - a PROFILES[key] entry
 * @param {object} [override]
 * @returns {object} a new profile-shaped object; baseProfile is not mutated
 */
export function mergeProfileParams(baseProfile, override) {
    if (!override || typeof override !== 'object') return baseProfile;
    const merged = { ...baseProfile };
    const width = clampDim(override.width);
    const height = clampDim(override.height);
    const steps = clampSteps(override.steps);
    const cfg = clampCfg(override.cfg);
    if (width !== undefined) merged.width = width;
    if (height !== undefined) merged.height = height;
    if (steps !== undefined) merged.steps = steps;
    if (cfg !== undefined) merged.cfg = cfg;
    return merged;
}

/**
 * Apply marker-level "size"/"steps"/"cfg" JSON trigger overrides onto
 * already-assembled params, in place. Invalid values are simply absent
 * (parseTriggers already warns and drops them at parse time) — width/height
 * only apply as a pair so a lone dimension never distorts the aspect ratio.
 * @param {object} params - assemblePrompt()'s .params, mutated in place
 * @param {object} [overrides] - parseTriggers()'s .paramOverrides
 */
export function applyMarkerParamOverrides(params, overrides) {
    if (!overrides) return;
    const width = clampDim(overrides.width);
    const height = clampDim(overrides.height);
    if (width !== undefined && height !== undefined) {
        params.width = width;
        params.height = height;
    }
    const steps = clampSteps(overrides.steps);
    if (steps !== undefined) params.steps = steps;
    const cfg = clampCfg(overrides.cfg);
    if (cfg !== undefined) params.cfg = cfg;
    // D2: marker seed (already validated as integer >= -1 by parseTriggers).
    if (Number.isInteger(overrides.seed) && overrides.seed >= -1) params.seed = overrides.seed;
}

/**
 * D2: character seed lock. Returns the locked seed to use, or undefined.
 * Applies ONLY when exactly one character resolved (with two or more, the
 * locks would fight), that character's lock.seed is a non-negative integer,
 * and the marker did not set its own seed (marker JSON beats the lock).
 * @param {Array<{char?: {lock?: {seed?: number}}}>} characters parseTriggers().characters
 * @param {object} [markerOverrides] parseTriggers().paramOverrides
 * @returns {number|undefined}
 */
export function resolveLockedSeed(characters, markerOverrides) {
    if (Number.isInteger(markerOverrides?.seed) && markerOverrides.seed >= -1) return undefined;
    const list = Array.isArray(characters) ? characters : [];
    if (list.length !== 1) return undefined;
    const lockSeed = list[0]?.char?.lock?.seed;
    return (Number.isInteger(lockSeed) && lockSeed >= 0) ? lockSeed : undefined;
}

/**
 * Map a {{dialect: X}} override value to the corresponding PROFILES key.
 * The override wins over the configured default profile; unknown values
 * fall back with a console warning (never echoing raw user text beyond the
 * directive value itself).
 * @param {string|null} dialectOverride - from parseTriggers, e.g. 'illus'
 * @param {string} configuredProfileKey - e.g. 'anima'
 * @returns {{profileKey: string, usedOverride: boolean}}
 */
const DIALECT_TO_PROFILE = { krea: 'krea2', anima: 'anima', illus: 'illustrious' };

export function resolveProfileKey(dialectOverride, configuredProfileKey) {
    if (dialectOverride) {
        const mapped = DIALECT_TO_PROFILE[dialectOverride];
        if (mapped) return { profileKey: mapped, usedOverride: true };
        console.warn(`[IF Image] Unknown dialect override "${dialectOverride}" — falling back to the configured profile.`);
    }
    return { profileKey: configuredProfileKey, usedOverride: false };
}

/**
 * Resolve the region x rating x view matrix cells relevant to a trigger's
 * modifiers into flat sfw/nsfw tag lists.
 *
 * Region selection: 'full' modifier includes face+upper+lower, otherwise
 * face+upper (portrait, matching the legacy no-region behavior). View:
 * 'back' modifier selects the back column, otherwise front. Rating: sfw
 * cells are always collected; nsfw cells are collected IN ADDITION when the
 * 'nsfw' modifier is present.
 *
 * Empty cells contribute nothing here — callers fall back to the flat
 * legacy fields (booru/views.back/nsfwExtra) when the resulting list for an
 * axis is empty, so a character with no booruDetail filled in renders
 * byte-identical to the pre-matrix implementation.
 * @param {object} char
 * @param {string[]} mods
 * @returns {{ sfwTags: string[], nsfwTags: string[] }}
 */
function collectMatrixTags(char, mods) {
    const detail = char.booruDetail;
    const view = mods.includes('back') ? 'back' : 'front';
    const regions = mods.includes('full') ? ['face', 'upper', 'lower'] : ['face', 'upper'];
    const sfwTags = [];
    const nsfwTags = [];
    if (detail) {
        for (const region of regions) {
            const sfwCell = detail[region]?.sfw?.[view];
            if (sfwCell) sfwTags.push(sfwCell);
            const nsfwCell = detail[region]?.nsfw?.[view];
            if (nsfwCell) nsfwTags.push(nsfwCell);
        }
    }
    return { sfwTags, nsfwTags };
}

/**
 * Render a character entity for a specific dialect.
 * @param {object} item - from parseTriggers ({ char, modifiers, isPersona, persona })
 * @param {string} dialect - 'krea' | 'anima' | 'illus'
 * @returns {string}
 */
export function renderCharacterForDialect(item, dialect) {
    if (item.isPersona && item.persona) {
        return renderPersonaForDialect(item.persona, dialect, item.modifiers);
    }
    const char = item.char;
    if (!char) return '';

    const mods = Array.isArray(item.modifiers) ? item.modifiers : [];
    const isBack = mods.includes('back');
    const isNsfw = mods.includes('nsfw');
    const matrix = collectMatrixTags(char, mods);

    if (dialect === 'krea') {
        // Prose representation
        let text = char.natural || char.facts || char.name;
        if (isBack) {
            text += matrix.sfwTags.length ? `, ${matrix.sfwTags.join(', ')}` : ', seen from behind';
        } else if (matrix.sfwTags.length) {
            text += `, ${matrix.sfwTags.join(', ')}`;
        }
        if (isNsfw) {
            if (matrix.nsfwTags.length) text += `, ${matrix.nsfwTags.join(', ')}`;
            else if (char.nsfwExtra) text += `, ${char.nsfwExtra}`;
        }
        if (item.outfitTags) text += `, ${item.outfitTags}`;
        return text;
    }

    if (dialect === 'anima') {
        // Hybrid: count -> character -> series -> tags
        const parts = [];
        if (char.countTag) parts.push(char.countTag);
        if (char.booru) parts.push(normalizeBooruTags(char.booru));
        if (matrix.sfwTags.length) parts.push(normalizeBooruTags(matrix.sfwTags.join(', ')));
        else if (isBack && char.views?.back) parts.push(normalizeBooruTags(char.views.back));
        if (isNsfw) {
            if (matrix.nsfwTags.length) parts.push(normalizeBooruTags(matrix.nsfwTags.join(', ')));
            else if (char.nsfwExtra) parts.push(normalizeBooruTags(char.nsfwExtra));
        }
        if (item.outfitTags) parts.push(normalizeBooruTags(item.outfitTags));
        return parts.filter(Boolean).join(', ');
    }

    // Default to 'illus' (NoobAI / Illustrious Booru Tags)
    const tags = [];
    if (char.countTag) tags.push(char.countTag);
    if (char.booru) tags.push(normalizeBooruTags(char.booru));
    if (isBack) tags.push('from behind, looking back'); // literal phrase, independent of the matrix
    if (matrix.sfwTags.length) tags.push(normalizeBooruTags(matrix.sfwTags.join(', ')));
    if (isNsfw) {
        if (matrix.nsfwTags.length) tags.push(normalizeBooruTags(matrix.nsfwTags.join(', ')));
        else if (char.nsfwExtra) tags.push(normalizeBooruTags(char.nsfwExtra));
    }
    if (item.outfitTags) tags.push(normalizeBooruTags(item.outfitTags));

    return tags.filter(Boolean).join(', ');
}

/**
 * Render persona according to the POV ladder (PROMPT-SPEC §6). Danbooru-
 * verified tags: 'pov' / 'pov hands' are real, well-populated Danbooru tags;
 * 'solo, looking at viewer' keeps the persona itself out of frame while
 * acknowledging the camera.
 * @param {object} persona
 * @param {string} dialect
 * @param {string[]} [modifiers] - the scene's own trigger modifiers (back/full/nsfw)
 */
export function renderPersonaForDialect(persona, dialect, modifiers = []) {
    if (!persona) return '';
    let mode = persona.povMode || 'auto';

    // 'auto': pick a sane default from the scene's own modifiers rather than
    // always falling through to 'full'. Explicit 'full' on the trigger means
    // the user asked for the persona visibly in frame; 'nsfw' without an
    // explicit 'full' defaults to a POV-hands framing (the common intimate-
    // scene composition); otherwise the persona stays out of frame.
    if (mode === 'auto') {
        if (modifiers.includes('full')) mode = 'full';
        else if (modifiers.includes('nsfw')) mode = 'hands';
        else mode = 'hidden';
    }

    if (mode === 'hidden') {
        return dialect === 'krea' ? 'first person POV, no one else visible' : 'solo, looking at viewer';
    }
    if (mode === 'hands') {
        return dialect === 'krea' ? 'first person POV, hands in frame' : '1other, solo focus, pov, pov hands';
    }
    if (mode === 'third_person') {
        return '';
    }

    // 'full'
    if (dialect === 'krea') {
        return persona.natural || persona.facts || 'a companion';
    }
    const tags = [persona.countTag || '1boy', normalizeBooruTags(persona.booru || '')];
    return tags.filter(Boolean).join(', ');
}

/**
 * Phase C8: merge per-character rendered strings into the block inserted
 * into the prompt for a dialect. Fewer than 2 characters reproduces the
 * pre-C8 single string join exactly (byte-identical). 2+ characters use a
 * distinct grouping per dialect so each character reads as a separate
 * subject instead of one run-on tag list.
 * @param {string[]} charParts
 * @param {string} dialect
 * @returns {string}
 */
function groupCharacterParts(charParts, dialect) {
    if (charParts.length < 2) return charParts.join(dialect === 'krea' ? '. ' : ', ');
    if (dialect === 'illus') {
        // Escaped-parens grouping; each part already starts with its own
        // count tag (renderCharacterForDialect pushes it first).
        return charParts.map(p => `\\(${p}\\)`).join(', ');
    }
    if (dialect === 'anima') {
        // Sequential per-character caption blocks.
        return charParts.join('. ');
    }
    // krea: prose anchors across the frame.
    if (charParts.length === 2) {
        return `on the left, ${charParts[0]}; on the right, ${charParts[1]}`;
    }
    return charParts.map((p, i) => `character ${i + 1}: ${p}`).join('; ');
}

/**
 * Assembles the full prompt, negative prompt, and parameters for the selected dialect.
 * @param {object} parsedTriggers - output from parseTriggers
 * @param {string} dialectKey - 'krea' | 'anima' | 'illus'
 * @param {object} baseProfile - profile from PROFILES
 * @returns {object} { prompt: string, negative: string, params: object, characters: string[] }
 */
export function assemblePrompt(parsedTriggers, dialectKey, baseProfile = {}) {
    const dialect = dialectKey || 'illus';
    const charParts = parsedTriggers.characters.map(c => renderCharacterForDialect(c, dialect)).filter(Boolean);
    const scenePrompt = parsedTriggers.residualPrompt || '';

    let positiveParts = [];
    let negativeParts = [];

    if (dialect === 'krea') {
        // Krea 2: Prose only, no negative prompt at CFG 1
        if (scenePrompt) positiveParts.push(scenePrompt);
        if (charParts.length) positiveParts.push(groupCharacterParts(charParts, 'krea'));

        for (const style of parsedTriggers.styles || []) {
            const h = style.dialectHints?.krea;
            if (h?.stylePhrase) positiveParts.push(h.stylePhrase);
            if (h?.lighting) positiveParts.push(h.lighting);
            if (h?.camera) positiveParts.push(h.camera);
        }

        const fullPrompt = positiveParts.filter(Boolean).join(', ');
        return {
            prompt: fullPrompt,
            negative: '',
            characters: charParts,
            params: {
                width: baseProfile.width || 1344,
                height: baseProfile.height || 768,
                steps: baseProfile.steps || 8,
                cfg: baseProfile.cfg ?? 1, // 0 is a valid CFG override; only fall back on null/undefined
            },
        };
    }

    if (dialect === 'anima') {
        // Anima: Prefix -> Chars -> Scene -> Styles
        if (baseProfile.prefix) positiveParts.push(baseProfile.prefix);
        if (charParts.length) positiveParts.push(groupCharacterParts(charParts, 'anima'));
        if (scenePrompt) positiveParts.push(scenePrompt);

        for (const style of parsedTriggers.styles || []) {
            const h = style.dialectHints?.anima;
            if (h?.booruTags) positiveParts.push(normalizeBooruTags(h.booruTags));
            if (h?.artists) positiveParts.push(h.artists);
        }

        if (baseProfile.negative) negativeParts.push(baseProfile.negative);

        return {
            prompt: deduplicateTags(positiveParts.filter(Boolean).join(', ')),
            negative: deduplicateTags(negativeParts.filter(Boolean).join(', ')),
            characters: charParts,
            params: {
                width: baseProfile.width || 832,
                height: baseProfile.height || 1216,
                steps: baseProfile.steps || 16,
                cfg: baseProfile.cfg ?? 2,
            },
        };
    }

    // Default: 'illus' (Illustrious/NoobAI)
    if (baseProfile.prefix) positiveParts.push(baseProfile.prefix);
    if (charParts.length) positiveParts.push(groupCharacterParts(charParts, 'illus'));
    if (scenePrompt) positiveParts.push(normalizeBooruTags(scenePrompt));

    for (const style of parsedTriggers.styles || []) {
        const h = style.dialectHints?.illus;
        if (h?.qualityPrefix) positiveParts.push(h.qualityPrefix);
        if (h?.artists) positiveParts.push(h.artists);
        if (h?.negativeTags) negativeParts.push(h.negativeTags);
    }

    if (baseProfile.negative) negativeParts.push(baseProfile.negative);

    return {
        prompt: deduplicateTags(positiveParts.filter(Boolean).join(', ')),
        negative: deduplicateTags(negativeParts.filter(Boolean).join(', ')),
        characters: charParts,
        params: {
            width: baseProfile.width || 832,
            height: baseProfile.height || 1216,
            steps: baseProfile.steps || 20,
            cfg: baseProfile.cfg ?? 5,
        },
    };
}
