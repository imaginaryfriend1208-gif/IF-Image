// IF Image - Persona and Style store management.
// Follows PROMPT-SPEC §6 (Persona & POV) and §9 (Style presets).

import { STORES, getAllItems, getItem, putItem, deleteItem } from './idb.js';

export function createDefaultPersona(name = 'Default User') {
    return {
        id: crypto.randomUUID ? crypto.randomUUID() : 'persona_' + Date.now(),
        name,
        isDefault: true,
        gender: 'male',
        countTag: '1boy',
        povMode: 'auto', // auto | hidden | hands | full | third_person
        facts: '',
        booru: '',
        natural: '',
        avoidTags: [],
        autoSync: false,
        // Phase C5: last time syncPersonaFromSt() successfully applied. Manual
        // edits (meta.updatedAt newer than syncedAt) block the next auto-sync
        // from silently overwriting them — see applyPersonaSync() below.
        syncedAt: null,
        // Keyword triggers: when these appear in scene text, this persona is
        // auto-injected (like character aliases). $me always resolves to the
        // default persona regardless.
        aliases: [],
        // A1111 LoRA token, same role as a character's — a persona IS a
        // character, just flagged as the protagonist.
        lora: '',
        // Per-dialect style hints (like Style presets). Used when persona is
        // rendered in 'full' mode — e.g. persona's own krea/anima/illus
        // dialect fragments get merged into the prompt.
        dialectHints: {
            krea: { stylePhrase: '', lighting: '', camera: '' },
            anima: { booruTags: '', artists: '' },
            illus: { artists: '', qualityPrefix: '', negativeTags: '' },
        },
        meta: {
            version: 1,
            updatedAt: Date.now(),
        },
    };
}

/**
 * Merge an LLM-synced persona payload (from engine.syncPersonaFromSt) into
 * an existing persona record. Manual edits win: if the record was touched
 * (meta.updatedAt) more recently than the last sync (syncedAt), the merge
 * is skipped unless force=true.
 * @param {object} persona - existing (or newly created) persona record, mutated in place
 * @param {{ name?: string, countTag?: string, booru?: string, natural?: string }} synced
 * @param {boolean} [force]
 * @returns {{ applied: boolean, persona: object }}
 */
export function applyPersonaSync(persona, synced, force = false) {
    const manuallyEditedSinceSync = Boolean(persona.syncedAt) && (persona.meta?.updatedAt ?? 0) > persona.syncedAt;
    if (manuallyEditedSinceSync && !force) {
        return { applied: false, persona };
    }
    if (typeof synced?.name === 'string' && synced.name.trim()) persona.name = synced.name.trim();
    if (typeof synced?.countTag === 'string' && synced.countTag.trim()) persona.countTag = synced.countTag.trim();
    if (typeof synced?.booru === 'string') persona.booru = synced.booru;
    if (typeof synced?.natural === 'string') persona.natural = synced.natural;
    if (Array.isArray(synced?.aliases)) persona.aliases = synced.aliases.filter(a => typeof a === 'string' && a.trim());
    if (synced?.dialectHints && typeof synced.dialectHints === 'object') {
        persona.dialectHints = persona.dialectHints || {};
        for (const dialect of ['krea', 'anima', 'illus']) {
            const src = synced.dialectHints[dialect];
            if (src && typeof src === 'object') {
                persona.dialectHints[dialect] = { ...(persona.dialectHints[dialect] || {}), ...src };
            }
        }
    }
    persona.syncedAt = Date.now();
    return { applied: true, persona };
}

export function createDefaultStyle(name = 'New Style') {
    return {
        id: crypto.randomUUID ? crypto.randomUUID() : 'style_' + Date.now(),
        name,
        // A1111 LoRA token. Style LoRAs lead the final prompt, ahead of
        // character LoRAs (src/prompt/ordering.js: collectLoras).
        lora: '',
        dialectHints: {
            krea: {
                stylePhrase: '',
                lighting: '',
                camera: '',
            },
            anima: {
                booruTags: '',
                artists: '',
            },
            illus: {
                artists: '',
                qualityPrefix: '',
                negativeTags: '',
            },
        },
        meta: {
            version: 1,
            updatedAt: Date.now(),
        },
    };
}

export async function getAllPersonas() {
    return getAllItems(STORES.PERSONAS);
}

export async function savePersona(persona) {
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
