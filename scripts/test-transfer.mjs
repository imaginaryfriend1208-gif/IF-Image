#!/usr/bin/env node
// IF Image - D7 preset export/import tests (pure module, no IDB/DOM needed).
// Run: node scripts/test-transfer.mjs

import assert from 'node:assert/strict';
import {
    buildExport, validateImport, planMerge, PRESET_FORMAT, PRESET_VERSION,
    buildEntityExport, validateEntityImport, prepareEntityImport, ENTITY_FORMAT,
} from '../src/storage/transfer.js';

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

console.log('Preset transfer tests');

const sampleChar = { id: 'c1', name: 'Lyna', booru: 'silver hair', lock: { seed: 42, params: null }, presetVersion: 3 };
const sampleOutfit = { id: 'o1', name: 'Casual', tags: 'jeans', charId: 'c1' };
const sampleStyle = { id: 's1', name: 'Noir', dialectHints: { krea: { stylePhrase: 'noir' } } };
const samplePersona = { id: 'p1', name: 'User', countTag: '1boy' };
const sampleRule = { trigger: 'foo', mode: 'replace', replacement: 'bar' };
const sampleCkpt = { 'model-a.safetensors': { profile: 'anima', steps: 28 } };

function fullExport() {
    return buildExport({
        characters: [sampleChar], outfits: [sampleOutfit], styles: [sampleStyle],
        personas: [samplePersona], replaceRules: [sampleRule], checkpointProfiles: sampleCkpt,
    });
}

test('buildExport round-trips collection data intact', () => {
    const doc = JSON.parse(JSON.stringify(fullExport()));
    assert.equal(doc.format, PRESET_FORMAT);
    assert.equal(doc.version, PRESET_VERSION);
    assert.ok(doc.exportedAt);
    assert.deepEqual(doc.characters, [sampleChar]);
    assert.deepEqual(doc.outfits, [sampleOutfit]);
    assert.deepEqual(doc.styles, [sampleStyle]);
    assert.deepEqual(doc.personas, [samplePersona]);
    assert.deepEqual(doc.replaceRules, [sampleRule]);
    assert.deepEqual(doc.checkpointProfiles, sampleCkpt);
});

test('export never contains forbidden keys at any depth', () => {
    const doc = buildExport({
        characters: [{ ...sampleChar, apiKey: 'pst-secret', nested: { baseUrl: 'http://x', deep: { password: 'p' } } }],
        styles: [{ name: 'S', auth: 'user:pass' }],
        checkpointProfiles: { 'm.safetensors': { profile: 'anima', discovery: { models: [] } } },
    });
    const json = JSON.stringify(doc);
    for (const key of ['auth', 'apiKey', 'password', 'baseUrl', 'discovery']) {
        assert.ok(!json.includes(`"${key}"`), `forbidden key "${key}" must be stripped`);
    }
    // Non-forbidden siblings survive the sanitizer.
    assert.equal(doc.characters[0].name, 'Lyna');
    assert.equal(doc.characters[0].nested.deep.password, undefined);
});

test('validateImport accepts a fresh export', () => {
    const { ok, errors } = validateImport(JSON.parse(JSON.stringify(fullExport())));
    assert.deepEqual(errors, []);
    assert.equal(ok, true);
});

test('validateImport rejects wrong format/version/shapes with clear messages', () => {
    assert.equal(validateImport(null).ok, false);
    assert.equal(validateImport([]).ok, false);
    const wrongFormat = validateImport({ format: 'other', version: 1 });
    assert.ok(wrongFormat.errors.some(e => e.includes('ifimage-preset')), 'names the expected format');
    const wrongVersion = validateImport({ format: PRESET_FORMAT, version: 99 });
    assert.ok(wrongVersion.errors.some(e => e.includes('version')), 'names the version problem');
    const badShape = validateImport({ format: PRESET_FORMAT, version: 1, characters: 'nope', styles: [{}] });
    assert.ok(badShape.errors.some(e => e.includes('"characters" must be an array')));
    assert.ok(badShape.errors.some(e => e.includes('styles[0]') && e.includes('name')));
    const badRule = validateImport({ format: PRESET_FORMAT, version: 1, replaceRules: [{ mode: 'replace' }] });
    assert.ok(badRule.errors.some(e => e.includes('trigger')));
    const badCkpt = validateImport({ format: PRESET_FORMAT, version: 1, checkpointProfiles: [] });
    assert.ok(badCkpt.errors.some(e => e.includes('checkpointProfiles')));
});

test('validateImport treats absent collections as empty (still ok)', () => {
    const { ok } = validateImport({ format: PRESET_FORMAT, version: 1 });
    assert.equal(ok, true);
});

test('planMerge keep-mine: new records added, conflicts skipped', () => {
    const existing = { characters: [sampleChar], replaceRules: [sampleRule], checkpointProfiles: sampleCkpt };
    const incoming = {
        characters: [
            { id: 'c1', name: 'Lyna', booru: 'CHANGED' },       // id conflict
            { id: 'c9', name: 'LYNA', booru: 'other' },          // name conflict (case-insensitive)
            { id: 'c2', name: 'Mira', booru: 'red hair' },       // new
        ],
        replaceRules: [sampleRule, { trigger: 'new', mode: 'replace', replacement: 'x' }],
        checkpointProfiles: { 'model-a.safetensors': { profile: 'krea2' }, 'model-b.safetensors': { profile: 'illustrious' } },
    };
    const plan = planMerge(existing, incoming, 'keep-mine');
    assert.equal(plan.characters.add.length, 1);
    assert.equal(plan.characters.add[0].id, 'c2');
    assert.equal(plan.characters.overwrite.length, 0);
    assert.equal(plan.characters.skip.length, 2);
    assert.equal(plan.replaceRules.add.length, 1);
    assert.equal(plan.replaceRules.skip.length, 1);
    assert.equal(plan.checkpointProfiles.add.length, 1);
    assert.equal(plan.checkpointProfiles.add[0].title, 'model-b.safetensors');
    assert.equal(plan.checkpointProfiles.skip.length, 1);
});

test('planMerge overwrite: conflicts win and keep the EXISTING id', () => {
    const existing = { characters: [sampleChar] };
    const incoming = { characters: [{ id: 'other-id', name: 'lyna', booru: 'CHANGED' }] };
    const plan = planMerge(existing, incoming, 'overwrite');
    assert.equal(plan.characters.add.length, 0);
    assert.equal(plan.characters.overwrite.length, 1);
    assert.equal(plan.characters.overwrite[0].id, 'c1', 'existing id preserved so references stay valid');
    assert.equal(plan.characters.overwrite[0].booru, 'CHANGED');
});

test('planMerge handles empty/absent collections on both sides', () => {
    const plan = planMerge({}, {}, 'keep-mine');
    for (const name of ['characters', 'outfits', 'styles', 'personas', 'replaceRules', 'checkpointProfiles']) {
        assert.deepEqual(plan[name], { add: [], overwrite: [], skip: [] }, name);
    }
});

test('single-entity export is portable and strips credentials recursively', () => {
    const doc = buildEntityExport('character', {
        id: 'c1', name: 'Lyna', keyword: 'lyna', apiKey: 'configured-credential',
        binding: { cardIds: ['lyna.png'], chatIds: ['chat-old'], global: true },
        nested: { authorization: 'configured-credential', safe: 'kept' },
    });
    assert.equal(doc.format, ENTITY_FORMAT);
    assert.equal(doc.entity.apiKey, undefined);
    assert.equal(doc.entity.nested.authorization, undefined);
    assert.equal(doc.entity.nested.safe, 'kept');
});

test('single-entity import validates shape, changes colliding id, and resets non-portable binding', () => {
    const doc = buildEntityExport('persona', {
        id: 'p1', name: 'Hero', keyword: 'hero', aliases: [' Hero '],
        binding: { cardIds: ['hero.png'], chatIds: ['chat-old'], global: true },
    });
    assert.equal(validateEntityImport(doc).ok, true);
    const imported = prepareEntityImport(doc, {
        existing: [{ id: 'p1', keyword: 'hero' }],
        idFactory: () => 'p2',
    });
    assert.equal(imported.id, 'p2');
    assert.equal(imported.keyword, 'hero2');
    assert.deepEqual(imported.aliases, ['hero']);
    assert.deepEqual(imported.binding, { cardIds: ['hero.png'], chatIds: [], global: false });
});

test('single-entity import rejects malformed documents', () => {
    assert.equal(validateEntityImport({}).ok, false);
    assert.throws(() => prepareEntityImport({ format: ENTITY_FORMAT, version: 1, kind: 'character', entity: {} }), /entity\.name/i);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
