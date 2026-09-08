#!/usr/bin/env node
// IF Image - offline tests for the AUTOMATIC1111-compatible client.
// All fetches are mocked; no network, no real keys. Dummy credential strings
// below ("dummy-secret", "user:pass") are synthetic test values only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    A1111Client, A1111Error,
    utf8Base64, buildBasicAuthHeader, normalizeBaseUrl,
    normalizeModels, resolveCheckpoint, summarizeValidationError,
    reshapeRelayBody,
} from '../src/backends/a1111.js';
import { ComfyProxyClient } from '../src/backends/comfy.js';

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
// R0: legible server errors (summarizeValidationError)
// ---------------------------------------------------------------------------

// Captured shape from a comfy-cloud-forge proxy relaying ComfyUI's prompt
// validation failure (missing checkpoint + LoRA files on the cloud host).
const NODE_ERRORS_BODY = {
    error: 'txt2img failed',
    detail: JSON.stringify({
        error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation' },
        node_errors: {
            '4': {
                errors: [{
                    type: 'value_not_in_list',
                    message: 'Value not in list',
                    details: "ckpt_name: 'krea2_turbo.safetensors' not in ['animaX.safetensors']",
                    extra_info: { input_name: 'ckpt_name', received_value: 'krea2_turbo.safetensors' },
                }],
            },
            '10': {
                errors: [{
                    type: 'value_not_in_list',
                    message: 'Value not in list',
                    details: "lora_name: 'detailer_v2.safetensors' not in []",
                    extra_info: { input_name: 'lora_name', received_value: 'detailer_v2.safetensors' },
                }],
            },
        },
    }),
};

test('summarizeValidationError: node_errors payload becomes a short missing-files line', () => {
    const summary = summarizeValidationError(NODE_ERRORS_BODY.detail);
    assert.ok(summary.startsWith('Server workflow references missing files:'), summary);
    assert.match(summary, /ckpt_name=krea2_turbo\.safetensors/);
    assert.match(summary, /lora_name=detailer_v2\.safetensors/);
    assert.ok(summary.length <= 300);
    assert.equal(summary.includes('{'), false, 'no raw JSON in the summary');
});

test('summarizeValidationError: at most 3 items, still <= 300 chars', () => {
    const details = Array.from({ length: 6 }, (_, i) =>
        `ckpt_name: 'model_number_${i}_${'x'.repeat(40)}.safetensors' not in ['a']`).join(' ');
    const summary = summarizeValidationError(`node_errors ${details}`);
    assert.ok(summary.length <= 300, `too long: ${summary.length}`);
    assert.equal(summary.split(';').length <= 3, true, 'max 3 items');
});

test('summarizeValidationError: plain text falls back to the bounded input', () => {
    assert.equal(summarizeValidationError('Internal Server Error'), 'Internal Server Error');
    const long = 'y'.repeat(900);
    assert.equal(summarizeValidationError(long).length, 300);
    // Mentions node_errors but has no parseable entries: bounded fallback.
    assert.equal(summarizeValidationError('node_errors: unreadable'), 'node_errors: unreadable');
});

test('A1111 txt2img failure surfaces the missing-files summary, no URL/auth leak', async () => {
    const routes = { 'POST /sdapi/v1/txt2img': jsonResponse(NODE_ERRORS_BODY, { status: 500 }) };
    const client = makeClient(routes);
    await assert.rejects(client.txt2img({ prompt: 'p', checkpoint: 'm' }), err => {
        assert.equal(err.code, 'A1111_HTTP');
        assert.match(err.message, /Server workflow references missing files:/);
        assert.match(err.message, /ckpt_name=krea2_turbo\.safetensors/);
        assert.equal(err.message.includes('dummy-secret'), false, 'auth never leaks');
        assert.equal(err.message.includes('sd.example.com'), false, 'base URL never leaks');
        assert.equal(err.message.includes('node_errors'), false, 'raw JSON structure never leaks');
        return true;
    });
});

test('A1111 txt2img plain-text 500 keeps the existing bounded redacted detail', async () => {
    const routes = { 'POST /sdapi/v1/txt2img': textResponse('boom from dummy-secret', 500) };
    const client = makeClient(routes);
    await assert.rejects(client.txt2img({ prompt: 'p', checkpoint: 'm' }), err => {
        assert.equal(err.code, 'A1111_HTTP');
        assert.match(err.message, /500/);
        assert.match(err.message, /boom/);
        assert.equal(err.message.includes('dummy-secret'), false);
        return true;
    });
});

test('Comfy proxy txt2img failure reuses the same summary helper', async () => {
    const client = new ComfyProxyClient({
        getBaseUrl: () => 'http://localhost:7861',
        getUsername: () => 'user',
        getPassword: () => 'dummy-secret',
        fetchImpl: async () => ({
            ok: false, status: 400, headers: {},
            text: async () => JSON.stringify(NODE_ERRORS_BODY),
        }),
    });
    await assert.rejects(client.txt2img({ prompt: 'p' }), err => {
        assert.equal(err.code, 'COMFY_HTTP');
        assert.match(err.message, /Server workflow references missing files:/);
        assert.match(err.message, /lora_name=detailer_v2\.safetensors/);
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
// R1: discover() — models + samplers + schedulers + optional /internal/models
// ---------------------------------------------------------------------------

const DISCOVERY_ROUTES = {
    'GET /sdapi/v1/sd-models': jsonResponse([
        { title: 'Krea 2 | Turbo18+', model_name: 'krea2_turbo', filename: 'krea2_turbo.safetensors' },
        { title: 'Anima | RDBT Anima', model_name: 'rdbt_anima', filename: 'rdbt_anima.safetensors' },
        { title: 'Mystery Model', model_name: 'mystery', filename: 'mystery.safetensors' },
    ]),
    'GET /sdapi/v1/samplers': jsonResponse([{ name: 'Euler a' }, { name: 'DPM++ 2M' }]),
    'GET /sdapi/v1/schedulers': jsonResponse([{ name: 'karras' }, { name: 'simple' }]),
};

test('discover(): /internal/models 200 enriches matched titles with family + mapped defaults', async () => {
    const routes = {
        ...DISCOVERY_ROUTES,
        'GET /internal/models': jsonResponse([
            {
                id: 'krea', title: 'Krea 2 | Turbo18+', family: 'krea2', checkpointFile: 'krea2_turbo.safetensors',
                defaults: { steps: 8, cfg: 1, sampler: 'Euler a', scheduler: 'simple', width: 1344, height: 768 },
            },
            // Matched by checkpointFile == model_name (title differs).
            { id: 'anima', title: 'Anima (renamed)', family: 'anima', checkpointFile: 'rdbt_anima', defaults: { steps: 16 } },
        ]),
    };
    const client = makeClient(routes);
    const result = await client.discover();
    assert.equal(result.enrichment, 'internal');
    assert.deepEqual(result.samplers, ['Euler a', 'DPM++ 2M']);
    assert.deepEqual(result.schedulers, ['karras', 'simple']);
    const krea = result.models.find(m => m.title === 'Krea 2 | Turbo18+');
    assert.equal(krea.family, 'krea2');
    assert.deepEqual(krea.defaults, { width: 1344, height: 768, steps: 8, cfg: 1, sampler: 'Euler a', scheduler: 'simple' });
    const anima = result.models.find(m => m.title === 'Anima | RDBT Anima');
    assert.equal(anima.family, 'anima');
    assert.deepEqual(anima.defaults, { steps: 16 });
    const mystery = result.models.find(m => m.title === 'Mystery Model');
    assert.equal(mystery.family, undefined);
    assert.equal(mystery.defaults, undefined);
});

test('discover(): /internal/models 404 is ignored (enrichment none)', async () => {
    const routes = { ...DISCOVERY_ROUTES, 'GET /internal/models': jsonResponse({ detail: 'Not Found' }, { status: 404 }) };
    const client = makeClient(routes);
    const result = await client.discover();
    assert.equal(result.enrichment, 'none');
    assert.equal(result.models.length, 3);
    assert.equal(result.models.every(m => m.family === undefined), true);
});

test('discover(): /internal/models network error and schedulers 404 are both tolerated', async () => {
    const routes = {
        ...DISCOVERY_ROUTES,
        'GET /sdapi/v1/schedulers': jsonResponse({ detail: 'Not Found' }, { status: 404 }),
        'GET /internal/models': () => { throw new TypeError('Failed to fetch'); },
    };
    const client = makeClient(routes);
    const result = await client.discover();
    assert.equal(result.enrichment, 'none');
    assert.deepEqual(result.schedulers, []);
    assert.deepEqual(result.samplers, ['Euler a', 'DPM++ 2M']);
    assert.equal(result.models.length, 3);
});

test('discover(): models() failure rejects (models are required)', async () => {
    const routes = { ...DISCOVERY_ROUTES, 'GET /sdapi/v1/sd-models': jsonResponse({ detail: 'boom' }, { status: 500 }) };
    const client = makeClient(routes);
    await assert.rejects(client.discover(), err => err.code === 'A1111_HTTP');
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

// ---------------------------------------------------------------------------
// ST-relay transport (browser -> SillyTavern /api/sd/* -> backend)
// ---------------------------------------------------------------------------

/** Relay mock: routes keyed by "POST /api/sd/<name>"; records parsed bodies. */
function makeRelayClient(routes, log = [], cfg = {}) {
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        log.push({ url, method: init.method ?? 'GET', headers: init.headers, body, signal: init.signal });
        const key = `${init.method ?? 'GET'} ${url}`;
        const route = routes[key];
        if (!route) throw new Error(`mock: no route for ${key}`);
        return typeof route === 'function' ? route(body, init) : route;
    };
    return new A1111Client({
        getBaseUrl: () => cfg.baseUrl ?? 'https://sd.example.com',
        getAuth: () => cfg.auth ?? 'dummy-secret',
        getTransport: () => cfg.transport ?? 'st-relay',
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf-dummy' }),
        fetchImpl,
    });
}

const RELAY_ROUTES = {
    'POST /api/sd/get-model': textResponse('Krea 2 | A'),
    'POST /api/sd/models': jsonResponse([{ value: 'Krea 2 | A', text: 'Krea 2 | A' }, { value: 'Anima | B', text: 'Anima | B' }]),
    'POST /api/sd/samplers': jsonResponse(['Euler', 'Euler a', 'DPM++ 2M']),
    'POST /api/sd/schedulers': jsonResponse(['Automatic', 'simple', 'karras']),
    'POST /api/sd/generate': jsonResponse({ images: ['aGVsbG8='], parameters: {}, info: JSON.stringify({ seed: 4321 }) }),
};

test('relay: transport() defaults to direct without a getter and never throws', () => {
    const plain = new A1111Client({ getBaseUrl: () => 'x', getAuth: () => '', fetchImpl: async () => {} });
    assert.equal(plain.transport(), 'direct');
    const bad = new A1111Client({ getBaseUrl: () => 'x', getAuth: () => '', getTransport: () => { throw new Error('boom'); }, fetchImpl: async () => {} });
    assert.equal(bad.transport(), 'direct');
    assert.equal(makeRelayClient({}).transport(), 'st-relay');
    assert.equal(makeRelayClient({}, [], { transport: 'nonsense' }).transport(), 'direct');
});

test('relay: discovery posts {url, auth} to /api/sd/* with ST headers and never touches the backend origin', async () => {
    const log = [];
    const client = makeRelayClient(RELAY_ROUTES, log);
    const discovery = await client.discover();
    assert.deepEqual(discovery.models.map(m => m.title), ['Krea 2 | A', 'Anima | B']);
    assert.deepEqual(discovery.samplers, ['Euler', 'Euler a', 'DPM++ 2M']);
    assert.deepEqual(discovery.schedulers, ['Automatic', 'simple', 'karras']);
    assert.equal(discovery.enrichment, 'none', '/internal/models is not relayable and must be tolerated');
    assert.ok(log.length >= 3);
    for (const call of log) {
        assert.equal(call.method, 'POST');
        assert.match(call.url, /^\/api\/sd\//, 'relay endpoint only');
        assert.ok(!/sd\.example\.com/.test(call.url), 'backend origin never fetched directly');
        assert.equal(call.body.url, 'https://sd.example.com');
        assert.equal(call.body.auth, 'dummy-secret', 'auth string passed verbatim for the server to encode');
        assert.equal(call.headers['X-CSRF-Token'], 'csrf-dummy');
        assert.equal(call.headers['Content-Type'], 'application/json');
        assert.equal(call.headers['Authorization'], undefined, 'no Basic header on the relay hop');
    }
});

test('relay: options() reshapes /get-model text into {sd_model_checkpoint}; JSON-string form too', async () => {
    const a = makeRelayClient(RELAY_ROUTES);
    assert.deepEqual(await a.options(), { sd_model_checkpoint: 'Krea 2 | A' });
    const b = makeRelayClient({ ...RELAY_ROUTES, 'POST /api/sd/get-model': jsonResponse('Anima | B') });
    assert.deepEqual(await b.options(), { sd_model_checkpoint: 'Anima | B' });
    const probe = await a.testConnection();
    assert.equal(probe.currentCheckpoint, 'Krea 2 | A');
    assert.equal(probe.models.length, 2);
});

test('relay: txt2img posts the full payload plus url/auth to /api/sd/generate and parses the image', async () => {
    const log = [];
    const client = makeRelayClient(RELAY_ROUTES, log);
    const result = await client.txt2img({ prompt: 'p', negative_prompt: 'n', checkpoint: 'Krea 2 | A', seed: 7, width: 1344, height: 768, steps: 8, cfg_scale: 1, sampler_name: 'Euler', scheduler: 'simple' });
    assert.equal(result.info.seed, 4321);
    assert.ok(result.image instanceof Blob);
    const call = log.at(-1);
    assert.equal(call.url, '/api/sd/generate');
    assert.equal(call.body.url, 'https://sd.example.com');
    assert.equal(call.body.auth, 'dummy-secret');
    assert.equal(call.body.prompt, 'p');
    assert.equal(call.body.seed, 7);
    assert.equal(call.body.override_settings.sd_model_checkpoint, 'Krea 2 | A');
    assert.equal(call.body.override_settings_restore_afterwards, true);
    assert.equal(call.body.sampler_name, 'Euler');
    assert.equal(call.body.scheduler, 'simple');
});

test('relay: generate is never aborted mid-flight (ST would POST /interrupt); abort surfaces after settle', async () => {
    const log = [];
    let release;
    const gate = new Promise(r => { release = r; });
    const routes = {
        ...RELAY_ROUTES,
        'POST /api/sd/generate': async (body, init) => {
            await gate;
            assert.equal(init.signal.aborted, false, 'fetch signal must NOT be aborted for generate');
            return jsonResponse({ images: ['aGVsbG8='], info: '{"seed":1}' });
        },
    };
    const client = makeRelayClient(routes, log);
    const ac = new AbortController();
    const pending = client.txt2img({ prompt: 'p', checkpoint: 'Krea 2 | A' }, { signal: ac.signal });
    ac.abort();
    release();
    await assert.rejects(pending, err => err.code === 'A1111_ABORTED' && /discarded/.test(err.message));
    assert.equal(log.at(-1).signal.aborted, false);
});

test('relay: discovery honors abort immediately; pre-aborted signal never fetches', async () => {
    const log = [];
    let release;
    const gate = new Promise(r => { release = r; });
    const routes = {
        ...RELAY_ROUTES,
        'POST /api/sd/models': async (body, init) => {
            await gate;
            if (init.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
            return jsonResponse([]);
        },
    };
    const client = makeRelayClient(routes, log);
    const ac = new AbortController();
    const pending = client.models({ signal: ac.signal });
    ac.abort();
    release();
    await assert.rejects(pending, err => err.code === 'A1111_ABORTED');
    const pre = new AbortController();
    pre.abort();
    const before = log.length;
    await assert.rejects(client.models({ signal: pre.signal }), err => err.code === 'A1111_ABORTED');
    assert.equal(log.length, before, 'no fetch when already aborted');
});

test('relay: 500 maps to A1111_HTTP with a server-console pointer and an http:// redirect hint', async () => {
    const routes = { ...RELAY_ROUTES, 'POST /api/sd/models': textResponse('Internal Server Error', 500) };
    await assert.rejects(makeRelayClient(routes).models(), err =>
        err.code === 'A1111_HTTP' && /SillyTavern server console/.test(err.message) && !/http:\/\//.test(err.message));
    await assert.rejects(makeRelayClient(routes, [], { baseUrl: 'http://sd.example.com' }).models(), err =>
        err.code === 'A1111_HTTP' && /https:\/\/ URL directly/.test(err.message));
});

test('relay: 401/403 from ST itself maps to A1111_AUTH without echoing the key; network error maps to A1111_NETWORK', async () => {
    const routes = { ...RELAY_ROUTES, 'POST /api/sd/models': textResponse('Forbidden', 403) };
    await assert.rejects(makeRelayClient(routes).models(), err => err.code === 'A1111_AUTH' && !/dummy-secret/.test(err.message));
    const net = new A1111Client({
        getBaseUrl: () => 'https://sd.example.com', getAuth: () => 'dummy-secret', getTransport: () => 'st-relay',
        fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    });
    await assert.rejects(net.models(), err => err.code === 'A1111_NETWORK' && /relay/.test(err.message) && !/dummy-secret/.test(err.message));
});

test('relay: /internal/models has no relay route -> A1111_CONFIG (discover() ignores it)', async () => {
    const client = makeRelayClient(RELAY_ROUTES);
    await assert.rejects(client.internalModels(), err => err.code === 'A1111_CONFIG');
});

test('relay: malformed relay bodies are rejected as A1111_MALFORMED', async () => {
    const routes = { ...RELAY_ROUTES, 'POST /api/sd/models': textResponse('<html>login</html>') };
    await assert.rejects(makeRelayClient(routes).models(), err => err.code === 'A1111_MALFORMED');
    const routes2 = { ...RELAY_ROUTES, 'POST /api/sd/generate': textResponse('not json') };
    await assert.rejects(makeRelayClient(routes2).txt2img({ prompt: 'p', checkpoint: 'Krea 2 | A' }), err => err.code === 'A1111_MALFORMED');
});

test('reshapeRelayBody: shapes models/names/options/raw and rejects junk', () => {
    assert.deepEqual(JSON.parse(reshapeRelayBody('models', JSON.stringify([{ value: 'A', text: 'A' }, 'B', {}, null]))),
        [{ title: 'A', model_name: 'A' }, { title: 'B', model_name: 'B' }]);
    assert.deepEqual(JSON.parse(reshapeRelayBody('names', JSON.stringify(['Euler', { name: 'DPM++ 2M' }, 3, null]))),
        [{ name: 'Euler' }, { name: 'DPM++ 2M' }]);
    assert.deepEqual(JSON.parse(reshapeRelayBody('options', ' Krea 2 | A ')), { sd_model_checkpoint: 'Krea 2 | A' });
    assert.deepEqual(JSON.parse(reshapeRelayBody('options', JSON.stringify({ sd_model_checkpoint: 'X' }))), { sd_model_checkpoint: 'X' });
    assert.deepEqual(JSON.parse(reshapeRelayBody('options', JSON.stringify({ other: 1 }))), { sd_model_checkpoint: '' });
    assert.equal(reshapeRelayBody('raw', '{"images":[]}'), '{"images":[]}');
    assert.equal(reshapeRelayBody('raw', 'nope'), null);
    assert.equal(reshapeRelayBody('models', '{"not":"array"}'), null);
    assert.equal(reshapeRelayBody('unknown', '[]'), null);
});

test('direct transport is unchanged when getTransport says direct', async () => {
    const log = [];
    const client = new A1111Client({
        getBaseUrl: () => 'https://sd.example.com', getAuth: () => 'dummy-secret', getTransport: () => 'direct',
        fetchImpl: mockFetch({ 'GET /sdapi/v1/sd-models': jsonResponse([{ title: 'A', model_name: 'a' }]) }, log),
    });
    const models = await client.models();
    assert.equal(models[0].title, 'A');
    assert.equal(log[0].url, 'https://sd.example.com/sdapi/v1/sd-models');
    assert.equal(log[0].headers['Authorization'], buildBasicAuthHeader('dummy-secret'));
});
