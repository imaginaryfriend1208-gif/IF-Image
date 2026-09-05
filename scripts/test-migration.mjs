#!/usr/bin/env node
// IF Image - migration round-trip tests.
// Run: node scripts/test-migration.mjs

import assert from 'node:assert/strict';

// We can't import settings.js (it imports ST modules), so we import migration
// directly and simulate what getSettings() does.
import { runMigrations, CURRENT_VERSION, migrators } from '../src/migration.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.message}`);
        failed++;
    }
}

console.log('Migration tests');
console.log(`  CURRENT_VERSION = ${CURRENT_VERSION}`);

// --- Test 1: fresh settings (already at current version) ---
test('fresh settings with current version are not migrated', () => {
    const s = { settingsVersion: CURRENT_VERSION, enabled: true };
    const ran = runMigrations(s);
    assert.equal(ran, false);
    assert.equal(s.settingsVersion, CURRENT_VERSION);
});

// --- Test 2: v0.1.0 legacy (no settingsVersion) ---
test('v0.1.0 settings (no version) migrate to current', () => {
    const legacy = {
        enabled: true,
        backends: {
            nai: { apiKey: 'pst-test123', model: 'nai-diffusion-4-5-full' },
            comfy: { baseUrl: 'http://localhost:7861', username: 'u', password: 'p', profile: 'anima' },
        },
        test: { prompt: 'hello', negative: '', width: 832, height: 1216, steps: 16, cfg: 4, seed: -1, backend: 'comfy', profile: 'anima' },
    };
    const ran = runMigrations(legacy);
    assert.equal(ran, true);
    assert.equal(legacy.settingsVersion, CURRENT_VERSION);
    // Credentials must survive
    assert.equal(legacy.backends.nai.apiKey, 'pst-test123');
    assert.equal(legacy.backends.comfy.username, 'u');
    assert.equal(legacy.backends.comfy.password, 'p');
    // Test params must survive
    assert.equal(legacy.test.prompt, 'hello');
    assert.equal(legacy.test.width, 832);
});

// --- Test 3: v0.1.0 legacy gets new sections from migrator 1→2 ---
test('v0.1.0 gets llm and generation sections after migration', () => {
    const legacy = { enabled: true, backends: { nai: {}, comfy: {} }, test: {} };
    runMigrations(legacy);
    assert.ok(legacy.llm, 'llm section should exist');
    assert.equal(legacy.llm.defaultMethod, 'direct');
    assert.ok(legacy.generation, 'generation section should exist');
    assert.equal(legacy.generation.mode, 'direct');
    assert.equal(legacy.generation.startTag, 'image###');
    assert.equal(legacy.generation.endTag, '###');
});

// --- Test 4: idempotent — running twice does nothing ---
test('migration is idempotent', () => {
    const s = { enabled: true };
    runMigrations(s);
    const v1 = s.settingsVersion;
    const snap = JSON.stringify(s);
    const ran = runMigrations(s);
    assert.equal(ran, false);
    assert.equal(JSON.stringify(s), snap);
    assert.equal(s.settingsVersion, v1);
});

// --- Test 5: existing llm/generation not overwritten ---
test('existing llm/generation fields preserved during migration', () => {
    const s = {
        enabled: true,
        llm: { apiProfiles: [{ name: 'custom' }], defaultMethod: 'st_proxy' },
        generation: { mode: 'full', startTag: 'img[[', endTag: ']]', enabled: false },
    };
    runMigrations(s);
    assert.equal(s.llm.defaultMethod, 'st_proxy');
    assert.deepEqual(s.llm.apiProfiles, [{ name: 'custom' }]);
    assert.equal(s.generation.mode, 'full');
    assert.equal(s.generation.startTag, 'img[[');
    assert.equal(s.generation.enabled, false);
});

// --- Test 6: migrators array length matches CURRENT_VERSION ---
test('CURRENT_VERSION matches migrators count', () => {
    assert.equal(CURRENT_VERSION, migrators.length);
});

// --- Test 7 (v2 → v3): a1111 section added, legacy proxy untouched ---
test('v2 → v3 adds a1111 backend and comfy.connection without touching legacy credentials', () => {
    const v2 = {
        settingsVersion: 2,
        enabled: true,
        backends: {
            nai: { apiKey: 'pst-keep', model: 'nai-diffusion-4-5-full' },
            comfy: {
                baseUrl: 'https://my-proxy.example.com/',
                username: 'proxyuser',
                password: 'proxypass',
                profile: 'krea2',
            },
        },
    };
    const ran = runMigrations(v2);
    assert.equal(ran, true);
    assert.equal(v2.settingsVersion, CURRENT_VERSION);
    // New a1111 section exists and starts blank.
    assert.deepEqual(v2.backends.a1111, { baseUrl: '', auth: '', checkpoint: '' });
    // Connection defaults to the legacy proxy.
    assert.equal(v2.backends.comfy.connection, 'legacy_proxy');
    // Legacy proxy URL/credentials survive byte-for-byte.
    assert.equal(v2.backends.comfy.baseUrl, 'https://my-proxy.example.com/');
    assert.equal(v2.backends.comfy.username, 'proxyuser');
    assert.equal(v2.backends.comfy.password, 'proxypass');
    assert.equal(v2.backends.comfy.profile, 'krea2');
});

// --- Test 8: existing a1111 settings are never overwritten ---
test('existing a1111 config and connection choice survive migration', () => {
    const s = {
        settingsVersion: 2,
        backends: {
            nai: {},
            comfy: { connection: 'a1111', baseUrl: 'http://x', username: 'u', password: 'p' },
            a1111: { baseUrl: 'https://hosted.example', auth: 'configured-key', checkpoint: 'modelA.safetensors' },
        },
    };
    runMigrations(s);
    assert.equal(s.backends.comfy.connection, 'a1111');
    assert.equal(s.backends.a1111.baseUrl, 'https://hosted.example');
    assert.equal(s.backends.a1111.auth, 'configured-key');
    assert.equal(s.backends.a1111.checkpoint, 'modelA.safetensors');
});

// --- Test 9: v0.1.0 (no version) gets the a1111 section too ---
test('v0.1.0 legacy settings receive the a1111 section through full migration', () => {
    const legacy = {
        backends: {
            nai: { apiKey: 'k', model: 'm' },
            comfy: { baseUrl: 'http://localhost:7861', username: 'u', password: 'p', profile: 'anima' },
        },
    };
    runMigrations(legacy);
    assert.deepEqual(legacy.backends.a1111, { baseUrl: '', auth: '', checkpoint: '' });
    assert.equal(legacy.backends.comfy.connection, 'legacy_proxy');
    assert.equal(legacy.backends.comfy.username, 'u');
    assert.equal(legacy.backends.comfy.password, 'p');
});

// --- Test 10: missing comfy section is created safely ---
test('missing/corrupt comfy section is created without throwing', () => {
    const s = { settingsVersion: 2, backends: { nai: {} } };
    runMigrations(s);
    assert.equal(s.backends.comfy.connection, 'legacy_proxy');
    assert.deepEqual(s.backends.a1111, { baseUrl: '', auth: '', checkpoint: '' });
});

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
