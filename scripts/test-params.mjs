#!/usr/bin/env node
// IF Image - generation param override tests (Phase C0).
// Run: node scripts/test-params.mjs
import assert from 'node:assert/strict';
import { parseTriggers } from '../src/prompt/triggers.js';
import { assemblePrompt, mergeProfileParams, applyMarkerParamOverrides, clampDim, clampSteps, clampCfg } from '../src/prompt/render.js';
import { PROFILES } from '../src/profiles.js';
import { inferProfileKey, seedCheckpointProfiles, resolveCheckpointProfile, mergeParams } from '../src/backends/checkpoint-profiles.js';

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

// --- R1: checkpoint-profile model ---
test('inferProfileKey: explicit family wins; title regexes; else fallback', () => {
    assert.equal(inferProfileKey({ title: 'whatever', family: 'illustrious' }, 'anima'), 'illustrious');
    assert.equal(inferProfileKey({ title: 'Krea 2 | Turbo18+' }, 'anima'), 'krea2');
    assert.equal(inferProfileKey({ title: 'Anima | RDBT Anima' }, 'krea2'), 'anima');
    assert.equal(inferProfileKey({ title: 'NoobAI XL v1' }, 'anima'), 'illustrious');
    assert.equal(inferProfileKey({ title: 'totally-unknown' }, 'anima'), 'anima');
    // Unknown family string falls through to title inference.
    assert.equal(inferProfileKey({ title: 'Illustrious | New ERA', family: 'bogus' }, 'anima'), 'illustrious');
});

test('R1: 10 real magimo titles infer the correct profile', () => {
    const cases = [
        ['Krea 2 | Turbo18+', 'krea2'],
        ['Krea 2 | Base', 'krea2'],
        ['krea2_turbo.safetensors', 'krea2'],
        ['Anima | RDBT Anima', 'anima'],
        ['Anima | Base ym1f', 'anima'],
        ['rdbtAnima_v2.safetensors', 'anima'],
        ['Illustrious | New ERA Retro', 'illustrious'],
        ['NoobAI-XL v1.1', 'illustrious'],
        ['Pony Diffusion V6 XL', 'illustrious'],
        ['WAI-illustrious-SDXL v14', 'illustrious'],
    ];
    for (const [title, expected] of cases) {
        assert.equal(inferProfileKey({ title }, 'anima'), expected, title);
    }
});

test('seedCheckpointProfiles: adds missing titles with inferred profile + mapped defaults', () => {
    const models = [
        { title: 'Krea 2 | Turbo18+', family: 'krea2', defaults: { steps: 8, cfg: 1, width: 1344, height: 768, sampler: 'Euler a', scheduler: 'simple' } },
        { title: 'Mystery Model' },
    ];
    const seeded = seedCheckpointProfiles({}, models, 'anima');
    assert.deepEqual(seeded['Krea 2 | Turbo18+'], { profile: 'krea2', width: 1344, height: 768, steps: 8, cfg: 1, sampler: 'Euler a', scheduler: 'simple' });
    assert.deepEqual(seeded['Mystery Model'], { profile: 'anima' });
});

test('seedCheckpointProfiles: user edits survive re-seed (existing entries untouched, new object)', () => {
    const existing = { 'Krea 2 | Turbo18+': { profile: 'anima', steps: 30 } };
    const models = [
        { title: 'Krea 2 | Turbo18+', family: 'krea2', defaults: { steps: 8 } },
        { title: 'Anima | RDBT Anima', family: 'anima' },
    ];
    const seeded = seedCheckpointProfiles(existing, models, 'anima');
    assert.notEqual(seeded, existing, 'must return a NEW object');
    assert.deepEqual(seeded['Krea 2 | Turbo18+'], { profile: 'anima', steps: 30 }, 'user edit kept byte-identical');
    assert.deepEqual(existing, { 'Krea 2 | Turbo18+': { profile: 'anima', steps: 30 } }, 'input never mutated');
    assert.deepEqual(seeded['Anima | RDBT Anima'], { profile: 'anima' });
});

test('resolveCheckpointProfile: returns {profileKey, overrides} or null', () => {
    const settings = { backends: { a1111: { checkpointProfiles: {
        'Anima | RDBT Anima': { profile: 'anima', steps: 20, sampler: 'Euler a' },
        'Broken': { profile: 'not-a-profile' },
    } } } };
    assert.deepEqual(resolveCheckpointProfile(settings, 'Anima | RDBT Anima'), { profileKey: 'anima', overrides: { steps: 20, sampler: 'Euler a' } });
    assert.equal(resolveCheckpointProfile(settings, 'Broken'), null);
    assert.equal(resolveCheckpointProfile(settings, 'Unknown'), null);
    assert.equal(resolveCheckpointProfile({}, 'Anything'), null);
});

test('mergeParams: five-layer precedence PROFILES < settings < checkpoint < marker < LLM', () => {
    const settings = {
        generation: { params: { illustrious: { steps: 30, cfg: 6, width: 896, height: 896 } } },
        backends: { a1111: { checkpointProfiles: {
            'Illustrious | New ERA Retro': { profile: 'illustrious', steps: 24, sampler: 'DPM++ 2M', scheduler: 'karras' },
        } } },
    };
    // Layer 1+2: settings override beats the PROFILES default.
    let p = mergeParams({ profileKey: 'illustrious', settings });
    assert.equal(p.steps, 30);
    assert.equal(p.width, 896);
    // Layer 3: checkpoint override beats settings for steps, inherits width.
    p = mergeParams({ profileKey: 'illustrious', checkpointTitle: 'Illustrious | New ERA Retro', settings });
    assert.equal(p.steps, 24);
    assert.equal(p.width, 896);
    assert.equal(p.sampler, 'DPM++ 2M');
    assert.equal(p.scheduler, 'karras');
    assert.equal(p.checkpoint, 'Illustrious | New ERA Retro');
    // Layer 4: marker JSON beats the checkpoint layer.
    p = mergeParams({ profileKey: 'illustrious', checkpointTitle: 'Illustrious | New ERA Retro', settings, markerOverrides: { steps: 12, width: 1216, height: 832 } });
    assert.equal(p.steps, 12);
    assert.equal(p.width, 1216);
    assert.equal(p.height, 832);
    // Layer 5: LLM <size> beats everything.
    p = mergeParams({ profileKey: 'illustrious', checkpointTitle: 'Illustrious | New ERA Retro', settings, markerOverrides: { steps: 12 }, llmOverrides: { width: 1024, height: 1024, cfg: 5 } });
    assert.equal(p.width, 1024);
    assert.equal(p.height, 1024);
    assert.equal(p.cfg, 5);
    assert.equal(p.steps, 12);
});

test('mergeParams: C0 clamps hold on every layer; lone marker width is ignored', () => {
    const settings = {
        generation: { params: { anima: { width: 4000, steps: 999 } } },
        backends: { a1111: { checkpointProfiles: { M: { profile: 'anima', cfg: 99 } } } },
    };
    const p = mergeParams({ profileKey: 'anima', checkpointTitle: 'M', settings, markerOverrides: { width: 1024 } });
    assert.equal(p.width, 2048);          // settings width clamped to max, marker lone width ignored
    assert.equal(p.steps, 150);           // clamped
    assert.equal(p.cfg, 30);              // checkpoint cfg clamped
    assert.equal(p.height, PROFILES.anima.height); // untouched inherits profile
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
