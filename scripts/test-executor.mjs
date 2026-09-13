#!/usr/bin/env node
// Offline connection-first executor tests: mocked facade, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExecutor } from '../src/runtime/executor.js';

const settings = () => ({
    connection: {
        imageBackend: 'comfy',
        comfy: { model: 'ckpt-default' },
        nai: { apiKey: 'configured-credential', model: 'nai-diffusion-4-5-full' },
    },
});

function blob() {
    return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
}

function makeBackend(implementation) {
    const calls = [];
    const imageBackend = {
        generate: async (request, options) => {
            calls.push([request, options]);
            if (implementation) return implementation(request, options);
            return {
                blob: blob(),
                seed: request.backend === 'nai' ? request.params.seed : 7,
                backend: request.backend,
                model: request.params.model ?? request.params.checkpoint,
                checkpoint: request.params.checkpoint,
            };
        },
    };
    return { imageBackend, calls };
}

const envelope = {
    prompt: '1girl, city',
    negative: 'bad',
    params: { width: 832, height: 1216, steps: 16, cfg: 4, seed: -1 },
};
const task = (kind, prompt = envelope) => ({ id: 't1', prompt, backend: { kind }, profile: 'anima' });

function executor(facade, getSettings = settings) {
    return createExecutor({ imageBackend: facade, getSettings });
}

test('createExecutor validates facade and settings getter', () => {
    assert.throws(() => createExecutor({ imageBackend: null, getSettings: settings }), TypeError);
    assert.throws(() => createExecutor({ imageBackend: {}, getSettings: settings }), TypeError);
    assert.throws(() => createExecutor({ imageBackend: { generate() {} } }), TypeError);
});

test('comfy dispatch uses connection.comfy.model and returns the canonical shape', async () => {
    const { imageBackend, calls } = makeBackend();
    const result = await executor(imageBackend)(task('comfy'), new AbortController().signal);
    assert.equal(calls[0][0].backend, 'comfy');
    assert.equal(calls[0][0].params.checkpoint, 'ckpt-default');
    assert.equal(calls[0][0].prompt, '1girl, city');
    assert.ok(result.blob instanceof Blob);
    assert.equal(result.backend, 'comfy');
    assert.equal(result.checkpoint, 'ckpt-default');
    assert.equal(result.profileKey, 'anima');
    assert.equal(result.width, 832);
    assert.equal(typeof result.elapsedMs, 'number');
});

test('legacy a1111 task kind is normalized to public comfy backend', async () => {
    const { imageBackend, calls } = makeBackend();
    const result = await executor(imageBackend)(task('a1111'), new AbortController().signal);
    assert.equal(calls[0][0].backend, 'comfy');
    assert.equal(result.backend, 'comfy');
});

test('NAI dispatch uses connection.nai.model and precomputes a random seed', async () => {
    const { imageBackend, calls } = makeBackend();
    const result = await executor(imageBackend)(task('nai'), new AbortController().signal);
    assert.equal(calls[0][0].backend, 'nai');
    assert.equal(calls[0][0].params.model, 'nai-diffusion-4-5-full');
    assert.ok(calls[0][0].params.seed >= 0);
    assert.equal(result.seed, calls[0][0].params.seed);
    assert.equal(result.backend, 'nai');
});

test('explicit envelope checkpoint overrides the comfy connection model', async () => {
    const { imageBackend, calls } = makeBackend();
    const prompt = { ...envelope, params: { ...envelope.params, checkpoint: 'ckpt-marker' } };
    const result = await executor(imageBackend)(task('comfy', prompt), new AbortController().signal);
    assert.equal(calls[0][0].params.checkpoint, 'ckpt-marker');
    assert.equal(result.checkpoint, 'ckpt-marker');
});

test('explicit envelope model overrides the NAI connection model', async () => {
    const { imageBackend, calls } = makeBackend();
    const prompt = { ...envelope, params: { ...envelope.params, model: 'nai-diffusion-3', seed: 12 } };
    await executor(imageBackend)(task('nai', prompt), new AbortController().signal);
    assert.equal(calls[0][0].params.model, 'nai-diffusion-3');
    assert.equal(calls[0][0].params.seed, 12);
});

test('sampler and scheduler overrides are forwarded only when populated', async () => {
    const { imageBackend, calls } = makeBackend();
    const prompt = { ...envelope, params: { ...envelope.params, sampler: 'Euler a', scheduler: 'karras' } };
    await executor(imageBackend)(task('comfy', prompt), new AbortController().signal);
    assert.equal(calls[0][0].params.sampler, 'Euler a');
    assert.equal(calls[0][0].params.scheduler, 'karras');
    calls.length = 0;
    await executor(imageBackend)(task('comfy'), new AbortController().signal);
    assert.equal('sampler' in calls[0][0].params, false);
    assert.equal('scheduler' in calls[0][0].params, false);
});

test('dimensions and numeric parameters receive stable fallbacks', async () => {
    const { imageBackend, calls } = makeBackend();
    const prompt = { prompt: 'x', negative: '', params: { width: 'bad', height: 0, cfg: 'bad' } };
    await executor(imageBackend)(task('comfy', prompt), new AbortController().signal);
    assert.deepEqual(
        Object.fromEntries(['width', 'height', 'steps', 'cfg', 'seed'].map(key => [key, calls[0][0].params[key]])),
        { width: 832, height: 1216, steps: 16, cfg: 4, seed: -1 },
    );
});

test('missing task backend uses connection.imageBackend', async () => {
    const { imageBackend, calls } = makeBackend();
    const execute = executor(imageBackend, () => ({ connection: { ...settings().connection, imageBackend: 'nai' } }));
    await execute({ prompt: envelope, profile: 'anima' }, new AbortController().signal);
    assert.equal(calls[0][0].backend, 'nai');
});

test('abort signal is passed unchanged to the facade', async () => {
    const controller = new AbortController();
    const { imageBackend } = makeBackend((_request, options) => new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ABORTED' })));
    }));
    const pending = executor(imageBackend)(task('comfy'), controller.signal);
    controller.abort();
    await assert.rejects(pending, error => error.code === 'ABORTED');
});

test('unknown backend throws without calling the facade', async () => {
    const { imageBackend, calls } = makeBackend();
    await assert.rejects(executor(imageBackend)(task('unknown'), new AbortController().signal), error => error.code === 'EXECUTOR_CONFIG');
    assert.equal(calls.length, 0);
});

test('empty characters are removed before facade dispatch', async () => {
    const { imageBackend, calls } = makeBackend();
    const prompt = { ...envelope, characters: ['first', '', null, 'second'] };
    await executor(imageBackend)(task('nai', prompt), new AbortController().signal);
    assert.deepEqual(calls[0][0].characters, ['first', 'second']);
});

test('task snapshots and executor results never contain credentials', async () => {
    const { imageBackend } = makeBackend();
    const input = task('nai');
    const result = await executor(imageBackend)(input, new AbortController().signal);
    const serialized = JSON.stringify({ input, result: { ...result, blob: null } });
    assert.ok(!serialized.includes('configured-credential'));
});
