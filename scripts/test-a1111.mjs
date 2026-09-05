#!/usr/bin/env node
// IF Image - offline tests for the AUTOMATIC1111-compatible client.
// All fetches are mocked; no network, no real keys. Dummy credential strings
// below ("dummy-secret", "user:pass") are synthetic test values only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    A1111Client, A1111Error,
    utf8Base64, buildBasicAuthHeader, normalizeBaseUrl,
    normalizeModels, resolveCheckpoint,
} from '../src/backends/a1111.js';

// Node has no DOM URL.createObjectURL; a stand-in is enough for shape checks.
if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = blob => `blob:mock-${blob?.size ?? 0}`;
}

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

function jsonResponse(body, { status = 200, headers = {} } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => headers['content-type'] ?? 'application/json' },
        text: async () => JSON.stringify(body),
    };
}

function textResponse(text, status = 200) {
    return { ok: status < 300, status, headers: { get: () => 'text/plain' }, text: async () => text };
}

/** Route table keyed by "METHOD path"; unknown routes throw (test bug). */
function mockFetch(routes, log) {
    return async (url, init = {}) => {
        const parsed = new URL(url);
        log.push({ url: parsed.toString(), method: init.method ?? 'GET', headers: init.headers, init });
        const key = `${init.method ?? 'GET'} ${parsed.pathname}`;
        const route = routes[key];
        if (!route) throw new Error(`mock: no route for ${key}`);
        if (typeof route === 'function') return route(parsed, init);
        return route;
    };
}

function makeClient(routes, log = [], cfg = {}) {
    const fetchImpl = mockFetch(routes, log);
    return new A1111Client({
        getBaseUrl: () => cfg.baseUrl ?? 'https://sd.example.com',
        getAuth: () => cfg.auth ?? 'dummy-secret',
        fetchImpl,
        ...cfg,
    });
}

// ---------------------------------------------------------------------------
// Auth header semantics (exact ST getBasicAuthHeader behavior)
// ---------------------------------------------------------------------------

test('auth string without a colon is NOT modified (no colon insertion)', () => {
    assert.equal(buildBasicAuthHeader('sk-abc123'), `Basic ${utf8Base64('sk-abc123')}`);
    assert.notEqual(buildBasicAuthHeader('sk-abc123'), `Basic ${utf8Base64(':sk-abc123')}`);
});

test('auth string with a colon is used verbatim', () => {
    assert.equal(buildBasicAuthHeader('user:pass'), `Basic ${utf8Base64('user:pass')}`);
});

test('utf8Base64 matches Node Buffer base64 for ASCII and Unicode', () => {
    for (const value of ['user:pass', 'sk-abc_123', 'pässwörd:ключ:鍵', 'é 😀 ü']) {
        assert.equal(utf8Base64(value), Buffer.from(value, 'utf8').toString('base64'), `mismatch for ${value}`);
    }
});

test('auth is never trimmed or converted to Bearer', () => {
    const header = buildBasicAuthHeader(' padded-secret ');
    assert.ok(header.startsWith('Basic '), 'must stay Basic');
    assert.equal(header, `Basic ${utf8Base64(' padded-secret ')}`, 'whitespace preserved');
});

test('empty auth sends no Authorization header', async () => {
    const log = [];
    const routes = { 'GET /sdapi/v1/options': jsonResponse({}) };
    const client = new A1111Client({
        getBaseUrl: () => 'https://sd.example.com',
        getAuth: () => '',
        fetchImpl: mockFetch(routes, log),
    });
    await client.options();
    assert.equal('Authorization' in log[0].headers, false);
});

// ---------------------------------------------------------------------------
// URL validation / normalization
// ---------------------------------------------------------------------------

test('normalizeBaseUrl accepts http/https and keeps base path, strips trailing slashes', () => {
    assert.deepEqual(normalizeBaseUrl('https://sd.example.com'), { ok: true, url: 'https://sd.example.com' });
    assert.deepEqual(normalizeBaseUrl('https://sd.example.com/'), { ok: true, url: 'https://sd.example.com' });
    assert.deepEqual(normalizeBaseUrl('https://sd.example.com/a1111///'), { ok: true, url: 'https://sd.example.com/a1111' });
    assert.deepEqual(normalizeBaseUrl('http://127.0.0.1:7860'), { ok: true, url: 'http://127.0.0.1:7860' });
});

test('normalizeBaseUrl rejects empty, non-URL, non-http schemes, embedded creds, query, fragment', () => {
    for (const bad of ['', '   ', 'not a url', 'ftp://sd.example.com', 'file:///etc/passwd',
        'https://user:pass@sd.example.com', 'https://sd.example.com?x=1', 'https://sd.example.com#frag']) {
        assert.equal(normalizeBaseUrl(bad).ok, false, `should reject: ${bad}`);
    }
});

test('invalid base URL fails fast with A1111_CONFIG and no fetch', async () => {
    const log = [];
    const client = makeClient({}, log, { baseUrl: 'https://user:pass@bad' });
    await assert.rejects(client.models(), err => {
        assert.ok(err instanceof A1111Error);
        assert.equal(err.code, 'A1111_CONFIG');
        assert.match(err.message, /embedded credentials/);
        return true;
    });
    assert.equal(log.length, 0);
});

// ---------------------------------------------------------------------------
// Endpoint separation: no /internal/* ever leaves the client
// ---------------------------------------------------------------------------

test('A1111 mode never calls /internal/* endpoints', async () => {
    const log = [];
    const routes = {
        'GET /sdapi/v1/options': jsonResponse({ sd_model_checkpoint: 'modelA.safetensors' }),
        'GET /sdapi/v1/sd-models': jsonResponse([{ title: 'modelA.safetensors', model_name: 'modelA', filename: 'fA' }]),
        'GET /sdapi/v1/samplers': jsonResponse([{ name: 'Euler a' }]),
    };
    const client = makeClient(routes, log);
    await client.testConnection();
    for (const call of log) {
        assert.equal(call.url.includes('/internal/'), false, `internal endpoint used: ${call.url}`);
    }
    assert.deepEqual(log.map(c => c.url.split('.com')[1]), ['/sdapi/v1/options', '/sdapi/v1/sd-models', '/sdapi/v1/samplers']);
});

test('testConnection reads options read-only and never writes them', async () => {
    const log = [];
    const routes = {
        'GET /sdapi/v1/options': jsonResponse({ sd_model_checkpoint: 'modelA.safetensors' }),
        'GET /sdapi/v1/sd-models': jsonResponse([{ title: 'modelA.safetensors' }]),
        'GET /sdapi/v1/samplers': jsonResponse([{ name: 'Euler' }]),
    };
    const client = makeClient(routes, log);
    const info = await client.testConnection();
    assert.equal(info.currentCheckpoint, 'modelA.safetensors');
    assert.equal(info.models.length, 1);
    assert.equal(info.samplers.length, 1);
    assert.equal(info.samplersError, null);
    assert.equal(log.every(c => c.method === 'GET'), true, 'testConnection must only GET');
});

test('samplers failure is tolerated and never reported as auth failure', async () => {
    const routes = {
        'GET /sdapi/v1/options': jsonResponse({}),
        'GET /sdapi/v1/sd-models': jsonResponse([{ title: 'm' }]),
        'GET /sdapi/v1/samplers': jsonResponse({ detail: 'gone' }, { status: 404 }),
    };
    const client = makeClient(routes);
    const info = await client.testConnection();
    assert.equal(info.samplers, null);
    assert.match(info.samplersError, /404/);
    assert.doesNotMatch(info.samplersError, /Authentication/);
});

test('samplers 401 on that one route does not fail the whole test', async () => {
    const routes = {
        'GET /sdapi/v1/options': jsonResponse({}),
        'GET /sdapi/v1/sd-models': jsonResponse([{ title: 'm' }]),
        'GET /sdapi/v1/samplers': jsonResponse({}, { status: 401 }),
    };
    const client = makeClient(routes);
    const info = await client.testConnection();
    assert.equal(info.models.length, 1);
    assert.match(info.samplersError, /401/);
});

// ---------------------------------------------------------------------------
// txt2img payload: checkpoint via override_settings, one image, no retry
// ---------------------------------------------------------------------------

test('txt2img sends checkpoint via override_settings.sd_model_checkpoint with restore flag', async () => {
    const log = [];
    const routes = {
        'POST /sdapi/v1/txt2img': jsonResponse({ images: ['aGk='], info: '{"seed": 1}' }),
    };
    const client = makeClient(routes, log);
    await client.txt2img({ prompt: 'p', negative_prompt: 'n', checkpoint: 'modelA.safetensors', seed: 7, width: 512, height: 512, steps: 5, cfg_scale: 5 });
    const body = JSON.parse(log[0].init.body);
    assert.equal(body.override_settings.sd_model_checkpoint, 'modelA.safetensors');
    assert.equal(body.override_settings_restore_afterwards, true);
    assert.equal('model' in body, false, 'legacy top-level model must not be sent');
    assert.equal(body.batch_size, 1);
    assert.equal(body.n_iter, 1);
    assert.equal(body.seed, 7);
});

test('txt2img without a checkpoint is blocked client-side', async () => {
    const log = [];
    const client = makeClient({ 'POST /sdapi/v1/txt2img': jsonResponse({ images: ['aGk='] }) }, log);
    await assert.rejects(client.txt2img({ prompt: 'p', checkpoint: '' }), err => err.code === 'A1111_CONFIG');
    await assert.rejects(client.txt2img({ prompt: 'p' }), err => err.code === 'A1111_CONFIG');
    assert.equal(log.length, 0, 'no request may leave');
});

test('txt2img result shape {image, dataUrl, info, raw}; info parsed from string or object', async () => {
    const routes = {
        'POST /sdapi/v1/txt2img': jsonResponse({ images: ['aGk='], info: '{"seed": 42}' }),
        'POST /sdapi/v1/txt2img/x': jsonResponse({ images: ['aGk='], info: { seed: 43 } }),
    };
    const client = makeClient(routes);
    const r1 = await client.txt2img({ prompt: 'p', checkpoint: 'm' });
    assert.ok(r1.image instanceof Blob);
    assert.equal(typeof r1.dataUrl, 'string');
    assert.equal(r1.info.seed, 42);
    assert.ok(r1.raw && Array.isArray(r1.raw.images));

    const routes2 = { 'POST /sdapi/v1/txt2img': jsonResponse({ images: ['aGk='], info: { seed: 43 } }) };
    const client2 = makeClient(routes2);
    const r2 = await client2.txt2img({ prompt: 'p', checkpoint: 'm' });
    assert.equal(r2.info.seed, 43);
});

test('malformed txt2img responses (no images / bad JSON) are explicit errors', async () => {
    const noImages = makeClient({ 'POST /sdapi/v1/txt2img': jsonResponse({ images: [] }) });
    await assert.rejects(noModelsCheck(noImages), err => err.code === 'A1111_MALFORMED');

    const badJson = makeClient({ 'POST /sdapi/v1/txt2img': textResponse('<html>gateway</html>') });
    await assert.rejects(noModelsCheck(badJson), err => err.code === 'A1111_MALFORMED');

    const badModels = makeClient({ 'GET /sdapi/v1/sd-models': jsonResponse({ not: 'array' }) });
    await assert.rejects(badModels.models(), err => err.code === 'A1111_MALFORMED');

    const badOptions = makeClient({ 'GET /sdapi/v1/options': jsonResponse([1, 2]) });
    await assert.rejects(badOptions.options(), err => err.code === 'A1111_MALFORMED');
});

function noModelsCheck(client) {
    return client.txt2img({ prompt: 'p', checkpoint: 'm' });
}

test('no auto-retry: exactly one POST per txt2img even on 500', async () => {
    const log = [];
    let hits = 0;
    const routes = {
        'POST /sdapi/v1/txt2img': () => { hits += 1; return jsonResponse({ detail: 'boom' }, { status: 500 }); },
    };
    const client = makeClient(routes, log);
    await assert.rejects(client.txt2img({ prompt: 'p', checkpoint: 'm' }), err => {
        assert.equal(err.code, 'A1111_HTTP');
        assert.match(err.message, /500/);
        return true;
    });
    assert.equal(hits, 1);
    assert.equal(log.length, 1);
});

// ---------------------------------------------------------------------------
// HTTP status handling
// ---------------------------------------------------------------------------

test('401 and 403 map to A1111_AUTH without echoing the credential', async () => {
    for (const status of [401, 403]) {
        const log = [];
        const routes = { 'GET /sdapi/v1/options': jsonResponse({ detail: 'bad auth dummy-secret' }, { status }) };
        const client = makeClient(routes, log);
        await assert.rejects(client.options(), err => {
            assert.equal(err.code, 'A1111_AUTH');
            assert.equal(err.message.includes('dummy-secret'), false, 'credential must be redacted');
            assert.ok(err.message.includes('***'));
            return true;
        });
    }
});

test('HTTP errors surface bounded redacted detail; raw body is not exposed', async () => {
    const routes = { 'POST /sdapi/v1/txt2img': jsonResponse({ detail: `failure for dummy-secret ${'x'.repeat(900)}` }, { status: 500 }) };
    const client = makeClient(routes);
    await assert.rejects(client.txt2img({ prompt: 'p', checkpoint: 'm' }), err => {
        assert.equal(err.code, 'A1111_HTTP');
        assert.equal(err.message.includes('dummy-secret'), false);
        assert.ok(err.message.length < 600);
        assert.equal(err.raw, undefined);
        return true;
    });
});

test('plain-text error bodies are redacted too', async () => {
    const routes = { 'GET /sdapi/v1/options': textResponse('denied: dummy-secret', 500) };
    const client = makeClient(routes);
    await assert.rejects(client.options(), err => {
        assert.match(err.message, /500/);
        assert.equal(err.message.includes('dummy-secret'), false);
        return true;
    });
});

// ---------------------------------------------------------------------------
// Network vs abort vs timeout
// ---------------------------------------------------------------------------

test('TypeError from fetch becomes A1111_NETWORK without claiming CORS for sure', async () => {
    const client = new A1111Client({
        getBaseUrl: () => 'https://sd.example.com',
        getAuth: () => 'k',
        fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    await assert.rejects(client.models(), err => {
        assert.equal(err.code, 'A1111_NETWORK');
        assert.match(err.message, /cannot distinguish|Network-level failure/);
        assert.match(err.message, /CORS/); // mentioned as one possibility among several
        return true;
    });
});

test('timeout aborts with A1111_TIMEOUT and distinguishes from user cancel', async () => {
    const client = new A1111Client({
        getBaseUrl: () => 'https://sd.example.com',
        getAuth: () => 'k',
        timeoutMs: 30,
        fetchImpl: (url, init) => new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    });
    await assert.rejects(client.models(), err => {
        assert.equal(err.code, 'A1111_TIMEOUT');
        assert.match(err.message, /NOT cancelled/);
        return true;
    });
});

test('external AbortSignal yields A1111_ABORTED', async () => {
    const controller = new AbortController();
    const client = new A1111Client({
        getBaseUrl: () => 'https://sd.example.com',
        getAuth: () => 'k',
        fetchImpl: (url, init) => new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            setTimeout(() => controller.abort(), 5);
        }),
    });
    await assert.rejects(client.models({ signal: controller.signal }), err => {
        assert.equal(err.code, 'A1111_ABORTED');
        assert.match(err.message, /cancelled/);
        return true;
    });
});

test('pre-aborted signal rejects before any fetch', async () => {
    const log = [];
    const controller = new AbortController();
    controller.abort();
    const client = makeClient({}, log);
    await assert.rejects(client.models({ signal: controller.signal }), err => err.code === 'A1111_ABORTED');
    assert.equal(log.length, 0);
});

test('redirect responses are A1111_REDIRECT (credentials never followed)', async () => {
    const routes = { 'GET /sdapi/v1/options': jsonResponse({}, { status: 302 }) };
    const client = makeClient(routes);
    await assert.rejects(client.options(), err => {
        assert.equal(err.code, 'A1111_REDIRECT');
        assert.match(err.message, /302/);
        return true;
    });
});

test('request uses redirect:"error" so the browser itself blocks credentialed redirects', async () => {
    const log = [];
    const routes = { 'GET /sdapi/v1/options': jsonResponse({}) };
    const client = makeClient(routes, log);
    await client.options();
    assert.equal(log[0].init.redirect, 'error');
});

test('AbortSignal listener is removed after completion (no leak)', async () => {
    const controller = new AbortController();
    const routes = { 'GET /sdapi/v1/options': jsonResponse({}) };
    const client = makeClient(routes);
    await client.options({ signal: controller.signal });
    // No direct introspection API: dispatching abort after completion must
    // not throw and must not affect anything.
    controller.abort();
});

test('credentials go only to the configured base URL (no absolute override)', async () => {
    const log = [];
    const routes = { 'GET /sdapi/v1/options': jsonResponse({}) };
    const client = makeClient(routes, log, { baseUrl: 'https://sd.example.com' });
    await client.options();
    assert.equal(log[0].url.startsWith('https://sd.example.com/'), true);
    assert.equal(log[0].headers.Authorization, buildBasicAuthHeader('dummy-secret'));
});

// ---------------------------------------------------------------------------
// Model normalization + checkpoint resolution (UI helper, pure)
// ---------------------------------------------------------------------------

test('normalizeModels tolerates missing fields and drops junk entries', () => {
    const list = normalizeModels([
        { title: 'A.safetensors [hash]', model_name: 'A', filename: 'a.safetensors' },
        { model_name: 'B' },
        { title: '' },
        null,
        42,
    ]);
    assert.deepEqual(list, [
        { title: 'A.safetensors [hash]', model_name: 'A', filename: 'a.safetensors' },
        { title: 'B', model_name: 'B', filename: null },
    ]);
    assert.equal(normalizeModels('nope'), null);
});

test('resolveCheckpoint: exact title/model_name match only, no dialect inference', () => {
    const models = [
        { title: 'rdbtAnima_v2.safetensors', model_name: 'rdbtAnima_v2' },
        { title: 'krea2_turbo.safetensors', model_name: 'krea2_turbo' },
    ];
    assert.equal(resolveCheckpoint(models, 'rdbtAnima_v2.safetensors'), 'rdbtAnima_v2.safetensors');
    assert.equal(resolveCheckpoint(models, 'rdbtAnima_v2'), 'rdbtAnima_v2.safetensors');
    // Dialect/profile names are NEVER treated as checkpoints.
    assert.equal(resolveCheckpoint(models, 'anima'), null);
    assert.equal(resolveCheckpoint(models, 'krea2'), null);
    assert.equal(resolveCheckpoint(models, 'illustrious'), null);
    assert.equal(resolveCheckpoint(models, ''), null);
    assert.equal(resolveCheckpoint(models, undefined), null);
    assert.equal(resolveCheckpoint([], 'whatever'), null);
    // A stored checkpoint missing from the fresh list is stale -> null.
    assert.equal(resolveCheckpoint(models, 'gone.safetensors'), null);
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

test('A1111Client requires cfg accessors and a fetch implementation', () => {
    assert.throws(() => new A1111Client(), /getBaseUrl/);
    assert.throws(() => new A1111Client({ getBaseUrl: () => 'x' }), /getAuth/);
    // Node has a global fetch, so the missing-fetchImpl case needs a stubbed absent global.
    const realFetch = globalThis.fetch;
    Object.defineProperty(globalThis, 'fetch', { value: undefined, configurable: true });
    try {
        assert.throws(() => new A1111Client({ getBaseUrl: () => 'x', getAuth: () => '' }), /fetchImpl/);
    } finally {
        Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true });
    }
});
