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
});

test('a1111 with stale checkpoint fails before txt2img', async () => {
    const { clients, calls } = makeClients();
    const execute = createExecutor({ ...clients, getSettings: () => ({ backends: { ...settings().backends, a1111: { checkpoint: 'gone' } } }) });
    await assert.rejects(execute(task('a1111'), new AbortController().signal), err => err.code === 'A1111_CONFIG');
    assert.equal(calls.length, 0);
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
