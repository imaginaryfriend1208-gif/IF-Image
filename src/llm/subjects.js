// IF Image - Canonical subject-token contract shared by LLM planning,
// rewriting, and the marker compiler. Pure functions only; no ST/DOM/IDB deps.
//
// Tokens emitted here must be understood by src/prompt/triggers.js:
//   - $Name              simple character/persona name
//   - ${char: "Name"}    character name with spaces / non-Latin letters
//   - $me                the default persona
// There is no ${persona: ...} trigger. A complex non-default persona therefore
// has no safe compiler token and is omitted from the catalog.

const SIMPLE_NAME_RE = /^[A-Za-z0-9_\u00C0-\u024F\u1E00-\u1EFF]+$/;
const WORD_CHAR = 'A-Za-z0-9_\\u00C0-\\u024F\\u1E00-\\u1EFF';
const SIMPLE_TOKEN_RE = new RegExp(`\\$([${WORD_CHAR}]+)(?::[${WORD_CHAR}|]+)?`, 'g');
const OBJECT_TOKEN_RE = /\$\{([^}]+)\}/g;

// Complete artifacts are protected before token scanning or bare-name repair.
// Generic HTML elements are protected as a whole where possible, then any
// remaining tags are protected individually. LoRA tags are intentionally
// protected from identity repair but are scanned separately for style leaks.
const PROTECTED_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|<ifimage\b[^>]*>[\s\S]*?<\/ifimage\s*>|<ifimage\s*\/\s*>|image###[\s\S]*?###|<([A-Za-z][\w:-]*)\b[^>]*>[\s\S]*?<\/\1\s*>|<[^>]*>/gi;
const STYLE_PROTECTED_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~|<ifimage\b[^>]*>[\s\S]*?<\/ifimage\s*>|<ifimage\s*\/\s*>|image###[\s\S]*?###/gi;

// These belong to the compiler/profile rather than an LLM-authored scene.
const STYLE_LEAK_RE = /<\s*lora\s*:|\{\{\s*(?:style|dialect)\s*:|\b(?:masterpiece|best quality|amazing quality|very aesthetic|absurdres|newest|photorealistic|photo-realistic|anime style|digital art|cinematic lighting|score_\d+)\b/i;

/** Case/diacritic-preserving fold used only for identity comparison. */
export function normalizeSubjectName(value) {
    return typeof value === 'string' ? value.normalize('NFKC').trim().toLocaleLowerCase() : '';
}

/** A name the trigger parser can carry as a bare $Name. */
export function isSimpleName(name) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    return Boolean(trimmed) && SIMPLE_NAME_RE.test(trimmed) && normalizeSubjectName(trimmed) !== 'me';
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function objectCharToken(name) {
    return `\${char: ${JSON.stringify(name)}}`;
}

/**
 * Return an exact token the trigger parser can resolve, or an empty string if
 * this subject cannot be represented without colliding with another subject.
 */
export function createSubjectToken(subject, { simpleUnavailable = false } = {}) {
    const name = typeof subject?.name === 'string' ? subject.name.trim() : '';
    if (!name) return '';
    const kind = subject.kind === 'persona' ? 'persona' : 'character';
    if (kind === 'persona') {
        if (subject.isDefault) return '$me';
        return !simpleUnavailable && isSimpleName(name) ? `$${name}` : '';
    }
    return !simpleUnavailable && isSimpleName(name) ? `$${name}` : objectCharToken(name);
}

function cleanAliases(record) {
    if (!Array.isArray(record?.aliases)) return [];
    const out = [];
    for (const alias of record.aliases) {
        if (typeof alias !== 'string' || !alias.trim()) continue;
        const value = alias.trim();
        if (!out.some(item => normalizeSubjectName(item) === normalizeSubjectName(value))) out.push(value);
    }
    return out;
}

function hasExactPhrase(text, phrase) {
    if (!text || !phrase) return false;
    const escaped = escapeRegExp(phrase);
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(text);
}

function characterPriority(character, options, relevanceText) {
    let priority = 99;
    if (options.activeCardId && character?.binding?.cardId === options.activeCardId) priority = Math.min(priority, 0);
    if (options.chatId && Array.isArray(character?.binding?.chatIds)
        && character.binding.chatIds.includes(options.chatId)) priority = Math.min(priority, 1);
    const names = [character?.name, ...cleanAliases(character)];
    if (options.activeCharacterName
        && names.some(name => normalizeSubjectName(name) === normalizeSubjectName(options.activeCharacterName))) {
        priority = Math.min(priority, 2);
    }
    if (relevanceText && names.some(name => hasExactPhrase(relevanceText, name))) priority = Math.min(priority, 3);
    return priority;
}

function recordKey(record, kind) {
    if (record?.id !== undefined && record?.id !== null && String(record.id)) return `${kind}:id:${record.id}`;
    return `${kind}:name:${normalizeSubjectName(record?.name)}`;
}

/**
 * Build a stable, relevance-ordered canonical catalog. The cap applies to the
 * combined character + persona list, not to each collection independently.
 *
 * Priority: active card, current-chat binding, active ST character, transcript
 * mention, active/default persona, other mentioned personas, then stable roster
 * order as a bounded compatibility fallback.
 *
 * @returns {Array<{ id, kind, name, aliases, token, alternateTokens, record }>}
 */
export function buildSubjectCatalog({
    characters = [], personas = [], persona = null, relevanceText = '',
    activeCardId = null, chatId = null, activeCharacterName = '',
    includeAll = false, maxSubjects = 12,
} = {}) {
    const requestedCap = Number(maxSubjects);
    const cap = Number.isFinite(requestedCap) ? Math.max(0, Math.floor(requestedCap)) : Number.MAX_SAFE_INTEGER;
    if (cap === 0) return [];

    const options = { activeCardId, chatId, activeCharacterName };
    const candidates = [];
    const chars = Array.isArray(characters) ? characters : [];
    chars.forEach((record, order) => {
        if (!record || typeof record !== 'object' || !String(record.name ?? '').trim()) return;
        const priority = characterPriority(record, options, relevanceText);
        candidates.push({ record, kind: 'character', isDefault: false, priority, order });
    });

    const personaRecords = [];
    const seenPersonas = new Set();
    const addPersona = (record) => {
        if (!record || typeof record !== 'object' || !String(record.name ?? '').trim()) return;
        const key = recordKey(record, 'persona');
        if (seenPersonas.has(key)) return;
        seenPersonas.add(key);
        personaRecords.push(record);
    };
    addPersona(persona);
    for (const record of Array.isArray(personas) ? personas : []) addPersona(record);

    const activePersonaKey = persona ? recordKey(persona, 'persona') : '';
    personaRecords.forEach((record, order) => {
        const isDefault = Boolean(record?.isDefault) || (activePersonaKey && recordKey(record, 'persona') === activePersonaKey);
        const names = [record?.name, ...cleanAliases(record)];
        const mentioned = relevanceText && names.some(name => hasExactPhrase(relevanceText, name));
        candidates.push({
            record,
            kind: 'persona',
            isDefault,
            priority: isDefault ? 4 : (mentioned ? 5 : 98),
            order,
        });
    });

    // If any scoped/relevant character exists, unrelated characters are left
    // out. If there is no signal at all, retain a bounded stable fallback so a
    // sparse host context does not make every roster subject unavailable.
    const hasRelevantCharacter = candidates.some(item => item.kind === 'character' && item.priority < 99);
    const filtered = candidates.filter(item => includeAll
        || (item.kind === 'persona' ? item.priority < 98 : (!hasRelevantCharacter || item.priority < 99)));
    filtered.sort((a, b) => a.priority - b.priority
        || (a.kind === b.kind ? a.order - b.order : (a.kind === 'character' ? -1 : 1)));

    // Characters own simple-name collisions because trigger parsing checks the
    // character roster before personas. Compute ownership over selected
    // candidates, then skip any token collision and continue filling the cap.
    const characterNames = new Set(filtered
        .filter(item => item.kind === 'character')
        .flatMap(item => [item.record.name, ...cleanAliases(item.record)])
        .map(normalizeSubjectName));
    const usedTokens = new Set();
    const usedTokenKeys = new Set();
    const catalog = [];
    for (const item of filtered) {
        if (catalog.length >= cap) break;
        const name = String(item.record.name ?? '').trim();
        const collides = item.kind === 'persona' && characterNames.has(normalizeSubjectName(name));
        const token = createSubjectToken({ name, kind: item.kind, isDefault: item.isDefault }, { simpleUnavailable: collides });
        const tokenKey = normalizeSubjectName(token);
        if (!token || usedTokens.has(token) || usedTokenKeys.has(tokenKey)) continue;
        usedTokens.add(token);
        usedTokenKeys.add(tokenKey);
        catalog.push({
            id: String(item.record.id ?? `${item.kind}:${normalizeSubjectName(name)}`),
            kind: item.kind,
            name,
            aliases: cleanAliases(item.record),
            token,
            // Kept in the public shape for compatibility. LLMs receive and
            // may declare only the one canonical Exact token.
            alternateTokens: [],
            record: item.record,
        });
    }
    return catalog;
}

/** Render identity metadata only; appearance/style fields never enter it. */
export function renderSubjectCatalog(catalog = []) {
    if (!Array.isArray(catalog) || !catalog.length) return '(no known subject tokens)';
    const lines = ['KNOWN SUBJECT TOKENS (copy each Exact token byte-for-byte):'];
    for (const entry of catalog) {
        const aliases = entry.aliases?.length ? ` | Aliases: ${entry.aliases.join(', ')}` : '';
        const role = entry.kind === 'persona' ? 'user persona' : 'character';
        lines.push(`- Exact token: ${entry.token} | Canonical name: ${entry.name} | Role: ${role}${aliases}`);
        lines.push(`  Use ${entry.token} whenever ${entry.name} is visibly present. Never replace it with a generic description, pronoun-only reference, or appearance tags.`);
    }
    return lines.join('\n');
}

function canonicalTokenMap(catalog) {
    const map = new Map();
    for (const entry of Array.isArray(catalog) ? catalog : []) map.set(entry.token, entry);
    return map;
}

function addOwner(map, surface, entry) {
    const key = normalizeSubjectName(surface);
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(entry);
}

function nameOwners(catalog, { charactersOnly = false, simpleOnly = false } = {}) {
    const map = new Map();
    for (const entry of Array.isArray(catalog) ? catalog : []) {
        if (charactersOnly && entry.kind !== 'character') continue;
        for (const surface of [entry.name, ...(entry.aliases ?? [])]) {
            if (simpleOnly && !isSimpleName(surface)) continue;
            addOwner(map, surface, entry);
        }
    }
    return map;
}

/** Parse a relaxed `${char: "Name"}` body into an identity, or null. */
function parseIdentityObject(body) {
    try {
        const normalized = body.replace(/(['"])?([A-Za-z0-9_]+)(['"])?:/g, '"$2": ');
        const value = JSON.parse(`{${normalized}}`);
        if (typeof value.char === 'string' && value.char.trim()) {
            return { kind: 'character', name: value.char.trim() };
        }
    } catch { /* reported as unresolved below when it looks like a char object */ }
    return null;
}

function collectRanges(text, pattern) {
    const ranges = [];
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(re)) ranges.push([match.index, match.index + match[0].length]);
    return ranges;
}

function mergeRanges(ranges) {
    const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const out = [];
    for (const range of sorted) {
        const last = out[out.length - 1];
        if (!last || range[0] > last[1]) out.push([...range]);
        else last[1] = Math.max(last[1], range[1]);
    }
    return out;
}

function maskRanges(text, ranges) {
    if (!ranges.length) return text;
    const chars = text.split('');
    for (const [start, end] of ranges) {
        for (let i = start; i < end; i++) chars[i] = ' ';
    }
    return chars.join('');
}

function protectedRanges(text) {
    return collectRanges(text, PROTECTED_RE);
}

function maskProtected(text) {
    return maskRanges(text, protectedRanges(text));
}

function inRanges(index, ranges) {
    return ranges.some(([start, end]) => index >= start && index < end);
}

function addUnique(list, value) {
    if (!list.includes(value)) list.push(value);
}

/**
 * Extract canonical known subjects and unresolved identity-looking tokens.
 * `nonCanonical` identifies aliases/case/object spellings that resolve to a
 * known entry but violate the LLM's exact-token contract.
 *
 * @returns {{ tokens: string[], unknown: string[], nonCanonical: string[] }}
 */
export function extractSubjectTokens(prompt, catalog = []) {
    const source = typeof prompt === 'string' ? prompt : '';
    const text = maskProtected(source);
    const direct = canonicalTokenMap(catalog);
    const characterOwners = nameOwners(catalog, { charactersOnly: true });
    const simpleOwners = nameOwners(catalog, { simpleOnly: true });
    const tokens = [];
    const unknown = [];
    const nonCanonical = [];
    const objectSpans = [];

    for (const match of text.matchAll(new RegExp(OBJECT_TOKEN_RE.source, 'g'))) {
        objectSpans.push([match.index, match.index + match[0].length]);
        const identity = parseIdentityObject(match[1]);
        if (!identity) {
            if (/\bchar\s*:/i.test(match[1])) addUnique(unknown, match[0]);
            continue; // ${size: ...}, ${seed: ...}, etc. are not subjects.
        }
        const directEntry = direct.get(match[0]);
        const owners = characterOwners.get(normalizeSubjectName(identity.name));
        const entry = directEntry ?? (owners?.size === 1 ? [...owners][0] : null);
        if (!entry) {
            addUnique(unknown, objectCharToken(identity.name));
            continue;
        }
        addUnique(tokens, entry.token);
        if (!directEntry) addUnique(nonCanonical, match[0]);
    }

    for (const match of text.matchAll(new RegExp(SIMPLE_TOKEN_RE.source, 'g'))) {
        if (inRanges(match.index, objectSpans)) continue;
        const baseToken = `$${match[1]}`;
        const directEntry = direct.get(baseToken);
        const owners = simpleOwners.get(normalizeSubjectName(match[1]));
        const entry = directEntry ?? (owners?.size === 1 ? [...owners][0] : null);
        if (!entry) {
            addUnique(unknown, baseToken);
            continue;
        }
        addUnique(tokens, entry.token);
        if (!directEntry || match[0] !== baseToken) addUnique(nonCanonical, match[0]);
    }
    return { tokens, unknown, nonCanonical };
}

/**
 * Resolve structured `subjects` metadata. Field absence is a controlled legacy
 * mode; a present field accepts canonical tokens only.
 */
export function resolveDeclaredSubjects(subjects, catalog = []) {
    if (subjects === undefined) return { mode: 'legacy', tokens: [], errors: [] };
    if (!Array.isArray(subjects)) {
        return { mode: 'structured', tokens: [], errors: ['"subjects" must be an array of canonical token strings.'] };
    }
    const direct = canonicalTokenMap(catalog);
    const tokens = [];
    const errors = [];
    for (const raw of subjects) {
        if (typeof raw !== 'string' || !raw) {
            errors.push('Every subject must be a non-empty canonical token string.');
            continue;
        }
        const entry = direct.get(raw);
        if (!entry) errors.push(`Unknown subject token or non-canonical spelling: ${raw.trim() || '(empty)'}`);
        else if (!tokens.includes(entry.token)) tokens.push(entry.token);
    }
    return { mode: 'structured', tokens, errors };
}

function repairMask(text) {
    const ranges = protectedRanges(text);
    const protectedText = maskRanges(text, ranges);
    for (const match of protectedText.matchAll(new RegExp(OBJECT_TOKEN_RE.source, 'g'))) {
        ranges.push([match.index, match.index + match[0].length]);
    }
    for (const match of protectedText.matchAll(new RegExp(SIMPLE_TOKEN_RE.source, 'g'))) {
        ranges.push([match.index, match.index + match[0].length]);
    }
    return maskRanges(text, mergeRanges(ranges));
}

/**
 * One-pass exact bare-name repair. Matches are discovered only in the original
 * protected text, selected longest-first without overlap, and then applied
 * right-to-left, so inserted `${char: ...}` tokens can never be scanned again.
 *
 * @returns {{ prompt: string, repaired: string[], unresolved: string[] }}
 */
export function repairBareSubjectNames(prompt, catalog = [], { requiredTokens = null } = {}) {
    const text = typeof prompt === 'string' ? prompt : '';
    const direct = canonicalTokenMap(catalog);
    const owners = nameOwners(catalog);
    const extracted = extractSubjectTokens(text, catalog);
    const present = new Set(extracted.tokens);
    const wanted = Array.isArray(requiredTokens)
        ? new Set(requiredTokens)
        : new Set((Array.isArray(catalog) ? catalog : []).map(entry => entry.token));
    const scan = repairMask(text);
    const candidates = [];

    (Array.isArray(catalog) ? catalog : []).forEach((entry, entryOrder) => {
        if (!wanted.has(entry.token) || present.has(entry.token)) return;
        for (const surface of [entry.name, ...(entry.aliases ?? [])]) {
            const key = normalizeSubjectName(surface);
            if (!key || owners.get(key)?.size !== 1) continue;
            const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escapeRegExp(surface)})(?=$|[^\\p{L}\\p{N}_])`, 'giu');
            for (const match of scan.matchAll(re)) {
                const start = match.index + match[1].length;
                const end = start + match[2].length;
                candidates.push({ start, end, length: end - start, entry, entryOrder });
            }
        }
    });

    // Prefer the longest surface globally ("Mary Jane" over "Mary"), then
    // stable left-to-right/catalog order. At most one insertion per identity.
    candidates.sort((a, b) => b.length - a.length || a.start - b.start || a.entryOrder - b.entryOrder);
    const selected = [];
    const selectedTokens = new Set();
    for (const candidate of candidates) {
        if (selectedTokens.has(candidate.entry.token)) continue;
        if (selected.some(item => candidate.start < item.end && candidate.end > item.start)) continue;
        selected.push(candidate);
        selectedTokens.add(candidate.entry.token);
    }

    let out = text;
    for (const candidate of selected.slice().sort((a, b) => b.start - a.start)) {
        out = out.slice(0, candidate.start) + candidate.entry.token + out.slice(candidate.end);
    }
    const repaired = selected
        .sort((a, b) => a.start - b.start)
        .map(item => item.entry.token);
    for (const token of repaired) present.add(token);

    // Unknown required tokens remain explicitly unresolved rather than being
    // silently dropped from validation.
    const unresolved = [...wanted].filter(token => !direct.has(token) || !present.has(token));
    return { prompt: out, repaired, unresolved };
}

/** Compiler-owned style fragments used for exact duplicate-leak checks. */
export function styleLeakFragments(style, dialect = '') {
    if (!style || typeof style !== 'object') return [];
    const values = [style.name];
    const hints = style.dialectHints ?? {};
    const selected = dialect && hints[dialect] ? [hints[dialect]] : Object.values(hints);
    for (const block of selected) {
        if (!block || typeof block !== 'object') continue;
        for (const value of Object.values(block)) {
            if (typeof value === 'string' && value.trim()) values.push(value.trim());
        }
    }
    const out = [];
    for (const value of values) {
        if (typeof value !== 'string' || value.trim().length < 3) continue;
        const normalized = normalizeSubjectName(value);
        if (normalized && !out.some(item => normalizeSubjectName(item) === normalized)) out.push(value.trim());
    }
    return out;
}

function detectStyleLeak(prompt, forbiddenFragments) {
    const source = typeof prompt === 'string' ? prompt : '';
    const styleText = source.replace(STYLE_PROTECTED_RE, value => ' '.repeat(value.length));
    if (STYLE_LEAK_RE.test(styleText)) return true;
    const normalized = normalizeSubjectName(styleText);
    return (Array.isArray(forbiddenFragments) ? forbiddenFragments : [])
        .some(fragment => {
            const target = normalizeSubjectName(fragment);
            return target.length >= 5 && normalized.includes(target);
        });
}

/**
 * Validate one raw scene before compiler/backend handoff.
 * `allowedTokens` distinguishes required-token loss from undeclared additions.
 */
export function validateScenePrompt(prompt, catalog = [], {
    requiredTokens = [], allowedTokens = null, forbiddenFragments = [],
    forbidStyleLeak = true,
} = {}) {
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    const { tokens, unknown, nonCanonical } = extractSubjectTokens(text, catalog);
    const required = Array.isArray(requiredTokens) ? [...new Set(requiredTokens)] : [];
    const allowed = Array.isArray(allowedTokens) ? new Set(allowedTokens) : null;
    const missing = required.filter(token => !tokens.includes(token));
    const added = allowed ? tokens.filter(token => !allowed.has(token)) : [];
    const styleLeak = detectStyleLeak(text, forbiddenFragments);
    const ok = Boolean(text)
        && missing.length === 0
        && added.length === 0
        && unknown.length === 0
        && nonCanonical.length === 0
        && (!forbidStyleLeak || !styleLeak);
    return { ok, present: tokens, missing, added, unknown, nonCanonical, styleLeak, empty: !text };
}

/** Compare two token sets regardless of order. */
export function diffTokenSets(before = [], after = []) {
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    return {
        preserved: [...beforeSet].every(token => afterSet.has(token)) && beforeSet.size === afterSet.size,
        dropped: [...beforeSet].filter(token => !afterSet.has(token)),
        added: [...afterSet].filter(token => !beforeSet.has(token)),
    };
}
