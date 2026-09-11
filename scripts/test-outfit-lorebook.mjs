#!/usr/bin/env node
// IF Image - lorebook-style outfit trigger tests.
// Covers storage normalization, the pure keyword matcher, automatic outfit
// assignment inside parseTriggers, and per-dialect outfit rendering.
// Run: node scripts/test-outfit-lorebook.mjs
import assert from 'node:assert/strict';
import { parseTriggers } from '../src/prompt/triggers.js';
import { renderCharacterForDialect, renderPersonaForDialect, resolveOutfitText } from '../src/prompt/render.js';
import {
    normalizeOutfit,
    normalizeOutfitKeys,
    normalizeOutfitTriggerMode,
    OUTFIT_TRIGGER_MODES,
} from '../src/storage/outfits.js';
import {
    matchAutomaticOutfit,
    containsOutfitKeyword,
    normalizeOutfitKeyword,
} from '../src/prompt/outfit-keywords.js';

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

console.log('Outfit lorebook tests');

// ---------------------------------------------------------------- storage --

test('legacy outfit without lorebook fields normalizes to explicit', () => {
    const out = normalizeOutfit({ id: 'o1', name: 'Casual', tags: 't-shirt', charId: 'c1' });
    assert.equal(out.triggerMode, OUTFIT_TRIGGER_MODES.EXPLICIT);
    assert.deepEqual(out.triggers, []);
    assert.deepEqual(out.excludeKeys, []);
    assert.deepEqual(out.dialectHints, { krea: '', anima: '', illus: '' });
});

test('normalizeOutfit preserves the legacy { id, name, tags, charId } shape', () => {
    const out = normalizeOutfit({ id: 'o1', name: '  Casual  ', tags: ' t-shirt ', charId: 'c1' });
    assert.equal(out.id, 'o1');
    assert.equal(out.name, 'Casual');
    assert.equal(out.tags, 't-shirt');
    assert.equal(out.charId, 'c1');
});

test('import alias "keyword" normalizes to auto_keyword', () => {
    assert.equal(normalizeOutfitTriggerMode('keyword'), OUTFIT_TRIGGER_MODES.AUTO_KEYWORD);
    assert.equal(normalizeOutfitTriggerMode('auto_keyword'), OUTFIT_TRIGGER_MODES.AUTO_KEYWORD);
});

test('unknown / missing trigger mode falls back to explicit (never auto-enables)', () => {
    assert.equal(normalizeOutfitTriggerMode(undefined), OUTFIT_TRIGGER_MODES.EXPLICIT);
    assert.equal(normalizeOutfitTriggerMode('nonsense'), OUTFIT_TRIGGER_MODES.EXPLICIT);
    assert.equal(normalizeOutfitTriggerMode(null), OUTFIT_TRIGGER_MODES.EXPLICIT);
});

test('normalizeOutfitKeys splits strings, trims, and de-duplicates case-insensitively', () => {
    assert.deepEqual(normalizeOutfitKeys(' pajamas , Pajamas \n bathrobe '), ['pajamas', 'bathrobe']);
    assert.deepEqual(normalizeOutfitKeys(['a', '', '  ', 'a']), ['a']);
    assert.deepEqual(normalizeOutfitKeys(undefined), []);
});

test('normalizeOutfit keeps unknown fields for forward compatibility', () => {
    const out = normalizeOutfit({ name: 'X', futureField: 42 });
    assert.equal(out.futureField, 42);
});

test('normalizeOutfit does not mutate the caller object', () => {
    const input = { name: 'X' };
    normalizeOutfit(input);
    assert.equal(input.triggerMode, undefined);
});

// --------------------------------------------------------------- matching --

test('containsOutfitKeyword matches whole words only, not substrings', () => {
    assert.ok(containsOutfitKeyword('she wears a bikini today', 'bikini'));
    assert.ok(!containsOutfitKeyword('bikinis are folded', 'bikini'));
    assert.ok(!containsOutfitKeyword('nothing here', 'bikini'));
});

test('containsOutfitKeyword is diacritic-insensitive and multi-word aware', () => {
    assert.ok(containsOutfitKeyword('cô ấy mặc đồ ngủ', 'do ngu'));
    assert.ok(containsOutfitKeyword('a silk   night gown', 'night gown'));
    assert.equal(normalizeOutfitKeyword('  Đồ   Ngủ '), 'do ngu');
});

test('containsOutfitKeyword handles empty and non-string input safely', () => {
    assert.equal(containsOutfitKeyword('', 'x'), false);
    assert.equal(containsOutfitKeyword('text', ''), false);
    assert.equal(containsOutfitKeyword(null, null), false);
});

test('regex metacharacters in a key are treated literally', () => {
    assert.ok(containsOutfitKeyword('wearing a c++ hoodie', 'c++'));
    assert.ok(!containsOutfitKeyword('wearing a cxx hoodie', 'c++'));
});

const autoSleep = { id: 'a1', name: 'Sleepwear', charId: 'c1', tags: 'pajamas', triggerMode: 'auto_keyword', triggers: ['pajamas', 'bed'], excludeKeys: ['armor'] };
const autoArmor = { id: 'a2', name: 'Armor', charId: 'c1', tags: 'plate armor', triggerMode: 'auto_keyword', triggers: ['battle'] };
const explicitOnly = { id: 'e1', name: 'Gala', charId: 'c1', tags: 'ball gown', triggerMode: 'explicit', triggers: ['bed'] };

test('matchAutomaticOutfit ignores explicit-mode outfits even when keys match', () => {
    assert.equal(matchAutomaticOutfit('sitting on the bed', [explicitOnly]), null);
});

test('matchAutomaticOutfit selects an auto outfit on a keyword hit', () => {
    assert.equal(matchAutomaticOutfit('sitting on the bed', [autoSleep])?.id, 'a1');
});

test('excludeKeys veto a candidate even when a trigger matched', () => {
    assert.equal(matchAutomaticOutfit('on the bed in full armor', [autoSleep]), null);
});

test('no keyword evidence yields no outfit', () => {
    assert.equal(matchAutomaticOutfit('a quiet afternoon', [autoSleep, autoArmor]), null);
    assert.equal(matchAutomaticOutfit('', [autoSleep]), null);
    assert.equal(matchAutomaticOutfit('bed', []), null);
});

test('the longer matched phrase wins over a shorter one', () => {
    const short = { id: 's', name: 'Short', triggerMode: 'auto_keyword', triggers: ['dress'] };
    const long = { id: 'l', name: 'Long', triggerMode: 'auto_keyword', triggers: ['red evening dress'] };
    assert.equal(matchAutomaticOutfit('in a red evening dress', [short, long])?.id, 'l');
});

test('more matched keys break a tie at equal phrase length', () => {
    const one = { id: 'one', name: 'One', triggerMode: 'auto_keyword', triggers: ['rain'] };
    const two = { id: 'two', name: 'Two', triggerMode: 'auto_keyword', triggers: ['rain', 'cold'] };
    assert.equal(matchAutomaticOutfit('cold rain outside', [one, two])?.id, 'two');
});

test('selection is deterministic and stable for identical candidates', () => {
    const a = { id: 'z', name: 'Zephyr', triggerMode: 'auto_keyword', triggers: ['bed'] };
    const b = { id: 'y', name: 'Alpha', triggerMode: 'auto_keyword', triggers: ['bed'] };
    const first = matchAutomaticOutfit('on the bed', [a, b])?.id;
    assert.equal(first, matchAutomaticOutfit('on the bed', [b, a])?.id);
    assert.equal(first, 'y'); // normalized name "alpha" sorts first
});

test('matchAutomaticOutfit tolerates malformed input', () => {
    assert.equal(matchAutomaticOutfit(null, [autoSleep]), null);
    assert.equal(matchAutomaticOutfit('bed', null), null);
    assert.equal(matchAutomaticOutfit('bed', [null, { triggerMode: 'auto_keyword' }]), null);
});

// ------------------------------------------------------- parseTriggers ----

const lyna = { id: 'c1', name: 'Lyna', aliases: [], countTag: '1girl', booru: 'silver hair' };
const mira = { id: 'c2', name: 'Mira', aliases: [], countTag: '1girl', booru: 'red hair' };
const roster = [lyna, mira];
const sharedAuto = { id: 'sh1', name: 'Swimsuit', charId: null, tags: 'bikini', triggerMode: 'auto_keyword', triggers: ['beach'] };
const ownedExplicit = { id: 'o1', name: 'Casual', charId: 'c1', tags: 't-shirt, jeans' };
const outfits = [autoSleep, autoArmor, explicitOnly, sharedAuto, ownedExplicit];

test('an owned auto outfit applies to its own character on a keyword hit', () => {
    const parsed = parseTriggers('$Lyna sitting on the bed', { roster, outfits });
    assert.equal(parsed.characters[0].outfit, 'Sleepwear');
    assert.equal(parsed.characters[0].outfitTags, 'pajamas');
    assert.equal(parsed.characters[0].outfitSource, 'auto_keyword');
});

test('an owned auto outfit never applies to a different character', () => {
    const parsed = parseTriggers('$Mira sitting on the bed', { roster, outfits });
    assert.equal(parsed.characters[0].outfitTags, undefined);
});

test('an explicit $Name:outfit trigger always beats an auto keyword hit', () => {
    const parsed = parseTriggers('$Lyna:casual sitting on the bed', { roster, outfits });
    assert.equal(parsed.characters[0].outfit, 'Casual');
    assert.equal(parsed.characters[0].outfitSource, 'explicit');
});

test('an explicit outfit token that matched nothing still blocks auto-match', () => {
    // The user asked for a specific outfit; substituting another silently
    // would be wrong, so the subject stays unclothed by the resolver.
    const parsed = parseTriggers('$Lyna:nosuchoutfit sitting on the bed', { roster, outfits });
    assert.equal(parsed.characters[0].outfitTags, undefined);
});

test('a shared auto outfit applies when exactly one subject is in frame', () => {
    const parsed = parseTriggers('$Lyna at the beach', { roster, outfits });
    assert.equal(parsed.characters[0].outfitTags, 'bikini');
});

test('a shared auto outfit is ambiguous with two subjects and applies to neither', () => {
    const parsed = parseTriggers('$Lyna and $Mira at the beach', { roster, outfits });
    assert.equal(parsed.characters[0].outfitTags, undefined);
    assert.equal(parsed.characters[1].outfitTags, undefined);
});

test('an owned auto outfit still applies while a shared one is ambiguous', () => {
    const parsed = parseTriggers('$Lyna and $Mira on the bed', { roster, outfits });
    assert.equal(parsed.characters[0].outfitTags, 'pajamas'); // owned by c1
    assert.equal(parsed.characters[1].outfitTags, undefined);
});

test('the same character triggered twice resolves to one consistent outfit', () => {
    const parsed = parseTriggers('$Lyna:back on the bed, then $Lyna again', { roster, outfits });
    assert.equal(parsed.characters.length, 2);
    assert.equal(parsed.characters[0].outfitTags, 'pajamas');
    assert.equal(parsed.characters[1].outfitTags, 'pajamas');
});

test('generic prose alone never introduces a character or an outfit', () => {
    const parsed = parseTriggers('a woman on the bed at the beach', { roster, outfits });
    assert.equal(parsed.characters.length, 0);
});

test('keyword matching reads scene prose only, not consumed trigger tokens', () => {
    // "$Lyna" becomes an opaque slot placeholder before matching, so a key
    // spelled like the character name must NOT self-trigger.
    const nameKeyed = [{ id: 'n1', name: 'Named', charId: 'c1', tags: 'x', triggerMode: 'auto_keyword', triggers: ['lyna'] }];
    const parsed = parseTriggers('$Lyna', { roster, outfits: nameKeyed });
    assert.equal(parsed.characters[0].outfitTags, undefined);
});

test('auto outfits do not disturb styles, dialect, or residual text', () => {
    const parsed = parseTriggers('{{dialect: krea}}$Lyna on the bed', { roster, outfits });
    assert.equal(parsed.dialectOverride, 'krea');
    assert.ok(!parsed.residualPrompt.includes('$Lyna'));
});

test('an empty outfit roster is a no-op', () => {
    const parsed = parseTriggers('$Lyna on the bed', { roster, outfits: [] });
    assert.equal(parsed.characters[0].outfitTags, undefined);
});

// ------------------------------------------------------------- rendering --

const hinted = {
    char: lyna,
    modifiers: [],
    outfit: 'Sleepwear',
    outfitTags: 'pajamas',
    outfitRecord: { dialectHints: { krea: 'a loose silk nightgown', anima: '', illus: 'nightgown, silk' } },
};

test('resolveOutfitText prefers the dialect hint when present', () => {
    assert.equal(resolveOutfitText(hinted, 'krea'), 'a loose silk nightgown');
    assert.equal(resolveOutfitText(hinted, 'illus'), 'nightgown, silk');
});

test('resolveOutfitText falls back to tags when the hint is empty or missing', () => {
    assert.equal(resolveOutfitText(hinted, 'anima'), 'pajamas');
    assert.equal(resolveOutfitText({ outfitTags: 'pajamas' }, 'krea'), 'pajamas');
    assert.equal(resolveOutfitText({}, 'krea'), '');
    assert.equal(resolveOutfitText(null, 'krea'), '');
});

test('krea rendering uses the prose dialect hint', () => {
    const out = renderCharacterForDialect(hinted, 'krea');
    assert.ok(out.includes('a loose silk nightgown'));
    assert.ok(!out.includes('pajamas'));
});

test('illus rendering uses the booru dialect hint', () => {
    const out = renderCharacterForDialect(hinted, 'illus');
    assert.ok(out.includes('nightgown'));
});

test('legacy outfits without hints render from tags in every dialect', () => {
    const legacy = { char: lyna, modifiers: [], outfitTags: 't-shirt, jeans' };
    for (const dialect of ['krea', 'anima', 'illus']) {
        assert.ok(renderCharacterForDialect(legacy, dialect).includes('t-shirt'), dialect);
    }
});

test('a character with no outfit renders unchanged', () => {
    const bare = { char: lyna, modifiers: [] };
    assert.ok(!renderCharacterForDialect(bare, 'illus').includes('undefined'));
});

test('a persona in full POV wears its outfit', () => {
    const persona = { id: 'p1', name: 'Ann', povMode: 'full', countTag: '1boy', booru: 'black hair', natural: 'a tall man' };
    const item = { isPersona: true, persona, modifiers: [], outfitTags: 'bikini' };
    assert.ok(renderPersonaForDialect(persona, 'krea', [], item).includes('bikini'));
    assert.ok(renderPersonaForDialect(persona, 'illus', [], item).includes('bikini'));
});

test('a hidden/POV-hands persona is not in frame, so no clothing is emitted', () => {
    const persona = { id: 'p1', name: 'Ann', povMode: 'hidden', countTag: '1boy' };
    const item = { isPersona: true, persona, modifiers: [], outfitTags: 'bikini' };
    assert.ok(!renderPersonaForDialect(persona, 'illus', [], item).includes('bikini'));
});

test('renderPersonaForDialect stays callable without the outfit argument', () => {
    const persona = { id: 'p1', name: 'Ann', povMode: 'full', countTag: '1boy', booru: 'black hair' };
    assert.ok(renderPersonaForDialect(persona, 'illus', []).includes('1boy'));
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
