#!/usr/bin/env node
// Offline Comfy proxy client hardening tests (B5): injected fetch, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComfyProxyClient } from '../src/backends/comfy.js';

const PASS = 'hunter2-secret';
const cfg = () => ({ getBaseUrl: () => 'http://localhost:7861/', getUsername: () => 'user', getPassword: () => PASS });

function response(status, body, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    };
}

test('sends Basic auth, redirect:"error", and trailing slash is trimmed', async () => {
    const seen = [];
    const client = new ComfyProxyClient({ ...cfg(), fetchImpl: async (url, init) => { seen.push([url, init]); return response(200, { ok: true }); } });
    await client.ping();
    assert.equal(seen[0][0], 'http://localhost:7861/internal/ping');
    assert.equal(seen[0][1].redirect, 'error');
    assert.equal(seen[0][1].headers.Authorization, 'Basic ' + Buffer.from(`user:${PASS}`).toString('base64'));
});

test('401/403 -> COMFY_AUTH and the password never appears in the message', async () => {
    const client = new ComfyProxyClient({ ...cfg(), fetchImpl: async () => response(401, { error: `bad creds for user:${PASS}` }) });
    await assert.rejects(client.models(), err => {
        assert.equal(err.code, 'COMFY_AUTH');
        assert.ok(!err.message.includes(PASS));
        assert.ok(err.message.includes('***'));
        return true;
    });
});

test('HTTP error detail is bounded and redacted; 3xx is COMFY_REDIRECT', async () => {
    const long = 'x'.repeat(2000) + PASS;
    const client = new ComfyProxyClient({ ...cfg(), fetchImpl: async () => response(500, long) });
    await assert.rejects(client.txt2img({ prompt: 'a' }), err => err.code === 'COMFY_HTTP' && !err.message.includes(PASS) && err.message.length < 500);
    const redirecting = new ComfyProxyClient({ ...cfg(), fetchImpl: async () => response(302, '') });
    await assert.rejects(redirecting.ping(), err => err.code === 'COMFY_REDIRECT');
});

test('timeout aborts with COMFY_TIMEOUT; external abort is COMFY_ABORTED', async () => {
    const hang = (url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const client = new ComfyProxyClient({ ...cfg(), fetchImpl: hang });
    await assert.rejects(client._request('/internal/ping', { timeoutMs: 10 }), err => err.code === 'COMFY_TIMEOUT');
    const controller = new AbortController();
    const pending = client.txt2img({ prompt: 'a' }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, err => err.code === 'COMFY_ABORTED');
    controller.abort();
    await assert.rejects(client.models({ signal: controller.signal }), err => err.code === 'COMFY_ABORTED');
});

test('network failure -> COMFY_NETWORK without credentials; empty base URL -> COMFY_CONFIG', async () => {
    const client = new ComfyProxyClient({ ...cfg(), fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    await assert.rejects(client.ping(), err => err.code === 'COMFY_NETWORK' && !err.message.includes(PASS));
    const empty = new ComfyProxyClient({ ...cfg(), getBaseUrl: () => '', fetchImpl: async () => response(200, {}) });
    await assert.rejects(empty.ping(), err => err.code === 'COMFY_CONFIG');
});

test('txt2img clamps params, parses info, returns Blob; empty images is COMFY_MALFORMED', async () => {
    const seen = [];
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const client = new ComfyProxyClient({
        ...cfg(),
        fetchImpl: async (url, init) => { seen.push(JSON.parse(init.body)); return response(200, { images: [png], info: JSON.stringify({ seed: 5 }) }); },
    });
    globalThis.URL.createObjectURL ??= () => 'blob:test';
    const result = await client.txt2img({ prompt: 'a', width: 10, steps: 999, cfg_scale: 4.5, seed: -1 });
    assert.equal(seen[0].width, 64);
    assert.equal(seen[0].steps, 200);
    assert.equal(seen[0].seed, -1);
    assert.ok(result.image instanceof Blob);
    assert.equal(result.info.seed, 5);
    const noImage = new ComfyProxyClient({ ...cfg(), fetchImpl: async () => response(200, { images: [] }) });
    await assert.rejects(noImage.txt2img({ prompt: 'a' }), err => err.code === 'COMFY_MALFORMED');
});
