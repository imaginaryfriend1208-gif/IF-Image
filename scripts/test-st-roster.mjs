#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createCharacterFromStCard, findCharacterByCardId, getStCharacters,
} from '../src/storage/chars.js';
import { createDefaultPersona, applyPersonaNameImport } from '../src/storage/presets.js';

test('ST card mapping overlays card fields on a complete default character', () => {
    const character = createCharacterFromStCard({
        name: '  Alice  ', nickname: ' Ally ', avatar: 'alice.png',
        tags: ['blue hair', '', 42, ' green eyes '], description: 'An explorer.',
    });
    assert.equal(character.name, 'Alice');
    assert.deepEqual(character.aliases, []);
    assert.equal(character.countTag, '1girl');
    assert.equal(character.booru, '');
    assert.equal(character.natural, '');
    assert.equal(character.facts, '');
    assert.deepEqual(character.binding, { cardIds: ['alice.png'], chatIds: [], global: false });
    assert.equal(character.keyword, 'alice');
    assert.ok(character.id);
    assert.ok(character.booruDetail?.face?.sfw);
    assert.deepEqual(character.lock, { seed: -1, params: null });
});

test('ST card mapping tolerates missing optional fields', () => {
    const character = createCharacterFromStCard({ name: '', tags: 'not-an-array' });
    assert.equal(character.name, 'New Character');
    assert.deepEqual(character.aliases, []);
    assert.equal(character.booru, '');
    assert.equal(character.facts, '');
    assert.deepEqual(character.binding.cardIds, []);
});

test('ST card mapping rejects a missing card object', () => {
    assert.throws(() => createCharacterFromStCard(null), /card is required/i);
});

test('duplicate matching uses only a non-empty stable card id', () => {
    const records = [{ id: 'a', binding: { cardIds: ['a.png'] } }, { id: 'empty', binding: { cardIds: [] } }];
    assert.equal(findCharacterByCardId(records, 'a.png')?.id, 'a');
    assert.equal(findCharacterByCardId(records, 'missing.png'), null);
    assert.equal(findCharacterByCardId(records, null), null);
    assert.equal(findCharacterByCardId(records, ''), null);
});

test('bulk source accepts ST array/object rosters and filters empty entries', () => {
    const a = { name: 'A' };
    const b = { name: 'B' };
    assert.deepEqual(getStCharacters({ characters: [a, null, b] }), [a, b]);
    assert.deepEqual(getStCharacters({ characters: { first: a, empty: null } }), [a]);
    assert.deepEqual(getStCharacters({}), []);
});

test('persona import reads only the host display name', () => {
    const persona = createDefaultPersona('Old');
    persona.aliases = ['kept'];
    persona.dialectHints.krea.lighting = 'soft';
    const result = applyPersonaNameImport(persona, {
        name: ' New ', countTag: '1girl', booru: 'red hair', natural: 'a hero',
        aliases: ['ignored'], dialectHints: { krea: { lighting: 'hard' } },
    });
    assert.equal(result.applied, true);
    assert.equal(persona.name, 'New');
    assert.deepEqual(persona.aliases, ['kept']);
    assert.equal(persona.dialectHints.krea.lighting, 'soft');
});
