#!/usr/bin/env node
// Connection-first LLM client tests. All network is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createLlmClient, formatLlmError, listStProfiles, LlmError, resolveLlmTarget,
} from '../src/llm/client.js';

const TYPES = [
    'image_gen', 'char_design', 'char_modify', 'tag_modify',
    'translation', 'persona_gen', 'chat_place', 'chat_rewrite',
];
const request = type => ({ type, systemPrompt: `system-${type}`, userPrompt: `user-${type}` });

function stFixture({ selected = 'st-one', profiles, service } = {}) {
    const calls = [];
    const stProfiles = profiles ?? [{ id: 'st-one', name: 'Primary' }, { id: 'st-two', name: 'Other' }];
    const ctx = {
        extensionSettings: { connectionManager: { profiles: stProfiles } },
        ConnectionManagerRequestService: service ?? {
            sendRequest: async (profileId, messages, maxTokens, options) => {
                calls.push({ profileId, messages, maxTokens, options });
                return { content: 'ST reply' };
            },
        },
    };
    const settings = { connection: { llm: { mode: 'st_profile', stProfileId: selected, custom: {} } } };
    return {
        calls,
        client: createLlmClient({ getSettings: () => settings, getContext: () => ctx }),
        ctx,
        settings,
    };
}

function response(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => typeof body === 'string' ? body : JSON.stringify(body),
        json: async () => typeof body === 'string' ? JSON.parse(body) : body,
    };
}

test('resolveLlmTarget returns only the canonical ST or custom target', () => {
    assert.deepEqual(resolveLlmTarget({ connection: { llm: { mode: 'st_profile', stProfileId: 'p1' } } }), {
        mode: 'st_profile', stProfileId: 'p1',
    });
    assert.deepEqual(resolveLlmTarget({ connection: { llm: { mode: 'custom', custom: {
        baseUrl: ' https://llm.example/ ', apiKey: 'configured-credential', model: ' model-x ',
    } } } }), {
        mode: 'custom', baseUrl: 'https://llm.example/', apiKey: 'configured-credential', model: 'model-x',
    });
    assert.throws(() => resolveLlmTarget({}), error => error.code === 'CONFIG');
});

test('listStProfiles returns safe id/name metadata only', () => {
    const list = listStProfiles({ extensionSettings: { connectionManager: { profiles: [
        { id: 'p1', name: 'One', api: 'openai', secret: 'configured-credential' },
        { id: '', name: 'Invalid' },
        null,
    ] } } });
    assert.deepEqual(list, [{ id: 'p1', name: 'One' }]);
    assert.equal(JSON.stringify(list).includes('configured-credential'), false);
});

test('all eight request types use the same ST profile target', async () => {
    const { client, calls } = stFixture();
    for (const type of TYPES) {
        const result = await client.request(request(type));
        assert.equal(result.text, 'ST reply');
        assert.equal(result.method, 'st_profile');
    }
    assert.equal(calls.length, TYPES.length);
    assert.deepEqual(calls.map(call => call.profileId), TYPES.map(() => 'st-one'));
    assert.deepEqual(calls[0].messages, [
        { role: 'system', content: 'system-image_gen' },
        { role: 'user', content: 'user-image_gen' },
    ]);
    assert.equal(calls[0].maxTokens, 4096);
});

test('request ignores legacy API profiles and does not accept a per-call override', async () => {
    const { calls, ctx, settings } = stFixture();
    settings.llm = {
        defaultApiProfileId: 'legacy-two',
        requestMapping: { image_gen: { apiProfileId: 'legacy-three' } },
        apiProfiles: [{ id: 'legacy-two', stProfileId: 'st-two' }],
    };
    const client = createLlmClient({ getSettings: () => settings, getContext: () => ctx });
    await client.request({ ...request('image_gen'), profileId: 'st-two' });
    assert.equal(calls[0].profileId, 'st-one');
});

test('missing ST profile id is CONFIG and no request is sent', async () => {
    const { client, calls } = stFixture({ selected: 'deleted-profile' });
    await assert.rejects(client.request(request('image_gen')), error => error.code === 'CONFIG' && !error.message.includes('configured-credential'));
    assert.equal(calls.length, 0);
});

test('missing ConnectionManagerRequestService is METHOD_UNAVAILABLE with no generateRaw fallback', async () => {
    const fixture = stFixture({ service: {} });
    fixture.ctx.generateRaw = async () => { throw new Error('must not be called'); };
    await assert.rejects(fixture.client.request(request('image_gen')), error => error.code === 'METHOD_UNAVAILABLE');
});

test('ST abort is normalized and signal is passed unchanged', async () => {
    const controller = new AbortController();
    let seenSignal;
    const { client } = stFixture({ service: {
        sendRequest: async (_id, _messages, _tokens, options) => {
            seenSignal = options.signal;
            return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError'))));
        },
    } });
    const pending = client.request({ ...request('image_gen'), signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, error => error.code === 'ABORTED');
    assert.equal(seenSignal, controller.signal);
});

test('custom mode sends Authorization header without exposing its value elsewhere', async () => {
    const seen = [];
    const settings = { connection: { llm: { mode: 'custom', custom: {
        baseUrl: 'https://llm.example/api', apiKey: 'configured-credential', model: 'model-x',
    } } } };
    const client = createLlmClient({
        getSettings: () => settings,
        getContext: () => ({}),
        fetchImpl: async (url, init) => {
            seen.push({ url, init });
            return response(200, { choices: [{ message: { content: 'custom reply' } }] });
        },
    });
    const result = await client.request(request('translation'));
    assert.equal(result.text, 'custom reply');
    assert.equal(result.method, 'custom');
    assert.equal(seen.length, 1);
    assert.ok(Object.hasOwn(seen[0].init.headers, 'Authorization'));
    assert.equal(seen[0].url, 'https://llm.example/api/v1/chat/completions');
    assert.equal(JSON.stringify(result).includes('configured-credential'), false);
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.model, 'model-x');
    assert.equal(JSON.stringify(body).includes('configured-credential'), false);
});

test('custom mode validates URL/config and normalizes HTTP/malformed errors', async () => {
    const make = (custom, fetchImpl) => createLlmClient({
        getSettings: () => ({ connection: { llm: { mode: 'custom', custom } } }),
        getContext: () => ({}), fetchImpl,
    });
    await assert.rejects(make({ baseUrl: '', model: '' }).request(request('image_gen')), error => error.code === 'CONFIG');
    await assert.rejects(make({ baseUrl: 'data:text/plain,x', model: 'm' }).request(request('image_gen')), error => error.code === 'CONFIG');
    await assert.rejects(
        make({ baseUrl: 'https://llm.example', model: 'm' }, async () => response(401, 'rejected')).request(request('image_gen')),
        error => error.code === 'HTTP',
    );
    await assert.rejects(
        make({ baseUrl: 'https://llm.example', model: 'm' }, async () => response(200, {})).request(request('image_gen')),
        error => error.code === 'MALFORMED',
    );
});

test('request validates required fields and friendly messages redact credentials', async () => {
    const { client } = stFixture();
    await assert.rejects(client.request({ userPrompt: 'x' }), error => error.code === 'CONFIG');
    await assert.rejects(client.request({ type: 'image_gen' }), error => error.code === 'CONFIG');
    const message = formatLlmError(new LlmError('NETWORK', 'Bearer configured-credential'));
    assert.match(message, /selected target/i);
    assert.doesNotMatch(message, /configured-credential/);
    assert.match(message, /\[redacted\]/);
});
