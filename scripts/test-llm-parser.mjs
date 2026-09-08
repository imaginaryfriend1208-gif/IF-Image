#!/usr/bin/env node
// IF Image - LLM reply parser tests.
// Run: node scripts/test-llm-parser.mjs
import assert from 'node:assert/strict';
import { parseLlmReply } from '../src/llm/parser.js';

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

console.log('LLM parser tests');

// --- 1: well-formed single block ---
test('parses a well-formed <ifimage> block', () => {
    const reply = `<ifimage><image>girl</image><title>A girl</title><size>832x1216</size><prompt>1girl, solo, long hair</prompt><negative>bad hands</negative></ifimage>`;
    const entries = parseLlmReply(reply);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].prompt, '1girl, solo, long hair');
    assert.equal(entries[0].negative, 'bad hands');
    assert.equal(entries[0].title, 'A girl');
    assert.equal(entries[0].width, 832);
    assert.equal(entries[0].height, 1216);
});

// --- 2: unclosed tags auto-closed at block end ---
test('auto-closes unclosed tags at block end', () => {
    const reply = `<ifimage><prompt>1girl, solo</prompt><negative>blurry</ifimage>`;
    const entries = parseLlmReply(reply);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].prompt, '1girl, solo');
    assert.equal(entries[0].negative, 'blurry');
});

// --- 3: fenced code block ---
test('strips surrounding code fences', () => {
    const reply = "```xml\n<ifimage><prompt>1girl, forest</prompt></ifimage>\n```";
    const entries = parseLlmReply(reply);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].prompt, '1girl, forest');
});

// --- 4: full-width characters ---
test('normalizes full-width chars', () => {
    const reply = `＜ifimage＞＜prompt＞1girl，solo＜/prompt＞＜size＞832×1216＜/size＞＜/ifimage＞`;
    const entries = parseLlmReply(reply);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].prompt, '1girl，solo');
    assert.equal(entries[0].width, 832);
    assert.equal(entries[0].height, 1216);
});

// --- 5: typo closers <\image> and </ image> ---
test('accepts typo closers', () => {
    const reply = `<ifimage><image>1girl</image><prompt>solo girl</prompt><\\image></ifimage>`;
    const entries = parseLlmReply(reply);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].prompt, 'solo girl');
});

// --- 6: missing title → derived from prompt tokens ---
test('derives title from prompt tokens when missing', () => {
    const reply = `<ifimage><prompt>1girl, solo, long white hair, red eyes</prompt></ifimage>`;
    const entries = parseLlmReply(reply);
    assert.equal(entries.length, 1);
    assert.match(entries[0].title, /1girl/);
});

// --- 7: missing/invalid size → default ---
test('missing or invalid size defaults to 832x1216', () => {
    const r1 = `<ifimage><prompt>a</prompt></ifimage>`;
    const e1 = parseLlmReply(r1);
    assert.equal(e1[0].width, 832);
    assert.equal(e1[0].height, 1216);

    const r2 = `<ifimage><prompt>a</prompt><size>invalid</size></ifimage>`;
    const e2 = parseLlmReply(r2);
    assert.equal(e2[0].width, 832);
});

// --- 8: size accepts WxH, W×H, W*H ---
test('size accepts WxH, W×H, W*H', () => {
    const a = parseLlmReply(`<ifimage><prompt>a</prompt><size>512x768</size></ifimage>`)[0];
    const b = parseLlmReply(`<ifimage><prompt>a</prompt><size>512×768</size></ifimage>`)[0];
    const c = parseLlmReply(`<ifimage><prompt>a</prompt><size>512*768</size></ifimage>`)[0];
    assert.deepEqual([a.width, a.height], [512, 768]);
    assert.deepEqual([b.width, b.height], [512, 768]);
    assert.deepEqual([c.width, c.height], [512, 768]);
});

// --- 9: mixed <ifimage> + image### in one reply ---
test('mixed <ifimage> and image### in one reply', () => {
    const reply = `Some prose\n<ifimage><prompt>solo girl</prompt></ifimage>\nand then\nimage### a landscape scene ###`;
    const entries = parseLlmReply(reply);
    assert.equal(entries.length, 2);
    // Order must match position in reply
    assert.equal(entries[0].prompt, 'solo girl');
    assert.equal(entries[1].prompt, 'a landscape scene');
});

// --- 10: junk prose around blocks ---
test('ignores junk prose around blocks', () => {
    const reply = `Here is your image: <ifimage><prompt>1girl, cafe</prompt></ifimage> Hope you like it!`;
    const entries = parseLlmReply(reply);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].prompt, '1girl, cafe');
});

// --- 11: duplicate blocks deduped ---
test('dedupes exact duplicate blocks', () => {
    const reply = `<ifimage><prompt>1girl</prompt></ifimage><ifimage><prompt>1girl</prompt></ifimage>`;
    const entries = parseLlmReply(reply);
    assert.equal(entries.length, 1);
});

// --- 12: >4 blocks capped ---
test('caps at 4 entries', () => {
    const blocks = [];
    for (let i = 0; i < 6; i++) blocks.push(`<ifimage><prompt>prompt ${i}</prompt></ifimage>`);
    const entries = parseLlmReply(blocks.join('\n'));
    assert.equal(entries.length, 4);
});

// --- 13: empty reply ---
test('empty reply returns []', () => {
    assert.deepEqual(parseLlmReply(''), []);
    assert.deepEqual(parseLlmReply('   \n  '), []);
});

// --- 14: image### marker alone ---
test('parses image### markers', () => {
    const reply = `image### a girl in a garden ###`;
    const entries = parseLlmReply(reply);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].prompt, 'a girl in a garden');
});

// --- 15: non-string input ---
test('non-string input returns []', () => {
    assert.deepEqual(parseLlmReply(null), []);
    assert.deepEqual(parseLlmReply(undefined), []);
    assert.deepEqual(parseLlmReply(42), []);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
