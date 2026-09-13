// IF Image - Persona and Style store management.
// Follows PROMPT-SPEC §6 (Persona & POV) and §9 (Style presets).

import { STORES } from './idb.js';
import { claimUniqueKeyword, normalizeAliases, normalizeBinding, normalizeKeyword } from './entity-shape.js';
import { bindEntity, unbindEntity } from '../prompt/binding.js';
import { parseLoraLines, renderLoraToken } from '../prompt/ordering.js';

// Loaded only when persistence is used, keeping the pure schema/normalization
// helpers usable in non-SillyTavern tooling and tests.
const configStore = () => import('./config-store.js');
const getAllItems = async store => (await configStore()).getAllConfigItems(store);
const getItem = async (store, id) => (await configStore()).getConfigItem(store, id);
const putItem = async (store, item) => (await configStore()).putConfigItem(store, item);
const deleteItem = async (store, id) => (await configStore()).deleteConfigItem(store, id);

export function createDefaultPersona(name = 'Default User') {
    return {
        id: globalThis.crypto?.randomUUID?.() ?? `persona_${Date.now()}`,
        name,
        keyword: normalizeKeyword('', name, 'persona'),
        aliases: [],
        binding: { cardIds: [], chatIds: [], global: false },
        isDefault: true,
        gender: 'male', countTag: '1boy',
        povMode: 'auto',
        facts: '', booru: '', natural: '', avoidTags: [], lora: '',
        dialectHints: {
            krea: { stylePhrase: '', lighting: '', camera: '' },
            anima: { booruTags: '', artists: '' },
            illus: { artists: '', qualityPrefix: '', negativeTags: '' },
        },
        meta: { version: 1, updatedAt: Date.now() },
        presetVersion: PERSONA_CURRENT_VERSION,
    };
}

export const PERSONA_MIGRATORS = [
    (record, usedKeywords) => {
        record.aliases = normalizeAliases(record.aliases);
        record.binding = normalizeBinding(record.binding);
        delete record.bindings;
        delete record.autoSync;
        delete record.syncedAt;
        claimUniqueKeyword(record, usedKeywords, 'persona');
    },
];

export const PERSONA_CURRENT_VERSION = PERSONA_MIGRATORS.length;

export function applyPersonaMigrations(record, usedKeywords) {
    if (!record || typeof record !== 'object') return record;
    const from = Number.isInteger(record.presetVersion) && record.presetVersion >= 0 ? record.presetVersion : 0;
    for (let version = from; version < PERSONA_CURRENT_VERSION; version++) PERSONA_MIGRATORS[version](record, usedKeywords);
    record.aliases = normalizeAliases(record.aliases);
    record.binding = normalizeBinding(record.binding);
    delete record.bindings;
    delete record.autoSync;
    delete record.syncedAt;
    record.presetVersion = PERSONA_CURRENT_VERSION;
    return record;
}

/** Apply only a host-provided display name; visual fields stay user-authored. */
export function applyPersonaNameImport(persona, imported) {
    if (typeof imported?.name === 'string' && imported.name.trim()) persona.name = imported.name.trim();
    return { applied: true, persona };
}

// Compatibility export for older UI integrations; it now imports name only.
export const applyPersonaSync = applyPersonaNameImport;

export const STYLE_MIGRATORS = [record => {
    record.loras = parseLoraLines(record.lora);
    record.loraPosition = 'prompt_start';
    const binding = normalizeBinding(record.binding);
    record.binding = { cardIds: binding.cardIds, chatIds: binding.chatIds };
}];

export const STYLE_CURRENT_VERSION = STYLE_MIGRATORS.length;

export function applyStyleMigrations(record) {
    if (!record || typeof record !== 'object' || record.kind === 'replace_rules') return record;
    const from = Number.isInteger(record.presetVersion) && record.presetVersion >= 0
        ? Math.min(record.presetVersion, STYLE_CURRENT_VERSION) : 0;
    for (let version = from; version < STYLE_CURRENT_VERSION; version += 1) STYLE_MIGRATORS[version](record);
    record.loras = Array.isArray(record.loras) ? record.loras : [];
    record.loraPosition = ['prompt_start', 'prompt_end', 'style_end'].includes(record.loraPosition)
        ? record.loraPosition : 'prompt_start';
    const binding = normalizeBinding(record.binding);
    record.binding = { cardIds: binding.cardIds, chatIds: binding.chatIds };
    record.presetVersion = STYLE_CURRENT_VERSION;
    return record;
}

export function createDefaultStyle(name = 'New Style') {
    return {
        id: globalThis.crypto?.randomUUID?.() ?? `style_${Date.now()}`,
        name,
        lora: '',
        loras: [],
        loraPosition: 'prompt_start',
        binding: { cardIds: [], chatIds: [] },
        dialectHints: {
            krea: { stylePhrase: '', lighting: '', camera: '' },
            anima: { booruTags: '', artists: '' },
            illus: { artists: '', qualityPrefix: '', negativeTags: '' },
        },
        meta: { version: 1, updatedAt: Date.now() },
        presetVersion: STYLE_CURRENT_VERSION,
    };
}

export function bindStyle(style, scope, id) {
    return applyStyleMigrations(bindEntity(applyStyleMigrations({ ...style }), scope, id));
}

export function unbindStyle(style, scope, id) {
    return applyStyleMigrations(unbindEntity(applyStyleMigrations({ ...style }), scope, id));
}

export async function getAllPersonas() {
    const used = new Set();
    return (await getAllItems(STORES.PERSONAS)).map(record => applyPersonaMigrations(record, used));
}

export async function savePersona(persona) {
    if (!persona || typeof persona !== 'object') throw new TypeError('Persona record is required.');
    const all = await getAllItems(STORES.PERSONAS);
    const used = new Set(all.filter(item => item?.id !== persona.id).map(item => normalizeKeyword(item?.keyword, item?.name, 'persona')));
    applyPersonaMigrations(persona, used);
    persona.meta = persona.meta || {};
    persona.meta.updatedAt = Date.now();
    return putItem(STORES.PERSONAS, persona);
}

export async function removePersona(id) {
    return deleteItem(STORES.PERSONAS, id);
}

export async function getAllStyles() {
    const all = await getAllItems(STORES.STYLES);
    // Exclude the Phase C7 replace-rules singleton (see getReplaceRules
    // below) — it piggybacks the styles store to avoid a DB version bump,
    // and must never appear as a selectable style.
    return all.filter(s => s.kind !== 'replace_rules');
}

export async function saveStyle(style) {
    style.meta = style.meta || {};
    style.meta.updatedAt = Date.now();
    return putItem(STORES.STYLES, style);
}

export async function removeStyle(id) {
    return deleteItem(STORES.STYLES, id);
}

// ------------------------------------------------------------------
// Phase C7: replace rules. Settings (extension_settings) are off-limits
// for this feature per spec, and adding a dedicated IndexedDB store would
// require a version bump — so the rule list is stored as a single record
// in the EXISTING styles store, discriminated by kind: 'replace_rules'.
// ------------------------------------------------------------------
const REPLACE_RULES_ID = 'if_image_replace_rules_singleton';

/** @returns {Promise<Array<object>>} the current rule list (empty if none saved yet). */
export async function getReplaceRules() {
    const record = await getItem(STORES.STYLES, REPLACE_RULES_ID);
    return Array.isArray(record?.rules) ? record.rules : [];
}

/** Persist the full rule list (replaces the previous set). */
export async function saveReplaceRules(rules) {
    return putItem(STORES.STYLES, {
        id: REPLACE_RULES_ID,
        kind: 'replace_rules',
        rules: Array.isArray(rules) ? rules : [],
        meta: { updatedAt: Date.now() },
    });
}
