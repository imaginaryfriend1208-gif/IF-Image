// IF Image - Trigger resolution and parsing.
// Grammar conforms to PROMPT-SPEC §5:
// - $Name
// - $Name:view|modifier (e.g. $Lyna:back|nsfw)
// - $Name:outfitName (fuzzy-matched against the character's own + common outfits)
// - ${char: "Lyna", outfit: "casual", view: "full"}
// - $me (Persona)
// - {{style: StyleName}}
// - {{dialect: krea|anima|illus}}

import { resolveEntityKeyword } from '../storage/entity-shape.js';
import { matchAutomaticOutfit } from './outfit-keywords.js';

/**
 * Normalize strings for fuzzy/diacritic matching (NFKD, handles Vietnamese đ/Đ).
 */
export function normalizeName(str) {
    if (!str) return '';
    return str
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .trim()
        .toLowerCase();
}

/**
 * Finds the best matching character preset from a roster.
 * Longest and exact match wins.
 * @param {string} token
 * @param {Array<object>} roster
 * @returns {object|null}
 */
export function matchCharacter(token, roster = []) {
    if (!token || !Array.isArray(roster) || !roster.length) return null;
    const target = normalizeName(token);
    if (!target) return null;
    // Canonical keyword matches outrank aliases from any record. Ties within
    // either tier retain stable roster order.
    for (const record of roster) {
        if (normalizeName(resolveEntityKeyword(record)) === target) return record;
    }
    for (const record of roster) {
        if ((Array.isArray(record?.aliases) ? record.aliases : [])
            .some(value => normalizeName(value) === target)) return record;
    }
    return null;
}

/**
 * Finds the best matching outfit by name among a candidate list.
 * Same longest/exact-match scoring as matchCharacter, on `name` only.
 * @param {string} token
 * @param {Array<object>} outfits
 * @returns {object|null}
 */
export function matchOutfit(token, outfits = []) {
    if (!token || !outfits.length) return null;
    const target = normalizeName(token);
    let bestMatch = null;
    let highestScore = -1;
    for (const outfit of outfits) {
        const norm = normalizeName(outfit.name);
        if (!norm) continue;
        let score = 0;
        if (norm === target) score = 1000 + norm.length;
        else if (norm.includes(target) || target.includes(norm)) score = 100 + Math.min(norm.length, target.length);
        if (score > highestScore) {
            highestScore = score;
            bestMatch = outfit;
        }
    }
    return highestScore > 0 ? bestMatch : null;
}

/** Recognized camera/view modifier keywords (never treated as an outfit name). */
const VIEW_MODIFIERS = new Set(['back', 'front', 'full', 'side']);

/**
 * Strip character slot placeholders so keyword matching only ever inspects
 * the author's own scene prose, never a compiler-substituted tag block.
 */
function sceneTextForKeywords(text) {
    return String(text ?? '').replace(CHAR_SLOT_PATTERN, ' ');
}

/**
 * Assign lorebook-style automatic outfits to already-resolved subjects.
 *
 * Rules (see CLAUDE.md / outfit lorebook decisions):
 * - An explicit `$Name:outfit` trigger always wins and is never overwritten.
 * - An explicit outfit token that failed to match still blocks auto-match:
 *   the user asked for a specific outfit, so silently substituting another
 *   one would be wrong.
 * - Owned outfits (charId === subject.id) beat shared ones (charId falsy).
 * - A shared outfit only auto-applies when exactly ONE subject is in frame;
 *   with two or more, "who is wearing it" is ambiguous, so nothing applies.
 * - Personas can wear shared outfits but own none, so they only participate
 *   in the unambiguous-single-subject case.
 * - No keyword evidence means no outfit. Nothing is ever guessed.
 *
 * @param {string} text - residual scene text (slot placeholders included)
 * @param {Array<object>} items - resolved character/persona entries, mutated in place
 * @param {Array<object>} outfits - full outfit roster
 */
function resolveAutomaticOutfits(text, items, outfits, attachOutfit, subjectOf, subjectKey) {
    if (!Array.isArray(items) || !items.length || !Array.isArray(outfits) || !outfits.length) return;

    const scene = sceneTextForKeywords(text);
    if (!scene.trim()) return;

    // Deduplicate by subject: the same character may be triggered twice in
    // one marker ("$Lyna:back ... $Lyna ..."), and both entries must end up
    // with the same clothing rather than being resolved independently.
    const bySubject = new Map();
    for (const item of items) {
        if (!subjectOf(item)) continue;
        const key = subjectKey(item);
        if (!key) continue;
        if (!bySubject.has(key)) bySubject.set(key, []);
        bySubject.get(key).push(item);
    }
    if (!bySubject.size) return;

    const soleSubject = bySubject.size === 1;

    for (const entries of bySubject.values()) {
        // Explicit intent anywhere in the group locks the whole subject.
        if (entries.some(item => item.outfitRequested || item.outfitSource === 'explicit')) continue;

        const subject = subjectOf(entries[0]);
        const isPersona = Boolean(entries[0].isPersona);
        const subjectId = subject?.id;

        const owned = !isPersona && subjectId
            ? outfits.filter(o => o.charId === subjectId)
            : [];
        // Shared outfits are only unambiguous with a single subject in frame.
        const shared = soleSubject ? outfits.filter(o => !o.charId) : [];

        const match = matchAutomaticOutfit(scene, owned)
            ?? matchAutomaticOutfit(scene, shared);
        if (!match) continue;

        for (const item of entries) attachOutfit(item, match, 'auto_keyword');
    }
}

/**
 * Marks where a character trigger stood in the scene text so render.js can
 * substitute its tags in place. Trigger tokens used to be deleted outright,
 * which tore the character out of the sentence:
 *
 *   "a cat walking in front of $Carter while he eats"
 *     -> "a cat walking in front of  while he eats"  + tags hoisted to front
 *
 * Scene wording belongs to the LLM, so only the token is replaced. The
 * placeholder carries no underscores, commas, or parens so downstream tag
 * helpers treat it as one opaque tag.
 */
const CHAR_SLOT_PREFIX = 'ifimagecharslot';

/** Build the placeholder for the Nth resolved character. */
export function charSlotToken(index) {
    return `${CHAR_SLOT_PREFIX}${index}`;
}

/** Matches any character placeholder, capturing its index. */
export const CHAR_SLOT_PATTERN = new RegExp(`${CHAR_SLOT_PREFIX}(\\d+)`, 'gi');

/**
 * Extracts and resolves triggers from a raw prompt string.
 * @param {string} input
 * @param {object} context - `roster` and `personas` MUST already be the active
 *   subsets produced by buildTriggerContext(). This parser intentionally does
 *   not know cardId/chatId and never applies binding rules itself.
 * @returns {object} { characters: [], styles: [], dialectOverride: null, residualPrompt: string }
 */
export function parseTriggers(input, context = {}) {
    if (!input || typeof input !== 'string') {
        return { characters: [], styles: [], dialectOverride: null, residualPrompt: '', paramOverrides: {} };
    }

    let text = input;
    const roster = Array.isArray(context.roster) ? context.roster : [];
    const personaRoster = Array.isArray(context.personas) ? context.personas : [];
    const styles = Array.isArray(context.styles) ? context.styles : [];
    const outfits = Array.isArray(context.outfits) ? context.outfits : [];
    const foundChars = [];
    const foundStyles = [];
    let dialectOverride = null;
    const outfitsForChar = subject => outfits.filter(outfit => outfit.charId === subject?.id || !outfit.charId);
    const lastViewModsByChar = new Map();

    function attachOutfit(item, outfit, source, displayName = '') {
        if (displayName) item.outfit = displayName;
        if (!outfit) return;
        item.outfit = displayName || outfit.name;
        item.outfitTags = typeof outfit.tags === 'string' ? outfit.tags : '';
        item.outfitRecord = outfit;
        item.outfitSource = source;
    }
    const subjectOf = item => item?.char ?? item?.persona ?? null;
    const subjectKey = item => {
        const subject = subjectOf(item);
        return subject ? `${item.isPersona ? 'persona' : 'character'}:${subject.id ?? normalizeName(resolveEntityKeyword(subject))}` : '';
    };
    const resolveSubject = token => {
        const char = matchCharacter(token, roster);
        return char ? { char, persona: null } : { char: null, persona: matchCharacter(token, personaRoster) };
    };
    const activeDefaultPersona = context.defaultPersona ?? null;

    text = text.replace(/\{\{\s*dialect\s*:\s*([a-zA-Z0-9_-]+)\s*\}\}/gi, (_match, value) => {
        dialectOverride = value.toLowerCase();
        return '';
    });
    text = text.replace(/\{\{\s*style\s*:\s*([^}]+)\s*\}\}/gi, (_match, value) => {
        const style = styles.find(item => normalizeName(item?.name) === normalizeName(value));
        if (style) foundStyles.push(style);
        return '';
    });

    const paramOverrides = {};
    text = text.replace(/\$\{([^}]+)\}/g, (match, jsonLike) => {
        try {
            const normalized = jsonLike.replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2": ');
            const parsed = JSON.parse(`{${normalized}}`);
            let consumed = false;
            let slotToken = '';
            if (typeof parsed.char === 'string' && parsed.char) {
                const { char, persona } = resolveSubject(parsed.char);
                const subject = char ?? persona;
                if (subject) {
                    const modifiers = [];
                    if (['back', 'front', 'side', 'full'].includes(parsed.view)) modifiers.push(parsed.view);
                    if (parsed.nsfw === true) modifiers.push('nsfw');
                    const item = char ? { char, modifiers } : { isPersona: true, persona, modifiers };
                    if (typeof parsed.outfit === 'string' && parsed.outfit) {
                        item.outfitRequested = true;
                        attachOutfit(item, matchOutfit(parsed.outfit, outfitsForChar(subject)), 'explicit', parsed.outfit);
                    }
                    const views = modifiers.filter(value => VIEW_MODIFIERS.has(value));
                    if (views.length) lastViewModsByChar.set(subject.id, views);
                    slotToken = charSlotToken(foundChars.push(item) - 1);
                    consumed = true;
                }
            }
            if (typeof parsed.size === 'string') {
                const sizeMatch = parsed.size.match(/^\s*(\d+)\s*[xX*]\s*(\d+)\s*$/);
                const keyword = parsed.size.trim().toLowerCase();
                if (sizeMatch) {
                    paramOverrides.width = Number(sizeMatch[1]);
                    paramOverrides.height = Number(sizeMatch[2]);
                    consumed = true;
                } else if (['portrait', 'landscape', 'square'].includes(keyword)) {
                    paramOverrides.sizeKeyword = keyword;
                    consumed = true;
                } else console.warn('[IF Image] Ignoring invalid "size" trigger value.');
            }
            if (parsed.steps !== undefined) {
                const value = Number(parsed.steps);
                if (Number.isFinite(value)) { paramOverrides.steps = value; consumed = true; }
                else console.warn('[IF Image] Ignoring invalid "steps" trigger value (not a number).');
            }
            if (parsed.cfg !== undefined) {
                const value = Number(parsed.cfg);
                if (Number.isFinite(value)) { paramOverrides.cfg = value; consumed = true; }
                else console.warn('[IF Image] Ignoring invalid "cfg" trigger value (not a number).');
            }
            if (parsed.seed !== undefined) {
                const value = Number(parsed.seed);
                if (Number.isInteger(value) && value >= -1) { paramOverrides.seed = value; consumed = true; }
                else console.warn('[IF Image] Ignoring invalid "seed" trigger value (expected an integer >= -1).');
            }
            if (consumed) return slotToken;
        } catch { /* keep malformed token literal */ }
        return match;
    });

    text = text.replace(/\$me(?::([a-zA-Z0-9_|]+))?\b/gi, (match, raw) => {
        if (!activeDefaultPersona) return match;
        return charSlotToken(foundChars.push({ isPersona: true, persona: activeDefaultPersona, modifiers: raw ? raw.split('|') : [] }) - 1);
    });

    text = text.replace(/\$([a-zA-Z0-9_À-ɏḀ-ỿ]+)(?::([a-zA-Z0-9_À-ɏḀ-ỿ|]+))?/g, (match, token, modsRaw) => {
        if (normalizeName(token) === 'me') return match;
        const { char, persona } = resolveSubject(token);
        if (!char && !persona) return match;
        const subject = char ?? persona;
        const tokens = modsRaw ? modsRaw.split('|') : [];
        const viewMods = tokens.filter(value => VIEW_MODIFIERS.has(value));
        const otherMods = tokens.filter(value => value === 'nsfw');
        const outfitTokens = tokens.filter(value => !VIEW_MODIFIERS.has(value) && value !== 'nsfw');
        let matchedOutfit = null;
        for (const outfitToken of outfitTokens) {
            matchedOutfit = matchOutfit(outfitToken, outfitsForChar(subject));
            if (matchedOutfit) break;
        }
        let effectiveViews = viewMods;
        if (viewMods.length) lastViewModsByChar.set(subject.id, viewMods);
        else if (lastViewModsByChar.has(subject.id)) effectiveViews = lastViewModsByChar.get(subject.id);
        const item = char
            ? { char, modifiers: [...effectiveViews, ...otherMods] }
            : { isPersona: true, persona, modifiers: [...effectiveViews, ...otherMods] };
        if (outfitTokens.length) item.outfitRequested = true;
        if (matchedOutfit) attachOutfit(item, matchedOutfit, 'explicit');
        return charSlotToken(foundChars.push(item) - 1);
    });

    const prose = sceneTextForKeywords(text);
    const found = new Set(foundChars.map(subjectKey));
    const hasSurface = value => {
        const surface = typeof value === 'string' ? value.trim() : '';
        if (!surface) return false;
        const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(prose);
    };
    const characterSurfaces = new Set();
    for (const char of roster) {
        const surfaces = [resolveEntityKeyword(char), ...(Array.isArray(char?.aliases) ? char.aliases : [])].filter(Boolean);
        for (const surface of surfaces) characterSurfaces.add(normalizeName(surface));
        const item = { char, modifiers: [] };
        if (!found.has(subjectKey(item)) && surfaces.some(hasSurface)) {
            foundChars.push(item);
            found.add(subjectKey(item));
        }
    }
    for (const persona of personaRoster) {
        if (persona?.isDefault || persona === activeDefaultPersona
            || (persona?.id && persona.id === activeDefaultPersona?.id)) continue;
        const surfaces = [resolveEntityKeyword(persona), ...(Array.isArray(persona?.aliases) ? persona.aliases : [])]
            .filter(surface => surface && !characterSurfaces.has(normalizeName(surface)));
        const item = { isPersona: true, persona, modifiers: [] };
        if (!found.has(subjectKey(item)) && surfaces.some(hasSurface)) {
            foundChars.push(item);
            found.add(subjectKey(item));
        }
    }

    resolveAutomaticOutfits(text, foundChars, outfits, attachOutfit, subjectOf, subjectKey);
    const residualPrompt = text.replace(/,\s*,+/g, ',').replace(/^\s*,\s*|\s*,\s*$/g, '').trim();
    return { characters: foundChars, styles: foundStyles, dialectOverride, residualPrompt, paramOverrides };
}
