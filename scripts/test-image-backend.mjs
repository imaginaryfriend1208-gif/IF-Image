#!/usr/bin/env node
// Offline tests for the connection-first image backend facade.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createImageBackend } from '../src/backends/image-backend.js';

function response(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => 'application/json' },
        text: async () => typeof body === 'string' ? body : JSON.stringify(body),
        json: async () => typeof body === 'string' ? JSON.parse(body) : body,
        arrayBuffer: async () => new ArrayBuffer(0),
    };
}

function makeConnection(imageBackend = 'comfy') {
    return {
        imageBackend,
        comfy: {
            url: 'https://images.example', auth: 'configured-credential',
            model: 'Model A', modelList: [], lastFetchedAt: 0, transport: 'direct',
        },
        nai: {
            apiKey: 'configured-credential', model: 'nai-diffusion-4-5-full',
            modelList: [], lastFetchedAt: 0,
        },
    };
}

test('comfy fetchModels uses A1111 discovery and persists cache metadata', async () => {
    const connection = makeConnection('comfy');
    const routes = new Map([
        ['/sdapi/v1/sd-models', response(200, [{ title: 'Model A', model_name: 'model-a' }])],
        ['/sdapi/v1/samplers', response(200, [{ name: 'Euler' }])],
        ['/sdapi/v1/schedulers', response(200, [{ name: 'karras' }])],
        ['/internal/models', response(404, {})],
    ]);
    const facade = createImageBackend(() => connection, {
        fetchImpl: async url => routes.get(new URL(url).pathname) ?? response(404, {}),
    });
    const result = await facade.fetchModels();
    assert.equal(result.backend, 'comfy');
    assert.deepEqual(result.models, ['Model A']);
    assert.deepEqual(connection.comfy.modelList, ['Model A']);
    assert.ok(connection.comfy.lastFetchedAt > 0);
});

test('NAI fetchModels verifies the key and exposes all four static models', async () => {
    const connection = makeConnection('nai');
    let subscriptionCalls = 0;
    const facade = createImageBackend(() => connection, {
        fetchImpl: async url => {
            assert.equal(new URL(url).pathname, '/user/subscription');
            subscriptionCalls += 1;
            return response(200, { active: true, tier: 3 });
        },
    });
    const result = await facade.fetchModels();
    assert.equal(result.backend, 'nai');
    assert.equal(result.verified, true);
    assert.equal(subscriptionCalls, 1);
    assert.deepEqual(result.models, [
        'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated',
        'nai-diffusion-4-full', 'nai-diffusion-3',
    ]);
    assert.deepEqual(connection.nai.modelList, result.models);
});

test('NAI verifyKey reports false for a rejected key without leaking it', async () => {
    const connection = makeConnection('nai');
    const facade = createImageBackend(() => connection, {
        fetchImpl: async () => response(401, { error: 'rejected' }),
    });
    assert.equal(await facade.verifyKey(), false);
});

test('comfy generate uses the connection model default and preserves override_settings contract', async () => {
    const connection = makeConnection('comfy');
    const seen = [];
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const facade = createImageBackend(() => connection, {
        fetchImpl: async (url, init) => {
            const path = new URL(url).pathname;
            const body = init?.body ? JSON.parse(init.body) : null;
            seen.push({ path, body, headers: init?.headers ?? {} });
            if (path === '/sdapi/v1/sd-models') {
                return response(200, [
                    { title: 'Model A', model_name: 'model-a' },
                    { title: 'Model B', model_name: 'model-b' },
                ]);
            }
            return response(200, { images: [png], info: '{"seed":9}' });
        },
    });
    globalThis.URL.createObjectURL ??= () => 'blob:test';
    const result = await facade.generate({
        backend: 'comfy', prompt: 'scene', negative: 'bad',
        params: { width: 832, height: 1216, steps: 16, cfg: 4, seed: -1 },
    });
    assert.equal(result.checkpoint, 'Model A');
    const generation = seen.find(call => call.path === '/sdapi/v1/txt2img');
    assert.equal(generation.body.override_settings.sd_model_checkpoint, 'Model A');
    assert.equal(generation.body.override_settings_restore_afterwards, true);
    assert.equal('model' in generation.body, false);
});

test('explicit comfy model override wins and direct request body contains no auth field', async () => {
    const connection = makeConnection('comfy');
    const seen = [];
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const facade = createImageBackend(() => connection, {
        fetchImpl: async (url, init) => {
            const path = new URL(url).pathname;
            if (path === '/sdapi/v1/sd-models') return response(200, [{ title: 'Model B', model_name: 'model-b' }]);
            seen.push(JSON.parse(init.body));
            return response(200, { images: [png], info: '{}' });
        },
    });
    globalThis.URL.createObjectURL ??= () => 'blob:test';
    await facade.generate({ backend: 'comfy', prompt: 'scene', params: { checkpoint: 'Model B' } });
    assert.equal(seen[0].override_settings.sd_model_checkpoint, 'Model B');
    assert.equal('auth' in seen[0], false);
    assert.ok(!JSON.stringify(seen[0]).includes('configured-credential'));
});

test('relay requests contain auth only in the established relay body field', async () => {
    const connection = makeConnection('comfy');
    connection.comfy.transport = 'st-relay';
    const seen = [];
    const facade = createImageBackend(() => connection, {
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf' }),
        fetchImpl: async (url, init) => {
            const body = JSON.parse(init.body);
            seen.push({ url, body });
            if (url === '/api/sd/models') return response(200, [{ value: 'Model A', text: 'Model A' }]);
            return response(200, []);
        },
    });
    await facade.fetchModels();
    for (const call of seen) {
        assert.deepEqual(Object.keys(call.body).sort(), ['auth', 'url']);
        assert.equal(call.body.auth, 'configured-credential');
    }
});
