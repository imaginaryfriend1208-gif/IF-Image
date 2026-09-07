// IF Image - Image record storage (IndexedDB).
// Uses the existing IMAGES store (created in idb.js v1, by_timestamp index).
// Does NOT bump DB_VERSION — the store and index already exist.

import { STORES, getDB, getAllItems, getItem, putItem, deleteItem } from './idb.js';

/**
 * Save a generation result as an image record.
 * The Blob is stored natively in IndexedDB.
 *
 * R3: a record may instead be a LIGHT failure marker — status: 'failed',
 * a bounded sanitized `error` string, and NO blob — persisted so a failed
 * marker slot stays visible (failed chip + Retry) across chat revisits.
 * Gallery listing/counting skips blob-less records; getImagesForMessage
 * returns everything and callers filter.
 * @param {{ chatId, messageId, swipeId, occurrence, prompt, negative, params,
 *           backend, profileKey, checkpoint?, seed, blob?, width, height,
 *           content, status?, error? }} record
 * @returns {Promise<string>} the new record id
 */
export async function saveImageRecord(record) {
    const entry = {
        id: crypto.randomUUID ? crypto.randomUUID() : 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        timestamp: Date.now(),
        chatId: record.chatId,
        messageId: record.messageId,
        swipeId: record.swipeId ?? 0,
        occurrence: record.occurrence ?? 0,
        content: record.content ?? '',   // original marker text, for identity matching
        prompt: record.prompt ?? '',
        negative: record.negative ?? '',
        params: record.params ? { ...record.params } : {},
        // C8: per-character prompt strings (NAI captions); kept on the record
        // so a Gallery regeneration reproduces the multi-char payload.
        characters: Array.isArray(record.characters) ? [...record.characters] : [],
        backend: record.backend ?? '',
        profileKey: record.profileKey ?? '',
        // R2: checkpoint title used for this generation (a1111 backend);
        // undefined for backends without a checkpoint concept.
        checkpoint: typeof record.checkpoint === 'string' && record.checkpoint ? record.checkpoint : undefined,
        seed: record.seed ?? -1,
        blob: record.blob,               // Blob stored directly (absent on failure records)
        width: record.width ?? 0,
        height: record.height ?? 0,
    };
    // R3 failure-record fields (bounded, sanitized upstream).
    if (record.status === 'failed') {
        entry.status = 'failed';
        entry.error = typeof record.error === 'string' ? record.error.slice(0, 300) : '';
    }
    if (typeof record.id === 'string' && record.id) entry.id = record.id;
    await putItem(STORES.IMAGES, entry);
    return entry.id;
}

/**
 * Get all image records for a specific message, sorted newest first.
 * IndexedDB full-scan + JS filter: acceptable at Phase A scale.
 */
export async function getImagesForMessage(chatId, messageId, swipeId) {
    const all = await getAllItems(STORES.IMAGES);
    return all
        .filter(r => r.chatId === chatId && r.messageId === messageId && r.swipeId === swipeId)
        .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Get a single image record by id.
 */
export async function getImageRecord(id) {
    return getItem(STORES.IMAGES, id);
}

/**
 * Delete an image record by id.
 */
export async function deleteImageRecord(id) {
    return deleteItem(STORES.IMAGES, id);
}

// ------------------------------------------------------------------
// Phase C10: Gallery tab support. Object URLs are the CALLER's
// responsibility to create/revoke per page — records here carry the raw
// Blob only, never an eagerly-created object URL.
// ------------------------------------------------------------------

/**
 * List image records for the gallery, newest first, via the by_timestamp
 * index. Optionally scoped to one chat.
 * @param {{ chatId?: string, offset?: number, limit?: number }} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function listImages({ chatId, offset = 0, limit = 24 } = {}) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.IMAGES, 'readonly');
        const index = tx.objectStore(STORES.IMAGES).index('by_timestamp');
        const results = [];
        let skipped = 0;
        const request = index.openCursor(null, 'prev'); // descending timestamp = newest first
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor || results.length >= limit) {
                resolve(results);
                return;
            }
            const record = cursor.value;
            // R3: blob-less failure records never appear in the gallery.
            if (record.blob && (!chatId || record.chatId === chatId)) {
                if (skipped < offset) skipped += 1;
                else results.push(record);
            }
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    });
}

/**
 * Count image records, optionally scoped to one chat.
 * @param {{ chatId?: string }} [opts]
 * @returns {Promise<number>}
 */
export async function countImages({ chatId } = {}) {
    // R3: count only records with a blob — failure markers are invisible to
    // the gallery, so a plain store count() would overcount.
    const all = await getAllItems(STORES.IMAGES);
    return all.filter(r => r.blob && (!chatId || r.chatId === chatId)).length;
}
