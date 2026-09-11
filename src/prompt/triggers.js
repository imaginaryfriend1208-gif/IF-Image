// IF Image - Trigger resolution and parsing.
// Grammar conforms to PROMPT-SPEC §5:
// - $Name
// - $Name:view|modifier (e.g. $Lyna:back|nsfw)
// - $Name:outfitName (fuzzy-matched against the character's own + common outfits)
// - ${char: "Lyna", outfit: "casual", view: "full"}
// - $me (Persona)
// - {{style: StyleName}}
// - {{dialect: krea|anima|illus}}

import { resolveCharacterTrigger } from './binding.js';
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
    if (!token || !roster.length) return null;
    const target = normalizeName(token);
    let bestMatch = null;
    let highestScore = -1;

    for (const char of roster) {
        const names = [char.name, ...(char.aliases || [])];
        for (const candidate of names) {
            const norm = normalizeName(candidate);
            if (!norm) continue;

            let score = 0;
            if (norm === target) {
                score = 1000 + norm.length;
            } else if (norm.includes(target) || target.includes(norm)) {
                score = 100 + Math.min(norm.length, target.length);
            }

            if (score > highestScore) {
                highestScore = score;
                bestMatch = char;
            }
        }
    }
    return highestScore > 0 ? bestMatch : null;
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
 * @param {object} context - { roster: [], styles: [], defaultPersona: null, outfits: [] }
 * @returns {object} { characters: [], styles: [], dialectOverride: null, residualPrompt: string }
 */
export function parseTriggers(input, context = {}) {
    if (!input || typeof input !== 'string') {
        return { characters: [], styles: [], dialectOverride: null, residualPrompt: '', paramOverrides: {} };
    }

    let text = input;
    const roster = context.roster || [];
    const styles = context.styles || [];
    const outfits = context.outfits || [];
    // Personas are addressable by name too ($Ann, not just $me).
    const personaRoster = Array.isArray(context.personas) ? context.personas : [];
    const foundChars = [];
    const foundStyles = [];
    let dialectOverride = null;

    // Outfits usable by a given character: its own (by charId) plus every
    // common outfit (charId=null/undefined).
    const outfitsForChar = (char) => outfits.filter(o => o.charId === char.id || !o.charId);

    // Tracks the last explicit camera/view modifiers used per character id
    // within THIS marker, so a later outfit-only trigger for the same
    // character inherits them (e.g. "$Lyna:back ... $Lyna:casual ...").
    const lastViewModsByChar = new Map();

    function attachOutfit(item, outfit, source, displayName = '') {
        if (displayName) item.outfit = displayName;
        if (!outfit) return;
        item.outfit = displayName || outfit.name;
        item.outfitTags = typeof outfit.tags === 'string' ? outfit.tags : '';
        item.outfitRecord = outfit;
        item.outfitSource = source;
    }

    function subjectOf(item) {
        return item?.char ?? item?.persona ?? null;
    }

    function subjectKey(item) {
        const subject = subjectOf(item);
        if (!subject) return '';
        return `${item.isPersona ? 'persona' : 'character'}:${subject.id ?? normalizeName(subject.name)}`;
    }

    // Character resolution with the C4 fallback tiers (active -> bound ->
    // all). `roster` here is meant to be the ALREADY-ACTIVE subset (see
    // resolveActiveCharacters in binding.js); passing context.fullRoster
    // enables the wider tiers with a toastr-style warning via
    // context.onFallback(tier, token). Without fullRoster, behavior is
    // unchanged from pre-C4: a plain matchCharacter against context.roster.
    function resolveChar(token) {
        if (!context.fullRoster) return matchCharacter(token, roster);
        const result = resolveCharacterTrigger(matchCharacter, token, roster, context.fullRoster);
        if (result.usedFallback && typeof context.onFallback === 'function') {
            context.onFallback(result.tier, token);
        }
        return result.char;
    }

    // 1. Dialect directive: {{dialect: id}}
    text = text.replace(/\{\{\s*dialect\s*:\s*([a-zA-Z0-9_-]+)\s*\}\}/gi, (match, d) => {
        dialectOverride = d.toLowerCase();
        return '';
    });

    // 2. Style directive: {{style: StyleName}}
    text = text.replace(/\{\{\s*style\s*:\s*([^}]+)\s*\}\}/gi, (match, sName) => {
        const targetStyle = styles.find(s => normalizeName(s.name) === normalizeName(sName));
        if (targetStyle) foundStyles.push(targetStyle);
        return '';
    });

    // 3. JSON trigger: ${...}. Beside character triggers, the same object
    // form may carry marker-level generation param overrides: "size":
    // "WxH", "steps": n, "cfg": n. These are collected into paramOverrides
    // (last one wins if repeated) and consumed by index.js's compile(),
    // which merges them on top of profile + settings.generation.params —
    // see CLAUDE.md precedence note: profile < settings < marker JSON < LLM.
    // Invalid values are ignored with a console warning, never thrown.
    const paramOverrides = {};
    text = text.replace(/\$\{([^}]+)\}/g, (match, jsonLike) => {
        try {
            // relaxed json parse
            const normalized = jsonLike.replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2": ');
            const parsed = JSON.parse(`{${normalized}}`);
            let consumed = false;
            // Set when this trigger resolved a character: the JSON form also
            // carries param overrides, so the token may be consumed without
            // one. An empty slot token keeps the old delete-the-token result.
            let slotToken = '';
            if (parsed.char) {
                const char = resolveChar(parsed.char);
                if (char) {
                    // Normalize JSON keys to the same string[] modifier shape
                    // produced by the $Name:mod1|mod2 syntax. render.js checks
                    // .includes('back') / .includes('nsfw'), so modifiers must
                    // always be an array of strings. `outfit` is kept as a
                    // separate field (consumed by Phase C outfit triggers).
                    const modifiers = [];
                    if (parsed.view === 'back') modifiers.push('back');
                    if (parsed.view === 'full') modifiers.push('full');
                    if (parsed.nsfw === true) modifiers.push('nsfw');
                    const item = { char, modifiers };
                    if (typeof parsed.outfit === 'string' && parsed.outfit) {
                        item.outfitRequested = true;
                        const matched = matchOutfit(parsed.outfit, outfitsForChar(char));
                        attachOutfit(item, matched, 'explicit', parsed.outfit);
                    }
                    if (modifiers.some(m => VIEW_MODIFIERS.has(m))) {
                        lastViewModsByChar.set(char.id, modifiers.filter(m => VIEW_MODIFIERS.has(m)));
                    }
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
                } else if (keyword === 'portrait' || keyword === 'landscape' || keyword === 'square') {
                    // D3: orientation keyword. The numeric pair depends on
                    // the profile, which is not known here — compile()
                    // (index.js) resolves it AFTER the profile is picked.
                    // A numeric "WxH" from another trigger beats the keyword.
                    paramOverrides.sizeKeyword = keyword;
                    consumed = true;
                } else {
                    console.warn(`[IF Image] Ignoring invalid "size" trigger value "${parsed.size}" (expected "WxH" or portrait/landscape/square).`);
                }
            }
            if (parsed.steps !== undefined) {
                const n = Number(parsed.steps);
                if (Number.isFinite(n)) { paramOverrides.steps = n; consumed = true; }
                else console.warn('[IF Image] Ignoring invalid "steps" trigger value (not a number).');
            }
            if (parsed.cfg !== undefined) {
                const n = Number(parsed.cfg);
                if (Number.isFinite(n)) { paramOverrides.cfg = n; consumed = true; }
                else console.warn('[IF Image] Ignoring invalid "cfg" trigger value (not a number).');
            }
            // D2: marker-level seed override — integer >= -1 (-1 = random).
            if (parsed.seed !== undefined) {
                const n = Number(parsed.seed);
                if (Number.isInteger(n) && n >= -1) { paramOverrides.seed = n; consumed = true; }
                else console.warn('[IF Image] Ignoring invalid "seed" trigger value (expected an integer >= -1).');
            }
            if (consumed) return slotToken;
        } catch {
            // Ignore parse errors, keep literal
        }
        return match;
    });

    // 4. $me directive
    text = text.replace(/\$me(?::([a-zA-Z0-9_|]+))?\b/gi, (match, mods) => {
        if (context.defaultPersona) {
            const index = foundChars.push({
                isPersona: true,
                persona: context.defaultPersona,
                modifiers: mods ? mods.split('|') : [],
            }) - 1;
            return charSlotToken(index);
        }
        return match;
    });

    // 5. $Name:mods directive — mods tokens are either recognized view
    // modifiers (back/front/full/side), 'nsfw', or an outfit name to
    // fuzzy-match against the character's outfits (own + common). An
    // outfit-only trigger (no view tokens) inherits the last view modifiers
    // seen for that same character earlier in this marker.
    // The mods group shares the name group's accented ranges (À-ɏ, Ḁ-ỿ):
    // outfit names are user-authored and may carry Vietnamese diacritics
    // (e.g. `$Lyna:đồ ngủ` typed as `$Lyna:đồngủ`).
    text = text.replace(/\$([a-zA-Z0-9_À-ɏḀ-ỿ]+)(?::([a-zA-Z0-9_À-ɏḀ-ỿ|]+))?/g, (match, name, modsRaw) => {
        const char = resolveChar(name);
        // A persona is a character that happens to be the protagonist, so
        // $PersonaName resolves exactly like $CharacterName. Characters win
        // a name collision because they are the larger, chat-scoped set.
        const persona = char ? null : matchCharacter(name, personaRoster);
        if (!char && !persona) return match;

        const tokens = modsRaw ? modsRaw.split('|') : [];
        const viewMods = tokens.filter(t => VIEW_MODIFIERS.has(t));
        const otherMods = tokens.filter(t => t === 'nsfw');
        const outfitTokens = tokens.filter(t => !VIEW_MODIFIERS.has(t) && t !== 'nsfw');

        const subject = char ?? persona;
        let matchedOutfit = null;
        for (const token of outfitTokens) {
            const found = matchOutfit(token, outfitsForChar(subject));
            if (found) { matchedOutfit = found; break; }
        }

        let effectiveViewMods = viewMods;
        if (viewMods.length) {
            lastViewModsByChar.set(subject.id, viewMods);
        } else if (lastViewModsByChar.has(subject.id)) {
            effectiveViewMods = lastViewModsByChar.get(subject.id);
        }

        const modifiers = [...effectiveViewMods, ...otherMods];
        const item = char
            ? { char, modifiers }
            : { isPersona: true, persona, modifiers };
        if (outfitTokens.length) item.outfitRequested = true;
        if (matchedOutfit) attachOutfit(item, matchedOutfit, 'explicit');
        return charSlotToken(foundChars.push(item) - 1);
    });

    // 6. Persona keyword detection — a persona whose alias appears in the
    // scene text is pulled in even without an explicit trigger. Runs AFTER
    // the $Name pass so a persona already named there is not added twice.
    // These have no position in the text, so they carry no slot token and
    // render.js appends them; an explicit trigger is what pins a position.
    if (personaRoster.length) {
        const defaultId = context.defaultPersona?.id;
        const alreadyMatchedIds = new Set(foundChars.filter(c => c.isPersona).map(c => c.persona?.id));
        for (const p of personaRoster) {
            if (p.id === defaultId) continue; // $me handles default
            if (alreadyMatchedIds.has(p.id)) continue;
            const aliases = Array.isArray(p.aliases) ? p.aliases : [];
            if (!aliases.length) continue;
            // Build a temporary roster shape for matchCharacter
            const probe = [{ name: p.name, aliases }];
            const matched = matchCharacter(text, probe);
            if (matched) {
                foundChars.push({ isPersona: true, persona: p, modifiers: [] });
                alreadyMatchedIds.add(p.id);
            }
        }
    }

    // 7. Lorebook-style automatic outfits. Runs LAST, on the scene prose only
    // (trigger tokens are already slot placeholders), so keyword matching
    // never sees compiler-expanded character tags. It only ASSIGNS clothing
    // to subjects that were already resolved by an explicit trigger — it can
    // never introduce a character from generic prose.
    // Precedence: explicit `$Name:outfit` > owned auto outfit > shared auto
    // outfit (only when exactly one subject is in frame, otherwise ambiguous).
    resolveAutomaticOutfits(text, foundChars, outfits, attachOutfit, subjectOf, subjectKey);

    // Clean up excessive whitespace/commas
    const residualPrompt = text
        .replace(/,\s*,+/g, ',')
        .replace(/^\s*,\s*|\s*,\s*$/g, '')
        .trim();

    return {
        characters: foundChars,
        styles: foundStyles,
        dialectOverride,
        residualPrompt,
        paramOverrides,
    };
}
