#!/usr/bin/env node
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createCharacterFromStCard, findCharacterByCardId, getStCharacters,
} from '../src/storage/chars.js';
import { createDefaultPersona, applyPersonaSync } from '../src/storage/presets.js';

test('ST card mapping overlays card fields on a complete default character', () => {
    const character = createCharacterFromStCard({
        name: '  Alice  ', nickname: ' Ally ', avatar: 'alice.png',
        tags: ['blue hair', '', 42, ' green eyes '], description: 'An explorer.',
    });
    assert.equal(character.name, 'Alice');
    assert.deepEqual(character.aliases, ['Ally']);
    assert.equal(character.countTag, '1girl');
    assert.equal(character.booru, 'blue hair, green eyes');
    assert.equal(character.natural, '');
    assert.equal(character.facts, 'An explorer.');
    assert.deepEqual(character.binding, { cardId: 'alice.png', chatIds: [] });
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
    assert.equal(character.binding.cardId, null);
});

test('ST card mapping rejects a missing card object', () => {
    assert.throws(() => createCharacterFromStCard(null), /card is required/i);
});

test('duplicate matching uses only a non-empty stable card id', () => {
    const records = [{ id: 'a', binding: { cardId: 'a.png' } }, { id: 'empty', binding: { cardId: null } }];
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

test('explicit persona sync force-overrides manual freshness protection', () => {
    const persona = createDefaultPersona('Old');
    persona.syncedAt = 100;
    persona.meta.updatedAt = 200;
    assert.equal(applyPersonaSync(persona, { name: 'New' }).applied, false);
    assert.equal(persona.name, 'Old');
    const forced = applyPersonaSync(persona, {
        name: ' New ', countTag: '1girl', booru: 'red hair', natural: 'a hero',
        aliases: [' hero ', 3], dialectHints: { krea: { lighting: 'soft' } },
    }, true);
    assert.equal(forced.applied, true);
    assert.equal(persona.name, 'New');
    assert.deepEqual(persona.aliases, [' hero ']);
    assert.equal(persona.dialectHints.krea.lighting, 'soft');
    assert.ok(persona.syncedAt > 100);
});
