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

// --- Summary ---
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
