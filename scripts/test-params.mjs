#!/usr/bin/env node
// IF Image - generation param override tests (Phase C0).
// Run: node scripts/test-params.mjs
import assert from 'node:assert/strict';
import { parseTriggers } from '../src/prompt/triggers.js';
import { assemblePrompt, mergeProfileParams, applyMarkerParamOverrides, clampDim, clampSteps, clampCfg } from '../src/prompt/render.js';
import { PROFILES } from '../src/profiles.js';

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

console.log('Generation param override tests');

// --- clamp helpers ---
test('clampDim snaps to a 64px multiple and clamps to [256, 2048]', () => {
    assert.equal(clampDim(1000), 1024); // 1000/64=15.625 -> round 16 -> 16*64=1024
    assert.equal(clampDim(100), 256);
    assert.equal(clampDim(4000), 2048);
    assert.equal(clampDim('not a number'), undefined);
    assert.equal(clampDim(undefined), undefined);
});

test('clampSteps clamps to [1, 150] and rounds', () => {
    assert.equal(clampSteps(0), 1);
    assert.equal(clampSteps(500), 150);
    assert.equal(clampSteps(16.4), 16);
    assert.equal(clampSteps('bogus'), undefined);
});

test('clampCfg clamps to [0, 30]', () => {
    assert.equal(clampCfg(-5), 0);
    assert.equal(clampCfg(100), 30);
    assert.equal(clampCfg(4.5), 4.5);
    assert.equal(clampCfg(null), undefined);
});

// --- mergeProfileParams (settings-level override) ---
test('mergeProfileParams: blank/absent override inherits the profile default byte-identical', () => {
    const merged = mergeProfileParams(PROFILES.anima, {});
    assert.deepEqual(merged, PROFILES.anima);
    const mergedAbsent = mergeProfileParams(PROFILES.anima, undefined);
    assert.equal(mergedAbsent, PROFILES.anima);
});

test('mergeProfileParams: settings override applies clamped values', () => {
    const merged = mergeProfileParams(PROFILES.illustrious, { width: 1000, steps: 999, cfg: -1 });
    assert.equal(merged.width, 1024);
    assert.equal(merged.steps, 150);
    assert.equal(merged.cfg, 0);
    assert.equal(merged.height, PROFILES.illustrious.height); // untouched field inherits
});

test('mergeProfileParams: invalid override fields are ignored (inherit default)', () => {
    const merged = mergeProfileParams(PROFILES.anima, { width: 'bogus', steps: null });
    assert.equal(merged.width, PROFILES.anima.width);
    assert.equal(merged.steps, PROFILES.anima.steps);
});

// --- applyMarkerParamOverrides (marker JSON trigger, highest of the two) ---
test('applyMarkerParamOverrides: marker override beats an already-merged settings value', () => {
    const params = { width: 992, height: 992, steps: 150, cfg: 0 };
    applyMarkerParamOverrides(params, { width: 1216, height: 832, steps: 20, cfg: 5 });
    assert.equal(params.width, 1216);
    assert.equal(params.height, 832);
    assert.equal(params.steps, 20);
    assert.equal(params.cfg, 5);
});

test('applyMarkerParamOverrides: a lone width/height (no pair) is ignored to protect aspect ratio', () => {
    const params = { width: 832, height: 1216 };
    applyMarkerParamOverrides(params, { width: 1024 });
    assert.equal(params.width, 832);
    assert.equal(params.height, 1216);
});

test('applyMarkerParamOverrides: absent overrides object is a no-op', () => {
    const params = { width: 832, height: 1216, steps: 20, cfg: 5 };
    applyMarkerParamOverrides(params, undefined);
    assert.deepEqual(params, { width: 832, height: 1216, steps: 20, cfg: 5 });
});

// --- end-to-end: parseTriggers -> paramOverrides -> compile-shaped pipeline ---
test('marker JSON "size"/"steps"/"cfg" trigger parses into paramOverrides', () => {
    const parsed = parseTriggers('${size: "1024x1536", steps: 30, cfg: 7} a portrait');
    assert.deepEqual(parsed.paramOverrides, { width: 1024, height: 1536, steps: 30, cfg: 7 });
    assert.equal(parsed.residualPrompt, 'a portrait');
});

test('invalid "size" value is ignored with a console warning, never thrown', () => {
    const warn = console.warn;
    let warned = 0;
    console.warn = () => { warned += 1; };
    let parsed;
    try {
        parsed = parseTriggers('${size: "not-a-size"} a portrait');
    } finally {
        console.warn = warn;
    }
    assert.equal(warned, 1);
    assert.equal(parsed.paramOverrides.width, undefined);
});

test('full precedence chain: profile < settings < marker JSON, applied in order', () => {
    const parsed = parseTriggers('${size: "1216x832"} a scene');
    const effectiveProfile = mergeProfileParams(PROFILES.illustrious, { steps: 30, cfg: 6 });
    const assembled = assemblePrompt(parsed, 'illus', effectiveProfile);
    const params = { ...assembled.params };
    applyMarkerParamOverrides(params, parsed.paramOverrides);
    assert.equal(params.width, 1216); // marker JSON wins over profile default (832)
    assert.equal(params.height, 832);
    assert.equal(params.steps, 30);   // settings override wins over profile default (20)
    assert.equal(params.cfg, 6);
});

test('existing prompts with no overrides stay byte-identical (regression)', () => {
    const parsed = parseTriggers('a plain scene with no triggers');
    const assembled = assemblePrompt(parsed, 'illus', PROFILES.illustrious);
    const withOverrideLogic = { ...assembled.params };
    applyMarkerParamOverrides(withOverrideLogic, parsed.paramOverrides);
    assert.deepEqual(withOverrideLogic, assembled.params);
    assert.deepEqual(assembled.params, {
        width: PROFILES.illustrious.width,
        height: PROFILES.illustrious.height,
        steps: PROFILES.illustrious.steps,
        cfg: PROFILES.illustrious.cfg,
    });
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
