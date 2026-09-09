// IF Image - LLM context assembly for the rewrite engine.
// Builds the scene window, character block, and persona block that get
// injected into the master system prompt.

/**
 * Strip rendered artifacts from a message's text: code fences, reasoning
 * blocks, existing <ifimage> blocks, image### markers, and HTML tags.
 * @param {string} text
 * @returns {string}
 */
export function stripRenderedArtifacts(text) {
    if (typeof text !== 'string') return '';
    let out = text;
    // Code fences (```...``` and ~~~...~~~)
    out = out.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ');
    // Reasoning blocks (  thinking.../thinking)
    out = out.replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
        .replace(/`?thinking`?[\s\S]*?\/thinking/gi, ' ');
    // Existing <ifimage> blocks
    out = out.replace(/<ifimage>[\s\S]*?<\/ifimage>/gi, ' ')
        .replace(/<ifimage\/>/gi, ' ');
    // image###...### markers
    out = out.replace(/image###[\s\S]*?###/g, ' ');
    // HTML tags
    out = out.replace(/<[^>]+>/g, ' ');
    // Collapse whitespace
    return out.replace(/\s+/g, ' ').trim();
}

/**
 * Build the context blocks for an LLM rewrite request.
 * @param {{
 *   chat: Array<object>,
 *   settings: object,
 *   contextProfile: object,
 *   substituteParams: (text: string) => string,
 *   roster?: { characters: Array<object>, persona: object|null },
 * }} args
 * @returns {{ sceneText: string, charBlock: string, personaBlock: string }}
 */
export function buildContext({ chat, settings, contextProfile, substituteParams, roster = {} } = {}) {
    const profile = contextProfile ?? {};
    // Number(undefined) is NaN and ?? only catches null/undefined, so the
    // raw value must be resolved BEFORE the Number() conversion.
    const rawWindow = Number(profile.sceneWindow ?? settings?.generation?.sceneWindow ?? 4);
    const sceneWindow = Number.isFinite(rawWindow) ? Math.min(8, Math.max(2, rawWindow)) : 4;
    const scope = profile.scope ?? 'scene';

    let sceneText = '';
    let charBlock = '';
    let personaBlock = '';

    // ---- Scene window ----
    const messages = Array.isArray(chat) ? chat : [];
    if (scope === 'raw') {
        // No chat context — only the residual marker text is used by the caller.
        sceneText = '';
    } else if (scope === 'last') {
        // Last non-user message only.
        const last = [...messages].reverse().find(m => m && !m.is_system && m.role !== 'user');
        if (last) sceneText = stripRenderedArtifacts(last.mes ?? last.content ?? '');
    } else {
        // 'scene': last N messages, both user and character, in order.
        const window = messages.slice(-sceneWindow).filter(m => m && !m.is_system);
        sceneText = window.map(m => {
            const role = m.role === 'user' ? 'User' : 'Character';
            const body = stripRenderedArtifacts(m.mes ?? m.content ?? '');
            return body ? `${role}: ${body}` : '';
        }).filter(Boolean).join('\n');
    }

    // ---- Character block (from IF-Image roster cache, not ST cards) ----
    const chars = Array.isArray(roster.characters) ? roster.characters : [];
    if (profile.includeCharCard !== false && chars.length) {
        charBlock = chars.map(c => {
            const parts = [];
            if (c.name) parts.push(`Name: ${c.name}`);
            if (c.countTag) parts.push(`Count: ${c.countTag}`);
            if (c.booru) parts.push(`Tags: ${c.booru}`);
            if (c.facts) parts.push(`Facts: ${c.facts}`);
            return parts.join(' | ');
        }).join('\n');
    }

    // ---- Persona block ----
    const persona = roster.persona ?? null;
    if (profile.includePersona !== false && persona) {
        const parts = [];
        if (persona.name) parts.push(`Name: ${persona.name}`);
        if (persona.booru) parts.push(`Tags: ${persona.booru}`);
        if (persona.natural) parts.push(`Description: ${persona.natural}`);
        if (Array.isArray(persona.aliases) && persona.aliases.length) {
            parts.push(`Aliases: ${persona.aliases.join(', ')}`);
        }
        const h = persona.dialectHints;
        if (h) {
            const hintParts = [];
            if (h.krea?.stylePhrase) hintParts.push(`Krea: ${h.krea.stylePhrase}`);
            if (h.anima?.booruTags) hintParts.push(`Anima: ${h.anima.booruTags}`);
            if (h.illus?.artists) hintParts.push(`Illus: ${h.illus.artists}`);
            if (hintParts.length) parts.push(`Style hints: ${hintParts.join(' | ')}`);
        }
        personaBlock = parts.join(' | ');
    }

    // ---- ST macros ----
    if (typeof substituteParams === 'function') {
        sceneText = substituteParams(sceneText);
        charBlock = substituteParams(charBlock);
        personaBlock = substituteParams(personaBlock);
    }

    return { sceneText, charBlock, personaBlock };
}