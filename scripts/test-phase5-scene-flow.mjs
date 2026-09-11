#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngine } from '../src/llm/engine.js';
import { applyPlacements } from '../src/llm/inject.js';
import { createMarkerRuntime } from '../src/runtime/events.js';
import { createTaskQueue } from '../src/runtime/tasks.js';
import { parseTriggers } from '../src/prompt/triggers.js';
import { assemblePrompt } from '../src/prompt/render.js';
import { resolveActiveStyle } from '../src/prompt/active-style.js';
import { PROFILES } from '../src/profiles.js';

const text = nodeValue => ({ nodeType: 3, nodeValue });
const element = (tagName, ...children) => ({
    nodeType: 1, tagName, childNodes: children.map(child => typeof child === 'string' ? text(child) : child),
    hidden: false, getAttribute: () => null,
});

async function waitFor(predicate, timeoutMs = 1000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for queue');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

const rosario = {
    id: 'c1', name: 'Rosario', aliases: [], countTag: '1boy',
    booru: 'black hair, blue eyes', binding: { cardId: 'rosario.png', chatIds: ['chat-a'] },
};
const yenka = {
    id: 'p1', name: 'Yenka', aliases: [], isDefault: true, povMode: 'full',
    countTag: '1girl', booru: 'brown hair, green eyes', dialectHints: {},
};
const style = {
    id: 's1', name: 'Ink Wash', lora: '',
    dialectHints: { anima: { booruTags: 'deterministic ink wash', artists: '' } },
};

function compileScene(content) {
    const parsed = parseTriggers(content, {
        roster: [rosario], fullRoster: [rosario], defaultPersona: yenka,
        personas: [yenka], styles: [style], outfits: [],
    });
    const active = resolveActiveStyle({ styles: [style], defaultStyleId: style.id, explicitStyles: parsed.styles });
    if (active.style && active.source !== 'marker') parsed.styles.push(active.style);
    return assemblePrompt(parsed, 'anima', PROFILES.anima);
}

test('Phase 5 offline flow preserves context tokens through marker pickup and queue execution', async () => {
    const chat = [
        { role: 'user', is_user: true, mes: 'Stay with me.' },
        { role: 'char', name: 'Rosario', mes: 'Rosario lies down while Yenka, wearing a silk nightgown, curls against his side.' },
    ];
    const llmCalls = [];
    const reply = JSON.stringify({ images: [{
        anchor: 'curls against his side',
        subjects: ['$Rosario', '$me'],
        prompt: '$Rosario lies down while $me, wearing a silk nightgown, curls against his side, dim window light',
        negative: 'must be ignored', size: '1216x832',
    }] });
    const engine = createEngine({
        getSettings: () => ({ generation: { profile: 'anima' }, llm: { defaultApiProfileId: 'p', chatPlace: { rewrite: false, onlyCharacter: true } } }),
        getContext: () => ({ chat, name1: 'Yenka', name2: 'Rosario', characterId: 0, characters: [{ avatar: 'rosario.png' }], getCurrentChatId: () => 'chat-a' }),
        roster: () => ({ characters: [rosario], personas: [yenka], persona: yenka, styles: [style] }),
        substituteParams: value => value,
        compile: content => ({ profileKey: 'anima', envelope: compileScene(content) }),
        notify: () => {},
        llmClient: { request: async request => { llmCalls.push(request); return { text: reply, method: 'mock', elapsedMs: 1 }; } },
    });
    const plan = await engine.planChatImages(1);
    assert.equal(plan.placements.length, 1);
    assert.deepEqual(plan.placements[0].subjects, ['$Rosario', '$me']);
    assert.equal(plan.placements[0].negative, '');
    assert.match(llmCalls[0].systemPrompt, /Exact token: \$Rosario/);
    assert.match(llmCalls[0].systemPrompt, /Exact token: \$me/);
    assert.match(llmCalls[0].userPrompt, /\[\$Rosario .*character\]/);
    assert.match(llmCalls[0].userPrompt, /\[\$me .*user persona\]/);

    const listeners = new Map();
    const eventSource = {
        on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
        removeListener(name, fn) { listeners.get(name)?.delete(fn); },
        emit(name, value) { for (const fn of listeners.get(name) ?? []) fn(value); },
    };
    let root = element('DIV', chat[1].mes);
    const executed = [];
    const queue = createTaskQueue({
        concurrency: 1,
        execute: async snapshot => { executed.push(snapshot); return { ok: true }; },
    });
    const finalMetadata = [];
    const runtime = createMarkerRuntime({
        eventSource,
        eventTypes: { MESSAGE_UPDATED: 'MESSAGE_UPDATED' },
        getChatId: () => 'chat-a', getMessage: id => chat[id], getMessageElement: () => root,
        settings: { enabled: true, generation: { enabled: true, startTag: 'image###', endTag: '###' } },
        onMarker: marker => {
            const envelope = compileScene(marker.content);
            queue.addTask({ chatId: marker.chatId, messageId: marker.messageId, prompt: envelope, backend: { kind: 'comfy' }, profile: 'anima' });
        },
        logger: { log() {}, error() {} },
    });
    runtime.register();
    const injection = applyPlacements(plan.placements, {
        chat, mode: 'direct', startTag: 'image###', endTag: '###', saveChat: () => {},
        updateMessageBlock: (_id, message) => { root = element('DIV', message.mes); },
        onMarkerBuilt: metadata => finalMetadata.push(metadata),
        emit: id => eventSource.emit('MESSAGE_UPDATED', id),
    });
    assert.deepEqual(injection.touched, [1]);
    assert.equal(finalMetadata.length, 1);
    assert.match(finalMetadata[0].content, /\$Rosario/);
    assert.match(finalMetadata[0].content, /\$me/);
    await waitFor(() => queue.listTasks().some(task => task.status === 'succeeded'));
    assert.equal(executed.length, 1);
    const finalPrompt = executed[0].prompt.prompt;
    assert.match(finalPrompt, /black hair/);
    assert.match(finalPrompt, /brown hair/);
    assert.match(finalPrompt, /silk nightgown/);
    assert.equal((finalPrompt.match(/deterministic ink wash/g) ?? []).length, 1);
    assert.ok(!finalPrompt.includes('$Rosario'));
    assert.ok(!finalPrompt.includes('$me'));
    runtime.unregister();
    queue.dispose();
});
