#!/usr/bin/env node
// IF Image - LLM engine tests (mocked llmClient).
// Run: node scripts/test-llm-engine.mjs
import assert from 'node:assert/strict';
import { createEngine } from '../src/llm/engine.js';

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

console.log('LLM engine tests');

// --- Mock LLM client ---
function makeMockLlm({ reply, error, calls = [] }) {
    return {
        request: async ({ type, systemPrompt, userPrompt, profileId, signal }) => {
            calls.push({ type, systemPrompt, userPrompt, profileId, signal });
            if (error) throw error;
            return { text: reply, requestId: 'req-1', elapsedMs: 10, method: 'generateRaw' };
        },
    };
}

// Cycles through a fixed sequence of replies, one per call — for retry tests.
function makeMockLlmSeq(replies, calls = []) {
    let i = 0;
    return {
        request: async ({ type, systemPrompt, userPrompt, profileId, signal }) => {
            calls.push({ type, systemPrompt, userPrompt, profileId, signal });
            const text = replies[Math.min(i, replies.length - 1)];
            i += 1;
            return { text, requestId: 'req-' + i, elapsedMs: 10, method: 'generateRaw' };
        },
    };
}

// --- Mock compile ---
function makeCompile() {
    return (content) => ({
        profileKey: 'anima',
        envelope: { prompt: `compiled: ${content}`, negative: '', params: { seed: -1 } },
    });
}

// --- Mock engine deps ---
function makeEngine({ llm, compile, settings = {}, chat = [], contextExtra = {} } = {}) {
    const calls = [];
    const engine = createEngine({
        llmClient: llm,
        getSettings: () => ({
            llm: { defaultApiProfileId: 'prof-1', injectionStyle: 'compact' },
            generation: { profile: 'anima' },
            ...settings,
        }),
        getContext: () => ({ chat, ...contextExtra }),
        roster: () => ({ characters: [], persona: null }),
        substituteParams: (s) => s,
        compile: compile ?? makeCompile(),
        pipeline: {},
        queue: () => ({}),
        notify: () => {},
        fetchImpl: null,
    });
    return { engine, calls };
}

// --- 1: assist success ---
test('assist success: LLM reply parsed and compiled', async () => {
    const reply = `<ifimage><prompt>1girl, solo, forest</prompt><negative>blurry</negative></ifimage>`;
    const { engine } = makeEngine({ llm: makeMockLlm({ reply }) });
    const result = await engine.rewrite('a girl in a forest', {});
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].envelope.prompt, 'compiled: 1girl, solo, forest');
    assert.equal(result.method, 'generateRaw');
});

// --- 2: assist LLM failure → fallback to direct compile ---
test('assist LLM failure falls back to direct compile', async () => {
    const { engine } = makeEngine({
        llm: makeMockLlm({ error: new Error('LLM down') }),
    });
    const result = await engine.rewrite('a girl in a forest', {});
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].envelope.prompt, 'compiled: a girl in a forest');
    assert.equal(result.method, 'fallback_direct');
});

// --- 3: full-mode parse → pipeline handoff ---
test('full mode: multiple entries parsed and compiled', async () => {
    const reply = `<ifimage><prompt>solo girl</prompt></ifimage>\nimage### a landscape ###`;
    const { engine } = makeEngine({ llm: makeMockLlm({ reply }) });
    const result = await engine.rewrite('scene', {});
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].envelope.prompt, 'compiled: solo girl');
    assert.equal(result.entries[1].envelope.prompt, 'compiled: a landscape');
});

// --- 4: abort propagation ---
test('abort propagates to the LLM client', async () => {
    const controller = new AbortController();
    const calls = [];
    const { engine } = makeEngine({
        llm: makeMockLlm({
            reply: 'x',
            calls,
            error: Object.assign(new Error('aborted'), { name: 'AbortError' }),
        }),
    });
    controller.abort();
    await assert.rejects(
        () => engine.rewrite('scene', { signal: controller.signal }),
        (err) => err?.name === 'AbortError' || err?.code === 'ABORTED',
    );
});

// --- 5: regeneration includes previous_prompt + variation_hint ---
test('regeneration includes previous_prompt and variation_hint', async () => {
    const calls = [];
    const reply = `<ifimage><prompt>new version</prompt></ifimage>`;
    const { engine } = makeEngine({
        llm: makeMockLlm({ reply, calls }),
    });
    await engine.regenerate('a girl', 'old prompt', 'make it darker');
    assert.ok(calls.length === 1);
    assert.ok(calls[0].userPrompt.includes('old prompt'), 'previous prompt included');
    assert.ok(calls[0].userPrompt.includes('make it darker'), 'variation hint included');
});

// --- 6: LLM returns unparseable → fallback ---
test('unparseable LLM reply falls back to direct compile', async () => {
    const { engine } = makeEngine({
        llm: makeMockLlm({ reply: 'I cannot do that.' }),
    });
    const result = await engine.rewrite('a girl', {});
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].envelope.prompt, 'compiled: a girl');
    assert.equal(result.method, 'fallback_direct');
});

// --- 7: system prompt contains dialect rules + scene window ---
test('system prompt includes dialect rules and scene window', async () => {
    const calls = [];
    const reply = `<ifimage><prompt>x</prompt></ifimage>`;
    const chat = [{ role: 'user', mes: 'hello', is_system: false }];
    const { engine } = makeEngine({
        llm: makeMockLlm({ reply, calls }),
        chat,
    });
    await engine.rewrite('scene', {});
    assert.ok(calls[0].systemPrompt.includes('DIALECT'), 'dialect rules present');
    assert.ok(calls[0].systemPrompt.includes('SCENE WINDOW'), 'scene window present');
    assert.ok(calls[0].systemPrompt.includes('hello'), 'scene text present');
});

// --- Phase C5: request types beside image_gen ---

test('char_design: valid JSON reply is parsed and returned', async () => {
    const reply = '```json\n{"name":"Lyna","countTag":"1girl","booru":"silver hair, purple eyes","facts":["Elf archer"]}\n```';
    const { engine } = makeEngine({ llm: makeMockLlm({ reply }) });
    const result = await engine.generateCharacterDesign('a silver-haired elf archer');
    assert.equal(result.char.name, 'Lyna');
    assert.equal(result.char.countTag, '1girl');
});

test('char_design: invalid reply retries once with validator errors, then succeeds', async () => {
    const calls = [];
    const llm = makeMockLlmSeq([
        '{"name":"","countTag":"not-a-tag"}',
        '{"name":"Mira","countTag":"1girl","booru":"red hair","facts":["A knight"]}',
    ], calls);
    const { engine } = makeEngine({ llm });
    const result = await engine.generateCharacterDesign('a red-haired knight');
    assert.equal(result.char.name, 'Mira');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].userPrompt.includes('failed validation'), 'retry prompt includes validator errors');
});

test('char_design: invalid reply on both attempts throws MALFORMED', async () => {
    const llm = makeMockLlmSeq(['not json at all', 'still not json']);
    const { engine } = makeEngine({ llm });
    await assert.rejects(
        () => engine.generateCharacterDesign('a mystery character'),
        (err) => err.code === 'MALFORMED',
    );
});

test('char_modify: patches an existing character JSON', async () => {
    const reply = '{"name":"Lyna","countTag":"1girl","booru":"silver hair, red eyes","facts":["Elf archer"]}';
    const { engine } = makeEngine({ llm: makeMockLlm({ reply }) });
    const existing = { name: 'Lyna', countTag: '1girl', booru: 'silver hair, purple eyes', facts: 'Elf archer' };
    const result = await engine.modifyCharacter(existing, 'change eyes to red');
    assert.equal(result.char.booru, 'silver hair, red eyes');
});

test('tag_modify: returns a single-line tag list', async () => {
    const reply = '1girl, solo, red hair, blue eyes\n(extra lines are ignored)';
    const { engine } = makeEngine({ llm: makeMockLlm({ reply }) });
    const result = await engine.modifyTags('1girl, solo, black hair, blue eyes', 'change hair to red');
    assert.equal(result.tags, '1girl, solo, red hair, blue eyes');
});

test('translation: backfills booru tags from facts', async () => {
    const reply = 'elf, silver hair, purple eyes, archer';
    const { engine } = makeEngine({ llm: makeMockLlm({ reply }) });
    const result = await engine.translateFacts({ facts: 'A silver-haired elf archer with purple eyes' });
    assert.equal(result.tags, 'elf, silver hair, purple eyes, archer');
});

test('persona_gen: reads name1/persona_description from context and returns a persona payload', async () => {
    const reply = '{"name":"Alex","countTag":"1boy","booru":"black hair, casual clothes","natural":"a young man in casual attire"}';
    const calls = [];
    const { engine } = makeEngine({
        llm: makeMockLlm({ reply, calls }),
        contextExtra: { name1: 'Alex', powerUserSettings: { persona_description: 'a young man in casual attire' } },
    });
    const result = await engine.syncPersonaFromSt();
    assert.equal(result.persona.name, 'Alex');
    assert.ok(calls[0].userPrompt.includes('Alex'));
    assert.ok(calls[0].userPrompt.includes('casual attire'));
});

test('persona_gen: malformed reply throws MALFORMED, never throws to the caller as a crash', async () => {
    const { engine } = makeEngine({ llm: makeMockLlm({ reply: 'sorry, I cannot help with that' }) });
    await assert.rejects(() => engine.syncPersonaFromSt(), (err) => err.code === 'MALFORMED');
});

test('defensive JSON repair: trailing commas and surrounding prose are tolerated', async () => {
    const reply = 'Sure, here you go:\n{"name":"Kai","countTag":"1boy","booru":"tag1, tag2,","facts":["fact1",],}\nHope that helps!';
    const { engine } = makeEngine({ llm: makeMockLlm({ reply }) });
    const result = await engine.generateCharacterDesign('a boy named Kai');
    assert.equal(result.char.name, 'Kai');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);