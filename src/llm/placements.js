// IF Image - Chat placement validation and subject-token preservation.
// Pure functions only: anchors, structured metadata, repair, and rewrite
// fallback are resolved before any marker reaches the compiler/backend.

import {
    extractSubjectTokens,
    repairBareSubjectNames,
    resolveDeclaredSubjects,
    validateScenePrompt,
} from './subjects.js';

export function parseSize(text) {
    if (typeof text !== 'string') return null;
    const match = text.trim().toLowerCase().match(/^(\d{2,4})x(\d{2,4})$/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    return width >= 64 && width <= 2048 && height >= 64 && height <= 2048
        ? { width, height }
        : null;
}

function normalize(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text) {
    return new Set(normalize(text).split(' ').filter(Boolean));
}

function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    let intersection = 0;
    for (const value of a) if (b.has(value)) intersection += 1;
    const union = a.size + b.size - intersection;
    return union ? intersection / union : 0;
}

function isUserMessage(message) {
    return message?.role === 'user' || message?.is_user === true;
}

export function resolveAnchor(chat, anchor, { onlyCharacter = true } = {}) {
    if (typeof anchor !== 'string' || !anchor.trim()) return null;
    const needle = anchor.trim();
    const needleNorm = normalize(needle);
    if (!needleNorm) return null;
    const needleTokens = tokenize(needle);
    let bestFuzzyIdx = null;
    let bestFuzzyScore = 0;

    for (let i = (chat?.length ?? 0) - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_system || (onlyCharacter && isUserMessage(message))) continue;
        const body = message.mes ?? message.content ?? '';
        if (typeof body !== 'string' || !body) continue;
        if (body.includes(needle)) return i;
        const bodyNorm = normalize(body);
        if (bodyNorm.includes(needleNorm)) return i;
        const tail = bodyNorm.split(' ').filter(Boolean).slice(-30);
        const score = jaccard(new Set(tail), needleTokens);
        if (score > bestFuzzyScore) {
            bestFuzzyScore = score;
            bestFuzzyIdx = i;
        }
    }
    return bestFuzzyScore >= 0.5 ? bestFuzzyIdx : null;
}

function validationErrors(validation) {
    const errors = [];
    if (validation.empty) errors.push('prompt is empty');
    if (validation.missing.length) errors.push(`missing required subjects: ${validation.missing.join(', ')}`);
    if (validation.added.length) errors.push(`added undeclared subjects: ${validation.added.join(', ')}`);
    if (validation.unknown.length) errors.push(`unknown subject tokens: ${validation.unknown.join(', ')}`);
    if (validation.nonCanonical.length) errors.push(`non-canonical tokens: ${validation.nonCanonical.join(', ')}`);
    if (validation.styleLeak) errors.push('prompt contains compiler-owned style, quality, or LoRA content');
    return errors;
}

/**
 * Validate planner output. Invalid scene entries are rejected, while a
 * legacy item without `subjects` remains parseable if its prompt itself is
 * safe. Structured entries may repair exact declared bare names once.
 *
 * @returns {Array<object>} with non-enumerable `.diagnostics`
 */
export function validatePlacements(parsed, chat, count, {
    onlyCharacter = true, subjectCatalog = [], forbiddenFragments = [],
} = {}) {
    const out = [];
    const diagnostics = [];
    const requested = Number(count);
    const limit = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.images) || limit === 0) {
        Object.defineProperty(out, 'diagnostics', { value: diagnostics, enumerable: false });
        return out;
    }

    for (let sourceIndex = 0; sourceIndex < parsed.images.length; sourceIndex++) {
        const img = parsed.images[sourceIndex];
        if (typeof img?.prompt !== 'string' || !img.prompt.trim()) {
            diagnostics.push({ index: sourceIndex, errors: ['prompt is empty'] });
            continue;
        }
        const anchor = typeof img.anchor === 'string' ? img.anchor : img.text ?? '';
        const messageId = resolveAnchor(chat, anchor, { onlyCharacter });
        if (messageId === null) {
            diagnostics.push({ index: sourceIndex, errors: ['anchor did not resolve'] });
            continue;
        }
        if (out.some(placement => placement.messageId === messageId)) {
            diagnostics.push({ index: sourceIndex, errors: ['duplicate message anchor'] });
            continue;
        }

        const declared = resolveDeclaredSubjects(img.subjects, subjectCatalog);
        if (declared.errors.length) {
            diagnostics.push({ index: sourceIndex, errors: declared.errors });
            continue;
        }
        let prompt = img.prompt.trim();
        let repaired = [];
        if (declared.mode === 'structured' && declared.tokens.length) {
            const result = repairBareSubjectNames(prompt, subjectCatalog, { requiredTokens: declared.tokens });
            prompt = result.prompt;
            repaired = result.repaired;
        }

        const extracted = extractSubjectTokens(prompt, subjectCatalog);
        const requiredTokens = declared.mode === 'structured' ? declared.tokens : extracted.tokens;
        const allowedTokens = declared.mode === 'structured' ? declared.tokens : extracted.tokens;
        const scene = validateScenePrompt(prompt, subjectCatalog, {
            requiredTokens,
            allowedTokens,
            forbiddenFragments,
        });
        if (!scene.ok) {
            diagnostics.push({ index: sourceIndex, errors: validationErrors(scene), requiredTokens });
            continue;
        }

        const size = parseSize(img.size);
        out.push({
            messageId,
            prompt,
            negative: '', // deterministic compiler/profile owns negatives
            subjects: requiredTokens,
            subjectMode: declared.mode,
            ...(repaired.length ? { repairedSubjects: repaired } : {}),
            ...(size ? { width: size.width, height: size.height } : {}),
        });
        if (out.length >= limit) break;
    }
    Object.defineProperty(out, 'diagnostics', { value: diagnostics, enumerable: false });
    return out;
}

/**
 * Merge rewrite output while preserving each draft token set. A malformed,
 * identity-changing, style-leaking or unknown-token rewrite falls back to the
 * valid draft independently, without losing other successful rewrites.
 */
export function validateRewrites(parsed, placements, {
    subjectCatalog = [], forbiddenFragments = [],
} = {}) {
    const base = Array.isArray(placements) ? placements : [];
    const out = base.map(placement => ({ ...placement, subjects: [...(placement.subjects ?? [])] }));
    const rejected = [];
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.images)) {
        return { placements: out, changed: 0, rejected };
    }

    const seen = new Set();
    let changed = 0;
    for (const img of parsed.images) {
        if (!img || typeof img !== 'object') continue;
        const index = Number(img.index);
        if (!Number.isInteger(index) || index < 0 || index >= out.length || seen.has(index)) continue;
        const promptInput = typeof img.prompt === 'string' ? img.prompt.trim() : '';
        if (!promptInput) continue;
        seen.add(index);

        const target = out[index];
        const requiredTokens = Array.isArray(target.subjects) && target.subjects.length
            ? target.subjects
            : extractSubjectTokens(target.prompt, subjectCatalog).tokens;
        const declared = resolveDeclaredSubjects(img.subjects, subjectCatalog);
        if (declared.mode === 'structured'
            && (declared.errors.length
                || declared.tokens.length !== requiredTokens.length
                || declared.tokens.some(token => !requiredTokens.includes(token)))) {
            rejected.push({ index, errors: declared.errors.length ? declared.errors : ['rewrite subjects differ from draft'] });
            continue;
        }

        const repair = repairBareSubjectNames(promptInput, subjectCatalog, { requiredTokens });
        const scene = validateScenePrompt(repair.prompt, subjectCatalog, {
            requiredTokens,
            allowedTokens: requiredTokens,
            forbiddenFragments,
        });
        if (!scene.ok) {
            rejected.push({ index, errors: validationErrors(scene) });
            continue;
        }

        if (repair.prompt !== target.prompt) changed += 1;
        target.prompt = repair.prompt;
        target.negative = '';
        const size = parseSize(img.size);
        if (size) {
            target.width = size.width;
            target.height = size.height;
        }
    }
    return { placements: out, changed, rejected };
}
