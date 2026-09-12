// Small, user-authored IF Image records live in SillyTavern's canonical
// extension_settings payload. Generated image blobs remain in IndexedDB.
import { getSettings, saveSettings } from '../settings.js';
import { STORES, getAllItems } from './idb.js';

const COLLECTIONS = Object.freeze({
    [STORES.CHARS]: 'characters',
    [STORES.OUTFITS]: 'outfits',
    [STORES.STYLES]: 'styles',
    [STORES.PERSONAS]: 'personas',
});

let migrationPromise = null;

function announceChange(store) {
    globalThis.dispatchEvent?.(new CustomEvent('if-image:data-changed', { detail: { store } }));
}

function dataRoot() {
    const settings = getSettings();
    if (!settings.data || typeof settings.data !== 'object') settings.data = {};
    for (const key of Object.values(COLLECTIONS)) {
        if (!Array.isArray(settings.data[key])) settings.data[key] = [];
    }
    return settings.data;
}

async function migrateLegacyOnce() {
    const settings = getSettings();
    const data = dataRoot();
    if (settings.dataMigration?.indexedDbImported) return;

    let changed = false;
    let complete = typeof indexedDB !== 'undefined';
    // Import only into empty canonical collections. This makes an interrupted
    // migration retryable without replacing newer server-backed settings.
    if (complete) {
        for (const [store, key] of Object.entries(COLLECTIONS)) {
            if (data[key].length) continue;
            try {
                const legacy = await getAllItems(store);
                if (legacy.length) {
                    data[key] = structuredClone(legacy);
                    changed = true;
                }
            } catch (err) {
                complete = false;
                console.warn(`[IF Image] Legacy ${store} migration skipped:`, err?.message ?? err);
            }
        }
    }
    // Never stamp a partial/failed read as complete; the next load must retry.
    if (!complete) return;
    settings.dataMigration = { ...(settings.dataMigration || {}), indexedDbImported: true, importedAt: Date.now() };
    saveSettings();
    if (changed) console.info('[IF Image] Migrated preset data from IndexedDB to extension_settings.IF_Image.data.');
}

async function ready() {
    migrationPromise ??= migrateLegacyOnce();
    await migrationPromise;
}

function collection(store) {
    const key = COLLECTIONS[store];
    if (!key) throw new Error(`Unsupported settings collection: ${store}`);
    return dataRoot()[key];
}

export async function getAllConfigItems(store) {
    await ready();
    return structuredClone(collection(store));
}

export async function getConfigItem(store, id) {
    await ready();
    const item = collection(store).find(record => record?.id === id);
    return item ? structuredClone(item) : null;
}

export async function putConfigItem(store, item) {
    await ready();
    if (!item || typeof item !== 'object' || !item.id) throw new TypeError('Stored record requires an id.');
    const records = collection(store);
    const copy = structuredClone(item);
    const index = records.findIndex(record => record?.id === copy.id);
    if (index >= 0) records[index] = copy;
    else records.push(copy);
    saveSettings();
    return copy.id;
}

export async function deleteConfigItem(store, id) {
    await ready();
    const records = collection(store);
    const index = records.findIndex(record => record?.id === id);
    if (index < 0) return false;
    records.splice(index, 1);
    saveSettings();
    return true;
}
