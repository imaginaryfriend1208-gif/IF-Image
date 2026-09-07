#!/usr/bin/env node
// IF Image - multi-character rendering tests (Phase C8).
// Run: node scripts/test-multichar.mjs
import assert from 'node:assert/strict';
import { assemblePrompt } from '../src/prompt/render.js';
import { PROFILES } from '../src/profiles.js';
import { computeCharacterCenters } from '../src/backends/nai.js';

let passed = 0;
let failed = 0;
// Async-aware: several tests below need to await a dynamic import + a
// stubbed fetch, so `fn` may return a promise. Every call site below uses
// `await test(...)` (top-level await, supported in Node ESM) so a rejected
// assertion is actually caught here instead of becoming an unhandled
// rejection that crashes the process after the summary has already printed.
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.message}`);
        failed++;
    }
}

console.log('Multi-character rendering tests');

const lyna = { id: 'c1', name: 'Lyna', countTag: '1girl', booru: 'silver hair, purple eyes' };
const mira = { id: 'c2', name: 'Mira', countTag: '1girl', booru: 'red hair, green eyes' };
const kai = { id: 'c3', name: 'Kai', countTag: '1boy', booru: 'black hair' };

function parsed(chars) {
    return { characters: chars.map(c => ({ char: c, modifiers: [] })), styles: [], residualPrompt: 'at a cafe' };
}

// --- single-character regression: byte-identical to pre-C8 output ---
await test('single character: illus output unchanged (no parens grouping)', () => {
    const out = assemblePrompt(parsed([lyna]), 'illus', PROFILES.illustrious);
    assert.ok(!out.prompt.includes('\\('));
    assert.ok(out.prompt.includes('1girl, silver hair, purple eyes'));
});

await test('single character: anima/krea output unchanged', () => {
    const anima = assemblePrompt(parsed([lyna]), 'anima', PROFILES.anima);
    assert.ok(!anima.prompt.includes(';'));
    const krea = assemblePrompt({ ...parsed([lyna]) }, 'krea', PROFILES.krea2);
    assert.ok(!krea.prompt.includes('on the left'));
});

await test('assemblePrompt always returns a characters[] array of per-character rendered strings', () => {
    const out = assemblePrompt(parsed([lyna]), 'illus', PROFILES.illustrious);
    assert.equal(out.characters.length, 1);
    assert.ok(out.characters[0].includes('silver hair'));
});

// --- 2-character grouping ---
await test('illus: 2 characters grouped in escaped-parens blocks, count tag first', () => {
    const out = assemblePrompt(parsed([lyna, mira]), 'illus', PROFILES.illustrious);
    assert.ok(out.prompt.includes('\\(1girl, silver hair, purple eyes\\)'));
    assert.ok(out.prompt.includes('\\(1girl, red hair, green eyes\\)'));
});

await test('anima: 2 characters as sequential caption blocks', () => {
    const out = assemblePrompt(parsed([lyna, mira]), 'anima', PROFILES.anima);
    assert.ok(out.prompt.includes('silver hair, purple eyes. 1girl, red hair, green eyes'));
});

await test('krea: 2 characters as left/right prose anchors', () => {
    const out = assemblePrompt({ characters: [{ char: { ...lyna, natural: 'a silver-haired woman' }, modifiers: [] }, { char: { ...mira, natural: 'a red-haired woman' }, modifiers: [] }], styles: [], residualPrompt: 'at a cafe' }, 'krea', PROFILES.krea2);
    assert.ok(out.prompt.includes('on the left, a silver-haired woman'));
    assert.ok(out.prompt.includes('on the right, a red-haired woman'));
});

// --- 3+ characters ---
await test('illus: 3 characters each get their own escaped-parens block', () => {
    const out = assemblePrompt(parsed([lyna, mira, kai]), 'illus', PROFILES.illustrious);
    const blocks = out.prompt.match(/\\\(([^)]*)\\\)/g) || [];
    assert.equal(blocks.length, 3);
});

await test('assemblePrompt characters[] has one entry per resolved character', () => {
    const out = assemblePrompt(parsed([lyna, mira, kai]), 'illus', PROFILES.illustrious);
    assert.equal(out.characters.length, 3);
});

// --- cleanup stage must not corrupt \(...\) groups (regression) ---
await test('cleanupEnvelope keeps both illus paren groups intact (dedup is group-aware)', async () => {
    const { cleanupEnvelope } = await import('../src/prompt/cleanup.js');
    const asm = assemblePrompt(parsed([lyna, mira]), 'illus', PROFILES.illustrious);
    const cleaned = cleanupEnvelope(asm, 'illus', { rating: 'sfw' });
    const opens = (cleaned.prompt.match(/\\\(/g) || []).length;
    const closes = (cleaned.prompt.match(/\\\)/g) || []).length;
    assert.equal(opens, 2);
    assert.equal(closes, 2);
    assert.ok(cleaned.prompt.includes('\\(1girl, red hair, green eyes\\)'));
});

await test('dropTailByBudget never cuts inside an open \\(...\\) group', async () => {
    const { dropTailByBudget } = await import('../src/prompt/cleanup.js');
    const out = dropTailByBudget('a, b, \\(1girl, silver hair, purple eyes\\), tail', 5);
    const opens = (out.match(/\\\(/g) || []).length;
    const closes = (out.match(/\\\)/g) || []).length;
    assert.equal(opens, closes);
    assert.ok(!out.endsWith('tail')); // budget still drops tags OUTSIDE groups
});

// --- NAI center computation ---
await test('computeCharacterCenters: 2 characters spread to 0.3/0.7', () => {
    const centers = computeCharacterCenters(2);
    assert.deepEqual(centers, [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }]);
});

await test('computeCharacterCenters: 3+ characters spread evenly', () => {
    const centers = computeCharacterCenters(3);
    assert.equal(centers.length, 3);
    assert.ok(Math.abs(centers[0].x - 0.25) < 1e-9);
    assert.ok(Math.abs(centers[1].x - 0.5) < 1e-9);
    assert.ok(Math.abs(centers[2].x - 0.75) < 1e-9);
});

await test('computeCharacterCenters: a single character gets a centered default', () => {
    assert.deepEqual(computeCharacterCenters(1), [{ x: 0.5, y: 0.5 }]);
});

// --- NaiClient payload shape (single-char byte-identical, multi-char extended) ---
// NaiClient.generate() makes a real fetch call; we only need to inspect the
// request body, so stub global.fetch to capture it without a network call.
async function buildNaiBody(opts) {
    const { NaiClient } = await import('../src/backends/nai.js');
    let capturedBody = null;
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
        capturedBody = JSON.parse(init.body);
        return {
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(0),
        };
    };
    try {
        const client = new NaiClient(() => 'pst-test');
        try { await client.generate(opts); } catch { /* pngFromNaiZip on an empty buffer throws; body capture already happened */ }
    } finally {
        global.fetch = originalFetch;
    }
    return capturedBody;
}

await test('NaiClient payload: single-character request is byte-identical to the pre-C8 shape', async () => {
    const body = await buildNaiBody({ prompt: 'a scene', negative: 'bad', width: 832, height: 1216, steps: 20, seed: 1 });
    assert.deepEqual(body.parameters.characterPrompts, []);
    assert.equal(body.parameters.use_coords, false);
    assert.deepEqual(body.parameters.v4_prompt.caption.char_captions, []);
    assert.equal(body.parameters.v4_prompt.use_coords, false);
    assert.deepEqual(body.parameters.v4_negative_prompt.caption.char_captions, []);
});

await test('NaiClient payload: 2 characters fill characterPrompts + char_captions with spread centers', async () => {
    const body = await buildNaiBody({ prompt: 'a scene', negative: 'bad', width: 832, height: 1216, steps: 20, seed: 1, characters: ['1girl, silver hair', '1girl, red hair'] });
    assert.equal(body.parameters.characterPrompts.length, 2);
    assert.equal(body.parameters.characterPrompts[0].prompt, '1girl, silver hair');
    assert.deepEqual(body.parameters.characterPrompts[0].center, { x: 0.3, y: 0.5 });
    assert.deepEqual(body.parameters.characterPrompts[1].center, { x: 0.7, y: 0.5 });
    assert.equal(body.parameters.use_coords, true);
    assert.equal(body.parameters.v4_prompt.use_order, true);
    assert.equal(body.parameters.v4_prompt.char_captions, undefined); // captions live under caption.*, never at this level
    assert.equal(body.parameters.v4_prompt.caption.char_captions.length, 2);
    assert.equal(body.parameters.v4_prompt.caption.char_captions[0].char_caption, '1girl, silver hair');
    assert.deepEqual(body.parameters.v4_prompt.caption.char_captions[0].centers, [{ x: 0.3, y: 0.5 }]);
    assert.equal(body.parameters.v4_negative_prompt.caption.char_captions.length, 2);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
