#!/usr/bin/env node
// Offline executor tests: mocked backend clients, no fetch, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExecutor } from '../src/runtime/executor.js';

const settings = () => ({
    backends: {
        nai: { apiKey: 'pst-secret', model: 'nai-diffusion-4-5-full' },
        comfy: { proxyModel: 'proxy-anima' },
        a1111: { checkpoint: 'ckpt-a' },
    },
});

function blob() {
    return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
}

function makeClients(overrides = {}) {
    const calls = [];
    const clients = {
        nai: { generate: async (opts) => { calls.push(['nai', opts]); return blob(); } },
        comfy: { txt2img: async (body, opts) => { calls.push(['comfy', body, opts]); return { image: blob(), info: { seed: 42 } }; } },
        a1111: {
            models: async () => [{ title: 'ckpt-a', model_name: 'ckpt-a', filename: null }],
            txt2img: async (body, opts) => { calls.push(['a1111', body, opts]); return { image: blob(), info: { seed: 7 } }; },
        },
        ...overrides,
    };
    return { clients, calls };
}

const envelope = { prompt: '1girl, city', negative: 'bad', params: { width: 832, height: 1216, steps: 16, cfg: 4, seed: -1 } };
const task = (kind, profile = 'anima') => ({ id: 't1', prompt: envelope, backend: { kind }, profile });

test('createExecutor validates clients', () => {
    assert.throws(() => createExecutor({ nai: null, comfy: {}, a1111: {}, getSettings: settings }), TypeError);
});

test('comfy dispatch: uses proxyModel, passes signal, returns result shape', async () => {
    const { clients, calls } = makeClients();
    const execute = createExecutor({ ...clients, getSettings: settings });
    const controller = new AbortController();
    const result = await execute(task('comfy'), controller.signal);
    assert.equal(calls[0][0], 'comfy');
    assert.equal(calls[0][1].model, 'proxy-anima');
    assert.equal(calls[0][1].prompt, '1girl, city');
    assert.equal(calls[0][2].signal, controller.signal);
    assert.ok(result.blob instanceof Blob);
    assert.equal(result.seed, 42);
    assert.equal(result.backend, 'comfy');
    assert.equal(result.profileKey, 'anima');
    assert.equal(result.width, 832);
    assert.equal(typeof result.elapsedMs, 'number');
});

test('comfy without proxyModel is a config error, no request', async () => {
    const { clients, calls } = makeClients();
    const execute = createExecutor({ ...clients, getSettings: () => ({ backends: { ...settings().backends, comfy: { proxyModel: '' } } }) });
    await assert.rejects(execute(task('comfy'), new AbortController().signal), err => err.code === 'COMFY_CONFIG');
    assert.equal(calls.length, 0);
});

test('nai dispatch: precomputes seed when -1 and passes signal', async () => {
    const { clients, calls } = makeClients();
    const execute = createExecutor({ ...clients, getSettings: settings });
    const controller = new AbortController();
    const result = await execute(task('nai'), controller.signal);
    assert.equal(calls[0][0], 'nai');
    assert.ok(calls[0][1].seed >= 0);
    assert.equal(calls[0][1].seed, result.seed);
    assert.equal(calls[0][1].scale, 4);
    assert.equal(calls[0][1].signal, controller.signal);
    assert.equal(result.backend, 'nai');
});

test('a1111 dispatch: resolves checkpoint from fresh discovery', async () => {
    const { clients, calls } = makeClients();
    const execute = createExecutor({ ...clients, getSettings: settings });
    const result = await execute(task('a1111'), new AbortController().signal);
    assert.equal(calls[0][0], 'a1111');
    assert.equal(calls[0][1].checkpoint, 'ckpt-a');
    assert.equal(result.seed, 7);
    assert.equal(result.checkpoint, 'ckpt-a', 'R2: result carries the resolved checkpoint');
});

test('a1111 with stale checkpoint fails before txt2img with a named message', async () => {
    const { clients, calls } = makeClients();
    const execute = createExecutor({ ...clients, getSettings: () => ({ backends: { ...settings().backends, a1111: { checkpoint: 'gone' } } }) });
    await assert.rejects(execute(task('a1111'), new AbortController().signal), err => {
        assert.equal(err.code, 'EXECUTOR_CONFIG');
        assert.match(err.message, /"gone" is no longer offered by the server/);
        assert.match(err.message, /Test connection/);
        return true;
    });
    assert.equal(calls.length, 0);
});

// ---- R2: envelope checkpoint/sampler/scheduler ------------------------------

const r2task = (params) => ({
    id: 't2',
    prompt: { ...envelope, params: { ...envelope.params, ...params } },
    backend: { kind: 'a1111' },
    profile: 'anima',
});

test('R2: params.checkpoint is preferred over settings checkpoints', async () => {
    const { clients, calls } = makeClients({
        a1111: {
            models: async () => [
                { title: 'ckpt-a', model_name: 'ckpt-a', filename: null },
                { title: 'ckpt-envelope', model_name: 'ckpt-envelope', filename: null },
            ],
            txt2img: async (body, opts) => { calls.push(['a1111', body, opts]); return { image: blob(), info: { seed: 7 } }; },
        },
    });
    const execute = createExecutor({
        ...clients,
        getSettings: () => ({ backends: settings().backends, generation: { checkpoint: 'ckpt-a' } }),
    });
    const result = await execute(r2task({ checkpoint: 'ckpt-envelope' }), new AbortController().signal);
    assert.equal(calls[0][1].checkpoint, 'ckpt-envelope');
    assert.equal(result.checkpoint, 'ckpt-envelope');
});

test('R2: generation.checkpoint is used when the envelope has none', async () => {
    const { clients, calls } = makeClients({
        a1111: {
            models: async () => [{ title: 'gen-choice', model_name: 'gen-choice', filename: null }],
            txt2img: async (body, opts) => { calls.push(['a1111', body, opts]); return { image: blob(), info: { seed: 7 } }; },
        },
    });
    const execute = createExecutor({
        ...clients,
        getSettings: () => ({ backends: { ...settings().backends, a1111: { checkpoint: 'old-field' } }, generation: { checkpoint: 'gen-choice' } }),
    });
    await execute(task('a1111'), new AbortController().signal);
    assert.equal(calls[0][1].checkpoint, 'gen-choice');
});

test('R2: unresolved envelope checkpoint throws EXECUTOR_CONFIG naming the title', async () => {
    const { clients, calls } = makeClients();
    const execute = createExecutor({ ...clients, getSettings: settings });
    await assert.rejects(execute(r2task({ checkpoint: 'vanished-model' }), new AbortController().signal), err => {
        assert.equal(err.code, 'EXECUTOR_CONFIG');
        assert.match(err.message, /"vanished-model" is no longer offered/);
        return true;
    });
    assert.equal(calls.length, 0);
});

test('R2: sampler/scheduler are forwarded as sampler_name/scheduler when present', async () => {
    const { clients, calls } = makeClients();
    const execute = createExecutor({ ...clients, getSettings: settings });
    await execute(r2task({ checkpoint: 'ckpt-a', sampler: 'Euler a', scheduler: 'karras' }), new AbortController().signal);
    assert.equal(calls[0][1].sampler_name, 'Euler a');
    assert.equal(calls[0][1].scheduler, 'karras');
    // Absent -> not sent at all.
    calls.length = 0;
    await execute(r2task({ checkpoint: 'ckpt-a' }), new AbortController().signal);
    assert.equal('sampler_name' in calls[0][1], false);
    assert.equal('scheduler' in calls[0][1], false);
});

test('abort mid-flight rejects', async () => {
    const { clients } = makeClients({
        comfy: {
            txt2img: (body, { signal }) => new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'COMFY_ABORTED' })));
            }),
        },
    });
    const execute = createExecutor({ ...clients, getSettings: settings });
    const controller = new AbortController();
    const pending = execute(task('comfy'), controller.signal);
    controller.abort();
    await assert.rejects(pending, err => err.code === 'COMFY_ABORTED');
});

test('unknown backend throws without calling any client', async () => {
    const { clients, calls } = makeClients();
    const execute = createExecutor({ ...clients, getSettings: settings });
    await assert.rejects(execute(task('nope'), new AbortController().signal), err => err.code === 'EXECUTOR_CONFIG');
    assert.equal(calls.length, 0);
});

test('result never contains credentials', async () => {
    const { clients } = makeClients();
    const execute = createExecutor({ ...clients, getSettings: settings });
    const result = await execute(task('nai'), new AbortController().signal);
    assert.ok(!JSON.stringify({ ...result, blob: null }).includes('pst-secret'));
});
