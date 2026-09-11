#!/usr/bin/env node
// IF Image - per-user roster sync contract.
//
// These tests encode constraints read out of the SillyTavern source, not
// guesses. If ST changes them, these fail loudly instead of the extension
// silently losing a roster:
//   src/endpoints/assets.js  validateAssetFileName() -> no '/', no leading '.'
//   src/endpoints/files.js   /upload /delete /verify
//   src/users.js:1081        GET /user/files/*
//
// Run: node scripts/test-server-sync.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ROSTER_FILENAME, ROSTER_FORMAT, ROSTER_VERSION,
    validateRosterFilename, utf8ToBase64, buildRosterPayload, validateRosterPayload,
    uploadRoster, downloadRoster, rosterExists, deleteRoster, ServerSyncError,
} from '../src/storage/server-sync.js';

// btoa/atob are not globals in older Node; TextEncoder is. Provide only what
// is missing so the module under test runs unmodified.
if (typeof globalThis.btoa !== 'function') {
    globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}

const headers = () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 't' });

/** Minimal fetch double that records calls. */
function makeFetch(handler) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
        return handler(url, init, calls.length - 1);
    };
    fn.calls = calls;
    return fn;
}

const okJson = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
const okText = (text) => ({ ok: true, status: 200, text: async () => text });
const status = (code, text = '') => ({ ok: false, status: code, text: async () => text });

// ------------------------------------------------------------- filename ---

test('the default roster filename is accepted by ST rules', () => {
    assert.equal(validateRosterFilename(ROSTER_FILENAME).ok, true);
});

test('subdirectories are rejected — the endpoint cannot create them', () => {
    const res = validateRosterFilename('ifimage/roster.json');
    assert.equal(res.ok, false);
    assert.match(res.error, /subdirector/i);
});

test('a dotfile is rejected, matching validateAssetFileName', () => {
    assert.equal(validateRosterFilename('.ifimage-roster.json').ok, false);
});

test('forbidden extensions are rejected before a request is spent', () => {
    for (const name of ['roster.js', 'roster.html', 'roster.sh', 'roster.exe']) {
        assert.equal(validateRosterFilename(name).ok, false, name);
    }
});

test('an empty or non-string filename is rejected without throwing', () => {
    for (const value of ['', null, undefined, 42]) {
        assert.equal(validateRosterFilename(value).ok, false, String(value));
    }
});

// --------------------------------------------------------------- base64 ---

test('non-Latin-1 text survives base64 — plain btoa would throw here', () => {
    const text = 'Lyna · đồ ngủ · 日本語 · 🎨';
    const decoded = Buffer.from(utf8ToBase64(text), 'base64').toString('utf8');
    assert.equal(decoded, text);
});

test('a large payload does not exceed the fromCharCode argument limit', () => {
    const big = 'á'.repeat(200000); // 400k UTF-8 bytes
    assert.doesNotThrow(() => utf8ToBase64(big));
    assert.equal(Buffer.from(utf8ToBase64(big), 'base64').toString('utf8'), big);
});

test('empty and nullish input encode to an empty string', () => {
    for (const value of ['', null, undefined]) assert.equal(utf8ToBase64(value), '');
});

// -------------------------------------------------------------- payload ---

test('buildRosterPayload stamps the envelope and defaults every collection', () => {
    const payload = buildRosterPayload({});
    assert.equal(payload.format, ROSTER_FORMAT);
    assert.equal(payload.version, ROSTER_VERSION);
    assert.ok(Date.parse(payload.savedAt) > 0);
    for (const name of ['characters', 'outfits', 'styles', 'personas', 'replaceRules']) {
        assert.deepEqual(payload[name], [], name);
    }
});

test('buildRosterPayload coerces a non-array collection instead of storing junk', () => {
    const payload = buildRosterPayload({ characters: 'nope', outfits: null });
    assert.deepEqual(payload.characters, []);
    assert.deepEqual(payload.outfits, []);
});

test('validateRosterPayload accepts a well-formed envelope', () => {
    assert.equal(validateRosterPayload(buildRosterPayload({ characters: [{ id: 'c1' }] })).ok, true);
});

test('validateRosterPayload rejects a foreign format or version', () => {
    assert.equal(validateRosterPayload({ format: 'other', version: 1 }).ok, false);
    assert.equal(validateRosterPayload({ format: ROSTER_FORMAT, version: 99 }).ok, false);
});

test('validateRosterPayload never throws on hostile input', () => {
    for (const value of [null, undefined, 42, 'text', []]) {
        assert.equal(validateRosterPayload(value).ok, false, String(value));
    }
});

// --------------------------------------------------------------- upload ---

test('uploadRoster posts the ST body shape to /api/files/upload', async () => {
    const fetchFn = makeFetch(() => okJson({ path: 'user/files/ifimage-roster-v1.json' }));
    const res = await uploadRoster({ characters: [{ id: 'c1' }] },
        { fetch: fetchFn, getRequestHeaders: headers });

    const call = fetchFn.calls[0];
    assert.equal(call.url, '/api/files/upload');
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(Object.keys(call.body).sort(), ['data', 'name']);
    assert.equal(call.body.name, ROSTER_FILENAME);
    assert.equal(res.path, 'user/files/ifimage-roster-v1.json');
    assert.ok(res.bytes > 0);
});

test('the uploaded payload round-trips through base64 intact', async () => {
    const fetchFn = makeFetch(() => okJson({ path: 'user/files/x.json' }));
    await uploadRoster({ characters: [{ id: 'c1', name: 'Đồ Ngủ' }] },
        { fetch: fetchFn, getRequestHeaders: headers });
    const decoded = JSON.parse(Buffer.from(fetchFn.calls[0].body.data, 'base64').toString('utf8'));
    assert.equal(decoded.characters[0].name, 'Đồ Ngủ');
});

test('bytes counts UTF-8 bytes, not characters', async () => {
    const fetchFn = makeFetch(() => okJson({ path: 'p' }));
    const res = await uploadRoster({ characters: [{ n: 'áááá' }] },
        { fetch: fetchFn, getRequestHeaders: headers });
    const raw = Buffer.from(fetchFn.calls[0].body.data, 'base64').toString('utf8');
    assert.equal(res.bytes, Buffer.byteLength(raw, 'utf8'));
    assert.ok(res.bytes > raw.length, 'multi-byte characters must inflate the count');
});

test('an invalid filename fails before any request is made', async () => {
    const fetchFn = makeFetch(() => okJson({ path: 'p' }));
    await assert.rejects(
        () => uploadRoster({}, { fetch: fetchFn, getRequestHeaders: headers, filename: 'a/b.json' }),
        (err) => err instanceof ServerSyncError && err.code === 'SYNC_FILENAME',
    );
    assert.equal(fetchFn.calls.length, 0, 'no request may be spent on a known-bad name');
});

test('an HTTP rejection surfaces the server detail', async () => {
    const fetchFn = makeFetch(() => status(400, 'Illegal character in filename'));
    await assert.rejects(
        () => uploadRoster({}, { fetch: fetchFn, getRequestHeaders: headers }),
        (err) => err.code === 'SYNC_HTTP' && /Illegal character/.test(err.message),
    );
});

test('a network failure is reported as SYNC_NETWORK, not swallowed', async () => {
    const fetchFn = makeFetch(() => { throw new Error('offline'); });
    await assert.rejects(
        () => uploadRoster({}, { fetch: fetchFn, getRequestHeaders: headers }),
        (err) => err.code === 'SYNC_NETWORK',
    );
});

test('a response without a path is malformed, not a silent success', async () => {
    const fetchFn = makeFetch(() => okJson({}));
    await assert.rejects(
        () => uploadRoster({}, { fetch: fetchFn, getRequestHeaders: headers }),
        (err) => err.code === 'SYNC_MALFORMED',
    );
});

test('a missing fetch is a configuration error', async () => {
    await assert.rejects(() => uploadRoster({}, {}),
        (err) => err.code === 'SYNC_CONFIG');
});

// ------------------------------------------------------------- download ---

test('downloadRoster returns the validated payload', async () => {
    const payload = buildRosterPayload({ characters: [{ id: 'c1' }] });
    const fetchFn = makeFetch(() => okText(JSON.stringify(payload)));
    const got = await downloadRoster('user/files/x.json', { fetch: fetchFn, getRequestHeaders: headers });
    assert.equal(got.characters[0].id, 'c1');
    assert.equal(fetchFn.calls[0].init.method, 'GET');
});

test('a 404 means first run, not an error', async () => {
    const fetchFn = makeFetch(() => ({ ok: false, status: 404, text: async () => '' }));
    assert.equal(await downloadRoster('user/files/x.json', { fetch: fetchFn, getRequestHeaders: headers }), null);
});

test('an empty file is treated as absent rather than as broken JSON', async () => {
    const fetchFn = makeFetch(() => okText('   '));
    assert.equal(await downloadRoster('user/files/x.json', { fetch: fetchFn, getRequestHeaders: headers }), null);
});

test('a corrupt file is rejected loudly — it must not silently wipe the roster', async () => {
    const fetchFn = makeFetch(() => okText('{not json'));
    await assert.rejects(
        () => downloadRoster('user/files/x.json', { fetch: fetchFn, getRequestHeaders: headers }),
        (err) => err.code === 'SYNC_MALFORMED',
    );
});

test('a foreign envelope is rejected with the reason', async () => {
    const fetchFn = makeFetch(() => okText(JSON.stringify({ format: 'other', version: 1 })));
    await assert.rejects(
        () => downloadRoster('user/files/x.json', { fetch: fetchFn, getRequestHeaders: headers }),
        (err) => err.code === 'SYNC_MALFORMED' && /unknown format/.test(err.message),
    );
});

test('an empty path is a configuration error, not a request', async () => {
    const fetchFn = makeFetch(() => okText('{}'));
    await assert.rejects(
        () => downloadRoster('', { fetch: fetchFn, getRequestHeaders: headers }),
        (err) => err.code === 'SYNC_CONFIG',
    );
    assert.equal(fetchFn.calls.length, 0);
});

// --------------------------------------------------------- verify/delete ---

test('rosterExists reads the per-url verify map', async () => {
    const fetchFn = makeFetch(() => okJson({ 'user/files/x.json': true }));
    assert.equal(await rosterExists('user/files/x.json', { fetch: fetchFn, getRequestHeaders: headers }), true);
    assert.equal(fetchFn.calls[0].url, '/api/files/verify');
    assert.deepEqual(fetchFn.calls[0].body.urls, ['user/files/x.json']);
});

test('rosterExists is false for an unknown or unverifiable file', async () => {
    const missing = makeFetch(() => okJson({ 'user/files/x.json': false }));
    assert.equal(await rosterExists('user/files/x.json', { fetch: missing, getRequestHeaders: headers }), false);
    const broken = makeFetch(() => status(500));
    assert.equal(await rosterExists('user/files/x.json', { fetch: broken, getRequestHeaders: headers }), false);
    assert.equal(await rosterExists('', { fetch: broken, getRequestHeaders: headers }), false);
});

test('deleteRoster reports whether the file was actually there', async () => {
    const present = makeFetch(() => ({ ok: true, status: 200, text: async () => '' }));
    assert.equal(await deleteRoster('user/files/x.json', { fetch: present, getRequestHeaders: headers }), true);
    assert.equal(present.calls[0].url, '/api/files/delete');
    assert.equal(present.calls[0].body.path, 'user/files/x.json');

    const absent = makeFetch(() => ({ ok: false, status: 404, text: async () => '' }));
    assert.equal(await deleteRoster('user/files/x.json', { fetch: absent, getRequestHeaders: headers }), false);
});

test('a delete rejection is not reported as a successful delete', async () => {
    const fetchFn = makeFetch(() => status(400, 'Invalid path'));
    await assert.rejects(
        () => deleteRoster('user/files/x.json', { fetch: fetchFn, getRequestHeaders: headers }),
        (err) => err.code === 'SYNC_HTTP',
    );
});

// ------------------------------------------------------------ round trip ---

test('upload then download reproduces every collection exactly', async () => {
    let stored = null;
    const up = makeFetch((url, init) => {
        stored = JSON.parse(init.body).data;
        return okJson({ path: 'user/files/ifimage-roster-v1.json' });
    });
    const source = {
        characters: [{ id: 'c1', name: 'Lyna', booru: 'silver hair' }],
        outfits: [{ id: 'o1', name: 'Đồ ngủ', triggerMode: 'auto_keyword', triggers: ['bed'] }],
        styles: [{ id: 's1', name: 'Cinematic' }],
        personas: [{ id: 'p1', name: 'Ann', isDefault: true }],
        replaceRules: [{ trigger: 'a|b', mode: 'replace', replacement: 'c' }],
    };
    const saved = await uploadRoster(source, { fetch: up, getRequestHeaders: headers });
    assert.ok(saved.path);

    const down = makeFetch(() => okText(Buffer.from(stored, 'base64').toString('utf8')));
    const got = await downloadRoster(saved.path, { fetch: down, getRequestHeaders: headers });
    for (const name of Object.keys(source)) {
        assert.deepEqual(got[name], source[name], name);
    }
});
