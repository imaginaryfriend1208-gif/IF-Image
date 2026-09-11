// IF Image - Defensive LLM reply parser.
// Parses <ifimage> blocks and image### markers from LLM text output.
// NEVER throws; returns [] for unparseable input.
// Repairs common LLM formatting issues: fenced blocks, unclosed tags,
// full-width chars, typo closers, missing titles/sizes.

const MAX_ENTRIES = 4;

/**
 * Normalize full-width punctuation to half-width.
 * @param {string} text
 * @returns {string}
 */
function normalizeFullWidth(text) {
    return text
        .replace(/＜/g, '<').replace(/＞/g, '>')
        .replace(/：/g, ':').replace(/＊/g, '*')
        .replace(/×/g, 'x').replace(/Ｘ/g, 'X')
        .replace(/／/g, '/').replace(/＜\//g, '</');
}

/**
 * Strip surrounding code fences (```...```) from the entire reply.
 * @param {string} text
 * @returns {string}
 */
function stripCodeFences(text) {
    return text.replace(/^```[\w]*\n?/gm, '').replace(/\n?```\s*$/gm, '');
}

/**
 * Extract a tag value from a string, handling typos and unclosed tags.
 * @param {string} block - text inside an <ifimage> block
 * @param {string} tag - e.g. 'image', 'prompt', 'title', 'size', 'negative'
 * @returns {string}
 */
function extractTag(block, tag) {
    // Allow typo closers: <\tag>, </ tag>, </tag
    const openPattern = new RegExp(`<${tag}>`, 'i');
    const closePattern = new RegExp(`</\\s*${tag}\\s*>|<\\\\\\s*${tag}>`, 'i');
    const openMatch = openPattern.exec(block);
    if (!openMatch) return '';
    const start = openMatch.index + openMatch[0].length;
    const rest = block.slice(start);
    const closeMatch = closePattern.exec(rest);
    const end = closeMatch ? closeMatch.index : rest.length;
    return rest.slice(0, end).trim();
}

/**
 * Parse <ifimage> blocks from text.
 * Each block must contain at least a <prompt> child tag.
 * @param {string} text
 * @returns {Array<{ title, think, width, height, prompt, negative, raw }>}
 */
function parseIfImageBlocks(text) {
    const results = [];
    // Match <ifimage ...>...</ifimage> blocks (with optional attributes)
    const blockRegex = /<ifimage[\s\S]*?>([\s\S]*?)<\/ifimage>/gi;
    // Also accept typo variants: <IFIMAGE>, unclosed at block end
    const blockRegexFallback = /<ifimage[\s\S]*?>((?:[\s\S](?!<\/ifimage))*[\s\S])/gi;

    let blocks = Array.from(text.matchAll(blockRegex)).map(m => ({ inner: m[1], pos: m.index }));
    if (!blocks.length) {
        // Fallback: unclosed <ifimage> — take everything from the opening tag to end
        blocks = Array.from(text.matchAll(blockRegexFallback)).map(m => ({ inner: m[1], pos: m.index }));
    }

    for (const { inner: block, pos } of blocks) {
        const title = extractTag(block, 'title');
        const think = extractTag(block, 'think');
        const prompt = extractTag(block, 'prompt');
        const negative = extractTag(block, 'negative');
        const image = extractTag(block, 'image');
        const hasSubjects = /<subjects(?:\s[^>]*)?>/i.test(block);
        const subjectsText = extractTag(block, 'subjects');
        const sizeStr = extractTag(block, 'size');

        if (!prompt) continue; // <prompt> is the only required tag

        let subjects;
        if (hasSubjects) {
            subjects = null;
            try {
                const parsedSubjects = JSON.parse(subjectsText);
                if (Array.isArray(parsedSubjects)) subjects = parsedSubjects;
            } catch { /* null is intentionally rejected by structured validation */ }
        }

        let width = 832, height = 1216;
        if (sizeStr) {
            const parts = sizeStr.replace(/[×*]/g, 'x').split('x');
            const w = parseInt(parts[0], 10);
            const h = parseInt(parts[1], 10);
            if (w >= 64 && w <= 4096 && h >= 64 && h <= 4096) {
                width = w;
                height = h;
            }
        }

        // Derive title from first prompt tokens if missing
        const derivedTitle = title || prompt.split(/[,\s]+/).slice(0, 3).join(' ');

        results.push({
            title: derivedTitle,
            think,
            width,
            height,
            prompt,
            negative,
            ...(hasSubjects ? { subjects } : {}),
            raw: block,
            _pos: pos,
        });
    }
    return results;
}

/**
 * Parse image### ... ### markers from text.
 * Uses the same grammar as the Direct-mode compiler.
 * @param {string} text
 * @returns {Array<{ title, think, width, height, prompt, negative, raw }>}
 */
function parseMarkerBlocks(text) {
    const results = [];
    const markerRegex = /image###\s*([\s\S]*?)\s*###/g;
    let match;
    while ((match = markerRegex.exec(text)) !== null) {
        const inner = match[1].trim();
        if (!inner) continue;
        results.push({
            title: inner.split(/[,\n]/).slice(0, 3).join(' ').slice(0, 60),
            think: '',
            width: 832,
            height: 1216,
            prompt: inner,
            negative: '',
            raw: match[0],
            _pos: match.index,
        });
    }
    return results;
}

/**
 * Parse an LLM reply into an array of image-generation entries.
 * Accepts both <ifimage> blocks and image### markers.
 * Never throws; returns [] when nothing parseable is found.
 * @param {string} text - raw LLM text output
 * @returns {Array<{ title: string, think: string, width: number, height: number,
 *                     prompt: string, negative: string, raw: string }>}
 */
export function parseLlmReply(text) {
    if (typeof text !== 'string' || !text.trim()) return [];

    let cleaned = normalizeFullWidth(text);
    cleaned = stripCodeFences(cleaned);

    // Also strip reasoning wrappers that may surround the entire reply
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/`?thinking`?[\s\S]*?\/thinking/gi, '')
        .trim();

    const ifImageEntries = parseIfImageBlocks(cleaned);
    const markerEntries = parseMarkerBlocks(cleaned);

    // Merge and preserve order by each match's actual position in the
    // cleaned text (stable sort keeps in-format order for equal positions).
    const all = [...ifImageEntries, ...markerEntries];
    all.sort((a, b) => a._pos - b._pos);

    // Dedupe by prompt text
    const seen = new Set();
    const deduped = [];
    for (const entry of all) {
        const key = entry.prompt.toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(entry);
    }

    // Cap at MAX_ENTRIES
    if (deduped.length > MAX_ENTRIES) {
        console.warn(`[IF Image] LLM reply contained ${deduped.length} entries; keeping only ${MAX_ENTRIES}.`);
    }
    return deduped.slice(0, MAX_ENTRIES).map(({ _pos, ...rest }) => rest);
}