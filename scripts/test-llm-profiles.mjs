#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    API_PROFILE_EXPORT_FORMAT, API_PROFILE_EXPORT_VERSION,
    buildApiProfileExport, validateApiProfileImport, importApiProfiles,
} from '../src/llm/profiles.js';
import { LlmError, formatLlmError } from '../src/llm/client.js';

function doc(profiles) {
    return { format: API_PROFILE_EXPORT_FORMAT, version: API_PROFILE_EXPORT_VERSION, profiles };
}

const direct = {
    id: 'direct-1', name: 'Portable', method: 'direct_fetch',
    baseUrl: 'https://user:pass@example.test/v1?api_key=secret&region=eu#token',
    apiKey: 'top-secret', model: 'model-a', temperature: 0.4, maxTokens: 1234,
};

test('profile export omits API keys and strips URL credentials', () => {
    const exported = buildApiProfileExport({ llm: { apiProfiles: [direct] } });
    const serialized = JSON.stringify(exported);
    assert.equal(exported.credentialsIncluded, false);
    assert.equal('apiKey' in exported.profiles[0], false);
    assert.equal(exported.profiles[0].baseUrl, 'https://example.test/v1?region=eu');
    assert.doesNotMatch(serialized, /top-secret|user|pass|api_key|#token/);
});

test('profile import ignores a manually injected key and normalizes bounds', () => {
    const input = doc([{ ...direct, baseUrl: 'https://example.test/v1', apiKey: 'injected', temperature: 9, maxTokens: -2 }]);
    const [profile] = validateApiProfileImport(input).profiles;
    assert.equal(profile.apiKey, '');
    assert.equal(profile.temperature, 2);
    assert.equal(profile.maxTokens, 1);
});

test('replace import preserves a locally stored key', () => {
    const settings = { llm: { apiProfiles: [{ ...direct, apiKey: 'local-key' }] } };
    const input = doc([{ ...direct, baseUrl: 'https://new.example/v1', model: 'new-model', apiKey: 'foreign' }]);
    const result = importApiProfiles(settings, input, { conflict: 'replace' });
    assert.deepEqual({ added: result.added, replaced: result.replaced, skipped: result.skipped }, { added: 0, replaced: 1, skipped: 0 });
    assert.equal(settings.llm.apiProfiles[0].apiKey, 'local-key');
    assert.equal(settings.llm.apiProfiles[0].model, 'new-model');
});

test('copy and skip conflict modes do not overwrite the local profile', () => {
    const settings = { llm: { apiProfiles: [{ ...direct, apiKey: 'local-key' }] } };
    const input = doc([{ ...direct, baseUrl: 'https://example.test/v1' }]);
    const copy = importApiProfiles(settings, input, { conflict: 'copy' });
    assert.equal(copy.added, 1);
    assert.notEqual(copy.profiles[0].id, direct.id);
    assert.match(copy.profiles[0].name, /Imported/);
    const skip = importApiProfiles(settings, input, { conflict: 'skip' });
    assert.equal(skip.skipped, 1);
    assert.equal(settings.llm.apiProfiles[0].apiKey, 'local-key');
});

test('import rejects bad format, duplicate ids, unsafe direct URLs, and methods', () => {
    assert.throws(() => validateApiProfileImport({}), /format/i);
    assert.throws(() => validateApiProfileImport(doc([{ ...direct, baseUrl: 'https://example.test/v1' }, { ...direct, baseUrl: 'https://example.test/v1' }])), /duplicate/i);
    assert.throws(() => validateApiProfileImport(doc([{ ...direct, baseUrl: 'data:text/plain,x' }])), /safe base URL/i);
    assert.throws(() => validateApiProfileImport(doc([{ ...direct, baseUrl: 'https://example.test/v1', method: 'unknown' }])), /unsupported method/i);
});

test('friendly LLM errors are actionable and sanitized', () => {
    const message = formatLlmError(new LlmError('NETWORK', 'generateRaw failed: Bearer hidden-token'), 'Plan & Place');
    assert.match(message, /LLM connection failed/);
    assert.match(message, /check the selected API profile/i);
    assert.doesNotMatch(message, /hidden-token/);
    assert.match(message, /\[redacted\]/);
    assert.equal(formatLlmError(new LlmError('ABORTED', 'x'), 'Profile test'), 'Profile test was cancelled.');
});
