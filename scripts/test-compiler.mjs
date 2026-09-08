#!/usr/bin/env node
// IF Image - Offline compiler unit tests.
// Run: node scripts/test-compiler.mjs

import assert from 'node:assert/strict';
import { parseTriggers, matchCharacter, normalizeName } from '../src/prompt/triggers.js';
import { renderCharacterForDialect, assemblePrompt, resolveProfileKey } from '../src/prompt/render.js';
import { normalizeBooruTags, deduplicateTags } from '../src/prompt/dialects.js';
import { PROFILES } from '../src/profiles.js';

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

console.log('Compiler & Trigger tests');

// Mock roster
const roster = [
    {
        id: 'c1',
        name: 'Lyna',
        aliases: ['dark elf', 'lyna elf'],
        countTag: '1girl',
        booru: 'silver hair, purple eyes, dark elf, pointed ears',
        natural: 'a slender dark elf woman with flowing silver hair and glowing violet eyes',
        facts: 'Elf assassin',
        views: { back: 'long hair over back, viewed from behind' },
        nsfwExtra: 'cleavage, bare shoulders',
    },
    {
        id: 'c2',
        name: 'Đào',
        aliases: ['Dao'],
        countTag: '1girl',
        booru: 'black hair, brown eyes, ao dai',
        natural: 'a young Vietnamese woman with long black hair wearing a white ao dai',
    }
];

const styles = [
    {
        id: 's1',
        name: 'Cyberpunk',
        dialectHints: {
            krea: { stylePhrase: 'cyberpunk city, neon lighting' },
            anima: { booruTags: 'cyberpunk, neon lights' },
            illus: { qualityPrefix: 'masterpiece, amazing quality', artists: 'retro anime' },
        }
    }
];

const defaultPersona = {
    id: 'p1',
    name: 'Player',
    povMode: 'hidden',
    countTag: '1boy',
    booru: 'short brown hair, leather jacket',
    natural: 'a tall man in a leather jacket',
};

// 1. Tag Normalization
test('normalizeBooruTags replaces underscores and trims', () => {
    const input = 'long_hair, , score_7, blue_eyes ';
    const res = normalizeBooruTags(input);
    assert.equal(res, 'long hair, score_7, blue eyes');
});

// 2. Tag Deduplication
test('deduplicateTags preserves case but eliminates duplicate entries', () => {
    const input = '1girl, solo, 1girl, SOLO, blue eyes, solo';
    const res = deduplicateTags(input);
    assert.equal(res, '1girl, solo, blue eyes');
});

// 3. Name Normalization (Vietnamese đ/Đ)
test('normalizeName handles accents and đ/Đ', () => {
    assert.equal(normalizeName('Đào'), 'dao');
    assert.equal(normalizeName('Lyna'), 'lyna');
});

// 4. Character Matching
test('matchCharacter matches exact and aliases', () => {
    assert.equal(matchCharacter('Lyna', roster)?.id, 'c1');
    assert.equal(matchCharacter('dark elf', roster)?.id, 'c1');
    assert.equal(matchCharacter('Đào', roster)?.id, 'c2');
    assert.equal(matchCharacter('dao', roster)?.id, 'c2');
});

// 5. Parse Triggers
test('parseTriggers extracts characters, modifiers, styles, and residual prompt', () => {
    const input = '$Lyna:back|nsfw sitting at a bar, neon lights, {{style: Cyberpunk}}';
    const parsed = parseTriggers(input, { roster, styles, defaultPersona });

    assert.equal(parsed.characters.length, 1);
    assert.equal(parsed.characters[0].char.name, 'Lyna');
    assert.deepEqual(parsed.characters[0].modifiers, ['back', 'nsfw']);
    assert.equal(parsed.styles.length, 1);
    assert.equal(parsed.styles[0].name, 'Cyberpunk');
    assert.equal(parsed.residualPrompt, 'sitting at a bar, neon lights');
});

// 6. 3-Dialect Assembly Test
test('assemblePrompt generates dialect-accurate outputs', () => {
    const input = '$Lyna:back sitting at a bar, {{style: Cyberpunk}}';
    const parsed = parseTriggers(input, { roster, styles, defaultPersona });

    // Krea (Prose)
    const kreaOut = assemblePrompt(parsed, 'krea', PROFILES.krea2);
    assert.ok(kreaOut.prompt.includes('sitting at a bar'));
    assert.ok(kreaOut.prompt.includes('seen from behind'));
    assert.ok(kreaOut.prompt.includes('cyberpunk city'));
    assert.equal(kreaOut.negative, ''); // No negative at CFG 1

    // Anima (Hybrid)
    const animaOut = assemblePrompt(parsed, 'anima', PROFILES.anima);
    assert.ok(animaOut.prompt.includes('1girl'));
    assert.ok(animaOut.prompt.includes('silver hair'));
    assert.ok(animaOut.prompt.includes('cyberpunk'));

    // Illustrious (Booru Tags)
    const illusOut = assemblePrompt(parsed, 'illus', PROFILES.illustrious);
    assert.ok(illusOut.prompt.includes('1girl'));
    assert.ok(illusOut.prompt.includes('from behind, looking back'));
    assert.ok(illusOut.prompt.includes('masterpiece'));
    assert.ok(illusOut.negative.includes('worst quality'));
});

// 7. Persona POV ladder
test('Persona hidden POV generates solo looking at viewer', () => {
    const input = '$me drinking coffee';
    const parsed = parseTriggers(input, { roster, styles, defaultPersona });
    const illusOut = assemblePrompt(parsed, 'illus', PROFILES.illustrious);
    assert.ok(illusOut.prompt.includes('solo, looking at viewer'));
});

// 8. B1 regression: JSON trigger modifiers must be a string[] like $Name:mods
test('JSON trigger ${char: Lyna, view: back, nsfw: true} renders back/nsfw variants', () => {
    const parsed = parseTriggers('${char: "Lyna", view: "back", nsfw: true, outfit: "casual"} at a bar', { roster, styles });
    assert.equal(parsed.characters.length, 1);
    assert.deepEqual(parsed.characters[0].modifiers, ['back', 'nsfw']);
    assert.equal(parsed.characters[0].outfit, 'casual');
    assert.equal(parsed.residualPrompt, 'at a bar');
    const viaColon = parseTriggers('$Lyna:back|nsfw at a bar', { roster, styles });
    assert.deepEqual(viaColon.characters[0].modifiers, parsed.characters[0].modifiers);
    const illus = assemblePrompt(parsed, 'illus', PROFILES.illustrious);
    assert.ok(illus.prompt.includes('from behind, looking back'));
    assert.ok(illus.prompt.includes('cleavage'));
    const krea = assemblePrompt(parsed, 'krea', PROFILES.krea2);
    assert.ok(krea.prompt.includes('seen from behind'));
});

// 9. B2: dialectOverride is parsed and maps to a profile key
test('dialectOverride maps krea/anima/illus to profile keys; unknown falls back', () => {
    const parsed = parseTriggers('{{dialect: illus}} $Lyna city', { roster, styles });
    assert.equal(parsed.dialectOverride, 'illus');
    assert.equal(parsed.residualPrompt, 'city');
    assert.deepEqual(resolveProfileKey('illus', 'anima'), { profileKey: 'illustrious', usedOverride: true });
    assert.deepEqual(resolveProfileKey('krea', 'anima'), { profileKey: 'krea2', usedOverride: true });
    assert.deepEqual(resolveProfileKey('anima', 'krea2'), { profileKey: 'anima', usedOverride: true });
    const warn = console.warn;
    let warned = 0;
    console.warn = () => { warned += 1; };
    try {
        assert.deepEqual(resolveProfileKey('bogus', 'anima'), { profileKey: 'anima', usedOverride: false });
    } finally {
        console.warn = warn;
    }
    assert.equal(warned, 1);
    assert.deepEqual(resolveProfileKey(null, 'anima'), { profileKey: 'anima', usedOverride: false });
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
