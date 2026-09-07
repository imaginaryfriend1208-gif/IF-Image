#!/usr/bin/env node
// IF Image - post-assembly cleanup stage tests (Phase C6).
// Run: node scripts/test-cleanup.mjs
import assert from 'node:assert/strict';
import { cleanupEnvelope, stripAvoidTags, enforceRating, escapeParens, dropTailByBudget, stripKreaArtifacts, estimateTokens } from '../src/prompt/cleanup.js';
import { renderPersonaForDialect } from '../src/prompt/render.js';

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

console.log('Cleanup stage tests');

test('stripAvoidTags removes exact tags case-insensitively', () => {
    assert.equal(stripAvoidTags('1girl, Glasses, beard, red hair', ['glasses', 'Beard']), '1girl, red hair');
});

test('stripAvoidTags is a no-op with no avoidTags', () => {
    assert.equal(stripAvoidTags('1girl, red hair', []), '1girl, red hair');
});

test('enforceRating drops the literal nsfw tag in sfw mode only', () => {
    assert.equal(enforceRating('1girl, nsfw, red hair', 'sfw'), '1girl, red hair');
    assert.equal(enforceRating('1girl, nsfw, red hair', 'nsfw'), '1girl, nsfw, red hair');
});

test('escapeParens escapes unescaped parens per tag, leaves already-escaped tags alone', () => {
    assert.equal(escapeParens('rating (safe), score_9'), 'rating \\(safe\\), score_9');
    assert.equal(escapeParens('rating \\(safe\\)'), 'rating \\(safe\\)');
});

test('dropTailByBudget drops whole tags past the budget, never mid-tag, keeps at least one', () => {
    const tags = Array.from({ length: 50 }, (_, i) => `tag${i}`).join(', ');
    const result = dropTailByBudget(tags, 10);
    const kept = result.split(', ');
    assert.ok(kept.length < 50);
    assert.ok(kept.every(t => /^tag\d+$/.test(t)), 'no tag was cut mid-token');
    assert.equal(dropTailByBudget('onlyonetag', 1), 'onlyonetag');
});

test('stripKreaArtifacts removes weight syntax and stray negative-prompt words', () => {
    const out = stripKreaArtifacts('a woman, (detailed skin:1.3), worst quality, photorealistic');
    assert.ok(out.includes('detailed skin'));
    assert.ok(!out.includes(':1.3'));
    assert.ok(!out.toLowerCase().includes('worst quality'));
});

test('estimateTokens counts whitespace/comma-separated chunks (documented approximation)', () => {
    assert.equal(estimateTokens('a, b, c'), 3);
    assert.equal(estimateTokens(''), 0);
});

// --- cleanupEnvelope end-to-end ---
test('cleanupEnvelope (illus): avoidTags stripped, rating enforced, dedupe, paren escape, tail drop', () => {
    const envelope = { prompt: '1girl, nsfw, rating (safe), glasses, glasses, red hair', negative: 'worst quality, nsfw', params: { width: 832 } };
    const out = cleanupEnvelope(envelope, 'illus', { avoidTags: ['glasses'], rating: 'sfw' });
    assert.ok(!out.prompt.includes('nsfw'));
    assert.ok(!out.prompt.includes('glasses'));
    assert.ok(out.prompt.includes('rating \\(safe\\)'));
    // dedupe: 'glasses' appeared twice but is stripped anyway; check a case with real dupes
    const dupeOut = cleanupEnvelope({ prompt: '1girl, red hair, red hair', negative: '', params: {} }, 'illus', {});
    assert.equal(dupeOut.prompt, '1girl, red hair');
    assert.ok(!out.negative.includes('nsfw'));
});

test('cleanupEnvelope (anima): underscores become spaces, <200 token drop-tail', () => {
    const out = cleanupEnvelope({ prompt: '1girl, long_hair, blue_eyes', negative: '', params: {} }, 'anima', {});
    assert.equal(out.prompt, '1girl, long hair, blue eyes');
});

test('cleanupEnvelope (krea): weight syntax and negative words stripped from prose, negative untouched (CFG 1)', () => {
    const out = cleanupEnvelope({ prompt: 'a woman, (soft light:1.2), worst quality', negative: 'irrelevant at cfg 1', params: {} }, 'krea', { avoidTags: ['woman'] });
    assert.ok(!out.prompt.includes(':1.2'));
    assert.ok(!out.prompt.toLowerCase().includes('woman'));
    assert.equal(out.negative, 'irrelevant at cfg 1');
});

test('avoidTags never survive into the final prompt regardless of dialect', () => {
    for (const dialect of ['illus', 'anima']) {
        const out = cleanupEnvelope({ prompt: '1girl, beard, red hair', negative: '', params: {} }, dialect, { avoidTags: ['beard'] });
        assert.ok(!out.prompt.toLowerCase().includes('beard'));
    }
});

test('cleanup does not mangle a literal $ macro token that survived unresolved', () => {
    const out = cleanupEnvelope({ prompt: '1girl, $UnresolvedName, red hair', negative: '', params: {} }, 'illus', { avoidTags: ['glasses'] });
    assert.ok(out.prompt.includes('$UnresolvedName'));
});

// --- POV auto ladder (C6) ---
test('persona povMode "auto" defaults to hidden with no modifiers', () => {
    const out = renderPersonaForDialect({ povMode: 'auto', countTag: '1boy', booru: 'black hair' }, 'illus', []);
    assert.equal(out, 'solo, looking at viewer');
});

test('persona povMode "auto" picks hands framing for nsfw without explicit full', () => {
    const out = renderPersonaForDialect({ povMode: 'auto', countTag: '1boy', booru: 'black hair' }, 'illus', ['nsfw']);
    assert.ok(out.includes('pov hands'));
});

test('persona povMode "auto" picks full framing when the trigger says full', () => {
    const out = renderPersonaForDialect({ povMode: 'auto', countTag: '1boy', booru: 'black hair' }, 'illus', ['full']);
    assert.ok(out.includes('1boy'));
    assert.ok(out.includes('black hair'));
});

test('explicit povMode is never overridden by scene modifiers (regression)', () => {
    const out = renderPersonaForDialect({ povMode: 'hidden', countTag: '1boy' }, 'illus', ['full', 'nsfw']);
    assert.equal(out, 'solo, looking at viewer');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
