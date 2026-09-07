// IF Image - Image record storage (IndexedDB).
// Uses the existing IMAGES store (created in idb.js v1, by_timestamp index).
// Does NOT bump DB_VERSION — the store and index already exist.

import { STORES, getAllItems, getItem, putItem, deleteItem } from './idb.js';

/**
 * Save a generation result as an image record.
 * The Blob is stored natively in IndexedDB.
 * @param {{ chatId, messageId, swipeId, occurrence, prompt, negative, params,
 *           backend, profileKey, seed, blob, width, height, content }} record
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
        backend: record.backend ?? '',
        profileKey: record.profileKey ?? '',
        seed: record.seed ?? -1,
        blob: record.blob,               // Blob stored directly
        width: record.width ?? 0,
        height: record.height ?? 0,
    };
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
