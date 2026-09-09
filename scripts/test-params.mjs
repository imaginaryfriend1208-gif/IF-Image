#!/usr/bin/env node
// IF Image - generation param override tests (Phase C0).
// Run: node scripts/test-params.mjs
import assert from 'node:assert/strict';
import { parseTriggers } from '../src/prompt/triggers.js';
import { assemblePrompt, mergeProfileParams, applyMarkerParamOverrides, clampDim, clampSteps, clampCfg, resolveLockedSeed, resolveSizeKeyword } from '../src/prompt/render.js';
import { PROFILES } from '../src/profiles.js';
import { inferProfileKey, resolveCheckpointProfile, getActiveProfile, mergeParams, matchDiscoveredName, suggestCheckpointProfile, normalizeCheckpointProfile, SIZE_PRESETS, matchSizePreset } from '../src/backends/checkpoint-profiles.js';

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

test('suggestCheckpointProfile: server defaults win, mapped + clamped, sampler aligned; source=server', () => {
    const model = { title: 'Krea 2 | Turbo18+', family: 'krea2', defaults: { steps: 8, cfg: 1, width: 1344, height: 768, sampler: 'euler', scheduler: 'simple' } };
    const s = suggestCheckpointProfile(model, 'anima', { samplers: ['Euler', 'Euler a'], schedulers: ['Automatic', 'simple'] });
    assert.deepEqual(s, { profile: 'krea2', width: 1344, height: 768, steps: 8, cfg: 1, sampler: 'Euler', scheduler: 'simple', source: 'server' });
});

test('suggestCheckpointProfile: without server defaults falls back to PROFILES numbers; source=profile; no sampler keys', () => {
    const s = suggestCheckpointProfile({ title: 'Anima | RDBT Anima' }, 'krea2');
    assert.deepEqual(s, { profile: 'anima', width: PROFILES.anima.width, height: PROFILES.anima.height, steps: PROFILES.anima.steps, cfg: PROFILES.anima.cfg, source: 'profile' });
    assert.equal('sampler' in s, false);
    // Unknown title -> fallback key; null model tolerated.
    assert.equal(suggestCheckpointProfile({ title: 'Mystery' }, 'illustrious').profile, 'illustrious');
    assert.equal(suggestCheckpointProfile(null, 'anima').profile, 'anima');
    // Partial server defaults: missing numbers come from the profile.
    const p = suggestCheckpointProfile({ title: 'Krea 2 | X', defaults: { steps: 4 } }, 'anima');
    assert.equal(p.steps, 4);
    assert.equal(p.width, PROFILES.krea2.width);
    assert.equal(p.source, 'server');
});

test('normalizeCheckpointProfile: clamps numbers, drops blanks/invalid, rejects unknown style, requires checkpoint (D14)', () => {
    assert.deepEqual(
        normalizeCheckpointProfile({ profile: 'anima', checkpoint: 'CkptA', name: ' Fast ', width: '1000', height: '1216', steps: '999', cfg: '4.5', sampler: 'Euler a', scheduler: '' }),
        { profile: 'anima', checkpoint: 'CkptA', name: 'Fast', width: 1024, height: 1216, steps: 150, cfg: 4.5, sampler: 'Euler a' },
    );
    // Blank name falls back to the checkpoint title.
    assert.deepEqual(
        normalizeCheckpointProfile({ profile: 'krea2', checkpoint: 'CkptB', name: '  ', width: '', height: 'abc' }),
        { profile: 'krea2', checkpoint: 'CkptB', name: 'CkptB' },
    );
    // D14: no checkpoint -> not saveable.
    assert.equal(normalizeCheckpointProfile({ profile: 'krea2' }), null);
    assert.equal(normalizeCheckpointProfile({ profile: 'krea2', checkpoint: '   ' }), null);
    assert.equal(normalizeCheckpointProfile({ profile: 'nope', checkpoint: 'X' }), null);
    assert.equal(normalizeCheckpointProfile(null), null);
});

test('SIZE_PRESETS are 64-multiples inside the clamp range; matchSizePreset round-trips and reports custom', () => {
    assert.ok(SIZE_PRESETS.length >= 6);
    for (const p of SIZE_PRESETS) {
        assert.equal(clampDim(p.width), p.width, p.key);
        assert.equal(clampDim(p.height), p.height, p.key);
        assert.equal(matchSizePreset(p.width, p.height), p.key);
        assert.equal(matchSizePreset(String(p.width), String(p.height)), p.key, 'string input from form fields');
    }
    assert.equal(matchSizePreset(832, 832), 'custom');
    assert.equal(matchSizePreset('', ''), 'custom');
    assert.equal(new Set(SIZE_PRESETS.map(p => p.key)).size, SIZE_PRESETS.length, 'keys unique');
    // Suggestion for a saved row round-trips through the preset matcher.
    const row = normalizeCheckpointProfile({ profile: 'anima', checkpoint: 'M', width: 832, height: 1216 });
    assert.equal(matchSizePreset(row.width, row.height), 'portrait');
});

test('resolveCheckpointProfile: keyed by profile id (D14); strips metadata; null on bad rows', () => {
    const settings = { backends: { a1111: { checkpointProfiles: {
        cp1: { profile: 'anima', checkpoint: 'Anima | RDBT Anima', name: 'Fast', steps: 20, sampler: 'Euler a' },
        cp2: { profile: 'not-a-profile', checkpoint: 'X', name: 'Broken' },
    } } } };
    assert.deepEqual(resolveCheckpointProfile(settings, 'cp1'), { profileKey: 'anima', overrides: { steps: 20, sampler: 'Euler a' } });
    assert.equal(resolveCheckpointProfile(settings, 'cp2'), null);
    assert.equal(resolveCheckpointProfile(settings, 'cp99'), null);
    assert.equal(resolveCheckpointProfile({}, 'cp1'), null);
});

test('getActiveProfile: returns the selected usable row or null (D14)', () => {
    const profiles = {
        cp1: { profile: 'anima', checkpoint: 'CkptA', name: 'Fast', steps: 20 },
        cp2: { profile: 'nope', checkpoint: 'CkptA', name: 'Broken style' },
        cp3: { profile: 'anima', checkpoint: '', name: 'No checkpoint' },
    };
    const s = (activeProfileId) => ({ backends: { a1111: { activeProfileId, checkpointProfiles: profiles } } });
    assert.deepEqual(getActiveProfile(s('cp1')), { id: 'cp1', entry: profiles.cp1 });
    assert.equal(getActiveProfile(s('')), null, 'no selection');
    assert.equal(getActiveProfile(s('cp99')), null, 'row deleted');
    assert.equal(getActiveProfile(s('cp2')), null, 'unknown prompt style');
    assert.equal(getActiveProfile(s('cp3')), null, 'no checkpoint title');
    assert.equal(getActiveProfile({}), null);
    assert.equal(getActiveProfile(null), null);
});

test('mergeParams: five-layer precedence PROFILES < settings < saved profile < marker < LLM (D14 profileId keying)', () => {
    const title = 'Illustrious | New ERA Retro';
    const settings = {
        generation: { params: { illustrious: { steps: 30, cfg: 6, width: 896, height: 896 } } },
        backends: { a1111: { checkpointProfiles: {
            cp1: { profile: 'illustrious', checkpoint: title, name: 'Retro', steps: 24, sampler: 'DPM++ 2M', scheduler: 'karras' },
        } } },
    };
    // Layer 1+2: settings override beats the PROFILES default.
    let p = mergeParams({ profileKey: 'illustrious', settings });
    assert.equal(p.steps, 30);
    assert.equal(p.width, 896);
    // Layer 3: saved-profile override (by profileId) beats settings for
    // steps, inherits width; checkpointTitle only stamps params.checkpoint.
    p = mergeParams({ profileKey: 'illustrious', checkpointTitle: title, profileId: 'cp1', settings });
    assert.equal(p.steps, 24);
    assert.equal(p.width, 896);
    assert.equal(p.sampler, 'DPM++ 2M');
    assert.equal(p.scheduler, 'karras');
    assert.equal(p.checkpoint, title);
    // checkpointTitle without profileId: no saved-profile layer applied.
    p = mergeParams({ profileKey: 'illustrious', checkpointTitle: title, settings });
    assert.equal(p.steps, 30, 'no profileId -> settings layer wins');
    assert.equal(p.checkpoint, title);
    // Layer 4: marker JSON beats the saved-profile layer.
    p = mergeParams({ profileKey: 'illustrious', checkpointTitle: title, profileId: 'cp1', settings, markerOverrides: { steps: 12, width: 1216, height: 832 } });
    assert.equal(p.steps, 12);
    assert.equal(p.width, 1216);
    assert.equal(p.height, 832);
    // Layer 5: LLM <size> beats everything.
    p = mergeParams({ profileKey: 'illustrious', checkpointTitle: title, profileId: 'cp1', settings, markerOverrides: { steps: 12 }, llmOverrides: { width: 1024, height: 1024, cfg: 5 } });
    assert.equal(p.width, 1024);
    assert.equal(p.height, 1024);
    assert.equal(p.cfg, 5);
    assert.equal(p.steps, 12);
});

test('mergeParams: C0 clamps hold on every layer; lone marker width is ignored', () => {
    const settings = {
        generation: { params: { anima: { width: 4000, steps: 999 } } },
        backends: { a1111: { checkpointProfiles: { cp1: { profile: 'anima', checkpoint: 'M', name: 'M', cfg: 99 } } } },
    };
    const p = mergeParams({ profileKey: 'anima', checkpointTitle: 'M', profileId: 'cp1', settings, markerOverrides: { width: 1024 } });
    assert.equal(p.width, 2048);          // settings width clamped to max, marker lone width ignored
    assert.equal(p.steps, 150);           // clamped
    assert.equal(p.cfg, 30);              // checkpoint cfg clamped
    assert.equal(p.height, PROFILES.anima.height); // untouched inherits profile
});

// --- D2: marker seed + character seed lock ---------------------------------
test('D2: ${seed:7} parses into paramOverrides.seed and reaches params', () => {
    const parsed = parseTriggers('${seed: 7} a scene');
    assert.equal(parsed.paramOverrides.seed, 7);
    const params = { width: 832, height: 1216, steps: 20, cfg: 5, seed: -1 };
    applyMarkerParamOverrides(params, parsed.paramOverrides);
    assert.equal(params.seed, 7);
});

test('D2: invalid seed values are ignored (float, below -1, non-numeric)', () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
        for (const bad of ['1.5', '-2', '"abc"']) {
            const parsed = parseTriggers(`\${seed: ${bad}} x`);
            assert.equal(parsed.paramOverrides.seed, undefined, `seed ${bad} must be dropped`);
        }
        // -1 (explicit random) is valid.
        assert.equal(parseTriggers('${seed: -1} x').paramOverrides.seed, -1);
    } finally { console.warn = warn; }
});

test('D2: mergeParams carries a marker seed through the a1111 layer chain', () => {
    const settings = { generation: { params: {} }, backends: { a1111: { checkpointProfiles: { M: { profile: 'anima' } } } } };
    const p = mergeParams({ profileKey: 'anima', checkpointTitle: 'M', settings, markerOverrides: { seed: 1234 } });
    assert.equal(p.seed, 1234);
    const p2 = mergeParams({ profileKey: 'anima', checkpointTitle: 'M', settings, markerOverrides: {} });
    assert.equal(p2.seed, undefined, 'no marker seed -> merge adds none');
});

test('D2: resolveLockedSeed applies for exactly one character', () => {
    const locked = { char: { lock: { seed: 42, params: null } } };
    assert.equal(resolveLockedSeed([locked], {}), 42);
    assert.equal(resolveLockedSeed([locked], undefined), 42);
});

test('D2: resolveLockedSeed never applies for two+ characters or unlocked chars', () => {
    const locked = { char: { lock: { seed: 42, params: null } } };
    const other = { char: { lock: { seed: 7, params: null } } };
    assert.equal(resolveLockedSeed([locked, other], {}), undefined, 'two chars -> no lock');
    assert.equal(resolveLockedSeed([], {}), undefined, 'no chars -> no lock');
    assert.equal(resolveLockedSeed([{ char: { lock: { seed: -1, params: null } } }], {}), undefined, 'lock -1 = unlocked');
    assert.equal(resolveLockedSeed([{ isPersona: true, persona: {} }], {}), undefined, 'persona entry has no char.lock');
});

test('D2: marker seed beats the character lock', () => {
    const locked = { char: { lock: { seed: 42, params: null } } };
    assert.equal(resolveLockedSeed([locked], { seed: 7 }), undefined, 'marker seed present -> lock skipped');
    assert.equal(resolveLockedSeed([locked], { seed: -1 }), undefined, 'explicit random marker seed also beats the lock');
});

// --- D3: size keyword --------------------------------------------------------
test('D3: ${size: portrait|landscape|square} parses into sizeKeyword', () => {
    assert.equal(parseTriggers('${size: "portrait"} x').paramOverrides.sizeKeyword, 'portrait');
    assert.equal(parseTriggers('${size: "LANDSCAPE"} x').paramOverrides.sizeKeyword, 'landscape');
    assert.equal(parseTriggers('${size: "square"} x').paramOverrides.sizeKeyword, 'square');
    // Numeric WxH still parses as before (no keyword set).
    const numeric = parseTriggers('${size: "640x960"} x').paramOverrides;
    assert.equal(numeric.width, 640);
    assert.equal(numeric.sizeKeyword, undefined);
    // Invalid keyword still warns and is dropped.
    const warn = console.warn;
    console.warn = () => {};
    try {
        assert.equal(parseTriggers('${size: "diagonal"} x').paramOverrides.sizeKeyword, undefined);
    } finally { console.warn = warn; }
});

test('D3: resolveSizeKeyword maps per profile and strips the keyword', () => {
    assert.deepEqual(resolveSizeKeyword({ sizeKeyword: 'portrait' }, 'anima'), { width: 832, height: 1216 });
    assert.deepEqual(resolveSizeKeyword({ sizeKeyword: 'landscape' }, 'anima'), { width: 1216, height: 832 });
    assert.deepEqual(resolveSizeKeyword({ sizeKeyword: 'portrait' }, 'krea2'), { width: 768, height: 1344 });
    assert.deepEqual(resolveSizeKeyword({ sizeKeyword: 'square' }, 'illustrious'), { width: 1024, height: 1024 });
    // Unknown profile: keyword dropped, nothing invented.
    assert.deepEqual(resolveSizeKeyword({ sizeKeyword: 'square' }, 'nope'), {});
});

test('D3: numeric WxH beats the keyword; input never mutated; no keyword = passthrough', () => {
    const both = { sizeKeyword: 'square', width: 640, height: 960, steps: 10 };
    assert.deepEqual(resolveSizeKeyword(both, 'anima'), { width: 640, height: 960, steps: 10 });
    assert.equal(both.sizeKeyword, 'square', 'input object untouched');
    const plain = { steps: 10 };
    assert.equal(resolveSizeKeyword(plain, 'anima'), plain, 'no keyword returns the same object');
});

test('matchDiscoveredName: aligns ComfyUI-style ids with the server spelling; keeps unknowns verbatim', () => {
    const samplers = ['Euler', 'Euler a', 'DPM++ 2M', 'DPM++ 2M SDE', 'DPM++ 2M SDE Karras'];
    assert.equal(matchDiscoveredName('euler', samplers), 'Euler');
    assert.equal(matchDiscoveredName('Euler', samplers), 'Euler', 'exact match wins');
    assert.equal(matchDiscoveredName('euler_ancestral', samplers), 'Euler a');
    assert.equal(matchDiscoveredName('euler a', samplers), 'Euler a');
    assert.equal(matchDiscoveredName('dpmpp_2m', samplers), 'DPM++ 2M');
    assert.equal(matchDiscoveredName('dpmpp_2m_sde', samplers), 'DPM++ 2M SDE');
    assert.equal(matchDiscoveredName('dpmpp_2m_sde_karras', samplers), 'DPM++ 2M SDE Karras');
    assert.equal(matchDiscoveredName('uni_pc', samplers), 'uni_pc', 'no match: original kept');
    assert.equal(matchDiscoveredName('euler', []), 'euler', 'empty list: original kept');
    assert.equal(matchDiscoveredName('euler', undefined), 'euler');
    assert.equal(matchDiscoveredName('', samplers), '');
    assert.equal(matchDiscoveredName('sgm_uniform', ['Automatic', 'simple', 'sgm_uniform']), 'sgm_uniform');
    assert.equal(matchDiscoveredName('SGM Uniform', ['Automatic', 'simple', 'sgm_uniform']), 'sgm_uniform');
});

test('suggestCheckpointProfile: sampler/scheduler names pass through untouched without discovered lists', () => {
    const model = { title: 'Krea 2 | X', family: 'krea2', defaults: { steps: 8, sampler: 'euler', scheduler: 'simple' } };
    const plain = suggestCheckpointProfile(model, 'anima');
    assert.equal(plain.sampler, 'euler');
    const aligned = suggestCheckpointProfile(model, 'anima', { samplers: ['Euler', 'Euler a'], schedulers: ['Automatic', 'simple'] });
    assert.equal(aligned.sampler, 'Euler');
    assert.equal(aligned.scheduler, 'simple');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
