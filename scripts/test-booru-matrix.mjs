#!/usr/bin/env node
// IF Image - booruDetail matrix tests (Phase C1).
// Run: node scripts/test-booru-matrix.mjs
import assert from 'node:assert/strict';
import { renderCharacterForDialect, assemblePrompt } from '../src/prompt/render.js';
import { PROFILES } from '../src/profiles.js';
import { emptyBooruDetail, applyCharMigrations, CHAR_CURRENT_VERSION, createDefaultCharacter } from '../src/storage/chars.js';

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

console.log('booruDetail matrix tests');

const legacyChar = {
    id: 'c1',
    name: 'Lyna',
    countTag: '1girl',
    booru: 'silver hair, purple eyes',
    natural: 'a woman with silver hair',
    views: { back: 'long hair over back' },
    nsfwExtra: 'cleavage, bare shoulders',
    // No booruDetail field at all: pre-Phase-C record shape.
};

test('empty/absent booruDetail: illus back+nsfw renders byte-identical to legacy', () => {
    const out = renderCharacterForDialect({ char: legacyChar, modifiers: ['back', 'nsfw'] }, 'illus');
    assert.equal(out, '1girl, silver hair, purple eyes, from behind, looking back, cleavage, bare shoulders');
});

test('empty/absent booruDetail: anima back+nsfw renders byte-identical to legacy', () => {
    const out = renderCharacterForDialect({ char: legacyChar, modifiers: ['back', 'nsfw'] }, 'anima');
    assert.equal(out, '1girl, silver hair, purple eyes, long hair over back, cleavage, bare shoulders');
});

test('empty/absent booruDetail: krea back+nsfw renders byte-identical to legacy', () => {
    const out = renderCharacterForDialect({ char: legacyChar, modifiers: ['back', 'nsfw'] }, 'krea');
    assert.equal(out, 'a woman with silver hair, seen from behind, cleavage, bare shoulders');
});

test('empty/absent booruDetail: front sfw (default) unaffected', () => {
    const out = renderCharacterForDialect({ char: legacyChar, modifiers: [] }, 'illus');
    assert.equal(out, '1girl, silver hair, purple eyes');
});

const matrixChar = {
    id: 'c2',
    name: 'Mira',
    countTag: '1girl',
    booru: 'red hair',
    natural: 'a woman with red hair',
    views: { back: 'legacy back tag (should be overridden)' },
    nsfwExtra: 'legacy nsfw tag (should be overridden)',
    booruDetail: {
        face: { sfw: { front: 'green eyes', back: 'face back tag' }, nsfw: { front: '', back: '' } },
        upper: { sfw: { front: '', back: 'upper back tag' }, nsfw: { front: '', back: 'upper nsfw back tag' } },
        lower: { sfw: { front: '', back: 'lower back tag' }, nsfw: { front: '', back: '' } },
    },
};

test('filled sfw back cells override the legacy views.back fallback (portrait: face+upper)', () => {
    const out = renderCharacterForDialect({ char: matrixChar, modifiers: ['back'] }, 'anima');
    assert.ok(out.includes('face back tag, upper back tag'));
    assert.ok(!out.includes('legacy back tag'));
});

test('full modifier includes the lower region matrix cells', () => {
    const out = renderCharacterForDialect({ char: matrixChar, modifiers: ['back', 'full'] }, 'anima');
    assert.ok(out.includes('face back tag, upper back tag, lower back tag'));
});

test('nsfw cells are collected in addition to sfw cells, overriding nsfwExtra fallback', () => {
    const out = renderCharacterForDialect({ char: matrixChar, modifiers: ['back', 'full', 'nsfw'] }, 'anima');
    assert.ok(out.includes('face back tag, upper back tag, lower back tag'));
    assert.ok(out.includes('upper nsfw back tag'));
    assert.ok(!out.includes('legacy nsfw tag'));
});

test('front (no back modifier) sfw cells apply too — matrix is view-aware, not back-gated', () => {
    // face.sfw.front = 'green eyes' is filled; the legacy code had no front
    // concept at all, so this is pure Phase C addition with no regression
    // risk (front previously only ever emitted the flat booru string).
    const out = renderCharacterForDialect({ char: matrixChar, modifiers: [] }, 'anima');
    assert.equal(out, '1girl, red hair, green eyes');
});

test('assemblePrompt end-to-end with a filled matrix cell (illus)', () => {
    const parsed = { characters: [{ char: matrixChar, modifiers: ['back'] }], styles: [], residualPrompt: 'at dusk' };
    const out = assemblePrompt(parsed, 'illus', PROFILES.illustrious);
    assert.ok(out.prompt.includes('face back tag'));
    assert.ok(out.prompt.includes('at dusk'));
});

// --- record migration ---
test('applyCharMigrations fills an empty matrix on an absent-field record', () => {
    const char = { id: 'x', name: 'X' };
    applyCharMigrations(char);
    assert.equal(char.presetVersion, CHAR_CURRENT_VERSION);
    assert.deepEqual(char.booruDetail, emptyBooruDetail());
    assert.deepEqual(char.outfits, []);
    assert.deepEqual(char.binding, { cardId: null, chatIds: [] });
});

test('applyCharMigrations preserves existing matrix cell values', () => {
    const char = { id: 'x', name: 'X', booruDetail: { face: { sfw: { front: 'kept', back: '' }, nsfw: { front: '', back: '' } } } };
    applyCharMigrations(char);
    assert.equal(char.booruDetail.face.sfw.front, 'kept');
    assert.equal(char.booruDetail.upper.sfw.front, '');
});

test('applyCharMigrations is idempotent', () => {
    const char = createDefaultCharacter('Y');
    const first = JSON.stringify(char);
    applyCharMigrations(char);
    assert.equal(JSON.stringify(char), first);
});

test('createDefaultCharacter stamps the current presetVersion', () => {
    const char = createDefaultCharacter();
    assert.equal(char.presetVersion, CHAR_CURRENT_VERSION);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
