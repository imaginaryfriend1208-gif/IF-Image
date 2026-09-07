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
                        item.outfit = parsed.outfit;
                        const matched = matchOutfit(parsed.outfit, outfitsForChar(char));
                        if (matched) item.outfitTags = matched.tags;
                    }
                    if (modifiers.some(m => VIEW_MODIFIERS.has(m))) {
                        lastViewModsByChar.set(char.id, modifiers.filter(m => VIEW_MODIFIERS.has(m)));
                    }
                    foundChars.push(item);
                    consumed = true;
                }
            }
            if (typeof parsed.size === 'string') {
                const sizeMatch = parsed.size.match(/^\s*(\d+)\s*[xX*]\s*(\d+)\s*$/);
                if (sizeMatch) {
                    paramOverrides.width = Number(sizeMatch[1]);
                    paramOverrides.height = Number(sizeMatch[2]);
                    consumed = true;
                } else {
                    console.warn(`[IF Image] Ignoring invalid "size" trigger value "${parsed.size}" (expected "WxH").`);
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
            if (consumed) return '';
        } catch {
            // Ignore parse errors, keep literal
        }
        return match;
    });

    // 4. $me directive
    text = text.replace(/\$me(?::([a-zA-Z0-9_|]+))?\b/gi, (match, mods) => {
        if (context.defaultPersona) {
            foundChars.push({
                isPersona: true,
                persona: context.defaultPersona,
                modifiers: mods ? mods.split('|') : [],
            });
            return '';
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
        if (!char) return match;

        const tokens = modsRaw ? modsRaw.split('|') : [];
        const viewMods = tokens.filter(t => VIEW_MODIFIERS.has(t));
        const otherMods = tokens.filter(t => t === 'nsfw');
        const outfitTokens = tokens.filter(t => !VIEW_MODIFIERS.has(t) && t !== 'nsfw');

        let outfitName = null;
        let outfitTags = '';
        for (const token of outfitTokens) {
            const found = matchOutfit(token, outfitsForChar(char));
            if (found) { outfitName = found.name; outfitTags = found.tags; break; }
        }

        let effectiveViewMods = viewMods;
        if (viewMods.length) {
            lastViewModsByChar.set(char.id, viewMods);
        } else if (lastViewModsByChar.has(char.id)) {
            effectiveViewMods = lastViewModsByChar.get(char.id);
        }

        const item = { char, modifiers: [...effectiveViewMods, ...otherMods] };
        if (outfitName) { item.outfit = outfitName; item.outfitTags = outfitTags; }
        foundChars.push(item);
        return '';
    });

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
