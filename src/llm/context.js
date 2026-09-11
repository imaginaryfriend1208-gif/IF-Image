// IF Image - LLM context assembly for scene generation and chat placement.
// The LLM sees speaker-aware transcript text plus an identity-only canonical
// subject catalog. Appearance, style, quality and LoRA data stay compiler-owned.

import { buildSubjectCatalog, renderSubjectCatalog } from './subjects.js';

/** Strip rendered artifacts without exposing old prompts back to the LLM. */
export function stripRenderedArtifacts(text) {
    if (typeof text !== 'string') return '';
    let out = text;
    out = out.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ');
    out = out.replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
        .replace(/`?thinking`?[\s\S]*?\/thinking/gi, ' ');
    out = out.replace(/<ifimage\b[^>]*>[\s\S]*?<\/ifimage>/gi, ' ')
        .replace(/<ifimage\s*\/\s*>/gi, ' ');
    out = out.replace(/image###[\s\S]*?###/g, ' ');
    out = out.replace(/<[^>]+>/g, ' ');
    return out.replace(/\s+/g, ' ').trim();
}

function messageIsUser(message) {
    return message?.role === 'user' || message?.is_user === true;
}

function contextCharacterName(message, host = {}) {
    if (typeof message?.name === 'string' && message.name.trim()) return message.name.trim();
    if (typeof message?.force_avatar === 'string' && message.force_avatar.trim()) {
        // Avatar is not a display name, so do not expose it as one.
    }
    const id = message?.character_id ?? message?.chid;
    if (id !== undefined && id !== null) {
        const record = host?.characters?.[id];
        if (typeof record?.name === 'string' && record.name.trim()) return record.name.trim();
    }
    if (typeof host?.name2 === 'string' && host.name2.trim()) return host.name2.trim();
    return 'Character';
}

function findCatalogEntry(catalog, kind, name) {
    const target = typeof name === 'string' ? name.normalize('NFKC').trim().toLocaleLowerCase() : '';
    if (!target) return null;
    return catalog.find(entry => entry.kind === kind
        && [entry.name, ...(entry.aliases ?? [])]
            .some(value => String(value).normalize('NFKC').trim().toLocaleLowerCase() === target)) ?? null;
}

/** Render one transcript speaker without replacing message-body mentions. */
export function renderSpeakerLabel(message, { catalog = [], host = {} } = {}) {
    if (messageIsUser(message)) {
        const persona = catalog.find(entry => entry.kind === 'persona' && entry.token === '$me')
            ?? catalog.find(entry => entry.kind === 'persona')
            ?? null;
        const name = persona?.name
            ?? (typeof host?.name1 === 'string' && host.name1.trim() ? host.name1.trim() : 'User');
        return persona ? `[${persona.token} — ${name}, user persona]` : `[${name} — user]`;
    }
    const name = contextCharacterName(message, host);
    const character = findCatalogEntry(catalog, 'character', name);
    return character ? `[${character.token} — ${character.name}, character]` : `[${name} — character]`;
}

function cleanMessageWindow(messages, sceneWindow, scope) {
    if (scope === 'raw') return [];
    if (scope === 'last') {
        const last = [...messages].reverse().find(message => message && !message.is_system && !messageIsUser(message));
        return last ? [last] : [];
    }
    return messages.slice(-sceneWindow).filter(message => message && !message.is_system);
}

/**
 * Build context for image_gen/chat_place/chat_rewrite.
 *
 * @returns {{ sceneText: string, subjectCatalog: Array, subjectBlock: string,
 *             charBlock: string, personaBlock: string }}
 */
export function buildContext({
    chat, settings, contextProfile, substituteParams, roster = {}, host = {},
    activeCardId = null, chatId = null, activeCharacterName = '',
    maxSubjects = 12, includeAllSubjects = false, additionalRelevanceText = '',
} = {}) {
    const profile = contextProfile ?? {};
    const rawWindow = Number(profile.sceneWindow ?? settings?.generation?.sceneWindow ?? 4);
    const rawCap = Number(profile.maxSceneWindow ?? 8);
    const windowCap = Number.isFinite(rawCap) ? Math.min(40, Math.max(2, Math.floor(rawCap))) : 8;
    const sceneWindow = Number.isFinite(rawWindow) ? Math.min(windowCap, Math.max(2, Math.floor(rawWindow))) : 4;
    const scope = profile.scope ?? 'scene';
    const messages = Array.isArray(chat) ? chat : [];
    const selectedMessages = cleanMessageWindow(messages, sceneWindow, scope);
    const relevanceText = [
        ...selectedMessages.map(message => stripRenderedArtifacts(message.mes ?? message.content ?? '')),
        stripRenderedArtifacts(additionalRelevanceText),
    ].filter(Boolean).join('\n');

    const characters = profile.includeCharCard === false ? [] : (Array.isArray(roster.characters) ? roster.characters : []);
    const persona = profile.includePersona === false ? null : (roster.persona ?? null);
    const personas = profile.includePersona === false ? [] : (Array.isArray(roster.personas) ? roster.personas : []);
    const subjectCatalog = buildSubjectCatalog({
        characters,
        personas,
        persona,
        relevanceText,
        activeCardId,
        chatId,
        activeCharacterName: activeCharacterName || host?.name2 || '',
        includeAll: includeAllSubjects,
        maxSubjects,
    });

    let sceneText = selectedMessages.map(message => {
        const body = stripRenderedArtifacts(message.mes ?? message.content ?? '');
        return body ? `${renderSpeakerLabel(message, { catalog: subjectCatalog, host })}: ${body}` : '';
    }).filter(Boolean).join('\n');
    let subjectBlock = renderSubjectCatalog(subjectCatalog);

    if (typeof substituteParams === 'function') {
        sceneText = substituteParams(sceneText);
        subjectBlock = substituteParams(subjectBlock);
    }

    // Legacy names remain as identity-only aliases for callers/tests that have
    // not migrated yet. Neither contains appearance/style information.
    const charBlock = profile.includeCharCard === false ? '' : subjectBlock;
    const personaBlock = '';
    return { sceneText, subjectCatalog, subjectBlock, charBlock, personaBlock };
}
