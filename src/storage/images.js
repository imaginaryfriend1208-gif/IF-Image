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
    // D4: mark records whose prompt/params the user edited before generating.
    if (record.editedPrompt === true) entry.editedPrompt = true;
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

// ------------------------------------------------------------------
// D6: image cache management. Storage stats and pruning walk the
// by_timestamp cursor and touch blob.size only (Blobs are lazy handles in
// IndexedDB — .size never reads the bytes). Blob-less failure records are
// ignored by both stats and pruning.
// ------------------------------------------------------------------

const slotOf = (r) => `${r.chatId}|${r.messageId}|${r.swipeId}|${r.occurrence}`;

/** Cursor walk over the by_timestamp index (ascending = oldest first),
 *  collecting caller-projected values without keeping Blobs alive. */
function walkByTimestamp(project) {
    return getDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.IMAGES, 'readonly');
        const index = tx.objectStore(STORES.IMAGES).index('by_timestamp');
        const out = [];
        const request = index.openCursor(null, 'next');
        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor) { resolve(out); return; }
            const value = project(cursor.value);
            if (value !== undefined) out.push(value);
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
    }));
}

/**
 * Storage usage of blob-bearing image records.
 * @param {{ chatId?: string }} [opts]
 * @returns {Promise<{count: number, bytes: number}>}
 */
export async function getStorageStats({ chatId } = {}) {
    let count = 0;
    let bytes = 0;
    await walkByTimestamp((r) => {
        if (!r.blob || (chatId && r.chatId !== chatId)) return undefined;
        count += 1;
        bytes += r.blob.size ?? 0;
        return undefined; // stats only; collect nothing
    });
    return { count, bytes };
}

/**
 * Delete blob-bearing records oldest-first via by_timestamp:
 * - `olderThanMs`: everything older than now - olderThanMs is a candidate;
 * - `maxBytes`: after the TTL pass, keep deleting oldest records until the
 *   remaining total is within the budget;
 * - `chatId`: restrict both passes to one chat.
 * PROTECTION: a slot's (chatId+messageId+swipeId+occurrence) newest record is
 * never deleted when it is the only blob record left for that slot — every
 * generated marker keeps at least its latest image. Failure records are
 * untouched.
 * @param {{ olderThanMs?: number, maxBytes?: number, chatId?: string }} [opts]
 * @returns {Promise<{deleted: number, bytesFreed: number}>}
 */
export async function pruneImages({ olderThanMs, maxBytes, chatId } = {}) {
    // Oldest-first metadata snapshot (id/slot/timestamp/size only, no Blob).
    const rows = await walkByTimestamp((r) => {
        if (!r.blob || (chatId && r.chatId !== chatId)) return undefined;
        return { id: r.id, slot: slotOf(r), timestamp: r.timestamp ?? 0, size: r.blob.size ?? 0 };
    });
    const remainingPerSlot = new Map();
    for (const row of rows) remainingPerSlot.set(row.slot, (remainingPerSlot.get(row.slot) ?? 0) + 1);

    const cutoff = Number.isFinite(olderThanMs) && olderThanMs > 0 ? Date.now() - olderThanMs : null;
    let totalBytes = rows.reduce((sum, r) => sum + r.size, 0);
    const toDelete = [];
    const overBudget = () => Number.isFinite(maxBytes) && maxBytes > 0 && totalBytes > maxBytes;

    for (const row of rows) {
        const expired = cutoff !== null && row.timestamp < cutoff;
        if (!expired && !overBudget()) continue;
        // Protection: oldest-first means when this row is its slot's last
        // remaining record, it IS the slot's newest — keep it.
        if ((remainingPerSlot.get(row.slot) ?? 0) <= 1) continue;
        toDelete.push(row);
        remainingPerSlot.set(row.slot, remainingPerSlot.get(row.slot) - 1);
        totalBytes -= row.size;
    }

    let deleted = 0;
    let bytesFreed = 0;
    for (const row of toDelete) {
        await deleteItem(STORES.IMAGES, row.id);
        deleted += 1;
        bytesFreed += row.size;
    }
    return { deleted, bytesFreed };
}

/**
 * Re-encode an image Blob as JPEG at `quality` (1-100) using a canvas.
 * Returns the ORIGINAL blob when quality is out of range, the environment
 * lacks canvas facilities, or the JPEG did not come out smaller. Never
 * applied to already-stored records — only callers of saveImageRecord use
 * this on fresh blobs when settings.cache.jpegQuality > 0.
 * @param {Blob} blob
 * @param {number} quality - 1-100
 * @returns {Promise<Blob>}
 */
export async function toJpegBlob(blob, quality) {
    const q = Number(quality);
    if (!blob || !Number.isFinite(q) || q < 1 || q > 100) return blob;
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return blob;
    try {
        const bitmap = await createImageBitmap(blob);
        try {
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext('2d');
            // JPEG has no alpha: flatten onto white first.
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, bitmap.width, bitmap.height);
            ctx.drawImage(bitmap, 0, 0);
            const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: q / 100 });
            return jpeg && jpeg.size < blob.size ? jpeg : blob;
        } finally {
            bitmap.close?.();
        }
    } catch (err) {
        console.warn('[IF Image] JPEG conversion failed; keeping original:', err?.message ?? err);
        return blob;
    }
}
