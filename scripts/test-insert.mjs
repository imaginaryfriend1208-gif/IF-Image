#!/usr/bin/env node
// Offline insert tests: a hand-built minimal DOM (same philosophy as
// test-events.mjs, extended with the mutation methods insert.js needs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderedSegments, extractMarkers } from '../src/runtime/events.js';
import { replaceMarkers, createSlotElement, renderSlotState, renderImageFrame, renderRegenerateChip, renderIdleChip, openLightbox, contentHash } from '../src/runtime/insert.js';

// ---- Minimal DOM stub ----------------------------------------------------
class Node {
    constructor() { this.parentNode = null; }
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
}
class Text extends Node {
    constructor(value) { super(); this.nodeType = 3; this.nodeValue = value; }
    splitText(offset) {
        const tail = new Text(this.nodeValue.slice(offset));
        this.nodeValue = this.nodeValue.slice(0, offset);
        const list = this.parentNode.childNodes;
        list.splice(list.indexOf(this) + 1, 0, tail);
        tail.parentNode = this.parentNode;
        return tail;
    }
}
class Element extends Node {
    constructor(tagName) {
        super();
        this.nodeType = 1; this.tagName = tagName; this.childNodes = []; this.attributes = {};
        this.dataset = {}; this.className = ''; this.listeners = {};
    }
    get firstChild() { return this.childNodes[0] ?? null; }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    removeAttribute(k) { delete this.attributes[k]; }
    appendChild(node) { node.remove(); node.parentNode = this; this.childNodes.push(node); return node; }
    removeChild(node) { node.remove(); return node; }
    insertBefore(node, ref) {
        node.remove();
        node.parentNode = this;
        const idx = ref ? this.childNodes.indexOf(ref) : -1;
        if (idx < 0) this.childNodes.push(node); else this.childNodes.splice(idx, 0, node);
        return node;
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    // Handlers may call stopPropagation() (C10 overlay buttons); the stub has
    // no bubbling, so it records the call instead. Returns the event for
    // assertions.
    dispatch(type) {
        const event = { propagationStopped: false, stopPropagation() { this.propagationStopped = true; } };
        for (const fn of this.listeners[type] || []) fn(event);
        return event;
    }
    set textContent(v) { this.childNodes = []; if (v) this.appendChild(new Text(v)); }
    get textContent() { return this.childNodes.map(c => c.nodeType === 3 ? c.nodeValue : c.textContent).join(''); }
}
const doc = { createElement: tag => new Element(tag.toUpperCase()) };

// D1: lightbox needs a document with body, doc-level key listeners, and
// URL.createObjectURL/revokeObjectURL. The URL stub records every call so
// tests can assert full revocation.
function makeLightboxEnv() {
    const body = new Element('BODY');
    const docListeners = {};
    const ldoc = {
        body,
        createElement: tag => new Element(tag.toUpperCase()),
        addEventListener: (type, fn) => { (docListeners[type] ??= []).push(fn); },
        removeEventListener: (type, fn) => {
            const list = docListeners[type] || [];
            const idx = list.indexOf(fn);
            if (idx >= 0) list.splice(idx, 1);
        },
        pressKey: key => { for (const fn of [...(docListeners.keydown || [])]) fn({ key }); },
    };
    const created = [];
    const revoked = [];
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    let seq = 0;
    URL.createObjectURL = () => { const u = `blob:stub-${++seq}`; created.push(u); return u; };
    URL.revokeObjectURL = (u) => { revoked.push(u); };
    const restore = () => {
        URL.createObjectURL = realCreate;
        URL.revokeObjectURL = realRevoke;
    };
    return { ldoc, body, created, revoked, restore };
}

const lbRecord = (id, seed = 1) => ({
    id, seed, checkpoint: `ckpt-${id}`, width: 832, height: 1216,
    profileKey: 'anima', blob: { fake: true, name: id },
});
const captionOf = body => {
    const overlay = body.childNodes[0];
    const inner = overlay.childNodes[0];
    return inner.childNodes.find(c => c.className === 'ifimg-lb-caption');
};
const lbButton = (body, cls) => {
    const inner = body.childNodes[0].childNodes[0];
    const all = [];
    (function walk(n) { for (const c of n.childNodes || []) { all.push(c); walk(c); } })(inner);
    return all.find(c => typeof c.className === 'string' && c.className.includes(cls)) ?? null;
};
const el = (tag, ...children) => {
    const e = new Element(tag);
    for (const c of children) e.appendChild(typeof c === 'string' ? new Text(c) : c);
    return e;
};
const marker = v => `image### ${v} ###`;
const tags = { startTag: 'image###', endTag: '###' };

function run(root) {
    const found = [];
    const n = replaceMarkers(root, tags, info => {
        found.push(info);
        return createSlotElement(doc, info);
    });
    return { n, found };
}
const slotsOf = root => root.childNodes.filter(c => c.nodeType === 1 && c.className === 'ifimg-slot');

// ---- Tests -----------------------------------------------------------------

test('single marker in one text node: text before/after preserved', () => {
    const root = el('DIV', `before ${marker('a')} after`);
    const { n, found } = run(root);
    assert.equal(n, 1);
    assert.deepEqual(found, [{ occurrence: 0, content: 'a' }]);
    assert.equal(root.childNodes[0].nodeValue, 'before ');
    assert.equal(root.childNodes[1].className, 'ifimg-slot');
    assert.equal(root.childNodes[2].nodeValue, ' after');
    assert.equal(renderedSegments(root).join(''), 'before  after'); // slot is aria-hidden
});

test('marker spanning two inline text nodes is removed as one range', () => {
    const root = el('DIV', 'x image### sp', el('SPAN', 'lit ###'), ' y');
    const { n, found } = run(root);
    assert.equal(n, 1);
    // Eligible text = "x image### split ### y"; the marker content ("split")
    // spans the DIV/SPAN boundary and the whole range is removed as one.
    assert.equal(found[0].content, 'split');
    assert.equal(root.childNodes[0].nodeValue, 'x ');
    assert.equal(root.childNodes[1].className, 'ifimg-slot');
    // Remaining text is "x " + " y" = "x  y" (the slot is aria-hidden).
    assert.equal(renderedSegments(root).join(''), 'x  y');
});

test('marker spanning a BR keeps outer text', () => {
    const root = el('DIV', 'a image### one', el('BR'), 'two ### b');
    const { n, found } = run(root);
    assert.equal(n, 1);
    assert.equal(found[0].content, 'one\ntwo');
    assert.equal(renderedSegments(root).join(''), 'a  b');
});

test('multiple markers replaced in one pass with detection-order occurrences', () => {
    const root = el('DIV', el('P', `${marker('a')} mid ${marker('b')}`), el('P', marker('c')));
    const before = renderedSegments(root).flatMap(s => extractMarkers(s, tags)).map(m => m.content);
    assert.deepEqual(before, ['a', 'b', 'c']);
    const { n, found } = run(root);
    assert.equal(n, 3);
    assert.deepEqual(found.map(f => [f.occurrence, f.content]).sort((x, y) => x[0] - y[0]), [[0, 'a'], [1, 'b'], [2, 'c']]);
    assert.deepEqual(renderedSegments(root).flatMap(s => extractMarkers(s, tags)), []);
    const p1 = root.childNodes[0];
    assert.equal(p1.childNodes.filter(c => c.className === 'ifimg-slot').map(c => c.dataset.ifimgOcc).join(','), '0,1');
});

test('skip-list respected: marker inside CODE untouched, sibling marker replaced', () => {
    const code = el('CODE', marker('forbidden'));
    const root = el('DIV', el('PRE', code), marker('visible'));
    const { n, found } = run(root);
    assert.equal(n, 1);
    assert.equal(found[0].content, 'visible');
    assert.equal(code.childNodes[0].nodeValue, marker('forbidden'));
});

test('block boundaries do not form synthetic markers', () => {
    const root = el('DIV', el('P', 'image### a'), el('P', 'b ###'));
    assert.equal(run(root).n, 0);
});

test('re-running over already processed DOM is a no-op (slots are aria-hidden)', () => {
    const root = el('DIV', marker('a'));
    assert.equal(run(root).n, 1);
    assert.equal(run(root).n, 0);
    assert.equal(slotsOf(root).length, 1);
    assert.equal(slotsOf(root)[0].dataset.ifimgProcessed, 'true');
});

test('slot element identity: occurrence + content hash', () => {
    const slot = createSlotElement(doc, { occurrence: 3, content: 'hello' });
    assert.equal(slot.getAttribute('aria-hidden'), 'true');
    assert.equal(slot.dataset.ifimgOcc, '3');
    assert.equal(slot.dataset.ifimgHash, contentHash('hello'));
    assert.notEqual(contentHash('hello'), contentHash('hellp'));
});

test('state transitions render expected slot content', () => {
    const slot = createSlotElement(doc, { occurrence: 0, content: 'a' });
    renderSlotState(slot, { status: 'queued' }, doc);
    assert.equal(slot.dataset.ifimgState, 'queued');
    assert.equal(slot.childNodes[0].className, 'ifimg-spinner');
    renderSlotState(slot, { status: 'running' }, doc);
    assert.equal(slot.dataset.ifimgState, 'running');
    let retried = 0;
    renderSlotState(slot, { status: 'failed', error: { message: 'boom' } }, doc, { onRetry: () => retried++ });
    assert.equal(slot.childNodes[0].className, 'ifimg-chip ifimg-chip-failed');
    assert.match(slot.childNodes[0].textContent, /boom/);
    slot.childNodes[1].dispatch('click');
    assert.equal(retried, 1);
    renderSlotState(slot, { status: 'cancelled' }, doc);
    assert.equal(slot.childNodes.length, 1);
    assert.equal(slot.childNodes[0].textContent, 'Cancelled');
    const frame = renderImageFrame(slot, doc, 'blob:x');
    assert.equal(slot.dataset.ifimgState, 'succeeded');
    assert.equal(frame.childNodes[0].src, 'blob:x');
});

test('300ms click disambiguation: single vs double', async () => {
    const slot = createSlotElement(doc, { occurrence: 0, content: 'a' });
    const events = [];
    const frame = renderImageFrame(slot, doc, 'blob:x', {
        onSingleClick: () => events.push('single'),
        onDoubleClick: () => events.push('double'),
    });
    frame.dispatch('click');
    frame.dispatch('click');
    assert.deepEqual(events, ['double']);
    frame.dispatch('click');
    await new Promise(r => setTimeout(r, 350));
    assert.deepEqual(events, ['double', 'single']);
});

test('failed slot error message never leaks credentials passed through snapshot fields', () => {
    const slot = createSlotElement(doc, { occurrence: 0, content: 'a' });
    renderSlotState(slot, { status: 'failed', error: { message: 'HTTP 401 from proxy' }, backend: { kind: 'comfy' } }, doc);
    assert.ok(!slot.textContent.includes('Basic '));
});

// ---- C10: hover overlay + regenerate chip ---------------------------------

const overlayOf = frame => frame.childNodes.find(c => c.className === 'if-image-frame-overlay') ?? null;
const overlayBtn = (frame, label) => overlayOf(frame)?.childNodes.find(b => b.textContent === label) ?? null;

test('C10 overlay: View/Regen/Delete buttons render only for supplied actions', () => {
    const slot = createSlotElement(doc, { occurrence: 0, content: 'a' });
    const frame = renderImageFrame(slot, doc, 'blob:x', {
        onView: () => {}, onRegen: () => {}, onDelete: () => {},
    });
    const overlay = overlayOf(frame);
    assert.ok(overlay, 'overlay div present');
    assert.deepEqual(overlay.childNodes.map(b => b.textContent), ['View', 'Regen', 'Delete']);
    // No overlay actions supplied -> no overlay at all (pre-C10 shape preserved).
    const slot2 = createSlotElement(doc, { occurrence: 1, content: 'b' });
    const frame2 = renderImageFrame(slot2, doc, 'blob:y', { onSingleClick: () => {} });
    assert.equal(overlayOf(frame2), null);
});

test('C10 overlay: View fires only onView, never regen, and stops propagation', async () => {
    const slot = createSlotElement(doc, { occurrence: 0, content: 'a' });
    const events = [];
    const frame = renderImageFrame(slot, doc, 'blob:x', {
        onSingleClick: () => events.push('lightbox'),
        onDoubleClick: () => events.push('dblclick-regen'),
        onView: () => events.push('view'),
        onRegen: () => events.push('regen'),
        onDelete: () => events.push('delete'),
    });
    const event = overlayBtn(frame, 'View').dispatch('click');
    assert.ok(event.propagationStopped, 'button click stops propagation');
    await new Promise(r => setTimeout(r, 350)); // outlive the 300ms single-click timer
    assert.deepEqual(events, ['view']);
});

// ---- R3: idle chip + aria-hidden visibility ---------------------------------

test('R3: idle chip renders label + Generate; button fires exactly once per click', () => {
    const slot = createSlotElement(doc, { occurrence: 0, content: 'a' });
    let generated = 0;
    const chip = renderIdleChip(slot, doc, { onGenerate: () => generated++ });
    assert.equal(slot.dataset.ifimgState, 'idle');
    assert.equal(chip.className, 'ifimg-chip ifimg-chip-idle');
    assert.equal(chip.textContent, 'Image not generated');
    const btn = slot.childNodes[1];
    assert.equal(btn.textContent, 'Generate');
    btn.dispatch('click');
    assert.equal(generated, 1);
    btn.dispatch('click');
    assert.equal(generated, 2);
    // Without onGenerate: chip only, no button; custom label honored.
    const slot2 = createSlotElement(doc, { occurrence: 1, content: 'b' });
    renderIdleChip(slot2, doc, { label: 'custom' });
    assert.equal(slot2.childNodes.length, 1);
    assert.equal(slot2.childNodes[0].textContent, 'custom');
});

test('R3: aria-hidden removed for visible content, restored for spinner states', () => {
    const slot = createSlotElement(doc, { occurrence: 0, content: 'a' });
    assert.equal(slot.getAttribute('aria-hidden'), 'true', 'slots start hidden');
    renderSlotState(slot, { status: 'queued' }, doc);
    assert.equal(slot.getAttribute('aria-hidden'), 'true', 'spinner stays hidden');
    renderSlotState(slot, { status: 'failed', error: { message: 'x' } }, doc);
    assert.equal(slot.getAttribute('aria-hidden'), null, 'failed chip is visible');
    renderSlotState(slot, { status: 'running' }, doc);
    assert.equal(slot.getAttribute('aria-hidden'), 'true', 'retry spinner hides again');
    renderIdleChip(slot, doc, {});
    assert.equal(slot.getAttribute('aria-hidden'), null, 'idle chip is visible');
    renderImageFrame(slot, doc, 'blob:x');
    assert.equal(slot.getAttribute('aria-hidden'), null, 'image frame is visible');
    renderRegenerateChip(slot, doc, () => {});
    assert.equal(slot.getAttribute('aria-hidden'), null, 'regenerate chip is visible');
});

// ---- D1: full lightbox ------------------------------------------------------

test('D1: prev/next and arrow keys wrap around; caption tracks the record', () => {
    const { ldoc, body, restore } = makeLightboxEnv();
    try {
        const close = openLightbox(ldoc, { records: [lbRecord('a'), lbRecord('b'), lbRecord('c')] });
        assert.match(captionOf(body).textContent, /ckpt-a/);
        assert.match(captionOf(body).textContent, /1\/3/);
        lbButton(body, 'ifimg-lb-next').dispatch('click');
        assert.match(captionOf(body).textContent, /ckpt-b/);
        ldoc.pressKey('ArrowRight');
        assert.match(captionOf(body).textContent, /ckpt-c/);
        ldoc.pressKey('ArrowRight'); // wraps to first
        assert.match(captionOf(body).textContent, /ckpt-a/);
        ldoc.pressKey('ArrowLeft'); // wraps back to last
        assert.match(captionOf(body).textContent, /ckpt-c/);
        close();
    } finally { restore(); }
});

test('D1: Escape and backdrop close; clicking the content does not', () => {
    const { ldoc, body, restore } = makeLightboxEnv();
    try {
        openLightbox(ldoc, { records: [lbRecord('a')] });
        const overlay = body.childNodes[0];
        const inner = overlay.childNodes[0];
        inner.dispatch('click'); // stopPropagation → still open
        assert.equal(body.childNodes.length, 1, 'content click keeps the lightbox open');
        ldoc.pressKey('Escape');
        assert.equal(body.childNodes.length, 0, 'Escape closes');
        openLightbox(ldoc, { records: [lbRecord('b')] });
        body.childNodes[0].dispatch('click'); // backdrop
        assert.equal(body.childNodes.length, 0, 'backdrop click closes');
    } finally { restore(); }
});

test('D1: delete middle record shows the next; deleting the last closes', async () => {
    const { ldoc, body, restore } = makeLightboxEnv();
    try {
        const deleted = [];
        openLightbox(ldoc, {
            records: [lbRecord('a'), lbRecord('b'), lbRecord('c')],
            index: 1, // start on 'b'
            onDelete: (r) => { deleted.push(r.id); },
        });
        const del = lbButton(body, 'ifimg-lb-delete');
        del.dispatch('click');
        await new Promise(r => setTimeout(r, 0));
        assert.deepEqual(deleted, ['b']);
        assert.match(captionOf(body).textContent, /ckpt-c/, 'next record shown after delete');
        del.dispatch('click');
        await new Promise(r => setTimeout(r, 0));
        assert.match(captionOf(body).textContent, /ckpt-a/, 'delete on last index wraps to first');
        del.dispatch('click');
        await new Promise(r => setTimeout(r, 0));
        assert.equal(body.childNodes.length, 0, 'deleting the final record closes the lightbox');
        assert.deepEqual(deleted, ['b', 'c', 'a']);
    } finally { restore(); }
});

test('D1: every object URL created by the lightbox is revoked on nav and close', () => {
    const { ldoc, created, revoked, restore } = makeLightboxEnv();
    try {
        const close = openLightbox(ldoc, { records: [lbRecord('a'), lbRecord('b')] });
        ldoc.pressKey('ArrowRight');
        ldoc.pressKey('ArrowRight');
        close();
        assert.ok(created.length >= 6, 'display+download URL per shown record');
        assert.deepEqual([...revoked].sort(), [...created].sort(), 'all created URLs revoked');
    } finally { restore(); }
});

test('D1: caller-supplied getObjectUrl is used and never revoked; Regen closes', () => {
    const { ldoc, body, created, revoked, restore } = makeLightboxEnv();
    try {
        let regen = 0;
        openLightbox(ldoc, {
            records: [lbRecord('a')],
            getObjectUrl: () => 'blob:caller-owned',
            onRegenerate: () => { regen += 1; },
        });
        lbButton(body, 'ifimg-lb-regen').dispatch('click');
        assert.equal(regen, 1);
        assert.equal(body.childNodes.length, 0, 'Regen closes the lightbox');
        assert.ok(!revoked.includes('blob:caller-owned'), 'caller URL never revoked');
        assert.deepEqual([...revoked].sort(), [...created].sort(), 'owned URLs still revoked');
    } finally { restore(); }
});

test('D1: opening a second lightbox closes the first', () => {
    const { ldoc, body, restore } = makeLightboxEnv();
    try {
        openLightbox(ldoc, { records: [lbRecord('a')] });
        openLightbox(ldoc, { records: [lbRecord('b')] });
        assert.equal(body.childNodes.length, 1, 'only one overlay in the DOM');
        assert.match(captionOf(body).textContent, /ckpt-b/);
        ldoc.pressKey('Escape');
        assert.equal(body.childNodes.length, 0);
    } finally { restore(); }
});

test('C10 overlay: Delete fires onDelete; caller collapses slot to a regenerate chip', () => {
    const slot = createSlotElement(doc, { occurrence: 0, content: 'a' });
    let regenerated = 0;
    const frame = renderImageFrame(slot, doc, 'blob:x', {
        onDelete: () => renderRegenerateChip(slot, doc, () => regenerated++),
    });
    overlayBtn(frame, 'Delete').dispatch('click');
    assert.equal(slot.dataset.ifimgState, 'idle');
    assert.equal(slot.childNodes[0].className, 'ifimg-chip ifimg-chip-regenerate');
    assert.equal(slot.childNodes[0].textContent, 'Image deleted');
    slot.childNodes[1].dispatch('click');
    assert.equal(regenerated, 1);
});
