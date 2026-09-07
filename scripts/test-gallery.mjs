#!/usr/bin/env node
// IF Image - gallery storage tests (Phase C10): listImages/countImages
// against a minimal in-memory IndexedDB stub (no real browser, no deps).
// Run: node scripts/test-gallery.mjs

import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.message}`);
        failed++;
    }
}

console.log('Gallery storage tests');

// ------------------------------------------------------------------
// Minimal fake IndexedDB: just enough surface for src/storage/idb.js's
// getDB() and images.js's listImages()/countImages()/saveImageRecord() —
// one object store, one 'by_timestamp' index, cursor iteration in both
// directions, count(), put()/get()/delete()/getAll(). Not a general IDB
// polyfill; every unused branch has been deliberately left out.
// ------------------------------------------------------------------
function installFakeIndexedDB() {
    const store = new Map();

    function sortedByTimestamp() {
        return Array.from(store.values()).sort((a, b) => a.timestamp - b.timestamp);
    }

    const index = {
        openCursor(range, direction) {
            const req = { onsuccess: null, onerror: null, result: null };
            let items = sortedByTimestamp();
            if (direction === 'prev') items = items.reverse();
            let i = 0;
            const step = () => {
                if (i >= items.length) {
                    req.result = null;
                    req.onsuccess?.({ target: req });
                    return;
                }
                const value = items[i];
                req.result = { value, continue: () => { i += 1; queueMicrotask(step); } };
                req.onsuccess?.({ target: req });
            };
            queueMicrotask(step);
            return req;
        },
    };

    const objectStore = {
        index: () => index,
        count: () => {
            const req = { onsuccess: null, onerror: null };
            queueMicrotask(() => { req.result = store.size; req.onsuccess?.({ target: req }); });
            return req;
        },
        put: (value) => {
            const req = { onsuccess: null, onerror: null };
            store.set(value.id, value);
            queueMicrotask(() => { req.result = value.id; req.onsuccess?.({ target: req }); });
            return req;
        },
        get: (id) => {
            const req = { onsuccess: null, onerror: null };
            queueMicrotask(() => { req.result = store.get(id) ?? null; req.onsuccess?.({ target: req }); });
            return req;
        },
        delete: (id) => {
            const req = { onsuccess: null, onerror: null };
            store.delete(id);
            queueMicrotask(() => req.onsuccess?.({ target: req }));
            return req;
        },
        getAll: () => {
            const req = { onsuccess: null, onerror: null };
            queueMicrotask(() => { req.result = Array.from(store.values()); req.onsuccess?.({ target: req }); });
            return req;
        },
    };

    const fakeDb = {
        transaction: () => ({ objectStore: () => objectStore }),
        objectStoreNames: { contains: () => true },
        set onversionchange(_fn) { /* no-op: never fires in this stub */ },
    };

    global.indexedDB = {
        open: () => {
            const req = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
            queueMicrotask(() => { req.result = fakeDb; req.onsuccess?.({ target: req }); });
            return req;
        },
    };

    return store;
}

const store = installFakeIndexedDB();
// Import AFTER installing the fake global — idb.js's getDB() lazily reads
// `indexedDB` only when first called, so import order here doesn't matter
// in practice, but this keeps the setup obviously correct either way.
const { saveImageRecord, listImages, countImages, getImageRecord, deleteImageRecord } = await import('../src/storage/images.js');

function makeRecord(overrides = {}) {
    return {
        chatId: 'chat-1', messageId: 0, swipeId: 0, occurrence: 0,
        content: 'a scene', prompt: 'a scene', negative: '', params: {},
        backend: 'nai', profileKey: 'anima', seed: 1, blob: new Blob(['x']),
        width: 832, height: 1216,
        ...overrides,
    };
}

// Seed records with distinct timestamps by saving sequentially (each
// saveImageRecord() call stamps Date.now(); to guarantee strict ordering
// under fast test execution, timestamps are patched directly afterward).
const ids = [];
for (let i = 0; i < 5; i++) {
    const id = await saveImageRecord(makeRecord({ chatId: i % 2 === 0 ? 'chat-1' : 'chat-2' }));
    ids.push(id);
}
// Patch timestamps to a known increasing sequence (id[0] oldest, id[4] newest).
ids.forEach((id, i) => { store.get(id).timestamp = 1000 + i; });

await test('listImages returns records newest-first', async () => {
    const results = await listImages({ limit: 10 });
    assert.equal(results.length, 5);
    assert.deepEqual(results.map(r => r.id), [...ids].reverse());
});

await test('listImages respects the chatId filter', async () => {
    const results = await listImages({ chatId: 'chat-1', limit: 10 });
    assert.ok(results.every(r => r.chatId === 'chat-1'));
    assert.equal(results.length, 3); // indices 0, 2, 4
});

await test('listImages paginates with offset/limit', async () => {
    const page1 = await listImages({ limit: 2 });
    const page2 = await listImages({ offset: 2, limit: 2 });
    assert.equal(page1.length, 2);
    assert.equal(page2.length, 2);
    assert.notEqual(page1[0].id, page2[0].id);
    assert.equal(page1[1].id, ids[4 - 1]); // second-newest
});

await test('listImages never eagerly attaches an object URL', async () => {
    const results = await listImages({ limit: 1 });
    assert.ok(!('objectUrl' in results[0]));
    assert.ok(results[0].blob instanceof Blob);
});

await test('countImages counts all records with no filter', async () => {
    assert.equal(await countImages({}), 5);
});

await test('countImages scopes to a chat when chatId is given', async () => {
    assert.equal(await countImages({ chatId: 'chat-2' }), 2);
});

await test('deleteImageRecord removes a record from subsequent listImages calls', async () => {
    await deleteImageRecord(ids[0]);
    const results = await listImages({ limit: 10 });
    assert.equal(results.length, 4);
    assert.ok(!results.some(r => r.id === ids[0]));
    assert.equal(await getImageRecord(ids[0]), null);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
