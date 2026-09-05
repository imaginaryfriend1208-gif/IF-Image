#!/usr/bin/env node
// Offline task queue tests: deferred promises and injected timers only;
// no sleeps, no network, no 300-second waits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskQueue } from '../src/runtime/tasks.js';

/** Manually advanced virtual clock for timeout tests. */
function fakeClock() {
    let now = 0;
    const timers = new Map();
    const clock = {
        setTimeout(fn, _delay) {
            const handle = { fn, at: now + _delay };
            timers.set(handle, handle);
            return handle;
        },
        clearTimeout(handle) { timers.delete(handle); },
        advance(ms) {
            now += ms;
            for (const handle of [...timers.values()]) {
                if (handle.at <= now) { timers.delete(handle); handle.fn(); }
            }
        },
        pending() { return timers.size; },
        now: () => now,
    };
    return clock;
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/** Resolves after `count` microtask ticks. */
function ticks(count = 1) {
    let promise = Promise.resolve();
    for (let i = 0; i < count; i++) promise = promise.then(() => {});
    return promise;
}

test('options are validated', () => {
    const noop = () => {};
    assert.throws(() => createTaskQueue(), /execute is required/);
    assert.throws(() => createTaskQueue({ execute: 'x' }), /execute is required/);
    assert.throws(() => createTaskQueue({ execute: noop, concurrency: 0 }), /concurrency/);
    assert.throws(() => createTaskQueue({ execute: noop, concurrency: 1.5 }), /concurrency/);
    assert.throws(() => createTaskQueue({ execute: noop, maxQueued: -1 }), /maxQueued/);
    assert.throws(() => createTaskQueue({ execute: noop, maxQueued: 2.5 }), /maxQueued/);
    assert.throws(() => createTaskQueue({ execute: noop, timeoutMs: 0 }), /timeoutMs/);
    assert.throws(() => createTaskQueue({ execute: noop, timeoutMs: Infinity }), /timeoutMs/);
    assert.throws(() => createTaskQueue({ execute: noop, historyLimit: -3 }), /historyLimit/);
    assert.throws(() => createTaskQueue({ execute: noop, onStateChange: 'x' }), /onStateChange/);
    assert.throws(() => createTaskQueue({ execute: noop, timers: {} }), /timers/);
    // Boundary values accepted.
    createTaskQueue({ execute: noop, concurrency: 1, maxQueued: 0, timeoutMs: 1, historyLimit: 0 });
});

test('FIFO order and concurrency of 2', async () => {
    const events = [];
    const gates = Array.from({ length: 4 }, deferred);
    const queue = createTaskQueue({ execute: (task) => { events.push(`start:${task.id}`); return gates[+task.id.slice(5) - 1].promise; } });
    const ids = ['a', 'b', 'c', 'd'].map((p, i) => queue.addTask({ chatId: 'C', prompt: p, messageId: i }));
    assert.deepEqual(events, ['start:task-1', 'start:task-2']);
    assert.equal(queue.getTask(ids[2]).status, 'queued');
    gates[0].resolve('r1');
    await ticks();
    assert.deepEqual(events, ['start:task-1', 'start:task-2', 'start:task-3']);
    gates[1].resolve('r2'); gates[2].resolve('r3');
    await ticks();
    assert.deepEqual(events, ['start:task-1', 'start:task-2', 'start:task-3', 'start:task-4']);
    gates[3].resolve('r4');
    await ticks();
    assert.deepEqual(queue.listTasks().map(t => t.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    assert.deepEqual(queue.listTasks().map(t => t.result), ['r1', 'r2', 'r3', 'r4']);
    queue.dispose();
});

test('admission rejects invalid specs and a full queue', () => {
    const queue = createTaskQueue({ execute: () => new Promise(() => {}), concurrency: 2, maxQueued: 2 });
    for (let i = 0; i < 4; i++) queue.addTask({ chatId: 'C', prompt: `p${i}` });
    assert.throws(() => queue.addTask({ chatId: 'C' }), { code: 'QUEUE_FULL' });
    assert.throws(() => queue.addTask(), /task spec/);
    assert.throws(() => queue.addTask(null), /task spec/);
    assert.throws(() => queue.addTask({ prompt: 'x' }), /chatId/);
    assert.throws(() => queue.addTask({ chatId: '' }), /chatId/);
    assert.throws(() => queue.addTask({ chatId: 'C', messageId: -1 }), /messageId/);
    assert.throws(() => queue.addTask({ chatId: 'C', messageId: 1.5 }), /messageId/);
    queue.dispose();
    assert.throws(() => queue.addTask({ chatId: 'C' }), { code: 'QUEUE_DISPOSED' });
});

test('maxQueued 0 admits only when a slot is free', async () => {
    const events = [];
    const gate = deferred();
    const queue = createTaskQueue({ execute: (t) => { events.push(t.id); return gate.promise; }, concurrency: 1, maxQueued: 0 });
    queue.addTask({ chatId: 'C' });
    assert.throws(() => queue.addTask({ chatId: 'C' }), { code: 'QUEUE_FULL' });
    gate.resolve();
    await ticks();
    assert.equal(events.length, 1);
    queue.addTask({ chatId: 'C' }); // slot free again
    queue.dispose();
});

test('failure and sync throw both fail the task', async () => {
    const gate = deferred();
    const queue = createTaskQueue({ execute: (task) => task.id === 'task-1' ? gate.promise.then(() => Promise.reject(Object.assign(new Error('boom'), { code: 'NAI_429' }))) : { then() { throw new Error('sync'); } } });
    queue.addTask({ chatId: 'C' });
    queue.addTask({ chatId: 'C' });
    gate.resolve();
    await ticks(4);
    const tasks = queue.listTasks();
    assert.equal(tasks[0].status, 'failed');
    assert.equal(tasks[0].error.code, 'NAI_429');
    assert.equal(tasks[1].status, 'failed');
    assert.equal(tasks[1].error.code, 'EXECUTOR_ERROR');
    assert.match(tasks[1].error.message, /sync/);
    queue.dispose();
});

test('queued cancel prevents start; running cancel aborts', async () => {
    let observed = [];
    const gate = deferred();
    const queue = createTaskQueue({
        execute: (task, signal) => {
            observed.push({ id: task.id, aborted: signal.aborted });
            signal.addEventListener('abort', () => observed.push(`abort:${task.id}`));
            return gate.promise;
        },
    });
    queue.addTask({ chatId: 'C' });
    queue.addTask({ chatId: 'C' });
    const third = queue.addTask({ chatId: 'C' });
    assert.equal(queue.cancelTask(third), true);
    assert.equal(queue.getTask(third).status, 'cancelled');
    assert.equal(queue.cancelTask(third), false); // terminal is final
    // Cancel task-1 while its executor is still pending.
    assert.equal(queue.cancelTask('task-1'), true);
    assert.deepEqual(observed.slice(-1), ['abort:task-1']);
    assert.equal(queue.getTask('task-1').status, 'cancelled');
    gate.resolve();
    await ticks();
    assert.deepEqual(
        observed.map(o => typeof o === 'string' ? o : `start:${o.id}`),
        ['start:task-1', 'start:task-2', 'abort:task-1'],
    );
    assert.equal(observed.filter(o => o === 'abort:task-3').length, 0); // never started
    queue.dispose();
});

test('queued cancel frees a slot for a later task', async () => {
    const gate = deferred();
    const started = [];
    const queue = createTaskQueue({
        execute: (task) => { started.push(task.id); return gate.promise; },
    });
    queue.addTask({ chatId: 'C' });
    queue.addTask({ chatId: 'C' });
    const doomed = queue.addTask({ chatId: 'C' });
    queue.cancelTask(doomed);
    const fourth = queue.addTask({ chatId: 'C' });
    assert.equal(queue.getTask(fourth).status, 'queued'); // both slots held
    gate.resolve('done');
    await ticks();
    assert.deepEqual(started, ['task-1', 'task-2', 'task-4']); // doomed skipped, fourth drained
    assert.equal(queue.getTask(fourth).status, 'succeeded'); // settles on the already-resolved gate
    queue.dispose();
});

test('cancelAllForChat scopes to one chat', async () => {
    const gate = deferred();
    const queue = createTaskQueue({ execute: () => gate.promise });
    for (const chat of ['A', 'B', 'A', 'A']) queue.addTask({ chatId: chat });
    assert.equal(queue.cancelAllForChat('A'), 3);
    gate.resolve();
    await ticks();
    const tasks = queue.listTasks();
    assert.equal(tasks.filter(t => t.status === 'cancelled').length, 3);
    assert.equal(tasks.filter(t => t.chatId === 'B').every(t => t.status === 'succeeded'), true);
    queue.dispose();
});

test('batch cancel marks scope before drain: doomed task never starts', async () => {
    const started = [];
    const queue = createTaskQueue({ execute: (task) => { started.push(task.id); return deferred().promise; } });
    for (let i = 0; i < 3; i++) queue.addTask({ chatId: 'A' });
    // 2 running, third queued; cancel chat A: none may start from now on.
    const cancelled = queue.cancelAllForChat('A');
    assert.equal(cancelled, 3);
    await ticks();
    assert.deepEqual(started, ['task-1', 'task-2']); // task-3 never started
    queue.dispose();
});

test('cancelAll terminates every live task', async () => {
    const gate = deferred();
    const queue = createTaskQueue({ execute: () => gate.promise });
    for (let i = 0; i < 4; i++) queue.addTask({ chatId: `C${i}` });
    assert.equal(queue.cancelAll(), 4);
    gate.resolve();
    await ticks();
    assert.equal(queue.listTasks().every(t => t.status === 'cancelled'), true);
    queue.dispose();
});

test('timeout fails with TASK_TIMEOUT and aborts', async () => {
    const clock = fakeClock();
    const aborts = [];
    const queue = createTaskQueue({
        execute: (task, signal) => new Promise((resolve) => {
            signal.addEventListener('abort', () => aborts.push(task.id));
            // Uncooperative: ignores the signal; settles only on demand.
            task.id === 'task-1' ? null : null;
            queue.__release = queue.__release || {};
            queue.__release[task.id] = resolve;
        }),
        timeoutMs: 300000,
        timers: clock,
    });
    queue.addTask({ chatId: 'C' });
    queue.addTask({ chatId: 'C' });
    clock.advance(299999);
    assert.deepEqual(aborts, []);
    clock.advance(1);
    assert.deepEqual(aborts, ['task-1', 'task-2']);
    const tasks = queue.listTasks();
    assert.ok(tasks.every(t => t.status === 'failed'));
    assert.ok(tasks.every(t => t.error.code === 'TASK_TIMEOUT'));
    clock.advance(500000);
    assert.equal(clock.pending(), 0);
    queue.dispose();
});

test('clearing the timeout on settle leaves no dangling timer', async () => {
    const clock = fakeClock();
    const gate = deferred();
    const queue = createTaskQueue({ execute: () => gate.promise, timeoutMs: 1000, timers: clock });
    queue.addTask({ chatId: 'C' });
    gate.resolve('done');
    await ticks();
    assert.equal(clock.pending(), 0);
    clock.advance(99999); // must not fire the cleared timer
    assert.equal(queue.listTasks()[0].status, 'succeeded');
    queue.dispose();
});

test('late resolve and late reject after cancel stay cancelled', async () => {
    const gate = deferred();
    const queue = createTaskQueue({ execute: () => gate.promise });
    const id = queue.addTask({ chatId: 'C' });
    queue.cancelTask(id);
    gate.resolve('late');
    await ticks();
    assert.equal(queue.getTask(id).status, 'cancelled');
    assert.equal(queue.getTask(id).result, null);

    const gate2 = deferred();
    const queue2 = createTaskQueue({ execute: () => gate2.promise });
    const id2 = queue2.addTask({ chatId: 'C' });
    queue2.cancelTask(id2);
    gate2.reject(new Error('late failure'));
    await ticks(4);
    assert.equal(queue2.getTask(id2).status, 'cancelled');
    queue.dispose();
    queue2.dispose();
});

test('uncooperative executor holds its physical slot until settle', async () => {
    const started = [];
    const pending = new Map();
    const queue = createTaskQueue({
        execute: (task, signal) => new Promise((resolve) => {
            started.push(task.id);
            pending.set(task.id, resolve);
            signal.addEventListener('abort', () => { /* deliberately ignored */ });
        }),
    });
    for (let i = 0; i < 3; i++) queue.addTask({ chatId: 'C' });
    assert.deepEqual(started, ['task-1', 'task-2']);
    // task-1 ignores abort; even after cancel, task-3 must not start.
    queue.cancelTask('task-1');
    await ticks();
    assert.deepEqual(started, ['task-1', 'task-2']);
    assert.equal(queue.getTask('task-3').status, 'queued');
    // The executor finally settles; the slot is released only now.
    pending.get('task-1')('finally');
    await ticks();
    assert.deepEqual(started, ['task-1', 'task-2', 'task-3']);
    assert.equal(queue.getTask('task-1').status, 'cancelled'); // late result dropped
    pending.get('task-2')();
    pending.get('task-3')();
    await ticks();
    queue.dispose();
});

test('dispose cancels live tasks, clears timers and is idempotent', async () => {
    const clock = fakeClock();
    const aborts = [];
    const queue = createTaskQueue({
        execute: (task, signal) => new Promise((resolve) => {
            signal.addEventListener('abort', () => aborts.push(task.id));
            signal.addEventListener('abort', () => { /* never settle */ });
        }),
        timers: clock,
    });
    const ids = [queue.addTask({ chatId: 'C' }), queue.addTask({ chatId: 'C' })];
    assert.equal(clock.pending(), 2);
    assert.equal(queue.dispose(), true);
    assert.equal(queue.dispose(), false); // idempotent
    assert.equal(clock.pending(), 0);
    assert.deepEqual(aborts, ids);
    assert.equal(queue.listTasks().length, 0);
    assert.throws(() => queue.addTask({ chatId: 'C' }), { code: 'QUEUE_DISPOSED' });
    await ticks();
    clock.advance(10 ** 9);
});

test('observer errors are isolated; snapshots are cloned', async () => {
    const seen = [];
    let calls = 0;
    const gate = deferred();
    const queue = createTaskQueue({
        execute: () => gate.promise,
        onStateChange(snap) {
            calls += 1;
            if (snap.status === 'running') throw new Error('observer bug');
            seen.push(snap);
        },
    });
    const id = queue.addTask({ chatId: 'C', prompt: 'p', backend: { name: 'nai' } });
    const snapshot1 = queue.getTask(id);
    snapshot1.status = 'hacked';
    snapshot1.backend.name = 'hacked';
    assert.equal(queue.getTask(id).status, 'running');
    assert.equal(queue.getTask(id).backend.name, 'nai');
    gate.resolve({ url: 'blob:x' });
    await ticks();
    assert.equal(calls, 3); // queued + running + succeeded, observer throw didn't stop them
    const final = queue.getTask(id);
    assert.equal(final.status, 'succeeded');
    assert.deepEqual(final.result, { url: 'blob:x' });
    const result = final.result;
    result.url = 'hacked';
    assert.equal(queue.getTask(id).result.url, 'blob:x');
    queue.dispose();
});

test('history retains only settled terminal tasks, bounded to the limit', async () => {
    let resolveCurrent;
    const queue = createTaskQueue({
        execute: () => new Promise((resolve) => { resolveCurrent = resolve; }),
        concurrency: 1,
        historyLimit: 3,
    });
    const ids = [];
    for (let i = 0; i < 6; i++) {
        ids.push(queue.addTask({ chatId: 'C' }));
        resolveCurrent(i);
        await ticks();
    }
    // 6 settled terminal tasks; only the last 3 ids remain listed.
    assert.deepEqual(queue.listTasks().map(t => t.id), ids.slice(-3));
    queue.dispose();
});

test('no credentials and no AbortController leak in snapshots', async () => {
    const gate = deferred();
    let seenSignal = null;
    const queue = createTaskQueue({
        execute: (task, signal) => { seenSignal = signal; return gate.promise; },
    });
    const id = queue.addTask({ chatId: 'C', apiKey: 'SECRET', prompt: 'p' });
    const snap = queue.getTask(id);
    assert.equal('apiKey' in snap, false);
    assert.equal('abortController' in snap, false);
    assert.equal('signal' in snap, false);
    assert.ok(seenSignal instanceof AbortSignal);
    gate.resolve();
    await ticks();
    queue.dispose();
});

test('stale completion never resurrects a terminal state', async () => {
    const clock = fakeClock();
    const pending = new Map();
    const queue = createTaskQueue({
        execute: (task) => new Promise((resolve) => pending.set(task.id, resolve)),
        timers: clock,
    });
    const id = queue.addTask({ chatId: 'C' });
    clock.advance(300000); // timeout fires, status failed
    assert.equal(queue.getTask(id).status, 'failed');
    pending.get(id)('too late');
    await ticks();
    const snap = queue.getTask(id);
    assert.equal(snap.status, 'failed');
    assert.equal(snap.result, null);
    queue.dispose();
});
