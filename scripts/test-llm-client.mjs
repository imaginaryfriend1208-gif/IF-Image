// IF Image - Unit tests for src/llm/client.js request dispatch.
// Focus: the connection_manager method must target the SillyTavern
// connection profile id (stProfileId), never this extension's own
// profile id — sending the wrong id silently reaches another model.
// Run: node scripts/test-llm-client.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlmClient, LlmError } from '../src/llm/client.js';

const REQ = { type: 'image_gen', systemPrompt: 'sys', userPrompt: 'user' };

/**
 * @param {object} opts
 * @param {Array<object>} opts.profiles - settings.llm.apiProfiles
 * @param {string} [opts.defaultApiProfileId]
 * @param {object} [opts.ctx] - extra getContext() fields
 */
function makeClient({ profiles = [], defaultApiProfileId = '', ctx = {} } = {}) {
    const calls = { sendRequest: [], generateRaw: [] };
    const context = {
        generateRaw: async (args) => {
            calls.generateRaw.push(args);
            return 'raw reply';
        },
        ...ctx,
    };
    const client = createLlmClient({
        getSettings: () => ({ llm: { apiProfiles: profiles, defaultApiProfileId } }),
        getContext: () => context,
    });
    return { client, calls, context };
}

/** A stand-in for ST's ConnectionManagerRequestService. */
function makeCmrs(calls, reply = 'cm reply') {
    return {
        sendRequest: async (profileId, messages, maxTokens, opts) => {
            calls.sendRequest.push({ profileId, messages, maxTokens, opts });
            return reply;
        },
    };
}

test('connection_manager: sends the ST connection profile id, not the extension profile id', async () => {
    const calls = { sendRequest: [], generateRaw: [] };
    const { client } = makeClient({
        profiles: [{
            id: 'ifimage_profile_1',
            name: 'Planner',
            method: 'connection_manager',
            stProfileId: 'st_conn_abc',
        }],
        defaultApiProfileId: 'ifimage_profile_1',
        ctx: { ConnectionManagerRequestService: makeCmrs(calls) },
    });

    const result = await client.request(REQ);

    assert.equal(calls.sendRequest.length, 1);
    assert.equal(calls.sendRequest[0].profileId, 'st_conn_abc');
    assert.notEqual(calls.sendRequest[0].profileId, 'ifimage_profile_1');
    assert.equal(result.method, 'connection_manager');
    assert.equal(result.text, 'cm reply');
});

test('connection_manager: system and user prompts are passed as chat messages', async () => {
    const calls = { sendRequest: [], generateRaw: [] };
    const { client } = makeClient({
        profiles: [{ id: 'p1', method: 'connection_manager', stProfileId: 'st_1' }],
        defaultApiProfileId: 'p1',
        ctx: { ConnectionManagerRequestService: makeCmrs(calls) },
    });

    await client.request(REQ);

    const { messages } = calls.sendRequest[0];
    assert.deepEqual(messages, [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user' },
    ]);
});

test('connection_manager: a profile with no stProfileId is a CONFIG error, not a silent fallback', async () => {
    const calls = { sendRequest: [], generateRaw: [] };
    const { client } = makeClient({
        profiles: [{ id: 'p1', name: 'Broken', method: 'connection_manager', stProfileId: '' }],
        defaultApiProfileId: 'p1',
        ctx: { ConnectionManagerRequestService: makeCmrs(calls) },
    });

    await assert.rejects(
        () => client.request(REQ),
        (err) => {
            assert.ok(err instanceof LlmError);
            assert.equal(err.code, 'CONFIG');
            assert.match(err.message, /connection profile/i);
            return true;
        },
    );
    // Nothing was sent anywhere.
    assert.equal(calls.sendRequest.length, 0);
    assert.equal(calls.generateRaw.length, 0);
});

test('connection_manager: falls back to generateRaw when the host lacks the service', async () => {
    const calls = { sendRequest: [], generateRaw: [] };
    const { client } = makeClient({
        profiles: [{ id: 'p1', method: 'connection_manager', stProfileId: 'st_1' }],
        defaultApiProfileId: 'p1',
        ctx: {
            generateRaw: async (args) => { calls.generateRaw.push(args); return 'raw reply'; },
        },
    });

    const warn = console.warn;
    console.warn = () => {};
    let result;
    try {
        result = await client.request(REQ);
    } finally {
        console.warn = warn;
    }

    assert.equal(result.method, 'generateRaw');
    assert.equal(result.text, 'raw reply');
    assert.equal(calls.generateRaw.length, 1);
});

test('connection_manager: extracts content from an object reply', async () => {
    const calls = { sendRequest: [], generateRaw: [] };
    const { client } = makeClient({
        profiles: [{ id: 'p1', method: 'connection_manager', stProfileId: 'st_1' }],
        defaultApiProfileId: 'p1',
        ctx: { ConnectionManagerRequestService: makeCmrs(calls, { content: 'extracted' }) },
    });
    const result = await client.request(REQ);
    assert.equal(result.text, 'extracted');
});

test('generateRaw: used when the profile method is generateRaw', async () => {
    const calls = { sendRequest: [], generateRaw: [] };
    const { client } = makeClient({
        profiles: [{ id: 'p1', method: 'generateRaw', stProfileId: '' }],
        defaultApiProfileId: 'p1',
        ctx: {
            generateRaw: async (args) => { calls.generateRaw.push(args); return 'raw reply'; },
            ConnectionManagerRequestService: makeCmrs(calls),
        },
    });

    const result = await client.request(REQ);

    assert.equal(result.method, 'generateRaw');
    assert.equal(calls.generateRaw.length, 1);
    assert.equal(calls.generateRaw[0].prompt, 'user');
    assert.equal(calls.generateRaw[0].systemPrompt, 'sys');
    // The Connection Manager was never consulted for this method.
    assert.equal(calls.sendRequest.length, 0);
});

test('request: missing type or userPrompt is a CONFIG error', async () => {
    const { client } = makeClient();
    await assert.rejects(() => client.request({ userPrompt: 'x' }), (e) => e.code === 'CONFIG');
    await assert.rejects(() => client.request({ type: 'image_gen' }), (e) => e.code === 'CONFIG');
});

test('direct_fetch: a profile without baseUrl/model is a CONFIG error', async () => {
    const { client } = makeClient({
        profiles: [{ id: 'p1', method: 'direct_fetch', baseUrl: '', model: '' }],
        defaultApiProfileId: 'p1',
    });
    await assert.rejects(
        () => client.request(REQ),
        (e) => e.code === 'CONFIG' && /baseUrl and model/.test(e.message),
    );
});


test('generateRaw: unavailable host API is an actionable CONFIG error', async () => {
    const { client } = makeClient({ ctx: { generateRaw: undefined } });
    await assert.rejects(
        () => client.request(REQ),
        (err) => err instanceof LlmError && err.code === 'CONFIG'
            && /direct_fetch or connection_manager/.test(err.message),
    );
});

test('generateRaw: thrown errors are NETWORK errors with sanitized detail', async () => {
    const logged = [];
    const originalError = console.error;
    console.error = (...args) => logged.push(args);
    try {
        const { client } = makeClient({
            ctx: { generateRaw: async () => { throw new Error('upstream Bearer super-secret-token'); } },
        });
        await assert.rejects(
            () => client.request(REQ),
            (err) => err.code === 'NETWORK' && /generateRaw failed/.test(err.message)
                && !err.message.includes('super-secret-token'),
        );
    } finally {
        console.error = originalError;
    }
    assert.equal(JSON.stringify(logged).includes('super-secret-token'), false);
    assert.equal(JSON.stringify(logged).includes('[redacted]'), true);
});

test('generateRaw: non-string replies remain MALFORMED rather than NETWORK', async () => {
    const { client } = makeClient({ ctx: { generateRaw: async () => ({ content: 'wrong shape' }) } });
    await assert.rejects(() => client.request(REQ), (err) => err.code === 'MALFORMED');
});

test('generateRaw: diagnostics contain lengths but not prompt contents', async () => {
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args);
    try {
        const { client } = makeClient({ ctx: { main_api: 'openai' } });
        await client.request({ type: 'image_gen', systemPrompt: 'secret-system', userPrompt: 'secret-user' });
    } finally {
        console.log = originalLog;
    }
    const metadata = logged.find(args => args[0] === '[IF Image] callGenerateRaw:')?.[1];
    assert.deepEqual(metadata, {
        hasGenerateRaw: true,
        mainApi: 'openai',
        promptLen: 'secret-user'.length,
        systemPromptLen: 'secret-system'.length,
    });
    assert.equal(JSON.stringify(logged).includes('secret-user'), false);
    assert.equal(JSON.stringify(logged).includes('secret-system'), false);
});
