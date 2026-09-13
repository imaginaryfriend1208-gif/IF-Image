// IF Image - Preset export/import (D7). PURE module: no IndexedDB, no DOM,
// no settings access — callers pass collections in and persist the plan out.
// The export format carries roster/preset data ONLY; connection data (URLs,
// auth, keys) and discovery caches are structurally excluded, and a deep
// sanitizer strips any forbidden key defensively before serialization.

import { normalizeAliases as normalizeEntityAliases, normalizeKeyword as normalizeEntityKeyword } from './entity-shape.js';

export const PRESET_FORMAT = 'ifimage-preset';
export const PRESET_VERSION = 1;

// Keys that must NEVER appear anywhere in an export, at any depth.
const FORBIDDEN_KEYS = new Set([
    'auth', 'authorization', 'apiKey', 'api_key', 'password', 'token', 'secret',
    'baseUrl', 'discovery',
]);



// Portable single-entity document. Kept separate from the bulk preset format
// so one Character/Persona can be shared without connection or chat state.
export const ENTITY_FORMAT = 'ifimage-entity';
export const ENTITY_VERSION = 1;
const ENTITY_KINDS = new Set(['character', 'persona']);

function newEntityId(kind, usedIds) {
    const prefix = kind === 'persona' ? 'persona' : 'char';
    let id;
    do {
        id = globalThis.crypto?.randomUUID?.()
            ?? `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    } while (usedIds.has(id));
    return id;
}

/** Build a credential-free, portable document for one Character or Persona. */
export function buildEntityExport(kind, record) {
    if (!ENTITY_KINDS.has(kind)) throw new TypeError('Entity kind must be character or persona.');
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new TypeError('Entity record must be an object.');
    }
    return sanitize({ format: ENTITY_FORMAT, version: ENTITY_VERSION, kind, entity: record });
}

/** Validate a parsed single-entity document without mutating it. */
export function validateEntityImport(document) {
    const errors = [];
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
        return { ok: false, errors: ['Import must be a JSON object.'] };
    }
    if (document.format !== ENTITY_FORMAT) errors.push(`format must be "${ENTITY_FORMAT}".`);
    if (document.version !== ENTITY_VERSION) errors.push(`version must be ${ENTITY_VERSION}.`);
    if (!ENTITY_KINDS.has(document.kind)) errors.push('kind must be character or persona.');
    if (!document.entity || typeof document.entity !== 'object' || Array.isArray(document.entity)) {
        errors.push('entity must be an object.');
    } else if (typeof document.entity.name !== 'string' || !document.entity.name.trim()) {
        errors.push('entity.name must be a non-empty string.');
    }
    return { ok: errors.length === 0, errors };
}

/**
 * Prepare one imported entity for persistence.
 * - keeps portable cardIds (avatar filenames);
 * - clears machine-local chatIds/global;
 * - normalizes keyword/aliases;
 * - assigns a new id only when the incoming id collides.
 */
export function prepareEntityImport(document, { existing = [], idFactory } = {}) {
    const validation = validateEntityImport(document);
    if (!validation.ok) throw new TypeError(validation.errors.join(' '));

    const record = sanitize(document.entity);
    const ids = new Set((Array.isArray(existing) ? existing : [])
        .map(item => item?.id).filter(id => typeof id === 'string' && id));
    if (typeof record.id !== 'string' || !record.id || ids.has(record.id)) {
        record.id = typeof idFactory === 'function' ? idFactory() : newEntityId(document.kind, ids);
        if (typeof record.id !== 'string' || !record.id || ids.has(record.id)) {
            throw new TypeError('Imported entity id factory must return a unique non-empty string.');
        }
    }

    const binding = record.binding && typeof record.binding === 'object' ? record.binding : {};
    const legacyCardIds = typeof binding.cardId === 'string' && binding.cardId ? [binding.cardId] : [];
    const sourceCardIds = Array.isArray(binding.cardIds) ? binding.cardIds : legacyCardIds;
    record.binding = {
        cardIds: [...new Set(sourceCardIds.filter(id => typeof id === 'string' && id))],
        chatIds: [],
        global: false,
    };
    record.aliases = normalizeEntityAliases(record.aliases);
    const usedKeywords = new Set((Array.isArray(existing) ? existing : [])
        .map(item => normalizeEntityKeyword(item?.keyword, item?.name, ''))
        .filter(Boolean));
    const baseKeyword = normalizeEntityKeyword(record.keyword, record.name, document.kind);
    let keyword = baseKeyword;
    let suffix = 2;
    while (usedKeywords.has(keyword)) keyword = `${baseKeyword}${suffix++}`;
    record.keyword = keyword;
    return record;
}

/** Collection names carried by the format, in a stable order. */
export const PRESET_COLLECTIONS = ['characters', 'outfits', 'styles', 'personas', 'replaceRules', 'checkpointProfiles'];

/**
 * Deep-clone `value` while dropping every forbidden key (case-sensitive,
 * exactly the names in FORBIDDEN_KEYS) at any depth. Arrays are cloned
 * per-element; primitives pass through. Blobs/functions are dropped —
 * presets are plain JSON data.
 */
function sanitize(value) {
    if (Array.isArray(value)) return value.map(sanitize).filter(v => v !== undefined);
    if (value === null || typeof value !== 'object') {
        return typeof value === 'function' ? undefined : value;
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) return undefined;
    const out = {};
    for (const [key, v] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        const clean = sanitize(v);
        if (clean !== undefined) out[key] = clean;
    }
    return out;
}

/**
 * Build a portable preset export.
 * @param {{ characters?: Array, outfits?: Array, styles?: Array,
 *           personas?: Array, replaceRules?: Array,
 *           checkpointProfiles?: object }} collections
 * @returns {object} JSON-serializable export document
 */
export function buildExport({ characters = [], outfits = [], styles = [], personas = [], replaceRules = [], checkpointProfiles = {} } = {}) {
    return {
        format: PRESET_FORMAT,
        version: PRESET_VERSION,
        exportedAt: new Date().toISOString(),
        characters: sanitize(characters),
        outfits: sanitize(outfits),
        styles: sanitize(styles),
        personas: sanitize(personas),
        replaceRules: sanitize(replaceRules),
        checkpointProfiles: sanitize(checkpointProfiles),
    };
}

/**
 * Validate a parsed import document. Never throws.
 * @param {unknown} json
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateImport(json) {
    const errors = [];
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return { ok: false, errors: ['Not a JSON object.'] };
    }
    if (json.format !== PRESET_FORMAT) {
        errors.push(`Unknown format ${JSON.stringify(json.format ?? null)} (expected "${PRESET_FORMAT}").`);
    }
    if (json.version !== PRESET_VERSION) {
        errors.push(`Unsupported version ${JSON.stringify(json.version ?? null)} (expected ${PRESET_VERSION}).`);
    }
    for (const name of ['characters', 'outfits', 'styles', 'personas', 'replaceRules']) {
        const value = json[name];
        if (value === undefined) continue; // absent collection = empty
        if (!Array.isArray(value)) {
            errors.push(`"${name}" must be an array.`);
            continue;
        }
        value.forEach((item, i) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                errors.push(`${name}[${i}] is not an object.`);
                return;
            }
            if (name === 'replaceRules') {
                if (typeof item.trigger !== 'string' || !item.trigger.trim()) {
                    errors.push(`${name}[${i}] is missing a "trigger" string.`);
                }
            } else if (typeof item.name !== 'string' || !item.name.trim()) {
                errors.push(`${name}[${i}] is missing a "name" string.`);
            }
        });
    }
    if (json.checkpointProfiles !== undefined
        && (typeof json.checkpointProfiles !== 'object' || json.checkpointProfiles === null || Array.isArray(json.checkpointProfiles))) {
        errors.push('"checkpointProfiles" must be an object keyed by checkpoint title.');
    }
    return { ok: errors.length === 0, errors };
}

const normName = (s) => String(s ?? '').trim().toLowerCase();

/** Identity for list records: id when both sides have one, else name. */
function matchExisting(existingList, item) {
    return existingList.find(e =>
        (item.id && e.id && e.id === item.id)
        || (item.name && normName(e.name) === normName(item.name)));
}

/**
 * Plan a merge of an incoming preset into existing collections. Pure: the
 * caller persists plan.add/plan.overwrite entries itself (characters via
 * applyCharMigrations first).
 * - list collections match by id, else case-insensitive name;
 *   replaceRules match by trigger;
 * - checkpointProfiles is an object keyed by checkpoint title.
 * - mode 'keep-mine': conflicts are skipped; 'overwrite': incoming wins.
 * Overwrites preserve the EXISTING record's id so references (outfit
 * charIds, character outfit lists) stay intact where they pointed.
 * @param {object} existing - { characters, outfits, styles, personas, replaceRules, checkpointProfiles }
 * @param {object} incoming - validated import document (same collection names)
 * @param {'keep-mine'|'overwrite'} mode
 * @returns {object} per-collection { add: [], overwrite: [], skip: [] }
 */
export function planMerge(existing = {}, incoming = {}, mode = 'keep-mine') {
    const overwriteWins = mode === 'overwrite';
    const plan = {};

    for (const name of ['characters', 'outfits', 'styles', 'personas']) {
        const have = Array.isArray(existing[name]) ? existing[name] : [];
        const want = Array.isArray(incoming[name]) ? incoming[name] : [];
        const add = [];
        const overwrite = [];
        const skip = [];
        for (const item of want) {
            const match = matchExisting(have, item);
            if (!match) add.push(item);
            else if (overwriteWins) overwrite.push({ ...item, id: match.id });
            else skip.push(item);
        }
        plan[name] = { add, overwrite, skip };
    }

    {
        const have = Array.isArray(existing.replaceRules) ? existing.replaceRules : [];
        const want = Array.isArray(incoming.replaceRules) ? incoming.replaceRules : [];
        const triggers = new Set(have.map(r => normName(r.trigger)));
        const add = [];
        const overwrite = [];
        const skip = [];
        for (const rule of want) {
            if (!triggers.has(normName(rule.trigger))) add.push(rule);
            else if (overwriteWins) overwrite.push(rule);
            else skip.push(rule);
        }
        plan.replaceRules = { add, overwrite, skip };
    }

    {
        const have = existing.checkpointProfiles && typeof existing.checkpointProfiles === 'object' ? existing.checkpointProfiles : {};
        const want = incoming.checkpointProfiles && typeof incoming.checkpointProfiles === 'object' ? incoming.checkpointProfiles : {};
        const add = [];
        const overwrite = [];
        const skip = [];
        for (const [title, entry] of Object.entries(want)) {
            const record = { title, entry };
            if (!(title in have)) add.push(record);
            else if (overwriteWins) overwrite.push(record);
            else skip.push(record);
        }
        plan.checkpointProfiles = { add, overwrite, skip };
    }

    return plan;
}
