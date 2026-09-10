// IF Image - Unit tests for src/prompt/ordering.js and the inline-character
// substitution it depends on.
//
// Two regressions these guard:
//  1. A character trigger used to be deleted and its tags hoisted to the
//     front, wrecking sentences like "a cat in front of $Carter while he
//     eats an ice cream".
//  2. normalizeBooruTags and the anima cleanup branch replace every
//     underscore, silently breaking <lora:my_cool_lora:1>.
//
// Run: node scripts/test-ordering.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isValidLora, extractLoras, maskLoras, unmaskLoras,
    stripPlaceholders, reorderPrompt, collectLoras,
} from '../src/prompt/ordering.js';
import { parseTriggers, charSlotToken } from '../src/prompt/triggers.js';
import { assemblePrompt } from '../src/prompt/render.js';
import { normalizeBooruTags } from '../src/prompt/dialects.js';
import { cleanupEnvelope } from '../src/prompt/cleanup.js';
import { PROFILES } from '../src/profiles.js';

const LORA = '<lora:WinxclubKrea2pack:1>';
const LORA_UNDERSCORE = '<lora:my_cool_lora:0.8>';

// ------------------------------------------------------------------
// isValidLora
// ------------------------------------------------------------------
test('isValidLora: accepts weighted and unweighted tokens', () => {
    assert.equal(isValidLora(LORA), true);
    assert.equal(isValidLora('<lora:Name>'), true);
    assert.equal(isValidLora('<lora:my_cool_lora:0.8>'), true);
    assert.equal(isValidLora('  <lora:Name:1>  '), true, 'surrounding space is trimmed');
});

test('isValidLora: rejects junk, prose, and multi-token strings', () => {
    for (const bad of ['', '   ', 'lora:Name:1', '<lora:>', 'a girl', null, 42]) {
        assert.equal(isValidLora(bad), false, `should reject ${JSON.stringify(bad)}`);
    }
    assert.equal(isValidLora('<lora:A:1> <lora:B:1>'), false, 'only one token allowed');
    assert.equal(isValidLora('1girl, <lora:A:1>'), false, 'no surrounding tags allowed');
});

// ------------------------------------------------------------------
// extract / mask / unmask
// ------------------------------------------------------------------
test('extractLoras: pulls tokens out and keeps source order', () => {
    const { text, loras } = extractLoras(`<lora:A:1>, 1girl, <lora:B:0.5>, smiling`);
    assert.deepEqual(loras, ['<lora:A:1>', '<lora:B:0.5>']);
    assert.equal(text, '1girl, smiling');
});

test('extractLoras: no LoRA is a passthrough', () => {
    const { text, loras } = extractLoras('1girl, smiling');
    assert.deepEqual(loras, []);
    assert.equal(text, '1girl, smiling');
});

test('maskLoras/unmaskLoras: round-trips byte-identically', () => {
    const input = `1girl, ${LORA_UNDERSCORE}, smiling`;
    const { text, loras } = maskLoras(input);
    assert.ok(!text.includes('<lora:'), 'no angle brackets survive masking');
    assert.equal(unmaskLoras(text, loras), input);
});

test('maskLoras: placeholder carries no character the tag pipeline rewrites', () => {
    const { text } = maskLoras(`1girl, ${LORA_UNDERSCORE}`);
    const placeholder = text.split(',').pop().trim();
    // Underscores would be replaced, parens escaped, commas would split it.
    assert.ok(!/[_(),<>]/.test(placeholder), `placeholder "${placeholder}" must be inert`);
});

test('stripPlaceholders: reports the LoRAs found and removes the markers', () => {
    const { text, loras } = maskLoras(`1girl, ${LORA}, smiling`);
    const { text: cleaned, found } = stripPlaceholders(text, loras);
    assert.deepEqual(found, [LORA]);
    assert.equal(cleaned, '1girl, smiling');
});

test('stripPlaceholders: an unknown index is dropped, never resurrected', () => {
    const { text, found } = stripPlaceholders('1girl, ifimageloraslot7, smiling', []);
    assert.deepEqual(found, []);
    assert.equal(text, '1girl, smiling');
});

// ------------------------------------------------------------------
// The underscore-corruption regression
// ------------------------------------------------------------------
test('a LoRA with underscores is corrupted by the raw tag helpers', () => {
    // Documents WHY masking exists — if this ever stops being true, the
    // masking dance could be simplified.
    assert.equal(normalizeBooruTags(LORA_UNDERSCORE), '<lora:my cool lora:0.8>');
});

test('masking protects a LoRA with underscores through normalizeBooruTags', () => {
    const { text, loras } = maskLoras(`1girl, ${LORA_UNDERSCORE}`);
    const afterPipeline = normalizeBooruTags(text);
    assert.equal(unmaskLoras(afterPipeline, loras).includes(LORA_UNDERSCORE), true);
});

test('masking protects a LoRA through the anima cleanup underscore replace', () => {
    const { text, loras } = maskLoras(`1girl, ${LORA_UNDERSCORE}`);
    const cleaned = cleanupEnvelope({ prompt: text, negative: '', params: {} }, 'anima');
    const restored = reorderPrompt(cleaned.prompt, { loras });
    assert.ok(restored.includes(LORA_UNDERSCORE), `expected the LoRA intact, got: ${restored}`);
});

// ------------------------------------------------------------------
// reorderPrompt
// ------------------------------------------------------------------
test('reorderPrompt: hoists inline LoRAs to the front, order preserved', () => {
    const { text, loras } = maskLoras('1girl, <lora:A:1>, smiling, <lora:B:1>, outdoors');
    assert.equal(reorderPrompt(text, { loras }), '<lora:A:1>, <lora:B:1>, 1girl, smiling, outdoors');
});

test('reorderPrompt: roster LoRAs lead, then inline ones', () => {
    const { text, loras } = maskLoras('1girl, <lora:Inline:1>');
    const out = reorderPrompt(text, { loras, extraLoras: ['<lora:Style:1>'] });
    assert.equal(out, '<lora:Style:1>, <lora:Inline:1>, 1girl');
});

test('reorderPrompt: the core prompt order is never rearranged', () => {
    const core = 'a cat walking in front of 1boy, brown hair while he is eating an ice cream';
    const { text, loras } = maskLoras(`${core}, <lora:A:1>`);
    assert.equal(reorderPrompt(text, { loras }), `<lora:A:1>, ${core}`);
});

test('reorderPrompt: a duplicated LoRA is emitted once', () => {
    const { text, loras } = maskLoras('1girl, <lora:A:1>, smiling, <lora:A:1>');
    assert.equal(reorderPrompt(text, { loras }), '<lora:A:1>, 1girl, smiling');
});

test('reorderPrompt: keepLoraPosition leaves inline LoRAs where written', () => {
    const { text, loras } = maskLoras('1girl, <lora:A:1>, smiling');
    assert.equal(
        reorderPrompt(text, { loras, keepLoraPosition: true }),
        '1girl, <lora:A:1>, smiling',
    );
});

test('reorderPrompt: keepLoraPosition still leads with roster LoRAs', () => {
    // A roster LoRA was never written into the prompt, so it has no position
    // of its own to keep.
    const { text, loras } = maskLoras('1girl, <lora:Inline:1>');
    const out = reorderPrompt(text, { loras, extraLoras: ['<lora:Style:1>'], keepLoraPosition: true });
    assert.equal(out, '<lora:Style:1>, 1girl, <lora:Inline:1>');
});

test('reorderPrompt: no LoRAs anywhere is a passthrough', () => {
    assert.equal(reorderPrompt('1girl, smiling', {}), '1girl, smiling');
});

test('reorderPrompt: non-string input yields empty string', () => {
    assert.equal(reorderPrompt(null, {}), '');
});

// ------------------------------------------------------------------
// collectLoras
// ------------------------------------------------------------------
test('collectLoras: styles first, then characters in order of appearance', () => {
    const out = collectLoras({
        styles: [{ lora: '<lora:Style:1>' }],
        characters: [
            { char: { lora: '<lora:Ann:1>' } },
            { char: { lora: '<lora:Bob:1>' } },
        ],
    });
    assert.deepEqual(out, ['<lora:Style:1>', '<lora:Ann:1>', '<lora:Bob:1>']);
});

test('collectLoras: a persona contributes exactly like a character', () => {
    const out = collectLoras({
        characters: [{ isPersona: true, persona: { lora: '<lora:Me:1>' } }],
    });
    assert.deepEqual(out, ['<lora:Me:1>']);
});

test('collectLoras: duplicates collapse to the earliest occurrence', () => {
    const out = collectLoras({
        styles: [{ lora: '<lora:Shared:1>' }],
        characters: [{ char: { lora: '<lora:Shared:1>' } }],
    });
    assert.deepEqual(out, ['<lora:Shared:1>']);
});

test('collectLoras: empty/absent slots and junk values are ignored', () => {
    assert.deepEqual(collectLoras({}), []);
    assert.deepEqual(collectLoras({ styles: [{ lora: '' }, {}], characters: [{}] }), []);
    assert.deepEqual(collectLoras({ styles: [{ lora: 'not a lora' }] }), []);
});

// ------------------------------------------------------------------
// Inline character substitution (the ice-cream regression)
// ------------------------------------------------------------------
const roster = [
    { id: 'c1', name: 'Carter', countTag: '1boy', booru: 'brown hair, blue eyes' },
    { id: 'c2', name: 'Ann', countTag: '1girl', booru: 'blonde hair' },
];

test('a character trigger renders where it stands, sentence intact', () => {
    const input = 'a cat walking in front of the $Carter while he is eating an ice cream';
    const parsed = parseTriggers(input, { roster, styles: [] });
    const out = assemblePrompt(parsed, 'illus', PROFILES.illustrious).prompt;

    assert.ok(out.includes('a cat walking in front of the 1boy, brown hair, blue eyes while he is eating an ice cream'),
        `character was not substituted in place: ${out}`);
    // The old bug left a gap where the token had been.
    assert.ok(!/front of the\s+while/.test(out), 'the sentence still has a hole where the trigger was');
    assert.ok(!out.includes(charSlotToken(0)), 'the slot marker leaked into the output');
});

test('a bare trigger with no prose is unchanged from the pre-inline behaviour', () => {
    const parsed = parseTriggers('$Carter', { roster, styles: [] });
    const out = assemblePrompt(parsed, 'illus', PROFILES.illustrious).prompt;
    assert.equal(out, 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, newest, 1boy, brown hair, blue eyes');
});

test('two characters each render at their own position', () => {
    const parsed = parseTriggers('$Ann hands a cup to $Carter', { roster, styles: [] });
    const out = assemblePrompt(parsed, 'illus', PROFILES.illustrious).prompt;
    const annAt = out.indexOf('blonde hair');
    const carterAt = out.indexOf('brown hair');
    assert.ok(annAt > -1 && carterAt > -1, `both characters should render: ${out}`);
    assert.ok(annAt < carterAt, 'Ann precedes Carter, as written');
    assert.ok(out.includes('hands a cup to'), 'the connecting words survive');
});

test('a persona is addressable by name, exactly like a character', () => {
    const personas = [{ id: 'p1', name: 'Nova', countTag: '1girl', booru: 'silver hair', povMode: 'full' }];
    const parsed = parseTriggers('$Nova sitting by the window', { roster, styles: [], personas });
    assert.equal(parsed.characters.length, 1);
    assert.equal(parsed.characters[0].isPersona, true);
    assert.equal(parsed.characters[0].persona.id, 'p1');

    const out = assemblePrompt(parsed, 'illus', PROFILES.illustrious).prompt;
    assert.ok(out.includes('silver hair'), `persona tags missing: ${out}`);
    assert.ok(out.includes('sitting by the window'), 'the scene wording survives');
});

test('a character name wins over a persona of the same name', () => {
    const personas = [{ id: 'p1', name: 'Carter', countTag: '1girl', booru: 'silver hair' }];
    const parsed = parseTriggers('$Carter waves', { roster, styles: [], personas });
    assert.equal(parsed.characters[0].isPersona, undefined);
    assert.equal(parsed.characters[0].char.id, 'c1');
});

test('an unknown $token is left alone, not turned into a slot', () => {
    const parsed = parseTriggers('$Nobody waves', { roster, styles: [] });
    assert.equal(parsed.characters.length, 0);
    assert.equal(parsed.residualPrompt, '$Nobody waves');
});
