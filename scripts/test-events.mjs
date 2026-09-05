#!/usr/bin/env node
// Offline DOM-shape and event lifecycle tests; no browser or network required.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractMarkers, renderedSegments, createMarkerRuntime } from '../src/runtime/events.js';
import { createTaskQueue } from '../src/runtime/tasks.js';

const text = nodeValue => ({ nodeType: 3, nodeValue });
const element = (tagName, ...children) => ({
    nodeType: 1, tagName, childNodes: children.map(c => typeof c === 'string' ? text(c) : c),
});
const marker = value => `image### ${value} ###`;
function fixture(hooks = {}) {
    const listeners = new Map();
    const state = {
        chatId: 'A', chat: [{ mes: marker('scene') }], root: element('DIV', marker('scene')),
        streaming: false, out: [], settings: { enabled: true, generation: { enabled: true } },
    };
    const names = ['USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED',
        'MESSAGE_SWIPED', 'CHAT_CHANGED', 'MESSAGE_DELETED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_EDITED'];
    const runtime = createMarkerRuntime({
        eventSource: {
            on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
            removeListener: (name, fn) => listeners.get(name)?.delete(fn),
        },
        eventTypes: Object.fromEntries(names.map(n => [n, n])),
        getChatId: () => state.chatId, getMessage: id => state.chat[id],
        getMessageElement: () => state.root, isStreaming: () => state.streaming,
        settings: state.settings, onMarker: m => state.out.push(m),
        logger: { log() {}, error() {} }, ...hooks,
    });
    state.emit = (name = 'CHARACTER_MESSAGE_RENDERED', id = 0) => {
        for (const fn of listeners.get(name) || []) fn(id);
    };
    state.update = value => { state.chat[0].mes = marker(value); state.root = element('DIV', marker(value)); };
    state.runtime = runtime;
    runtime.register();
    return state;
}

test('complete, multiline, empty and incomplete markers', () => {
    assert.deepEqual(extractMarkers(marker('a\nb')), [{ content: 'a\nb' }]);
    for (const input of [null, 42, '', 'image### incomplete', marker(' ')]) assert.deepEqual(extractMarkers(input), []);
});
test('custom tags are literal regex characters', () => {
    assert.deepEqual(extractMarkers('[[[ a ]]]', { startTag: '[[[', endTag: ']]]' }), [{ content: 'a' }]);
});
test('joins inline text nodes and preserves line breaks', () => {
    assert.deepEqual(renderedSegments(element('DIV', 'image', element('SPAN', '### a'), element('BR'), 'b ###')), ['image### a\nb ###']);
});
for (const tag of ['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'BUTTON', 'NOSCRIPT']) {
    test(`excludes ${tag} and never joins across it`, () => {
        const f = fixture();
        f.root = element('DIV', 'image### before', element(tag, marker('forbidden')), 'after ###');
        f.emit();
        assert.equal(f.out.length, 0);
    });
}
test('block boundaries prevent synthetic cross-paragraph markers', () => {
    const f = fixture();
    f.root = element('DIV', element('P', 'image### a'), element('P', 'b ###'));
    f.emit();
    assert.equal(f.out.length, 0);
});
test('raw code markers absent from rendered eligible content do not emit', () => {
    const f = fixture();
    f.chat[0].mes = '```\n' + marker('example') + '\n```';
    f.root = element('DIV', element('PRE', element('CODE', marker('example'))), marker('visible'));
    f.emit();
    assert.deepEqual(f.out.map(m => m.content), ['visible']);
});
test('pre-render events ignored; post-render event processes final DOM', () => {
    const f = fixture();
    for (const name of ['MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_EDITED']) f.emit(name);
    assert.equal(f.out.length, 0);
    f.update('final'); f.emit('MESSAGE_UPDATED');
    assert.equal(f.out[0].content, 'final');
});
test('streaming blocks detection until stopped', () => {
    const f = fixture(); f.streaming = true; f.emit();
    assert.equal(f.out.length, 0);
    f.streaming = false; f.emit(); assert.equal(f.out.length, 1);
});
test('identical occurrences remain distinct and rerender dedupes', () => {
    const f = fixture(); f.update('a'); f.root = element('DIV', marker('a') + marker('a'));
    f.emit(); f.emit();
    assert.deepEqual(f.out.map(m => m.occurrence), [0, 1]);
});
test('Ab and BA hash collision no longer suppresses edit', () => {
    const f = fixture(); f.update('Ab'); f.emit(); f.update('BA'); f.emit('MESSAGE_UPDATED');
    assert.deepEqual(f.out.map(m => m.content), ['Ab', 'BA']);
});
test('new scene revision emits; reverting known revision does not duplicate', () => {
    const f = fixture(); f.emit(); f.chat[0].mes += ' changed context'; f.emit('MESSAGE_UPDATED');
    assert.equal(f.out.length, 2);
    f.chat[0].mes = marker('scene'); f.emit('MESSAGE_UPDATED'); assert.equal(f.out.length, 2);
});
test('new swipe emits; return to previous swipe dedupes', () => {
    const f = fixture(); f.emit(); f.chat[0].swipe_id = 1; f.emit('MESSAGE_SWIPED');
    f.chat[0].swipe_id = 0; f.emit('MESSAGE_SWIPED'); assert.equal(f.out.length, 2);
});
test('deletion/index reuse does not inherit deleted message dedup', () => {
    const f = fixture(); f.emit(); f.chat.pop(); f.emit('MESSAGE_DELETED', 0);
    f.chat.push({ mes: marker('scene') }); f.emit(); assert.equal(f.out.length, 2);
});
test('reindex preserves dedup for surviving message object', () => {
    const f = fixture(); f.chat.unshift({ mes: 'other' }); f.emit('CHARACTER_MESSAGE_RENDERED', 1);
    f.chat.shift(); f.emit('MESSAGE_DELETED', 1); f.emit(); assert.equal(f.out.length, 1);
});
test('chat switch resets detection without scanning history automatically', () => {
    const f = fixture(); f.emit(); f.chatId = 'B'; f.emit('CHAT_CHANGED');
    assert.equal(f.out.length, 1); f.emit(); assert.equal(f.out.length, 2);
});
test('disable flags, unregister and idempotent registration', () => {
    const f = fixture(); assert.equal(f.runtime.register(), false);
    f.settings.enabled = false; f.emit(); f.settings.enabled = true;
    f.settings.generation.enabled = false; f.emit(); assert.equal(f.out.length, 0);
    f.settings.generation.enabled = true; f.runtime.unregister(); f.emit(); assert.equal(f.out.length, 0);
    f.runtime.register(); f.emit('USER_MESSAGE_RENDERED'); assert.equal(f.out.length, 1);
});
test('missing DOM, system messages, invalid ids and no chat ignored', () => {
    const f = fixture(); const root = f.root; f.root = null; f.emit(); f.root = root;
    for (const id of [null, '', -1, 1.5, 'bad', 99]) f.emit('CHARACTER_MESSAGE_RENDERED', id);
    f.chat[0].is_system = true; f.emit(); f.chat[0].is_system = false;
    f.chatId = undefined; f.emit(); assert.equal(f.out.length, 0);
});

// --- Step 2.2: lifecycle hooks and queue integration -----------------------

test('no lifecycle callbacks fire on initial registration', () => {
    const calls = [];
    fixture({
        onChatWillChange: prev => calls.push(`will:${prev}`),
        onChatChanged: (prev, next) => calls.push(`changed:${prev}->${next}`),
        onDispose: () => calls.push('dispose'),
    });
    assert.deepEqual(calls, []);
});

test('chat change fires will-change with the old chat, then changed', () => {
    const calls = [];
    const f = fixture({
        onChatWillChange: prev => calls.push(`will:${prev}`),
        onChatChanged: (prev, next) => calls.push(`changed:${prev}->${next}`),
    });
    f.chatId = 'B';
    f.emit('CHAT_CHANGED');
    assert.deepEqual(calls, ['will:A', 'changed:A->B']);
});

test('late detection of a chat mismatch also fires the hooks', () => {
    const calls = [];
    const f = fixture({
        onChatChanged: (prev, next) => calls.push(`${prev}->${next}`),
    });
    f.chatId = 'B'; // no CHAT_CHANGED event, noticed on next message render
    f.emit();
    assert.deepEqual(calls, ['A->B']);
    assert.equal(f.out[0].chatId, 'B');
});

test('unregister fires onDispose exactly once per registration', () => {
    let disposed = 0;
    const f = fixture({ onDispose: () => disposed += 1 });
    f.runtime.unregister();
    f.runtime.unregister(); // idempotent, no second callback
    assert.equal(disposed, 1);
    f.runtime.register();
    f.runtime.unregister();
    assert.equal(disposed, 2);
});

test('throwing hooks never break reset or listener cleanup', () => {
    const errors = [];
    const f = fixture({
        onChatWillChange: () => { throw new Error('will bug'); },
        onChatChanged: () => { throw new Error('changed bug'); },
        onDispose: () => { throw new Error('dispose bug'); },
        logger: { log() {}, error: msg => errors.push(msg) },
    });
    f.chatId = 'B';
    f.emit('CHAT_CHANGED');          // both hooks throw, reset still happens
    f.emit();                        // dedup was reset, marker emitted again
    assert.equal(f.out.length, 1);
    f.runtime.unregister();          // dispose hook throws, cleanup still runs
    f.emit();                        // listeners detached
    assert.equal(f.out.length, 1);
    assert.equal(errors.length, 3);
    assert.match(errors[2], /dispose bug/);
});

test('integration: CHAT_CHANGED cancels old chat tasks, unregister cancels all', () => {
    const executed = [];
    const queue = createTaskQueue({
        execute: task => { executed.push(task.id); return new Promise(() => {}); },
    });
    // Simulates the Step 2.5 wiring: onMarker -> addTask.
    const f = fixture({
        onChatWillChange: previousChat => { queue.cancelAllForChat(previousChat); },
        onDispose: () => { queue.cancelAll(); },
        onMarker: m => queue.addTask({ chatId: m.chatId, messageId: m.messageId, prompt: m.content }),
    });
    f.emit(); // task for chat A starts
    assert.equal(executed.length, 1);
    const aTask = queue.listTasks().find(t => t.chatId === 'A');
    assert.equal(aTask.status, 'running');
    f.chatId = 'B';
    f.emit('CHAT_CHANGED'); // old chat tasks cancelled
    assert.equal(queue.getTask(aTask.id).status, 'cancelled');
    f.emit(); // task for chat B still flows
    assert.equal(queue.listTasks().filter(t => t.chatId === 'B' && t.status === 'running').length, 1);
    f.runtime.unregister(); // cancels everything for this runtime
    assert.equal(queue.listTasks().filter(t => t.status === 'running').length, 0);
    assert.equal(queue.listTasks().every(t => t.status === 'cancelled'), true);
    queue.dispose();
});
