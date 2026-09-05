// IF Image - IndexedDB storage abstraction.
// Manages local persistence for chars, outfits, styles, personas, images.
// Does NOT touch extension_settings (kept lightweight for configuration).

const DB_NAME = 'IF_Image_DB';
const DB_VERSION = 1;

export const STORES = {
    CHARS: 'chars',
    OUTFITS: 'outfits',
    STYLES: 'styles',
    PERSONAS: 'personas',
    IMAGES: 'images',
};

let dbInstance = null;

/**
 * Opens or retrieves the singleton IndexedDB connection.
 * @returns {Promise<IDBDatabase>}
 */
export function getDB() {
    if (dbInstance) return Promise.resolve(dbInstance);

    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            return reject(new Error('IndexedDB is not available in this environment.'));
        }

        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            // Chars: id (UUID), name, aliases, bindings, meta
            if (!db.objectStoreNames.contains(STORES.CHARS)) {
                const charStore = db.createObjectStore(STORES.CHARS, { keyPath: 'id' });
                charStore.createIndex('by_name', 'name', { unique: false });
            }

            // Outfits: id (UUID), charId, name
            if (!db.objectStoreNames.contains(STORES.OUTFITS)) {
                const outfitStore = db.createObjectStore(STORES.OUTFITS, { keyPath: 'id' });
                outfitStore.createIndex('by_charId', 'charId', { unique: false });
            }

            // Styles: id (UUID), name
            if (!db.objectStoreNames.contains(STORES.STYLES)) {
                const styleStore = db.createObjectStore(STORES.STYLES, { keyPath: 'id' });
                styleStore.createIndex('by_name', 'name', { unique: false });
            }

            // Personas: id (UUID), name, isDefault
            if (!db.objectStoreNames.contains(STORES.PERSONAS)) {
                const personaStore = db.createObjectStore(STORES.PERSONAS, { keyPath: 'id' });
                personaStore.createIndex('by_name', 'name', { unique: false });
            }

            // Images: id (UUID/hash), timestamp, prompt, backend, blob
            if (!db.objectStoreNames.contains(STORES.IMAGES)) {
                const imgStore = db.createObjectStore(STORES.IMAGES, { keyPath: 'id' });
                imgStore.createIndex('by_timestamp', 'timestamp', { unique: false });
            }
        };

        request.onsuccess = (event) => {
            dbInstance = event.target.result;
            dbInstance.onversionchange = () => {
                dbInstance.close();
                dbInstance = null;
            };
            resolve(dbInstance);
        };

        request.onerror = (event) => {
            reject(new Error(`Failed to open IndexedDB: ${event.target.error?.message || 'unknown error'}`));
        };

        request.onblocked = () => {
            console.warn('[IF Image] IndexedDB upgrade blocked by open tabs.');
        };
    });
}

/**
 * Generic CRUD operations
 */
export async function getAllItems(storeName) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

export async function getItem(storeName, id) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

export async function putItem(storeName, item) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.put(item);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function deleteItem(storeName, id) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.delete(id);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

export async function clearStore(storeName) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.clear();
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}
