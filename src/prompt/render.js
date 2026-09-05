// IF Image - Prompt rendering and assembly per dialect.
// Implements PROMPT-SPEC §7 & §8.

import { normalizeBooruTags, deduplicateTags } from './dialects.js';

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

    if (dialect === 'krea') {
        // Prose representation
        let text = char.natural || char.facts || char.name;
        if (isBack) text += ', seen from behind';
        if (isNsfw && char.nsfwExtra) text += `, ${char.nsfwExtra}`;
        return text;
    }

    if (dialect === 'anima') {
        // Hybrid: count -> character -> series -> tags
        const parts = [];
        if (char.countTag) parts.push(char.countTag);
        if (char.booru) parts.push(normalizeBooruTags(char.booru));
        if (isBack && char.views?.back) parts.push(normalizeBooruTags(char.views.back));
        if (isNsfw && char.nsfwExtra) parts.push(normalizeBooruTags(char.nsfwExtra));
        return parts.filter(Boolean).join(', ');
    }

    // Default to 'illus' (NoobAI / Illustrious Booru Tags)
    const tags = [];
    if (char.countTag) tags.push(char.countTag);
    if (char.booru) tags.push(normalizeBooruTags(char.booru));
    if (isBack) tags.push('from behind, looking back');
    if (isNsfw && char.nsfwExtra) tags.push(normalizeBooruTags(char.nsfwExtra));

    return tags.filter(Boolean).join(', ');
}

/**
 * Render persona according to POV ladder (PROMPT-SPEC §6).
 */
export function renderPersonaForDialect(persona, dialect, modifiers = []) {
    if (!persona) return '';
    const mode = persona.povMode || 'auto';

    if (mode === 'hidden') {
        return dialect === 'krea' ? 'first person POV, no one else visible' : 'solo, looking at viewer';
    }
    if (mode === 'hands') {
        return dialect === 'krea' ? 'first person POV, hands in frame' : '1other, solo focus, pov, pov hands';
    }
    if (mode === 'third_person') {
        return '';
    }

    // 'full' or 'auto'
    if (dialect === 'krea') {
        return persona.natural || persona.facts || 'a companion';
    }
    const tags = [persona.countTag || '1boy', normalizeBooruTags(persona.booru || '')];
    return tags.filter(Boolean).join(', ');
}

/**
 * Assembles the full prompt, negative prompt, and parameters for the selected dialect.
 * @param {object} parsedTriggers - output from parseTriggers
 * @param {string} dialectKey - 'krea' | 'anima' | 'illus'
 * @param {object} baseProfile - profile from PROFILES
 * @returns {object} { prompt: string, negative: string, params: object }
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
        if (charParts.length) positiveParts.push(charParts.join('. '));

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
            params: {
                width: baseProfile.width || 1344,
                height: baseProfile.height || 768,
                steps: baseProfile.steps || 8,
                cfg: baseProfile.cfg || 1,
            },
        };
    }

    if (dialect === 'anima') {
        // Anima: Prefix -> Chars -> Scene -> Styles
        if (baseProfile.prefix) positiveParts.push(baseProfile.prefix);
        if (charParts.length) positiveParts.push(charParts.join(', '));
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
            params: {
                width: baseProfile.width || 832,
                height: baseProfile.height || 1216,
                steps: baseProfile.steps || 16,
                cfg: baseProfile.cfg || 2,
            },
        };
    }

    // Default: 'illus' (Illustrious/NoobAI)
    if (baseProfile.prefix) positiveParts.push(baseProfile.prefix);
    if (charParts.length) positiveParts.push(charParts.join(', '));
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
        params: {
            width: baseProfile.width || 832,
            height: baseProfile.height || 1216,
            steps: baseProfile.steps || 20,
            cfg: baseProfile.cfg || 5,
        },
    };
}
