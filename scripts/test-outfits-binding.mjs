#!/usr/bin/env node
// IF Image - outfit trigger + character binding tests (Phase C3/C4).
// Run: node scripts/test-outfits-binding.mjs
import assert from 'node:assert/strict';
import { parseTriggers, matchOutfit, charSlotToken } from '../src/prompt/triggers.js';
import { renderCharacterForDialect, assemblePrompt } from '../src/prompt/render.js';
import { PROFILES } from '../src/profiles.js';
import { buildTriggerContext, resolveActiveEntities as resolveActiveCharacters } from '../src/prompt/binding.js';

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

const lyna = { id: 'c1', name: 'Lyna', keyword: 'lyna', aliases: [], countTag: '1girl', booru: 'silver hair' };
const mira = { id: 'c2', name: 'Mira', keyword: 'mira', aliases: [], countTag: '1girl', booru: 'red hair' };
const roster = [lyna, mira];

const outfits = [
    { id: 'o1', name: 'Casual', keyword: 'casual', charId: 'c1', tags: 't-shirt, jeans' },
    { id: 'o2', name: 'Armor', keyword: 'armor', charId: 'c1', tags: 'plate armor, sword' },
    { id: 'o3', name: 'Swimsuit', keyword: 'swimsuit', charId: null, tags: 'bikini' }, // common
    { id: 'o4', name: 'Uniform', keyword: 'uniform', charId: 'c2', tags: 'school uniform' },
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
    const vnOutfits = [...outfits, { id: 'o5', name: 'đồngủ', keyword: 'ng', charId: 'c1', tags: 'pajamas' }];
    const parsed = parseTriggers('$Lyna:đồngủ sleeping', { roster, outfits: vnOutfits });
    assert.equal(parsed.characters[0].outfitTags, 'pajamas');
    assert.equal(parsed.residualPrompt, `${charSlotToken(0)} sleeping`);
});

test('common outfit with charId undefined (legacy record) still resolves via store filter parity', () => {
    const legacyOutfits = [{ id: 'o9', name: 'Cloak', keyword: 'cloak', tags: 'hooded cloak' }]; // no charId field at all
    const parsed = parseTriggers('$Mira:cloak in the rain', { roster, outfits: legacyOutfits });
    assert.equal(parsed.characters[0].outfitTags, 'hooded cloak');
});

test('JSON trigger outfit field stays a raw string when no outfits are supplied (regression)', () => {
    const parsed = parseTriggers('${char: "Lyna", outfit: "casual"} at a bar', { roster });
    assert.equal(parsed.characters[0].outfit, 'casual');
    assert.equal(parsed.characters[0].outfitTags, undefined);
});

// --- binding resolution (C4) ---
const bound = { ...lyna, binding: { cardIds: ['card-a'], chatIds: [], global: false } };
const boundChat = { ...mira, binding: { cardIds: [], chatIds: ['chat-1'], global: false } };
const unbound = { id: 'c3', name: 'Free', keyword: 'free', binding: { cardIds: [], chatIds: [], global: true } };

test('resolveActiveEntities: active = card-bound + chat-bound + global union', () => {
    const active = resolveActiveCharacters([bound, boundChat, unbound], 'card-a', 'chat-1');
    assert.deepEqual(active.map(c => c.id).sort(), ['c1', 'c2', 'c3']);
});

test('resolveActiveEntities: global entities stay active when others are bound here', () => {
    const active = resolveActiveCharacters([bound, unbound], 'card-a', 'chat-x');
    assert.deepEqual(active.map(c => c.id).sort(), ['c1', 'c3']);
});

test('resolveActiveEntities: an entity bound to a DIFFERENT card/chat is excluded', () => {
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

test('buildTriggerContext excludes unbound keyword and alias triggers', () => {
    const character = { ...lyna, aliases: ['silver'], binding: { cardIds: [], chatIds: [], global: false } };
    const context = buildTriggerContext({ characters: [character], cardId: 'card-a', chatId: 'chat-1' });
    assert.deepEqual(context.roster, []);
    assert.equal(parseTriggers('$lyna $silver', context).characters.length, 0);
});

test('buildTriggerContext includes a global entity', () => {
    const character = { ...lyna, binding: { cardIds: [], chatIds: [], global: true } };
    const context = buildTriggerContext({ characters: [character], cardId: 'card-x', chatId: 'chat-x' });
    assert.equal(parseTriggers('$lyna', context).characters[0].char.id, 'c1');
});

test('buildTriggerContext includes an entity bound to the current chat', () => {
    const character = { ...mira, binding: { cardIds: [], chatIds: ['chat-1'], global: false } };
    const context = buildTriggerContext({ characters: [character], cardId: 'card-x', chatId: 'chat-1' });
    assert.equal(parseTriggers('$mira', context).characters[0].char.id, 'c2');
});

test('inactive default persona yields null and $me does not resolve', () => {
    const persona = { id: 'p1', name: 'Player', keyword: 'player', isDefault: true,
        binding: { cardIds: ['other'], chatIds: [], global: false } };
    const context = buildTriggerContext({ personas: [persona], cardId: 'card-a', chatId: 'chat-1' });
    assert.equal(context.defaultPersona, null);
    assert.equal(parseTriggers('$me', context).characters.length, 0);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
