// IF Image - Unit tests for src/llm/inject.js.
// The regression these guard: the marker runtime detects markers by walking
// the message DOM, so writing chat[i].mes and emitting MESSAGE_UPDATED is
// not enough — the message block must be re-rendered FIRST, or the marker
// is never seen and no image is generated.
// Run: node scripts/test-llm-inject.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMarker, applyPlacements, undoPlacements } from '../src/llm/inject.js';

/** Records the order of saveChat / render / emit calls. */
function makeHost(chat) {
    const order = [];
    return {
        chat,
        order,
        saveChat: () => order.push('save'),
        updateMessageBlock: (id) => order.push(`render:${id}`),
        emit: (id) => order.push(`emit:${id}`),
        logger: { warn: () => {} },
    };
}

const mkChat = (...texts) => texts.map(t => ({ mes: t }));

// ------------------------------------------------------------------
// buildMarker
// ------------------------------------------------------------------
test('buildMarker: direct mode wraps in the configured tags', () => {
    assert.equal(buildMarker('a girl', { mode: 'direct' }), 'image### a girl ###');
});

test('buildMarker: custom tags are honoured', () => {
    assert.equal(
        buildMarker('a girl', { mode: 'direct', startTag: '<img>', endTag: '</img>' }),
        '<img> a girl </img>',
    );
});

test('buildMarker: assist and full modes emit an ifimage block', () => {
    assert.equal(buildMarker('a girl', { mode: 'assist' }), '<ifimage>a girl</ifimage>');
    assert.equal(buildMarker('a girl', { mode: 'full' }), '<ifimage>a girl</ifimage>');
});

test('buildMarker: an end tag inside the prompt cannot truncate the marker', () => {
    const marker = buildMarker('a girl ### holding ### a book', { mode: 'direct' });
    // Exactly one closing tag, at the end.
    assert.equal(marker.match(/###/g).length, 2); // the start tag ends in ###, plus the end tag
    assert.ok(marker.endsWith('###'));
    assert.ok(!marker.slice(0, -3).includes('###', 'image###'.length));
});

// ------------------------------------------------------------------
// applyPlacements — ordering
// ------------------------------------------------------------------
test('applyPlacements: re-renders the message BEFORE emitting the event', () => {
    const host = makeHost(mkChat('first', 'second'));
    applyPlacements([{ messageId: 1, prompt: 'a girl' }], host);
    assert.deepEqual(host.order, ['save', 'render:1', 'emit:1']);
    assert.ok(host.order.indexOf('render:1') < host.order.indexOf('emit:1'));
});

test('applyPlacements: appends the marker to the message text', () => {
    const chat = mkChat('She closed the door.');
    applyPlacements([{ messageId: 0, prompt: '1girl, closing door' }], makeHost(chat));
    assert.equal(chat[0].mes, 'She closed the door.\nimage### 1girl, closing door ###');
});

test('applyPlacements: no blank line when the message already ends in whitespace', () => {
    const chat = mkChat('She closed the door.\n');
    applyPlacements([{ messageId: 0, prompt: 'x' }], makeHost(chat));
    assert.equal(chat[0].mes, 'She closed the door.\nimage### x ###');
});

test('applyPlacements: assist mode injects an ifimage block', () => {
    const chat = mkChat('text');
    applyPlacements([{ messageId: 0, prompt: 'a girl' }], { ...makeHost(chat), mode: 'assist' });
    assert.ok(chat[0].mes.endsWith('<ifimage>a girl</ifimage>'));
});

test('applyPlacements: one marker per message, duplicates dropped', () => {
    const chat = mkChat('a', 'b');
    const { touched } = applyPlacements([
        { messageId: 1, prompt: 'first' },
        { messageId: 1, prompt: 'second' },
    ], makeHost(chat));
    assert.deepEqual(touched, [1]);
    assert.equal(chat[1].mes.match(/image###/g).length, 1);
});

test('applyPlacements: every touched message is rendered and emitted', () => {
    const host = makeHost(mkChat('a', 'b', 'c'));
    const { touched, rendered } = applyPlacements([
        { messageId: 0, prompt: 'p0' },
        { messageId: 2, prompt: 'p2' },
    ], host);
    assert.equal(touched.length, 2);
    assert.equal(rendered, 2);
    for (const id of touched) {
        assert.ok(host.order.includes(`render:${id}`));
        assert.ok(host.order.includes(`emit:${id}`));
    }
});

test('applyPlacements: a missing message is skipped, not injected out of range', () => {
    const chat = mkChat('a');
    const { touched } = applyPlacements([{ messageId: 9, prompt: 'x' }], makeHost(chat));
    assert.deepEqual(touched, []);
    assert.equal(chat.length, 1);
});

test('applyPlacements: nothing to place means no save, render, or emit', () => {
    const host = makeHost(mkChat('a'));
    const { touched, rendered } = applyPlacements([], host);
    assert.deepEqual(touched, []);
    assert.equal(rendered, 0);
    assert.deepEqual(host.order, []);
});

// ------------------------------------------------------------------
// applyPlacements — degraded hosts
// ------------------------------------------------------------------
test('applyPlacements: a host without updateMessageBlock still saves and emits', () => {
    const chat = mkChat('a');
    const order = [];
    const warnings = [];
    const { touched, rendered } = applyPlacements([{ messageId: 0, prompt: 'x' }], {
        chat,
        saveChat: () => order.push('save'),
        updateMessageBlock: undefined,
        emit: (id) => order.push(`emit:${id}`),
        logger: { warn: (m) => warnings.push(m) },
    });
    assert.deepEqual(touched, [0]);
    assert.equal(rendered, 0);
    assert.deepEqual(order, ['save', 'emit:0']);
    // The user must be told detection may not fire.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /re-rendered/i);
});

test('applyPlacements: a throwing renderer does not stop the remaining work', () => {
    const chat = mkChat('a', 'b');
    const order = [];
    const { touched } = applyPlacements([
        { messageId: 0, prompt: 'p0' },
        { messageId: 1, prompt: 'p1' },
    ], {
        chat,
        saveChat: () => order.push('save'),
        updateMessageBlock: (id) => { if (id === 0) throw new Error('render boom'); order.push(`render:${id}`); },
        emit: (id) => order.push(`emit:${id}`),
        logger: { warn: () => {} },
    });
    assert.equal(touched.length, 2);
    assert.ok(order.includes('emit:0'));
    assert.ok(order.includes('emit:1'));
});

test('applyPlacements: a throwing saveChat still renders and emits', () => {
    const chat = mkChat('a');
    const order = [];
    applyPlacements([{ messageId: 0, prompt: 'x' }], {
        chat,
        saveChat: () => { throw new Error('disk full'); },
        updateMessageBlock: (id) => order.push(`render:${id}`),
        emit: (id) => order.push(`emit:${id}`),
        logger: { warn: () => {} },
    });
    assert.deepEqual(order, ['render:0', 'emit:0']);
});

// ------------------------------------------------------------------
// undoPlacements
// ------------------------------------------------------------------
test('undoPlacements: restores text and re-renders before emitting', () => {
    const chat = mkChat('original');
    applyPlacements([{ messageId: 0, prompt: 'x' }], makeHost(chat));
    assert.notEqual(chat[0].mes, 'original');

    const host = makeHost(chat);
    const { restored } = undoPlacements([{ messageId: 0, prevMes: 'original' }], host);
    assert.deepEqual(restored, [0]);
    assert.equal(chat[0].mes, 'original');
    assert.deepEqual(host.order, ['save', 'render:0', 'emit:0']);
});

test('undoPlacements: an empty snapshot list is a no-op', () => {
    const host = makeHost(mkChat('a'));
    const { restored, rendered } = undoPlacements([], host);
    assert.deepEqual(restored, []);
    assert.equal(rendered, 0);
    assert.deepEqual(host.order, []);
});

test('undoPlacements: a message deleted since the snapshot is skipped', () => {
    const host = makeHost(mkChat('a'));
    const { restored } = undoPlacements([{ messageId: 5, prevMes: 'gone' }], host);
    assert.deepEqual(restored, []);
    assert.deepEqual(host.order, []);
});
