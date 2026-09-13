// IF Image - Character records stored in extension settings.

import { STORES } from './idb.js';
import { claimUniqueKeyword, normalizeAliases, normalizeBinding, normalizeKeyword } from './entity-shape.js';

const configStore = () => import('./config-store.js');
const getAllItems = async store => (await configStore()).getAllConfigItems(store);
const getItem = async (store, id) => (await configStore()).getConfigItem(store, id);
const putItem = async (store, item) => (await configStore()).putConfigItem(store, item);
const deleteItem = async (store, id) => (await configStore()).deleteConfigItem(store, id);

export { normalizeAliases, normalizeKeyword };

export function emptyBooruDetail() {
    return {
        face: { sfw: { front: '', back: '' }, nsfw: { front: '', back: '' } },
        upper: { sfw: { front: '', back: '' }, nsfw: { front: '', back: '' } },
        lower: { sfw: { front: '', back: '' }, nsfw: { front: '', back: '' } },
    };
}

export function createDefaultCharacter(name = 'New Character') {
    return {
        id: globalThis.crypto?.randomUUID?.() ?? `char_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        keyword: normalizeKeyword('', name, 'character'),
        aliases: [],
        countTag: '1girl', facts: '', booru: '', natural: '',
        views: { front: '', back: '', side: '' },
        booruDetail: emptyBooruDetail(), nsfwExtra: '', negative: '', lora: '', outfits: [],
        binding: { cardIds: [], chatIds: [], global: false },
        lock: { seed: -1, params: null },
        meta: { version: 1, createdAt: Date.now(), updatedAt: Date.now(), createdBy: 'user' },
        presetVersion: CHAR_CURRENT_VERSION,
    };
}

/** Import only the host display name and stable avatar filename. */
export function createCharacterFromStCard(stChar) {
    if (!stChar || typeof stChar !== 'object') throw new TypeError('A SillyTavern character card is required.');
    const name = typeof stChar.name === 'string' && stChar.name.trim() ? stChar.name.trim() : 'New Character';
    const character = createDefaultCharacter(name);
    const avatar = typeof stChar.avatar === 'string' && stChar.avatar ? stChar.avatar : '';
    character.binding = { cardIds: avatar ? [avatar] : [], chatIds: [], global: false };
    return character;
}

export function findCharacterByCardId(characters, cardId) {
    if (!Array.isArray(characters) || typeof cardId !== 'string' || !cardId) return null;
    return characters.find(character => Array.isArray(character?.binding?.cardIds)
        && character.binding.cardIds.includes(cardId)) ?? null;
}

export function getStCharacters(ctx) {
    const characters = ctx?.characters;
    if (Array.isArray(characters)) return characters.filter(value => value && typeof value === 'object');
    if (characters && typeof characters === 'object') return Object.values(characters).filter(value => value && typeof value === 'object');
    return [];
}

export const CHAR_MIGRATORS = [
    (record) => {
        if (!record.booruDetail || typeof record.booruDetail !== 'object') record.booruDetail = emptyBooruDetail();
        const empty = emptyBooruDetail();
        for (const region of Object.keys(empty)) {
            if (!record.booruDetail[region] || typeof record.booruDetail[region] !== 'object') record.booruDetail[region] = {};
            for (const rating of Object.keys(empty[region])) {
                if (!record.booruDetail[region][rating] || typeof record.booruDetail[region][rating] !== 'object') record.booruDetail[region][rating] = {};
                for (const view of Object.keys(empty[region][rating])) {
                    if (typeof record.booruDetail[region][rating][view] !== 'string') record.booruDetail[region][rating][view] = '';
                }
            }
        }
        if (!Array.isArray(record.outfits)) record.outfits = [];
        if (!record.lock || typeof record.lock !== 'object') record.lock = { seed: -1, params: null };
        if (typeof record.negative !== 'string') record.negative = '';
    },
    (record, usedKeywords) => {
        record.aliases = normalizeAliases(record.aliases);
        record.binding = normalizeBinding(record.binding);
        delete record.binding.cardId;
        delete record.bindings;
        claimUniqueKeyword(record, usedKeywords, 'character');
    },
];

export const CHAR_CURRENT_VERSION = CHAR_MIGRATORS.length;

export function applyCharMigrations(record, usedKeywords) {
    if (!record || typeof record !== 'object') return record;
    const from = Number.isInteger(record.presetVersion) && record.presetVersion >= 0 ? record.presetVersion : 0;
    for (let version = from; version < CHAR_CURRENT_VERSION; version++) CHAR_MIGRATORS[version](record, usedKeywords);
    // Normalize current-version records too; malformed imported data must not bypass invariants.
    record.aliases = normalizeAliases(record.aliases);
    record.binding = normalizeBinding(record.binding);
    delete record.bindings;
    record.presetVersion = CHAR_CURRENT_VERSION;
    return record;
}

export async function getAllCharacters() {
    const used = new Set();
    return (await getAllItems(STORES.CHARS)).map(record => applyCharMigrations(record, used));
}

export async function getCharacter(id) {
    const record = await getItem(STORES.CHARS, id);
    if (!record) return record;
    const raw = await getAllItems(STORES.CHARS);
    const used = new Set(raw
        .filter(item => item?.id !== id)
        .map(item => normalizeKeyword(item?.keyword, item?.name, 'character')));
    return applyCharMigrations(record, used);
}

export async function saveCharacter(record) {
    if (!record || typeof record !== 'object') throw new TypeError('Character record is required.');
    const all = await getAllItems(STORES.CHARS);
    const used = new Set(all.filter(item => item?.id !== record.id).map(item => normalizeKeyword(item?.keyword, item?.name, 'character')));
    applyCharMigrations(record, used);
    record.meta = record.meta || {};
    record.meta.updatedAt = Date.now();
    return putItem(STORES.CHARS, record);
}

export async function removeCharacter(id) { return deleteItem(STORES.CHARS, id); }
