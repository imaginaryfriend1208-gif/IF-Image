#!/usr/bin/env node
// IF Image - outfit trigger + character binding tests (Phase C3/C4).
// Run: node scripts/test-outfits-binding.mjs
import assert from 'node:assert/strict';
import { parseTriggers, matchOutfit, charSlotToken } from '../src/prompt/triggers.js';
import { renderCharacterForDialect, assemblePrompt } from '../src/prompt/render.js';
import { PROFILES } from '../src/profiles.js';
import { resolveActiveCharacters } from '../src/prompt/binding.js';

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

console.log('Outfits & binding tests');

const lyna = { id: 'c1', name: 'Lyna', aliases: [], countTag: '1girl', booru: 'silver hair' };
const mira = { id: 'c2', name: 'Mira', aliases: [], countTag: '1girl', booru: 'red hair' };
const roster = [lyna, mira];

const outfits = [
    { id: 'o1', name: 'Casual', charId: 'c1', tags: 't-shirt, jeans' },
    { id: 'o2', name: 'Armor', charId: 'c1', tags: 'plate armor, sword' },
    { id: 'o3', name: 'Swimsuit', charId: null, tags: 'bikini' }, // common
    { id: 'o4', name: 'Uniform', charId: 'c2', tags: 'school uniform' },
];

test('matchOutfit fuzzy-matches by name', () => {
    assert.equal(matchOutfit('casual', outfits.filter(o => o.charId === 'c1' || !o.charId))?.id, 'o1');
});

test('$Name:outfitName resolves an owned outfit and appends its tags', () => {
    const parsed = parseTriggers('$Lyna:casual at a cafe', { roster, outfits });
    assert.equal(parsed.characters.length, 1);
    assert.equal(parsed.characters[0].outfit, 'Casual');
    assert.equal(parsed.characters[0].outfitTags, 't-shirt, jeans');
    const illus = assemblePrompt(parsed, 'illus', PROFILES.illustrious);
    assert.ok(illus.prompt.includes('t-shirt, jeans'));
});

test('$Name:outfitName resolves a common outfit for any character', () => {
    const parsed = parseTriggers('$Mira:swimsuit at the beach', { roster, outfits });
    assert.equal(parsed.characters[0].outfitTags, 'bikini');
});

test('a character cannot resolve another character\'s non-common outfit', () => {
    const parsed = parseTriggers('$Mira:casual at a cafe', { roster, outfits });
    // "casual" belongs only to Lyna (c1); Mira should get no outfit match —
    // the unmatched token is dropped from modifiers, not echoed as a tag.
    assert.equal(parsed.characters[0].outfitTags, undefined);
});

test('outfit trigger inherits the preceding view modifier for the same character', () => {
    const parsed = parseTriggers('$Lyna:back running, later $Lyna:armor standing', { roster, outfits });
    assert.equal(parsed.characters.length, 2);
    assert.deepEqual(parsed.characters[0].modifiers, ['back']);
    // Second trigger specifies only an outfit; it inherits "back" from the
    // first trigger for the same character.
    assert.deepEqual(parsed.characters[1].modifiers, ['back']);
    assert.equal(parsed.characters[1].outfitTags, 'plate armor, sword');
});

test('JSON trigger outfit field still resolves tags when outfits are supplied', () => {
    const parsed = parseTriggers('${char: "Lyna", outfit: "armor"} at a bar', { roster, outfits });
    assert.equal(parsed.characters[0].outfit, 'armor');
    assert.equal(parsed.characters[0].outfitTags, 'plate armor, sword');
});

test('outfit token with Vietnamese diacritics matches ($Lyna:đồngủ)', () => {
    const vnOutfits = [...outfits, { id: 'o5', name: 'đồngủ', charId: 'c1', tags: 'pajamas' }];
    const parsed = parseTriggers('$Lyna:đồngủ sleeping', { roster, outfits: vnOutfits });
    assert.equal(parsed.characters[0].outfitTags, 'pajamas');
    assert.equal(parsed.residualPrompt, `${charSlotToken(0)} sleeping`);
});

test('common outfit with charId undefined (legacy record) still resolves via store filter parity', () => {
    const legacyOutfits = [{ id: 'o9', name: 'Cloak', tags: 'hooded cloak' }]; // no charId field at all
    const parsed = parseTriggers('$Mira:cloak in the rain', { roster, outfits: legacyOutfits });
    assert.equal(parsed.characters[0].outfitTags, 'hooded cloak');
});

test('JSON trigger outfit field stays a raw string when no outfits are supplied (regression)', () => {
    const parsed = parseTriggers('${char: "Lyna", outfit: "casual"} at a bar', { roster });
    assert.equal(parsed.characters[0].outfit, 'casual');
    assert.equal(parsed.characters[0].outfitTags, undefined);
});

// --- binding resolution (C4) ---
const bound = { ...lyna, binding: { cardId: 'card-a', chatIds: [] } };
const boundChat = { ...mira, binding: { cardId: null, chatIds: ['chat-1'] } };
const unbound = { id: 'c3', name: 'Free', binding: { cardId: null, chatIds: [] } };

test('resolveActiveCharacters: active = card-bound + chat-bound + unbound union', () => {
    const active = resolveActiveCharacters([bound, boundChat, unbound], 'card-a', 'chat-1');
    assert.deepEqual(active.map(c => c.id).sort(), ['c1', 'c2', 'c3']);
});

test('resolveActiveCharacters: unbound characters stay active even when others are bound here', () => {
    const active = resolveActiveCharacters([bound, unbound], 'card-a', 'chat-x');
    assert.deepEqual(active.map(c => c.id).sort(), ['c1', 'c3']);
});

test('resolveActiveCharacters: a character bound to a DIFFERENT card/chat is excluded', () => {
    const active = resolveActiveCharacters([bound, boundChat, unbound], 'card-x', 'chat-x');
    assert.deepEqual(active.map(c => c.id), ['c3']);
});

test('resolveActiveCharacters: never random — empty roster yields empty result', () => {
    assert.deepEqual(resolveActiveCharacters([], 'card-a', 'chat-1'), []);
});

test('resolveActiveCharacters: deterministic given identical inputs', () => {
    const a = resolveActiveCharacters([bound, boundChat, unbound], 'card-a', 'chat-1');
    const b = resolveActiveCharacters([bound, boundChat, unbound], 'card-a', 'chat-1');
    assert.deepEqual(a.map(c => c.id), b.map(c => c.id));
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
