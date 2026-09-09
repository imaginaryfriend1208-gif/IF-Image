// IF Image - Chat placement resolution: validates LLM output, resolves
// anchor text → message index. Pure functions — no ST/DOM deps.

/**
 * Parse a size string like "832x1216" into {width, height}.
 * @param {string} text
 * @returns {{ width: number, height: number } | null}
 */
export function parseSize(text) {
    if (typeof text !== 'string') return null;
    const m = text.trim().toLowerCase().match(/^(\d{2,4})x(\d{2,4})$/);
    if (!m) return null;
    const width = Number(m[1]);
    const height = Number(m[2]);
    return (width >= 64 && width <= 2048 && height >= 64 && height <= 2048)
        ? { width, height }
        : null;
}

/**
 * Normalize a string for fuzzy comparison: lowercase, strip punctuation,
 * collapse whitespace.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Tokenize a string into a Set of lowercase words.
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
    return new Set(normalize(text).split(' ').filter(Boolean));
}

/**
 * Jaccard similarity between two token sets.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const union = a.size + b.size - inter;
    return union ? inter / union : 0;
}

/**
 * Resolve an anchor string to a message index in the chat array.
 *
 * Three-layer matching:
 * 1. Exact substring — body.includes(needle) on the full text.
 * 2. Normalized substring — stripped punctuation, collapsed whitespace.
 * 3. Fuzzy — Jaccard similarity ≥ 0.5 on the last-N-tokens window.
 *
 * @param {Array<object>} chat - the SillyTavern chat array
 * @param {string} anchor - the LLM-provided anchor text
 * @param {{ onlyCharacter?: boolean }} [opts]
 * @returns {number|null} message index or null if no match
 */
export function resolveAnchor(chat, anchor, { onlyCharacter = true } = {}) {
    if (typeof anchor !== 'string') return null;
    const needle = anchor.trim();
    if (!needle) return null;
    const needleNorm = normalize(needle);
    if (!needleNorm) return null;
    const needleTokens = tokenize(needle);

    let bestFuzzyIdx = null;
    let bestFuzzyScore = 0;

    for (let i = (chat?.length ?? 0) - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        if (onlyCharacter && m.role === 'user') continue;
        const body = m.mes ?? m.content ?? '';
        if (typeof body !== 'string' || !body) continue;

        // Layer 1: exact substring
        if (body.includes(needle)) return i;

        // Layer 2: normalized substring
        const bodyNorm = normalize(body);
        if (bodyNorm.includes(needleNorm)) return i;

        // Layer 3: fuzzy — last 30 tokens of body vs anchor
        const bodyTokens = bodyNorm.split(' ').filter(Boolean);
        const tail = bodyTokens.slice(-30);
        const score = jaccard(new Set(tail), needleTokens);
        if (score > bestFuzzyScore) {
            bestFuzzyScore = score;
            bestFuzzyIdx = i;
        }
    }

    return bestFuzzyScore >= 0.5 ? bestFuzzyIdx : null;
}

/**
 * Validate raw LLM JSON output into a list of placements.
 * Drops invalid entries silently (no throw).
 *
 * @param {object} parsed - raw parsed JSON from LLM
 * @param {Array<object>} chat - the SillyTavern chat array
 * @param {number} count - desired number of images
 * @param {{ onlyCharacter?: boolean }} [opts]
 * @returns {Array<{ messageId: number, prompt: string, negative?: string, width?: number, height?: number }>}
 */
export function validatePlacements(parsed, chat, count, { onlyCharacter = true } = {}) {
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.images)) return [];
    const out = [];
    for (const img of parsed.images) {
        if (typeof img?.prompt !== 'string' || !img.prompt.trim()) continue;
        const anchor = typeof img.anchor === 'string' ? img.anchor : img.text ?? '';
        const messageId = resolveAnchor(chat, anchor, { onlyCharacter });
        if (messageId === null) continue;
        // Deduplicate — only one image per message.
        if (out.some(p => p.messageId === messageId)) continue;
        const size = parseSize(img.size);
        out.push({
            messageId,
            prompt: img.prompt.trim(),
            negative: typeof img.negative === 'string' ? img.negative.trim() : '',
            ...(size ? { width: size.width, height: size.height } : {}),
        });
        if (out.length >= count) break;
    }
    return out;
}

/**
 * Merge a chat_rewrite reply back onto the planned placements.
 *
 * The rewrite pass may only change prompt/negative/size. messageId, order,
 * and array length are invariant: an entry the LLM skipped, mangled, or
 * indexed out of range leaves its placement untouched, so a bad rewrite
 * reply degrades to the original plan instead of losing images.
 *
 * @param {object} parsed - raw parsed JSON from the rewrite call
 * @param {Array<{ messageId: number, prompt: string, negative?: string, width?: number, height?: number }>} placements
 * @returns {{ placements: Array<object>, changed: number }}
 */
export function validateRewrites(parsed, placements) {
    const base = Array.isArray(placements) ? placements : [];
    const out = base.map(p => ({ ...p }));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.images)) {
        return { placements: out, changed: 0 };
    }

    const seen = new Set();
    let changed = 0;

    for (const img of parsed.images) {
        if (!img || typeof img !== 'object') continue;
        const idx = Number(img.index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= out.length) continue;
        // One rewrite per index; a repeated index is ignored.
        if (seen.has(idx)) continue;

        const prompt = typeof img.prompt === 'string' ? img.prompt.trim() : '';
        if (!prompt) continue; // keep the original prompt

        seen.add(idx);
        const target = out[idx];
        if (prompt !== target.prompt) changed++;
        target.prompt = prompt;

        if (typeof img.negative === 'string' && img.negative.trim()) {
            target.negative = img.negative.trim();
        }
        const size = parseSize(img.size);
        if (size) {
            target.width = size.width;
            target.height = size.height;
        }
    }

    return { placements: out, changed };
}
