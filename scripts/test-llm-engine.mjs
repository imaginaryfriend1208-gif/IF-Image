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

// --- Mock compile ---
function makeCompile() {
    return (content) => ({
        profileKey: 'anima',
        envelope: { prompt: `compiled: ${content}`, negative: '', params: { seed: -1 } },
    });
}

// --- Mock engine deps ---
function makeEngine({ llm, compile, settings = {}, chat = [] } = {}) {
    const calls = [];
    const engine = createEngine({
        llmClient: llm,
        getSettings: () => ({
            llm: { defaultApiProfileId: 'prof-1', injectionStyle: 'compact' },
            generation: { profile: 'anima' },
            ...settings,
        }),
        getContext: () => ({ chat }),
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

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);