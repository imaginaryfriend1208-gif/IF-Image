#!/usr/bin/env node
// IF Image - replace rules tests (Phase C7).
// Run: node scripts/test-replace.mjs
import assert from 'node:assert/strict';
import { applyReplaceRules, evaluateCondition, parseCompactRule } from '../src/prompt/replace.js';

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

console.log('Replace rules tests');

function envelope(prompt, negative = '') {
    return { prompt, negative, params: {} };
}

// --- parseCompactRule ---
test('parseCompactRule parses "a|b=replacement" into a replace-mode rule', () => {
    const rule = parseCompactRule('bad hands|bad fingers=good hands');
    assert.deepEqual(rule, { trigger: 'bad hands|bad fingers', mode: 'replace', replacement: 'good hands' });
});

test('parseCompactRule returns null without an "="', () => {
    assert.equal(parseCompactRule('no equals here'), null);
});

// --- evaluateCondition: safe evaluator ---
test('evaluateCondition: no condition always passes', () => {
    assert.equal(evaluateCondition(undefined, {}), true);
});

test('evaluateCondition: dialect equality', () => {
    assert.equal(evaluateCondition('@if dialect==illus', { dialect: 'illus' }), true);
    assert.equal(evaluateCondition('@if dialect==illus', { dialect: 'anima' }), false);
});

test('evaluateCondition: bare boolean flag and negation', () => {
    assert.equal(evaluateCondition('@if nsfw', { nsfw: true }), true);
    assert.equal(evaluateCondition('@if !nsfw', { nsfw: true }), false);
    assert.equal(evaluateCondition('@if !nsfw', { nsfw: false }), true);
});

test('evaluateCondition: unknown/hostile condition is skipped, never executes code', () => {
    const warn = console.warn;
    let warned = 0;
    console.warn = () => { warned += 1; };
    try {
        assert.equal(evaluateCondition('@if process.exit(1)', {}), false);
        assert.equal(evaluateCondition('@if 1+1', {}), false);
        assert.equal(evaluateCondition('@if `${global.process}`', {}), false);
    } finally {
        console.warn = warn;
    }
    assert.equal(warned, 3);
});

// --- applyReplaceRules: all 7 modes ---
test('mode: replace swaps the matched tag', () => {
    const rules = [{ trigger: 'red hair', mode: 'replace', replacement: 'blue hair' }];
    const out = applyReplaceRules(envelope('1girl, red hair, smiling'), rules, 'pre', { dialect: 'illus' });
    assert.equal(out.prompt, '1girl, blue hair, smiling');
});

test('mode: delete removes the matched tag', () => {
    const rules = [{ trigger: 'smiling', mode: 'delete' }];
    const out = applyReplaceRules(envelope('1girl, red hair, smiling'), rules, 'pre', { dialect: 'illus' });
    assert.equal(out.prompt, '1girl, red hair');
});

test('mode: prefix-head inserts once at the very start of the list', () => {
    const rules = [{ trigger: 'red hair', mode: 'prefix-head', replacement: 'masterpiece' }];
    const out = applyReplaceRules(envelope('1girl, red hair'), rules, 'pre', { dialect: 'illus' });
    assert.equal(out.prompt, 'masterpiece, 1girl, red hair');
});

test('mode: prefix-tail inserts immediately before the matched tag', () => {
    const rules = [{ trigger: 'red hair', mode: 'prefix-tail', replacement: 'long' }];
    const out = applyReplaceRules(envelope('1girl, red hair'), rules, 'pre', { dialect: 'illus' });
    assert.equal(out.prompt, '1girl, long, red hair');
});

test('mode: suffix-head inserts immediately after the matched tag', () => {
    const rules = [{ trigger: 'red hair', mode: 'suffix-head', replacement: 'flowing' }];
    const out = applyReplaceRules(envelope('1girl, red hair, smiling'), rules, 'pre', { dialect: 'illus' });
    assert.equal(out.prompt, '1girl, red hair, flowing, smiling');
});

test('mode: suffix-tail inserts once at the very end of the list', () => {
    const rules = [{ trigger: 'red hair', mode: 'suffix-tail', replacement: 'detailed background' }];
    const out = applyReplaceRules(envelope('1girl, red hair'), rules, 'pre', { dialect: 'illus' });
    assert.equal(out.prompt, '1girl, red hair, detailed background');
});

test('mode: final behaves like replace but only runs in the "final" stage', () => {
    const rules = [{ trigger: 'red hair', mode: 'final', replacement: 'silver hair' }];
    const pre = applyReplaceRules(envelope('1girl, red hair'), rules, 'pre', { dialect: 'illus' });
    assert.equal(pre.prompt, '1girl, red hair'); // untouched in the pre stage
    const final = applyReplaceRules(pre, rules, 'final', { dialect: 'illus' });
    assert.equal(final.prompt, '1girl, silver hair');
});

test('non-final rules never fire during the final stage and vice versa', () => {
    const rules = [
        { trigger: 'a', mode: 'replace', replacement: 'A' },
        { trigger: 'b', mode: 'final', replacement: 'B' },
    ];
    const pre = applyReplaceRules(envelope('a, b'), rules, 'pre', { dialect: 'illus' });
    assert.equal(pre.prompt, 'A, b');
    const final = applyReplaceRules(pre, rules, 'final', { dialect: 'illus' });
    assert.equal(final.prompt, 'A, B');
});

// --- multi-trigger ---
test('multi-trigger "a|b" fires on either alternative', () => {
    const rules = [{ trigger: 'bad hands|bad fingers', mode: 'delete' }];
    const out1 = applyReplaceRules(envelope('1girl, bad hands'), rules, 'pre', { dialect: 'illus' });
    assert.equal(out1.prompt, '1girl');
    const out2 = applyReplaceRules(envelope('1girl, bad fingers'), rules, 'pre', { dialect: 'illus' });
    assert.equal(out2.prompt, '1girl');
});

// --- absent trigger is a no-op ---
test('a rule whose trigger tag is absent does not alter the prompt', () => {
    const rules = [{ trigger: 'nonexistent tag', mode: 'delete' }];
    const out = applyReplaceRules(envelope('1girl, red hair'), rules, 'pre', { dialect: 'illus' });
    assert.equal(out.prompt, '1girl, red hair');
});

// --- @if condition gating ---
test('a rule with a failing @if condition is skipped', () => {
    const rules = [{ trigger: 'red hair', mode: 'delete', condition: '@if dialect==anima' }];
    const out = applyReplaceRules(envelope('1girl, red hair'), rules, 'pre', { dialect: 'illus' });
    assert.equal(out.prompt, '1girl, red hair');
});

test('a rule with a passing @if condition applies', () => {
    const rules = [{ trigger: 'red hair', mode: 'delete', condition: '@if dialect==illus' }];
    const out = applyReplaceRules(envelope('1girl, red hair'), rules, 'pre', { dialect: 'illus' });
    assert.equal(out.prompt, '1girl');
});

// --- negative prompt also rewritten (except krea) ---
test('rules apply to the negative prompt for illus/anima', () => {
    const rules = [{ trigger: 'bad hands', mode: 'delete' }];
    const out = applyReplaceRules(envelope('1girl', 'worst quality, bad hands'), rules, 'pre', { dialect: 'illus' });
    assert.equal(out.negative, 'worst quality');
});

test('rules do NOT touch krea negative (CFG 1, no negative prompt)', () => {
    const rules = [{ trigger: 'bad hands', mode: 'delete' }];
    const out = applyReplaceRules(envelope('a scene', 'bad hands'), rules, 'pre', { dialect: 'krea' });
    assert.equal(out.negative, 'bad hands');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
