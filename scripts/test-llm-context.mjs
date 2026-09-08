#!/usr/bin/env node
// IF Image - LLM context assembly tests.
// Run: node scripts/test-llm-context.mjs
import assert from 'node:assert/strict';
import { stripRenderedArtifacts, buildContext } from '../src/llm/context.js';

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

console.log('LLM context tests');

// --- stripRenderedArtifacts ---
test('strips code fences', () => {
    const input = 'Hello ```some code block``` world';
    assert.equal(stripRenderedArtifacts(input), 'Hello world');
});

test('strips <thinking> blocks', () => {
    const input = 'Before <thinking>some reasoning here</thinking> After';
    assert.equal(stripRenderedArtifacts(input), 'Before After');
});

test('strips <ifimage> blocks', () => {
    const input = 'Text <ifimage><prompt>test</prompt></ifimage> more text';
    assert.equal(stripRenderedArtifacts(input), 'Text more text');
});

test('strips image### markers', () => {
    const input = 'Scene image### a girl dancing ### end';
    assert.equal(stripRenderedArtifacts(input), 'Scene end');
});

test('strips HTML tags', () => {
    const input = 'Hello <b>bold</b> <span class="x">text</span> world';
    assert.equal(stripRenderedArtifacts(input), 'Hello bold text world');
});

test('collapses whitespace', () => {
    const input = 'hello   \n  world   \n\n  test';
    assert.equal(stripRenderedArtifacts(input), 'hello world test');
});

test('non-string input returns empty', () => {
    assert.equal(stripRenderedArtifacts(null), '');
    assert.equal(stripRenderedArtifacts(undefined), '');
    assert.equal(stripRenderedArtifacts(42), '');
});

// --- buildContext ---
const makeChat = (...roles) => roles.map((r, i) => ({
    role: r === 'user' ? 'user' : 'character',
    mes: `Message ${i} from ${r}`,
    is_system: false,
}));

test('scene window: last N messages in order', () => {
    const chat = makeChat('user', 'character', 'user', 'character', 'user', 'character');
    const result = buildContext({
        chat,
        settings: { generation: { sceneWindow: 4 } },
        contextProfile: {},
    });
    // Last 4: user(2), character(3), user(4), character(5) → roles: User/Character/User/Character
    assert.match(result.sceneText, /User: Message 2/);
    assert.match(result.sceneText, /Character: Message 3/);
    assert.match(result.sceneText, /User: Message 4/);
    assert.match(result.sceneText, /Character: Message 5/);
});

test('scene window clamp: minimum 2, maximum 8', () => {
    const chat = makeChat('user', 'character', 'user', 'character');
    const r1 = buildContext({ chat, settings: { generation: { sceneWindow: 0 } }, contextProfile: {} });
    assert.ok(r1.sceneText.includes('Message'), 'clamp 0 → 2');
    const r2 = buildContext({ chat, settings: { generation: { sceneWindow: 15 } }, contextProfile: {} });
    assert.ok(r2.sceneText.includes('Message'), 'clamp 15 → 8');
});

test('system messages filtered out', () => {
    const chat = [
        { role: 'user', mes: 'hello', is_system: false },
        { role: 'character', mes: 'hi', is_system: true },
        { role: 'character', mes: 'world', is_system: false },
    ];
    const result = buildContext({ chat, settings: { generation: { sceneWindow: 4 } }, contextProfile: {} });
    assert.ok(result.sceneText.includes('hello'));
    assert.ok(result.sceneText.includes('world'));
    assert.ok(!result.sceneText.includes('hi'));
});

test('scope: last returns only the last non-user message', () => {
    const chat = makeChat('user', 'character', 'user', 'character');
    const result = buildContext({
        chat,
        settings: { generation: { sceneWindow: 4 } },
        contextProfile: { scope: 'last' },
    });
    assert.ok(result.sceneText.includes('Message 3'));
    assert.ok(!result.sceneText.includes('Message 1'));
});

test('scope: raw returns empty sceneText', () => {
    const chat = makeChat('user', 'character');
    const result = buildContext({
        chat,
        settings: { generation: { sceneWindow: 4 } },
        contextProfile: { scope: 'raw' },
    });
    assert.equal(result.sceneText, '');
});

test('character block from roster', () => {
    const roster = { characters: [
        { name: 'Lyna', countTag: '1girl', booru: 'silver hair, purple eyes', facts: 'Age 24' },
    ], persona: null };
    const result = buildContext({
        chat: [],
        settings: { generation: { sceneWindow: 4 } },
        contextProfile: {},
        roster,
    });
    assert.ok(result.charBlock.includes('Lyna'));
    assert.ok(result.charBlock.includes('silver hair'));
    assert.ok(result.charBlock.includes('Age 24'));
});

test('persona block from roster', () => {
    const roster = { characters: [], persona: { name: 'User', booru: '1boy, black hair', natural: 'a young man' } };
    const result = buildContext({
        chat: [],
        settings: { generation: { sceneWindow: 4 } },
        contextProfile: {},
        roster,
    });
    assert.ok(result.personaBlock.includes('User'));
    assert.ok(result.personaBlock.includes('1boy'));
});

test('includeCharCard=false suppresses character block', () => {
    const roster = { characters: [{ name: 'A', countTag: '1girl' }], persona: null };
    const result = buildContext({
        chat: [],
        settings: { generation: { sceneWindow: 4 } },
        contextProfile: { includeCharCard: false },
        roster,
    });
    assert.equal(result.charBlock, '');
});

test('includePersona=false suppresses persona block', () => {
    const roster = { characters: [], persona: { name: 'User' } };
    const result = buildContext({
        chat: [],
        settings: { generation: { sceneWindow: 4 } },
        contextProfile: { includePersona: false },
        roster,
    });
    assert.equal(result.personaBlock, '');
});

test('substituteParams is applied', () => {
    const chat = [{ role: 'user', mes: 'Hello {{char}}', is_system: false }];
    const result = buildContext({
        chat,
        settings: { generation: { sceneWindow: 4 } },
        contextProfile: {},
        substituteParams: (s) => s.replace(/\{\{char\}\}/g, 'Alice'),
    });
    assert.ok(result.sceneText.includes('Alice'));
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
