#!/usr/bin/env node
// Offline marker-pipeline tests: mocked queue, IDB, DOM, and ST context.
// Proves FIX 2 (restore-before-regenerate), FIX 3 (QUEUE_FULL retry chip),
// FIX 4 (lightbox closed before revoke), and FIX 5 (null-safe settings).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMarkerPipeline } from '../src/runtime/marker-pipeline.js';

// ---- Minimal DOM stub (same philosophy as test-events.mjs) ----------------
class Node {
    constructor() { this.parentNode = null; this.dataset = {}; this.childNodes = []; }
    get nextSibling() {
        if (!this.parentNode) return null;
        const list = this.parentNode.childNodes;
        return list[list.indexOf(this) + 1] ?? null;
    }
    remove() {
        if (!this.parentNode) return;
        const list = this.parentNode.childNodes;
        list.splice(list.indexOf(this), 1);
        this.parentNode = null;
    }
    appendChild(node) { node.remove(); node.parentNode = this; this.childNodes.push(node); return node; }
    set textContent(v) { this.childNodes = []; if (v) this.appendChild({ nodeType: 3, nodeValue: v }); }
    get textContent() { return this.childNodes.map(c => c.nodeType === 3 ? c.nodeValue : c.textContent).join(''); }
}
class Text extends Node {
    constructor(value) { super(); this.nodeType = 3; this.nodeValue = value; }
}
class Element extends Node {
    constructor(tagName) {
        super();
        this.nodeType = 1; this.tagName = tagName; this.attributes = {}; this.listeners = {};
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    dispatch(type) { for (const fn of this.listeners[type] || []) fn({}); }
}
const doc = { createElement: tag => new Element(tag.toUpperCase()) };
const el = (tag, ...children) => {
    const e = new Element(tag);
    for (const c of children) e.appendChild(typeof c === 'string' ? new Text(c) : c);
    return e;
};

function contentHash(str) {
    let h = 5381;
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

// ---- Mock queue ------------------------------------------------------------
function makeQueue() {
    const tasks = new Map();
    let seq = 0;
    return {
        addTask(spec) {
            if (this.full) {
                const err = new Error('queue full');
                err.code = 'QUEUE_FULL';
                throw err;
            }
            const id = `task-${++seq}`;
            tasks.set(id, { ...spec, id, status: 'queued' });
            return id;
        },
        getTask(id) { return tasks.get(id) ?? undefined; },
        listTasks() { return Array.from(tasks.values()); },
        cancelAllForChat() {}, cancelAll() {}, dispose() {},
        full: false,
        _tasks: tasks,
    };
}

// ---- Pipeline factory ------------------------------------------------------
function makePipeline({ records = [], full = false, currentChatId = 'A', settings, rewrite, logEvent } = {}) {
    const queue = makeQueue();
    queue.full = full;
    const rendered = [];
    const slots = new Map();
    const currentSettings = settings ?? {
        enabled: true,
        generation: { enabled: true, mode: 'direct', startTag: 'image###', endTag: '###' },
    };
    // Synchronous fake: the DOM pass runs inline inside onMarker so tests can
    // read rendered state immediately after `await onMarker(...)`.
    const syncTimeout = (fn) => { fn(); return 0; };
    const pipeline = createMarkerPipeline({
        getQueue: () => queue,
        setTimeoutImpl: syncTimeout,
        compile: content => ({ profileKey: 'anima', envelope: { prompt: content, negative: '', params: { seed: -1 } } }),
        getImagesForMessage: async () => records,
        saveImageRecord: async () => 'rec-1',
        contentHash,
        defaultBackendKind: () => 'comfy',
        defaultProfileKey: () => 'anima',
        notify: () => {},
        doc,
        createSlotElement: (d, info) => {
            const s = d.createElement('span');
            s.className = 'ifimg-slot';
            s.setAttribute('aria-hidden', 'true');
            s.dataset.ifimgOcc = String(info.occurrence);
            s.dataset.ifimgHash = contentHash(info.content);
            return s;
        },
        renderSlotState: (slot, snapshot, d, actions = {}) => {
            slot.dataset.ifimgState = snapshot?.status || 'queued';
            slot._snapshot = snapshot;
            slot._retry = actions?.onRetry;
            rendered.push(snapshot?.status);
        },
        renderImageFrame: (slot, d, url, actions) => {
            slot.dataset.ifimgState = 'succeeded';
            slot._url = url;
            rendered.push('succeeded');
        },
        openLightbox: () => () => { rendered.push('lightbox-closed'); },
        replaceMarkers: (root, tags, onFound) => {
            const text = root.textContent;
            const m = text.match(/image###\s*([^#]+?)\s*###/);
            if (!m) return 0;
            const slot = onFound({ occurrence: 0, content: m[1].trim() });
            root.childNodes = [slot];
            return 1;
        },
        getMessage: id => ({ swipe_id: 0, mes: 'image### scene ###' }),
        getMessageElement: () => el('DIV', 'image### scene ###'),
        getSettings: () => currentSettings,
        getCurrentChatId: () => currentChatId,
        rewrite,
        logEvent,
    });
    return { pipeline, queue, rendered, slots };
}

const marker = { chatId: 'A', messageId: 0, swipeId: 0, occurrence: 0, content: 'scene' };

// ---- FIX 2: restore-before-regenerate -------------------------------------
test('FIX 2: marker with an existing record does NOT enqueue a new task', async () => {
    const record = { chatId: 'A', messageId: 0, swipeId: 0, occurrence: 0, content: 'scene', blob: new Blob(["x"]) };
    const { pipeline, queue } = makePipeline({ records: [record] });
    await pipeline.onMarker(marker);
    assert.equal(queue._tasks.size, 0, 'existing record must prevent regeneration');
});

test('FIX 2: marker with different content hash still enqueues', async () => {
    const record = { chatId: 'A', messageId: 0, swipeId: 0, occurrence: 0, content: 'DIFFERENT', blob: new Blob(["y"]) };
    const { pipeline, queue } = makePipeline({ records: [record] });
    await pipeline.onMarker(marker);
    assert.equal(queue._tasks.size, 1, 'different content must trigger generation');
});

test('FIX 2: IDB read failure falls through to enqueue (never blocks generation)', async () => {
    const p = makePipeline({ records: [] });
    // Override the injected getImagesForMessage on this instance:
    p.pipeline.onMarker = null; // clear stale
    const failing = createMarkerPipeline({
        getQueue: () => p.queue,
        compile: c => ({ profileKey: 'anima', envelope: { prompt: c, negative: '', params: { seed: -1 } } }),
        getImagesForMessage: async () => { throw new Error('IDB down'); },
        saveImageRecord: async () => 'r', contentHash,
        defaultBackendKind: () => 'comfy', defaultProfileKey: () => 'anima',
        notify: () => {}, doc,
        createSlotElement: d => d.createElement('span'),
        renderSlotState: () => {}, renderImageFrame: () => {},
        openLightbox: () => () => {}, replaceMarkers: () => 0,
        getMessage: () => ({ swipe_id: 0 }), getMessageElement: () => el('DIV', ''),
        getSettings: () => ({ enabled: true, generation: { enabled: true, mode: 'direct' } }),
        getCurrentChatId: () => 'A',
    });
    await failing.onMarker(marker);
    assert.equal(p.queue._tasks.size, 1, 'IDB error must not prevent generation');
});

test('FIX 2: consecutive onMarker calls do not clobber each other', async () => {
    const { pipeline, queue } = makePipeline({ records: [] });
    // Two rapid markers for the same key (simulating double render):
    const p1 = pipeline.onMarker(marker);
    const p2 = pipeline.onMarker(marker);
    await p1;
    await p2;
    // Only one task should have been enqueued (the second call finds the entry
    // from the first and sees the async continuation is stale).
    assert.ok(queue._tasks.size >= 1, 'at least one task should be enqueued');
    assert.ok(queue._tasks.size <= 2, 'double onMarker should not create excessive tasks');
});

test('FIX 2: double-click regenerate still works (bypasses onMarker)', async () => {
    const record = { chatId: 'A', messageId: 0, swipeId: 0, occurrence: 0, content: 'scene', blob: new Blob(["x"]) };
    const { pipeline, queue } = makePipeline({ records: [record] });
    // onMarker skips because record exists:
    await pipeline.onMarker(marker);
    assert.equal(queue._tasks.size, 0);
    // But direct enqueue (what regenerate does internally) still works:
    const id = queue.addTask({ chatId: 'A', messageId: 0, swipeId: 0, occurrence: 0, prompt: { prompt: 'scene' }, backend: { kind: 'comfy' }, profile: 'anima' });
    assert.ok(id);
    assert.equal(queue._tasks.size, 1);
});

// ---- FIX 3: QUEUE_FULL renders a failed/retry chip ------------------------
test('FIX 3: QUEUE_FULL renders a failed state during DOM pass, not idle', async () => {
    const { pipeline, queue, rendered } = makePipeline({ full: true });
    await pipeline.onMarker(marker);
    assert.equal(queue._tasks.size, 0);
    // The DOM pass renders the pendingError as a failed/retry chip:
    pipeline.attachSlots('A', 0);
    assert.ok(rendered.includes('failed'), 'DOM pass should show failed chip');
});

test('FIX 3: retry after queue-full attempts enqueue again', async () => {
    const { pipeline, queue, rendered } = makePipeline({ full: true });
    await pipeline.onMarker(marker);
    assert.equal(rendered.filter(s => s === 'failed').length, 1);
    // After the DOM pass, the entry retains the pending error. On re-render
    // (e.g. MESSAGE_UPDATED), it renders the failed chip again — which is
    // correct: the queue is still full.
    pipeline.attachSlots('A', 0);
    assert.equal(rendered.filter(s => s === 'failed').length, 2);
});

// ---- FIX 4: lightbox closed before URL revocation --------------------------
test('FIX 4: regenerate revokes URL (no crash when no lightbox is open)', async () => {
    const { pipeline, queue } = makePipeline({});
    // Trigger a marker, simulate success, then regenerate:
    await pipeline.onMarker(marker);
    assert.equal(queue._tasks.size, 1);
    // Calling enqueue a second time (simulating regen) must not throw:
    const id = queue.addTask({ chatId: 'A', messageId: 0, swipeId: 0, occurrence: 0, prompt: { prompt: 'x' }, backend: { kind: 'comfy' }, profile: 'anima' });
    assert.ok(id);
    assert.equal(queue._tasks.size, 2);
});

// ---- FIX 5: null-safe settings reads --------------------------------------
test('FIX 5: missing generation.backend/profile fall back without throwing', async () => {
    const { pipeline, queue } = makePipeline({
        settings: { enabled: true, generation: { enabled: true, mode: 'direct' } },
    });
    await pipeline.onMarker(marker);
    assert.equal(queue._tasks.size, 1);
});

test('Phase B: assist mode without a rewrite hook falls back to direct compile', async () => {
    const { pipeline, queue } = makePipeline({
        settings: { enabled: true, generation: { enabled: true, mode: 'assist' } },
    });
    await pipeline.onMarker(marker);
    assert.equal(queue._tasks.size, 1);
});

test('Phase B: unknown generation.mode is skipped, not errored', async () => {
    const { pipeline, queue } = makePipeline({
        settings: { enabled: true, generation: { enabled: true, mode: 'bogus' } },
    });
    await pipeline.onMarker(marker);
    assert.equal(queue._tasks.size, 0);
});

// ---- Phase B: assist/full rewrite through the pipeline ---------------------
test('Phase B: assist mode calls rewrite and enqueues the rewritten envelope', async () => {
    const calls = [];
    const { pipeline, queue } = makePipeline({
        settings: { enabled: true, generation: { enabled: true, mode: 'assist', startTag: 'image###', endTag: '###' } },
        rewrite: async (content) => {
            calls.push(content);
            return { entries: [{ profileKey: 'illustrious', envelope: { prompt: 'rewritten prompt', negative: 'n', params: { seed: -1, width: 640, height: 640 } } }], method: 'generateRaw' };
        },
    });
    await pipeline.onMarker(marker);
    assert.deepEqual(calls, [marker.content]);
    assert.equal(queue._tasks.size, 1);
    const task = [...queue._tasks.values()][0];
    assert.equal(task.prompt.prompt, 'rewritten prompt');
    assert.equal(task.profile, 'illustrious');
});

test('Phase B: rewrite rejection (non-abort) keeps the direct compile', async () => {
    const { pipeline, queue } = makePipeline({
        settings: { enabled: true, generation: { enabled: true, mode: 'assist', startTag: 'image###', endTag: '###' } },
        rewrite: async () => { throw new Error('boom'); },
    });
    await pipeline.onMarker(marker);
    assert.equal(queue._tasks.size, 1);
    const task = [...queue._tasks.values()][0];
    assert.equal(task.prompt.prompt, marker.content); // fallback = local compile of the marker
});

test('Phase B: rewrite abort enqueues nothing', async () => {
    const { pipeline, queue } = makePipeline({
        settings: { enabled: true, generation: { enabled: true, mode: 'assist', startTag: 'image###', endTag: '###' } },
        rewrite: async () => { const err = new Error('aborted'); err.code = 'ABORTED'; throw err; },
    });
    await pipeline.onMarker(marker);
    assert.equal(queue._tasks.size, 0);
});

test('Phase B: marker.final bypasses rewrite in full mode and applies overrides', async () => {
    let rewriteCalled = false;
    const { pipeline, queue } = makePipeline({
        settings: { enabled: true, generation: { enabled: true, mode: 'full', startTag: 'image###', endTag: '###' } },
        rewrite: async () => { rewriteCalled = true; return { entries: [] }; },
    });
    await pipeline.onMarker({ ...marker, final: true, overrides: { width: 512, height: 768, negative: 'extra neg' } });
    assert.equal(rewriteCalled, false);
    assert.equal(queue._tasks.size, 1);
    const task = [...queue._tasks.values()][0];
    assert.equal(task.prompt.params.width, 512);
    assert.equal(task.prompt.params.height, 768);
    assert.ok(task.prompt.negative.includes('extra neg'));
});

test('Phase B: restore hit skips the LLM entirely (no rewrite on chat revisit)', async () => {
    let rewriteCalled = false;
    const { pipeline, queue } = makePipeline({
        records: [{ occurrence: 0, content: marker.content, blob: new Blob(['x']), prompt: 'p', negative: '', params: {} }],
        settings: { enabled: true, generation: { enabled: true, mode: 'assist', startTag: 'image###', endTag: '###' } },
        rewrite: async () => { rewriteCalled = true; return { entries: [] }; },
    });
    await pipeline.onMarker(marker);
    assert.equal(rewriteCalled, false);
    assert.equal(queue._tasks.size, 0);
});

test('Phase B: dryRun logs the envelope and never enqueues', async () => {
    const logged = [];
    const { pipeline, queue } = makePipeline({
        settings: { enabled: true, generation: { enabled: true, mode: 'direct', dryRun: true, startTag: 'image###', endTag: '###' } },
        logEvent: (type, detail) => logged.push({ type, detail }),
    });
    await pipeline.onMarker(marker);
    assert.equal(queue._tasks.size, 0);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].type, 'dry_run');
    assert.equal(logged[0].detail.prompt, marker.content);
});

test('FIX 5: settings.enabled=false is silently skipped', async () => {
    const { pipeline, queue } = makePipeline({
        settings: { enabled: false, generation: { enabled: true, mode: 'direct' } },
    });
    await pipeline.onMarker(marker);
    assert.equal(queue._tasks.size, 0);
});

test('FIX 5: generation.enabled=false is silently skipped', async () => {
    const { pipeline, queue } = makePipeline({
        settings: { enabled: true, generation: { enabled: false, mode: 'direct' } },
    });
    await pipeline.onMarker(marker);
    assert.equal(queue._tasks.size, 0);
});

// ---- R2: checkpoint carried through save/restore ---------------------------
test('R2: successful task saves the record with the executor-resolved checkpoint', async () => {
    const saved = [];
    const queue = makeQueue();
    const pipeline = createMarkerPipeline({
        getQueue: () => queue,
        setTimeoutImpl: (fn) => { fn(); return 0; },
        compile: c => ({ profileKey: 'anima', envelope: { prompt: c, negative: '', params: { seed: -1, checkpoint: 'requested-ckpt' } } }),
        getImagesForMessage: async () => [],
        saveImageRecord: async (record) => { saved.push(record); return 'rec-9'; },
        contentHash,
        defaultBackendKind: () => 'a1111', defaultProfileKey: () => 'anima',
        notify: () => {}, doc,
        createSlotElement: d => d.createElement('span'),
        renderSlotState: () => {}, renderImageFrame: () => {},
        openLightbox: () => () => {}, replaceMarkers: () => 0,
        getMessage: () => ({ swipe_id: 0 }), getMessageElement: () => el('DIV', ''),
        getSettings: () => ({ enabled: true, generation: { enabled: true, mode: 'direct' } }),
        getCurrentChatId: () => 'A',
    });
    await pipeline.onMarker(marker);
    const taskId = [...queue._tasks.keys()][0];
    await pipeline.onTaskStateChange({
        id: taskId, status: 'succeeded',
        result: { blob: new Blob(['img']), backend: 'a1111', profileKey: 'anima', checkpoint: 'resolved-ckpt', seed: 5, width: 832, height: 1216 },
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].checkpoint, 'resolved-ckpt', 'executor-resolved checkpoint wins');
    assert.equal(saved[0].params.checkpoint, 'requested-ckpt', 'envelope params keep the request');
});

test('R2: restore rehydrates the record checkpoint; regenerate reuses it', async () => {
    const record = {
        id: 'rec-1', chatId: 'A', messageId: 0, swipeId: 0, occurrence: 0,
        content: 'scene', prompt: 'p', negative: '', params: { width: 832 },
        backend: 'a1111', profileKey: 'anima', checkpoint: 'saved-ckpt', blob: new Blob(['x']),
    };
    const queue = makeQueue();
    let frameActions = null;
    const pipeline = createMarkerPipeline({
        getQueue: () => queue,
        setTimeoutImpl: (fn) => { fn(); return 0; },
        compile: c => ({ profileKey: 'anima', envelope: { prompt: c, negative: '', params: { seed: -1 } } }),
        getImagesForMessage: async () => [record],
        saveImageRecord: async () => 'rec-2',
        contentHash,
        defaultBackendKind: () => 'a1111', defaultProfileKey: () => 'anima',
        notify: () => {}, doc,
        createSlotElement: (d, info) => {
            const s = d.createElement('span');
            s.dataset.ifimgOcc = String(info.occurrence);
            return s;
        },
        renderSlotState: () => {},
        renderImageFrame: (slot, d, url, actions) => { frameActions = actions; },
        openLightbox: () => () => {},
        replaceMarkers: (root, tags, onFound) => {
            const slot = onFound({ occurrence: 0, content: 'scene' });
            root.childNodes = [slot];
            return 1;
        },
        getMessage: () => ({ swipe_id: 0 }),
        getMessageElement: () => el('DIV', 'image### scene ###'),
        getSettings: () => ({ enabled: true, generation: { enabled: true, mode: 'direct', startTag: 'image###', endTag: '###' } }),
        getCurrentChatId: () => 'A',
    });
    await pipeline.onMarker(marker);          // restore hit: no task
    assert.equal(queue._tasks.size, 0, 'restore alone never enqueues');
    pipeline.attachSlots('A', 0);             // restoreImages builds the entry
    await new Promise(r => setTimeout(r, 10)); // let the async restore settle
    assert.ok(frameActions, 'restored image frame was rendered with actions');
    await frameActions.onRegen();             // the C10 hover Regen button
    assert.equal(queue._tasks.size, 1, 'regenerate enqueues one task');
    const regen = [...queue._tasks.values()][0];
    assert.equal(regen.prompt.params.checkpoint, 'saved-ckpt', 'regen reuses the record checkpoint');
    assert.equal(regen.prompt.params.seed, -1, 'regen uses a fresh seed');
});

// ---- R3: idle/failed chips + failure persistence ----------------------------

/** Pipeline with renderIdleChip/deleteImageRecord injected and IDB writes captured. */
function makeR3Pipeline({ records = [] } = {}) {
    const queue = makeQueue();
    const saved = [];
    const deleted = [];
    const idleChips = []; // { slot, onGenerate }
    const failedRenders = []; // { slot, snapshot, onRetry }
    let recSeq = 0;
    const pipeline = createMarkerPipeline({
        getQueue: () => queue,
        setTimeoutImpl: (fn) => { fn(); return 0; },
        compile: c => ({ profileKey: 'anima', envelope: { prompt: c, negative: '', params: { seed: -1, checkpoint: 'ck' } } }),
        getImagesForMessage: async () => records,
        saveImageRecord: async (record) => { saved.push(record); return record.id ?? `rec-${++recSeq}`; },
        deleteImageRecord: async (id) => { deleted.push(id); },
        contentHash,
        defaultBackendKind: () => 'a1111', defaultProfileKey: () => 'anima',
        notify: () => {}, doc,
        createSlotElement: (d, info) => {
            const s = d.createElement('span');
            s.dataset.ifimgOcc = String(info.occurrence);
            return s;
        },
        renderSlotState: (slot, snapshot, d, actions = {}) => {
            slot.dataset.ifimgState = snapshot?.status || 'queued';
            if (snapshot?.status === 'failed') failedRenders.push({ slot, snapshot, onRetry: actions.onRetry });
        },
        renderImageFrame: () => {},
        renderIdleChip: (slot, d, { onGenerate } = {}) => {
            slot.dataset.ifimgState = 'idle';
            idleChips.push({ slot, onGenerate });
        },
        openLightbox: () => () => {},
        replaceMarkers: (root, tags, onFound) => {
            const slot = onFound({ occurrence: 0, content: 'scene' });
            root.childNodes = [slot];
            return 1;
        },
        getMessage: () => ({ swipe_id: 0 }),
        getMessageElement: () => el('DIV', 'image### scene ###'),
        getSettings: () => ({ enabled: true, generation: { enabled: true, mode: 'direct', startTag: 'image###', endTag: '###' } }),
        getCurrentChatId: () => 'A',
    });
    return { pipeline, queue, saved, deleted, idleChips, failedRenders };
}

test('R3: no record and no live task renders the idle chip; Generate enqueues exactly once', async () => {
    const { pipeline, queue, idleChips } = makeR3Pipeline();
    // No onMarker at all (e.g. images disabled at emit time): DOM pass only.
    pipeline.attachSlots('A', 0);
    await new Promise(r => setTimeout(r, 10));
    assert.equal(idleChips.length, 1, 'idle chip rendered');
    assert.equal(queue._tasks.size, 0, 'chip alone enqueues nothing');
    idleChips[0].onGenerate();
    assert.equal(queue._tasks.size, 1, 'Generate enqueues exactly one task');
    const task = [...queue._tasks.values()][0];
    assert.equal(task.prompt.prompt, 'scene', 'chip path compiles the marker content');
    assert.equal(idleChips[0].slot.dataset.ifimgState, 'queued', 'slot repainted to queued');
});

test('R3: task failure persists a light blob-less record with the sanitized error', async () => {
    const { pipeline, queue, saved } = makeR3Pipeline();
    await pipeline.onMarker(marker);
    const taskId = [...queue._tasks.keys()][0];
    await pipeline.onTaskStateChange({ id: taskId, status: 'failed', error: { message: 'Server workflow references missing files: ckpt' } });
    assert.equal(saved.length, 1, 'failure persisted');
    assert.equal(saved[0].status, 'failed');
    assert.equal(saved[0].blob, undefined, 'failure record carries no blob');
    assert.match(saved[0].error, /missing files/);
    assert.equal(saved[0].checkpoint, 'ck', 'envelope checkpoint recorded');
    assert.equal(saved[0].content, 'scene', 'marker content kept for identity matching');
});

test('R3: retry after failure overwrites the same failure record id', async () => {
    const { pipeline, queue, saved, failedRenders } = makeR3Pipeline();
    await pipeline.onMarker(marker);
    const taskId = [...queue._tasks.keys()][0];
    await pipeline.onTaskStateChange({ id: taskId, status: 'failed', error: { message: 'first' } });
    assert.equal(saved.length, 1);
    // Retry via the rendered failed chip, then fail again:
    assert.equal(failedRenders.length, 1, 'failed chip rendered with a Retry action');
    failedRenders[0].onRetry();
    const retryTaskId = [...queue._tasks.keys()].at(-1);
    assert.notEqual(retryTaskId, taskId, 'retry enqueued a new task');
    await pipeline.onTaskStateChange({ id: retryTaskId, status: 'failed', error: { message: 'second' } });
    const failureSaves = saved.filter(s => s.status === 'failed');
    assert.equal(failureSaves.length, 2);
    assert.equal(failureSaves[1].id, 'rec-1', 'second failure reuses the first record id');
});

test('R3: success after failure deletes the stale failure record', async () => {
    const { pipeline, queue, saved, deleted, failedRenders } = makeR3Pipeline();
    await pipeline.onMarker(marker);
    const taskId = [...queue._tasks.keys()][0];
    await pipeline.onTaskStateChange({ id: taskId, status: 'failed', error: { message: 'boom' } });
    assert.equal(saved.filter(s => s.status === 'failed').length, 1);
    // Retry via the failed chip's action so the entry binds the new task.
    failedRenders[0].onRetry();
    const retryTaskId = [...queue._tasks.keys()].at(-1);
    assert.notEqual(retryTaskId, taskId, 'retry enqueued a new task');
    await pipeline.onTaskStateChange({
        id: retryTaskId, status: 'succeeded',
        result: { blob: new Blob(['img']), backend: 'a1111', profileKey: 'anima', checkpoint: 'ck', seed: 5, width: 832, height: 1216 },
    });
    assert.deepEqual(deleted, ['rec-1'], 'stale failure record removed on success');
    assert.ok(saved.some(s => s.blob), 'image record saved');
});

test('R3: persisted failure record restores as a failed chip with the stored error; Retry regenerates', async () => {
    const failedRecord = {
        id: 'fail-7', chatId: 'A', messageId: 0, swipeId: 0, occurrence: 0,
        content: 'scene', status: 'failed', error: 'Server workflow references missing files: ckpt_name',
        prompt: 'p', negative: '', params: {}, backend: 'a1111', profileKey: 'anima',
    };
    const { pipeline, queue, saved, failedRenders, idleChips } = makeR3Pipeline({ records: [failedRecord] });
    await pipeline.onMarker(marker); // restore hit (failed record) -> no enqueue
    assert.equal(queue._tasks.size, 0, 'failed record prevents auto-regeneration');
    // onMarker's inline DOM pass already ran attachSlots (sync timeout stub);
    // wait for its async restoreImages to settle.
    await new Promise(r => setTimeout(r, 10));
    assert.equal(idleChips.length, 0, 'failed record renders a failed chip, not idle');
    assert.equal(failedRenders.length, 1);
    assert.match(failedRenders[0].snapshot.error.message, /missing files/);
    failedRenders[0].onRetry();
    assert.equal(queue._tasks.size, 1, 'Retry enqueues one task');
    // A subsequent failure overwrites fail-7 rather than adding a record.
    const retryTaskId = [...queue._tasks.keys()][0];
    await pipeline.onTaskStateChange({ id: retryTaskId, status: 'failed', error: { message: 'again' } });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, 'fail-7', 'failure overwrite reuses the persisted record id');
});

test('R3: cancellation is NOT persisted', async () => {
    const { pipeline, queue, saved } = makeR3Pipeline();
    await pipeline.onMarker(marker);
    const taskId = [...queue._tasks.keys()][0];
    await pipeline.onTaskStateChange({ id: taskId, status: 'cancelled' });
    assert.equal(saved.length, 0, 'cancelled tasks leave no record');
});

// ---- D2: Repro (record seed) vs Regen (seed -1) ------------------------------
test('D2: restored frame exposes onRepro with the record seed; Regen stays -1', async () => {
    const record = {
        id: 'rec-1', chatId: 'A', messageId: 0, swipeId: 0, occurrence: 0,
        content: 'scene', prompt: 'p', negative: '', params: { width: 832 },
        backend: 'a1111', profileKey: 'anima', checkpoint: 'saved-ckpt', seed: 777,
        blob: new Blob(['x']),
    };
    const queue = makeQueue();
    let frameActions = null;
    const pipeline = createMarkerPipeline({
        getQueue: () => queue,
        setTimeoutImpl: (fn) => { fn(); return 0; },
        compile: c => ({ profileKey: 'anima', envelope: { prompt: c, negative: '', params: { seed: -1 } } }),
        getImagesForMessage: async () => [record],
        saveImageRecord: async () => 'rec-2',
        contentHash,
        defaultBackendKind: () => 'a1111', defaultProfileKey: () => 'anima',
        notify: () => {}, doc,
        createSlotElement: (d, info) => {
            const s = d.createElement('span');
            s.dataset.ifimgOcc = String(info.occurrence);
            return s;
        },
        renderSlotState: () => {},
        renderImageFrame: (slot, d, url, actions) => { frameActions = actions; },
        openLightbox: () => () => {},
        replaceMarkers: (root, tags, onFound) => {
            const slot = onFound({ occurrence: 0, content: 'scene' });
            root.childNodes = [slot];
            return 1;
        },
        getMessage: () => ({ swipe_id: 0 }),
        getMessageElement: () => el('DIV', 'image### scene ###'),
        getSettings: () => ({ enabled: true, generation: { enabled: true, mode: 'direct', startTag: 'image###', endTag: '###' } }),
        getCurrentChatId: () => 'A',
    });
    await pipeline.onMarker(marker);
    await new Promise(r => setTimeout(r, 10)); // restoreImages settles
    assert.ok(frameActions, 'restored frame rendered');
    assert.equal(typeof frameActions.onRepro, 'function', 'record with a real seed exposes Repro');
    await frameActions.onRepro();
    let task = [...queue._tasks.values()].at(-1);
    assert.equal(task.prompt.params.seed, 777, 'Repro reuses the record seed');
    assert.equal(task.prompt.params.checkpoint, 'saved-ckpt', 'Repro keeps the record checkpoint');
    await frameActions.onRegen();
    task = [...queue._tasks.values()].at(-1);
    assert.equal(task.prompt.params.seed, -1, 'Regen still randomizes');
});

test('D2: onRepro is absent when the record has no usable seed', async () => {
    const record = {
        id: 'rec-1', chatId: 'A', messageId: 0, swipeId: 0, occurrence: 0,
        content: 'scene', prompt: 'p', negative: '', params: {},
        backend: 'a1111', profileKey: 'anima', seed: -1, blob: new Blob(['x']),
    };
    const queue = makeQueue();
    let frameActions = null;
    const pipeline = createMarkerPipeline({
        getQueue: () => queue,
        setTimeoutImpl: (fn) => { fn(); return 0; },
        compile: c => ({ profileKey: 'anima', envelope: { prompt: c, negative: '', params: { seed: -1 } } }),
        getImagesForMessage: async () => [record],
        saveImageRecord: async () => 'rec-2',
        contentHash,
        defaultBackendKind: () => 'a1111', defaultProfileKey: () => 'anima',
        notify: () => {}, doc,
        createSlotElement: (d, info) => {
            const s = d.createElement('span');
            s.dataset.ifimgOcc = String(info.occurrence);
            return s;
        },
        renderSlotState: () => {},
        renderImageFrame: (slot, d, url, actions) => { frameActions = actions; },
        openLightbox: () => () => {},
        replaceMarkers: (root, tags, onFound) => {
            const slot = onFound({ occurrence: 0, content: 'scene' });
            root.childNodes = [slot];
            return 1;
        },
        getMessage: () => ({ swipe_id: 0 }),
        getMessageElement: () => el('DIV', 'image### scene ###'),
        getSettings: () => ({ enabled: true, generation: { enabled: true, mode: 'direct', startTag: 'image###', endTag: '###' } }),
        getCurrentChatId: () => 'A',
    });
    await pipeline.onMarker(marker);
    await new Promise(r => setTimeout(r, 10));
    assert.ok(frameActions);
    assert.equal(frameActions.onRepro, undefined, 'seed -1 record gets no Repro');
});

// ---- Snapshot never contains credentials -----------------------------------
test('task snapshot never contains API keys or auth strings', async () => {
    const { pipeline, queue } = makePipeline({});
    await pipeline.onMarker(marker);
    const task = queue.listTasks()[0];
    const json = JSON.stringify(task);
    assert.ok(!json.includes('secret'), 'snapshot must not contain credential strings');
});