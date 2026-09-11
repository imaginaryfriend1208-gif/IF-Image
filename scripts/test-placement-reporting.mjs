#!/usr/bin/env node
// IF Image - honest-reporting contract for chat image placement.
//
// Regression guard for the "Placed 1 image" bug: appending text to
// chat[i].mes is only the FIRST of four steps, and saving, re-rendering and
// emitting can each fail on their own. Reporting success off the injection
// count alone told users an image was placed when nothing was generated.
//
// Every test below asserts that a partial failure is REPORTED, not swallowed.
// Run: node scripts/test-placement-reporting.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPlacements, undoPlacements } from '../src/llm/inject.js';

const mkChat = (...texts) => texts.map(t => ({ mes: t }));
const quiet = { warn: () => {} };

/** Host with every hook working. Individual tests break one hook at a time. */
function makeHost(chat, over = {}) {
    return {
        chat,
        saveChat: () => {},
        updateMessageBlock: () => {},
        emit: () => {},
        logger: quiet,
        ...over,
    };
}

// ---------------------------------------------------------------- render --

test('rendered counts only redraws that actually completed', () => {
    const chat = mkChat('a', 'b');
    const res = applyPlacements(
        [{ messageId: 0, prompt: 'x' }, { messageId: 1, prompt: 'y' }],
        makeHost(chat, {
            updateMessageBlock: (id) => { if (id === 0) throw new Error('boom'); },
        }),
    );
    assert.equal(res.touched.length, 2);
    assert.equal(res.rendered, 1, 'the throwing redraw must not be counted');
    assert.deepEqual(res.renderedIds, [1]);
});

test('a host without updateMessageBlock reports zero renders, not silent success', () => {
    const chat = mkChat('a');
    const res = applyPlacements([{ messageId: 0, prompt: 'x' }],
        makeHost(chat, { updateMessageBlock: undefined }));
    assert.equal(res.touched.length, 1);
    assert.equal(res.rendered, 0, 'touched > rendered is the signal the banner needs');
    assert.deepEqual(res.renderedIds, []);
});

test('a fully working host reports touched === rendered', () => {
    const chat = mkChat('a', 'b');
    const res = applyPlacements(
        [{ messageId: 0, prompt: 'x' }, { messageId: 1, prompt: 'y' }],
        makeHost(chat),
    );
    assert.equal(res.touched.length, 2);
    assert.equal(res.rendered, 2);
});

// ------------------------------------------------------------------ save --

test('a failing saveChat is reported as saved:false', () => {
    const chat = mkChat('a');
    const res = applyPlacements([{ messageId: 0, prompt: 'x' }],
        makeHost(chat, { saveChat: () => { throw new Error('disk'); } }));
    assert.equal(res.saved, false, 'markers would vanish on reload — must be visible');
    assert.equal(res.touched.length, 1, 'a save failure must not undo the injection');
});

test('a working saveChat reports saved:true, an absent one reports null', () => {
    assert.equal(applyPlacements([{ messageId: 0, prompt: 'x' }],
        makeHost(mkChat('a'))).saved, true);
    assert.equal(applyPlacements([{ messageId: 0, prompt: 'x' }],
        makeHost(mkChat('a'), { saveChat: undefined })).saved, null,
    'null distinguishes "no host support" from "tried and failed"');
});

// ------------------------------------------------------------------ emit --

test('a throwing listener cannot abort the run or hide the other emits', () => {
    const chat = mkChat('a', 'b');
    let res;
    assert.doesNotThrow(() => {
        res = applyPlacements(
            [{ messageId: 0, prompt: 'x' }, { messageId: 1, prompt: 'y' }],
            makeHost(chat, { emit: (id) => { if (id === 1) throw new Error('listener'); } }),
        );
    }, 'one bad listener must not turn a partial success into a thrown failure');
    assert.equal(res.touched.length, 2);
    assert.deepEqual(res.emitted, [0]);
});

// ----------------------------------------------------------- empty prompt --

test('an empty prompt is skipped instead of building an empty marker', () => {
    const chat = mkChat('a', 'b');
    const res = applyPlacements(
        [{ messageId: 0, prompt: '   ' }, { messageId: 1, prompt: 'real' }],
        makeHost(chat),
    );
    assert.deepEqual(res.skippedEmpty, [0]);
    assert.deepEqual(res.touched, [1]);
    assert.equal(chat[0].mes, 'a', 'the message must be left untouched');
    assert.ok(chat[1].mes.includes('real'));
});

test('a prompt that is only the end tag collapses to empty and is skipped', () => {
    const chat = mkChat('a');
    const res = applyPlacements([{ messageId: 0, prompt: '###' }], makeHost(chat));
    assert.deepEqual(res.skippedEmpty, [0]);
    assert.equal(chat[0].mes, 'a');
});

// ---------------------------------------------------------------- nothing --

test('no valid placement yields a fully zeroed, still well-formed result', () => {
    const res = applyPlacements([{ messageId: 99, prompt: 'x' }], makeHost(mkChat('a')));
    assert.deepEqual(res.touched, []);
    assert.equal(res.rendered, 0);
    assert.deepEqual(res.emitted, []);
    assert.equal(res.saved, null, 'nothing changed, so nothing was saved');
});

test('empty and non-array input never throws', () => {
    for (const input of [[], null, undefined, 'nope']) {
        const res = applyPlacements(input, makeHost(mkChat('a')));
        assert.deepEqual(res.touched, [], String(input));
        assert.deepEqual(res.skippedEmpty, [], String(input));
    }
});

test('touchedIds exclude duplicates so the banner cannot point at a skipped message', () => {
    const chat = mkChat('a', 'b');
    const res = applyPlacements(
        [{ messageId: 1, prompt: 'first' }, { messageId: 1, prompt: 'second' }],
        makeHost(chat),
    );
    assert.deepEqual(res.touched, [1], 'one message, one marker');
    assert.equal(res.touched.length, 1);
});

// ------------------------------------------------------------------ undo --

test('undo reports unrendered messages — stale marker text stays on screen', () => {
    const chat = mkChat('a\nimage### x ###');
    const res = undoPlacements([{ messageId: 0, prevMes: 'a' }],
        makeHost(chat, { updateMessageBlock: undefined }));
    assert.deepEqual(res.restored, [0]);
    assert.equal(res.rendered, 0, 'the user must be told the undo is not visible yet');
    assert.equal(chat[0].mes, 'a');
});

test('undo reports a failed save', () => {
    const chat = mkChat('a\nimage### x ###');
    const res = undoPlacements([{ messageId: 0, prevMes: 'a' }],
        makeHost(chat, { saveChat: () => { throw new Error('disk'); } }));
    assert.equal(res.saved, false);
    assert.deepEqual(res.restored, [0]);
});

test('undo of nothing is a clean no-op', () => {
    const res = undoPlacements([], makeHost(mkChat('a')));
    assert.deepEqual(res.restored, []);
    assert.equal(res.rendered, 0);
    assert.equal(res.saved, null);
});

test('a throwing listener cannot abort an undo', () => {
    const chat = mkChat('a\nimage### x ###', 'b\nimage### y ###');
    let res;
    assert.doesNotThrow(() => {
        res = undoPlacements(
            [{ messageId: 0, prevMes: 'a' }, { messageId: 1, prevMes: 'b' }],
            makeHost(chat, { emit: (id) => { if (id === 0) throw new Error('listener'); } }),
        );
    });
    assert.deepEqual(res.restored, [0, 1]);
    assert.deepEqual(res.emitted, [1]);
});
