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
    // New a1111 section exists and starts blank (v6 adds discovery fields).
    assert.deepEqual(v2.backends.a1111, {
        baseUrl: '', auth: '', checkpoint: '',
        discovery: { at: 0, models: [], samplers: [], schedulers: [] },
        checkpointProfiles: {},
        transport: 'st-relay',
    });
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
    assert.deepEqual(legacy.backends.a1111, {
        baseUrl: '', auth: '', checkpoint: '',
        discovery: { at: 0, models: [], samplers: [], schedulers: [] },
        checkpointProfiles: {},
        transport: 'st-relay',
    });
    assert.equal(legacy.backends.comfy.connection, 'legacy_proxy');
    assert.equal(legacy.backends.comfy.username, 'u');
    assert.equal(legacy.backends.comfy.password, 'p');
});

// --- Test 10: missing comfy section is created safely ---
test('missing/corrupt comfy section is created without throwing', () => {
    const s = { settingsVersion: 2, backends: { nai: {} } };
    runMigrations(s);
    assert.equal(s.backends.comfy.connection, 'legacy_proxy');
    assert.deepEqual(s.backends.a1111, {
        baseUrl: '', auth: '', checkpoint: '',
        discovery: { at: 0, models: [], samplers: [], schedulers: [] },
        checkpointProfiles: {},
        transport: 'st-relay',
    });
});

// --- Test 11: v3 → v4 promotes runtime defaults and adds Phase B LLM fields ---
test('v3 settings migrate to v4 with generation defaults, llm fields, and proxyModel', () => {
    const v3 = {
        settingsVersion: 3,
        enabled: true,
        backends: {
            nai: { apiKey: 'pst-keep', model: 'nai-diffusion-4-5-full' },
            comfy: { baseUrl: 'http://localhost:7861', username: 'u', password: 'p', profile: 'anima', connection: 'legacy_proxy' },
            a1111: { baseUrl: 'https://host', auth: 'k', checkpoint: 'ckpt' },
        },
    };
    const ran = runMigrations(v3);
    assert.equal(ran, true);
    assert.equal(v3.settingsVersion, CURRENT_VERSION);
    // generation defaults promoted (absent in v3)
    assert.equal(v3.generation.backend, 'comfy');
    assert.equal(v3.generation.profile, 'anima');
    assert.equal(v3.generation.sceneWindow, 4);
    assert.equal(v3.generation.logLimit, 50);
    // proxyModel stamped
    assert.equal(v3.backends.comfy.proxyModel, '');
    // Phase B LLM fields added
    assert.equal(v3.llm.defaultApiProfileId, '');
    assert.equal(v3.llm.injectionStyle, 'compact');
    // Existing values never overwritten
    assert.equal(v3.backends.comfy.baseUrl, 'http://localhost:7861');
    assert.equal(v3.backends.comfy.username, 'u');
});

// --- Test 12: existing v3 user values preserved ---
test('v3 settings with user values preserved during v3→v4 migration', () => {
    const v3 = {
        settingsVersion: 3,
        enabled: true,
        generation: { mode: 'assist', startTag: 'img[[', endTag: ']]', enabled: true, backend: 'nai', profile: 'krea2', sceneWindow: 6, logLimit: 25 },
        backends: { nai: {}, comfy: { connection: 'a1111', proxyModel: 'my_model.safetensors' }, a1111: {} },
        llm: { apiProfiles: [], contextProfiles: [], requestMapping: {}, defaultMethod: 'st_proxy', defaultApiProfileId: 'prof-1', injectionStyle: 'xml' },
    };
    const ran = runMigrations(v3);
    assert.equal(ran, true);
    // User values survive
    assert.equal(v3.generation.backend, 'nai');
    assert.equal(v3.generation.profile, 'krea2');
    assert.equal(v3.generation.sceneWindow, 6);
    assert.equal(v3.generation.logLimit, 25);
    assert.equal(v3.backends.comfy.proxyModel, 'my_model.safetensors');
    assert.equal(v3.llm.defaultApiProfileId, 'prof-1');
    assert.equal(v3.llm.injectionStyle, 'xml');
    assert.equal(v3.llm.defaultMethod, 'st_proxy');
});

// --- Test 13: sceneWindow clamp in v4 migration ---
test('v3 migration clamps out-of-range sceneWindow to 2–8', () => {
    const s = { settingsVersion: 3, generation: { sceneWindow: 15 } };
    runMigrations(s);
    assert.equal(s.generation.sceneWindow, 8);
    const s2 = { settingsVersion: 3, generation: { sceneWindow: 0 } };
    runMigrations(s2);
    assert.equal(s2.generation.sceneWindow, 2);
});

// --- Test 14: invalid injectionStyle falls back to compact ---
test('v3 migration sanitizes invalid injectionStyle to compact', () => {
    const s = { settingsVersion: 3, llm: { injectionStyle: 'bogus' } };
    runMigrations(s);
    assert.equal(s.llm.injectionStyle, 'compact');
});

// --- Test 15: v0.1.0 through full migration to v4 ---
test('v0.1.0 legacy reaches v4 with all defaults', () => {
    const legacy = { enabled: true, backends: { nai: { apiKey: 'pst-test' }, comfy: { baseUrl: 'http://x', username: 'u', password: 'p', profile: 'anima' } } };
    runMigrations(legacy);
    assert.equal(legacy.settingsVersion, CURRENT_VERSION);
    assert.equal(legacy.generation.backend, 'comfy');
    assert.equal(legacy.generation.profile, 'anima');
    assert.equal(legacy.generation.sceneWindow, 4);
    assert.equal(legacy.backends.comfy.proxyModel, '');
    assert.equal(legacy.llm.injectionStyle, 'compact');
});

// --- Test 16 (v4 → v5): generation.params structure added (Phase C0) ---
test('v4 settings migrate to v5 with an empty generation.params structure per profile', () => {
    const v4 = {
        settingsVersion: 4,
        enabled: true,
        generation: { mode: 'direct', startTag: 'image###', endTag: '###', enabled: true, backend: 'comfy', profile: 'anima', sceneWindow: 4, logLimit: 50, dryRun: false },
        backends: { nai: {}, comfy: { connection: 'legacy_proxy', proxyModel: '' }, a1111: {} },
        llm: { apiProfiles: [], contextProfiles: [], requestMapping: {}, defaultMethod: 'direct', defaultApiProfileId: '', injectionStyle: 'compact' },
    };
    const ran = runMigrations(v4);
    assert.equal(ran, true);
    assert.equal(v4.settingsVersion, CURRENT_VERSION);
    assert.deepEqual(v4.generation.params, { krea2: {}, anima: {}, illustrious: {} });
});

// --- Test 17: existing generation.params values survive v4→v5 migration ---
test('v4→v5 migration preserves existing generation.params overrides', () => {
    const v4 = {
        settingsVersion: 4,
        generation: { mode: 'direct', params: { anima: { width: 1024, steps: 24 } } },
    };
    runMigrations(v4);
    assert.equal(v4.generation.params.anima.width, 1024);
    assert.equal(v4.generation.params.anima.steps, 24);
    // Missing profile keys are still filled in as empty objects.
    assert.deepEqual(v4.generation.params.krea2, {});
    assert.deepEqual(v4.generation.params.illustrious, {});
});

// --- Test 18: v0.1.0 through full migration reaches v5 with generation.params ---
test('v0.1.0 legacy reaches v5 with generation.params present', () => {
    const legacy = { enabled: true, backends: { nai: { apiKey: 'pst-test' }, comfy: { baseUrl: 'http://x', username: 'u', password: 'p', profile: 'anima' } } };
    runMigrations(legacy);
    assert.equal(legacy.settingsVersion, CURRENT_VERSION);
    assert.deepEqual(legacy.generation.params, { krea2: {}, anima: {}, illustrious: {} });
});

// --- Test 19 (v5 → v6): discovery cache, checkpointProfiles, generation.checkpoint ---
test('v5 settings migrate to v6 with discovery cache, checkpointProfiles, and copied checkpoint', () => {
    const v5 = {
        settingsVersion: 5,
        enabled: true,
        generation: { mode: 'direct', backend: 'comfy', profile: 'anima', params: { krea2: {}, anima: {}, illustrious: {} } },
        backends: {
            nai: {},
            comfy: { connection: 'a1111' },
            a1111: { baseUrl: 'https://host.example', auth: 'k', checkpoint: 'Anima | RDBT Anima' },
        },
    };
    const ran = runMigrations(v5);
    assert.equal(ran, true);
    assert.equal(v5.settingsVersion, CURRENT_VERSION);
    assert.deepEqual(v5.backends.a1111.discovery, { at: 0, models: [], samplers: [], schedulers: [] });
    assert.deepEqual(v5.backends.a1111.checkpointProfiles, {});
    // generation.checkpoint copied from the old field; the old field survives.
    assert.equal(v5.generation.checkpoint, 'Anima | RDBT Anima');
    assert.equal(v5.backends.a1111.checkpoint, 'Anima | RDBT Anima');
});

// --- Test 20: v5 → v6 with no stored checkpoint copies an empty string ---
test('v5 → v6 with blank a1111.checkpoint stamps generation.checkpoint = ""', () => {
    const v5 = { settingsVersion: 5, backends: { nai: {}, comfy: {}, a1111: { baseUrl: '', auth: '', checkpoint: '' } }, generation: {} };
    runMigrations(v5);
    assert.equal(v5.generation.checkpoint, '');
});

// --- Test 21: v6 fields already present are never overwritten ---
test('existing v6 discovery/generation.checkpoint survive migration; pre-v8 checkpointProfiles are reset', () => {
    const s = {
        settingsVersion: 5,
        generation: { checkpoint: 'User Choice' },
        backends: {
            nai: {}, comfy: {},
            a1111: {
                checkpoint: 'Old Field',
                discovery: { at: 123, models: [{ title: 'M' }], samplers: ['Euler a'], schedulers: ['Karras'] },
                checkpointProfiles: { M: { profile: 'krea2', steps: 8 } },
            },
        },
    };
    runMigrations(s);
    assert.equal(s.generation.checkpoint, 'User Choice');
    assert.equal(s.backends.a1111.discovery.at, 123);
    // v8 intentionally drops pre-v8 rows (they were auto-seeded, not user intent).
    assert.deepEqual(s.backends.a1111.checkpointProfiles, {});
});

// --- Test 22: v0.1.0 through full migration reaches v6 ---
test('v0.1.0 legacy reaches v6 with all R1 fields present', () => {
    const legacy = { enabled: true, backends: { nai: { apiKey: 'pst-test' }, comfy: { baseUrl: 'http://x', username: 'u', password: 'p', profile: 'anima' } } };
    runMigrations(legacy);
    assert.equal(legacy.settingsVersion, CURRENT_VERSION);
    assert.deepEqual(legacy.backends.a1111.discovery, { at: 0, models: [], samplers: [], schedulers: [] });
    assert.deepEqual(legacy.backends.a1111.checkpointProfiles, {});
    assert.equal(legacy.generation.checkpoint, '');
});

// --- Test 23: v6 → v7 adds llmSize / cache / nai.variety with defaults ---
test('v6 → v7 stamps generation.llmSize, cache block, and backends.nai.variety', () => {
    const v6 = {
        settingsVersion: 6,
        backends: { nai: { apiKey: 'k', model: 'm' }, comfy: {}, a1111: { baseUrl: '', auth: '', checkpoint: '', discovery: { at: 0, models: [], samplers: [], schedulers: [] }, checkpointProfiles: {} } },
        generation: { checkpoint: '' },
    };
    const ran = runMigrations(v6);
    assert.equal(ran, true);
    assert.equal(v6.settingsVersion, CURRENT_VERSION);
    assert.equal(v6.generation.llmSize, 'auto');
    assert.deepEqual(v6.cache, { ttlDays: 0, maxMB: 0, jpegQuality: 0 });
    assert.equal(v6.backends.nai.variety, false);
    assert.equal(v6.backends.nai.apiKey, 'k', 'existing nai fields untouched');
});

// --- Test 24: v7 is idempotent; user values never overwritten ---
test('v7 re-run and existing user values survive untouched', () => {
    const s = {
        settingsVersion: 6,
        backends: { nai: { apiKey: '', model: '', variety: true }, comfy: {}, a1111: {} },
        generation: { llmSize: 'ignore' },
        cache: { ttlDays: 30, maxMB: 200, jpegQuality: 85 },
    };
    runMigrations(s);
    assert.equal(s.generation.llmSize, 'ignore');
    assert.deepEqual(s.cache, { ttlDays: 30, maxMB: 200, jpegQuality: 85 });
    assert.equal(s.backends.nai.variety, true);
    // Re-run at current version: no change, no error.
    assert.equal(runMigrations(s), false);
});

// --- Test 25: v0.1.0 legacy reaches v7 with the Phase D fields ---
test('v0.1.0 legacy reaches v7 with llmSize/cache/variety present', () => {
    const legacy = { enabled: true, backends: { nai: { apiKey: 'pst-test' }, comfy: { baseUrl: 'http://x', username: 'u', password: 'p', profile: 'anima' } } };
    runMigrations(legacy);
    assert.equal(legacy.settingsVersion, CURRENT_VERSION);
    assert.equal(legacy.generation.llmSize, 'auto');
    assert.deepEqual(legacy.cache, { ttlDays: 0, maxMB: 0, jpegQuality: 0 });
    assert.equal(legacy.backends.nai.variety, false);
});

// --- Test 26: v7 → v8 drops auto-seeded checkpointProfiles, keeps checkpoint + discovery, stamps transport ---
test('v7 → v8 clears checkpointProfiles, keeps checkpoint/discovery, stamps transport st-relay', () => {
    const v7 = {
        settingsVersion: 7,
        backends: {
            nai: {}, comfy: {},
            a1111: {
                baseUrl: 'https://host.example', auth: 'k', checkpoint: 'Krea 2 | A',
                discovery: { at: 5, models: [{ title: 'Krea 2 | A' }], samplers: ['Euler'], schedulers: ['simple'] },
                checkpointProfiles: { 'Krea 2 | A': { profile: 'krea2', steps: 8 }, 'Old': { profile: 'anima' } },
            },
        },
        generation: { checkpoint: 'Krea 2 | A' },
    };
    const ran = runMigrations(v7);
    assert.equal(ran, true);
    assert.equal(v7.settingsVersion, CURRENT_VERSION);
    assert.deepEqual(v7.backends.a1111.checkpointProfiles, {});
    assert.equal(v7.backends.a1111.checkpoint, 'Krea 2 | A');
    assert.equal(v7.generation.checkpoint, 'Krea 2 | A');
    assert.equal(v7.backends.a1111.discovery.at, 5);
    assert.equal(v7.backends.a1111.auth, 'k');
    assert.equal(v7.backends.a1111.transport, 'st-relay');
});

test('v7 → v8 keeps an explicit direct transport and tolerates a missing a1111 section', () => {
    const s = { settingsVersion: 7, backends: { a1111: { transport: 'direct', checkpointProfiles: { X: { profile: 'anima' } } } } };
    runMigrations(s);
    assert.equal(s.backends.a1111.transport, 'direct');
    assert.deepEqual(s.backends.a1111.checkpointProfiles, {});
    const bare = { settingsVersion: 7 };
    runMigrations(bare);
    assert.deepEqual(bare.backends.a1111.checkpointProfiles, {});
    assert.equal(bare.backends.a1111.transport, 'st-relay');
    assert.equal(runMigrations(bare), false);
});

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
