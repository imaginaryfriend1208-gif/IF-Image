// IF Image - Trigger resolution and parsing.
// Grammar conforms to PROMPT-SPEC §5:
// - $Name
// - $Name:view|modifier (e.g. $Lyna:back|nsfw)
// - ${char: "Lyna", outfit: "casual", view: "full"}
// - $me (Persona)
// - {{style: StyleName}}
// - {{dialect: krea|anima|illus}}

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
 * Extracts and resolves triggers from a raw prompt string.
 * @param {string} input
 * @param {object} context - { roster: [], styles: [], defaultPersona: null }
 * @returns {object} { characters: [], styles: [], dialectOverride: null, residualPrompt: string }
 */
export function parseTriggers(input, context = {}) {
    if (!input || typeof input !== 'string') {
        return { characters: [], styles: [], dialectOverride: null, residualPrompt: '' };
    }

    let text = input;
    const roster = context.roster || [];
    const styles = context.styles || [];
    const foundChars = [];
    const foundStyles = [];
    let dialectOverride = null;

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

    // 3. JSON trigger: ${...}
    text = text.replace(/\$\{([^}]+)\}/g, (match, jsonLike) => {
        try {
            // relaxed json parse
            const normalized = jsonLike.replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2": ');
            const parsed = JSON.parse(`{${normalized}}`);
            if (parsed.char) {
                const char = matchCharacter(parsed.char, roster);
                if (char) {
                    foundChars.push({ char, modifiers: parsed });
                    return '';
                }
            }
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

    // 5. $Name:mods directive
    text = text.replace(/\$([a-zA-Z0-9_À-ɏḀ-ỿ]+)(?::([a-zA-Z0-9_|]+))?/g, (match, name, mods) => {
        const char = matchCharacter(name, roster);
        if (char) {
            foundChars.push({
                char,
                modifiers: mods ? mods.split('|') : [],
            });
            return '';
        }
        return match;
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
    };
}
