#!/usr/bin/env node
// IF Image - roster sync POLICY (not transport).
//
// The whole point of this module is that a sync can destroy a roster, so the
// tests below are mostly about what must NOT happen. Anything that could
// replace records with nothing has to be refused by default.
//
// Run: node scripts/test-roster-sync.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    COLLECTIONS, countRecords, isEmpty, decideSync, canPush, canPull,
    pickCollections, summarize, describe, shouldMigrate,
} from '../src/storage/roster-sync.js';

const full = () => ({
    characters: [{ id: 'c1' }, { id: 'c2' }],
    outfits: [{ id: 'o1' }],
    styles: [],
    personas: [{ id: 'p1' }],
    replaceRules: [],
});
const empty = () => ({ characters: [], outfits: [], styles: [], personas: [], replaceRules: [] });

// --------------------------------------------------------------- counting --

test('countRecords sums every collection', () => {
    assert.equal(countRecords(full()), 4);
    assert.equal(countRecords(empty()), 0);
});

test('countRecords tolerates missing, null, and non-array collections', () => {
    assert.equal(countRecords({}), 0);
    assert.equal(countRecords(null), 0);
    assert.equal(countRecords(undefined), 0);
    assert.equal(countRecords({ characters: 'nope', outfits: null }), 0);
});

test('countRecords ignores collections outside the syncable set', () => {
    assert.equal(countRecords({ ...empty(), images: [{ id: 'i1' }] }), 0);
});

test('isEmpty agrees with countRecords', () => {
    assert.equal(isEmpty(empty()), true);
    assert.equal(isEmpty(full()), false);
    assert.equal(isEmpty(null), true);
});

// ---------------------------------------------------------------- decide ---

test('no server file and local records means push', () => {
    const d = decideSync(full(), null);
    assert.equal(d.action, 'push');
    assert.equal(d.localCount, 4);
    assert.equal(d.remoteCount, 0);
});

test('no server file and nothing local means noop, not a pointless upload', () => {
    assert.equal(decideSync(empty(), null).action, 'noop');
    assert.equal(decideSync(empty(), undefined).action, 'noop');
});

test('empty local with a populated server means pull', () => {
    const d = decideSync(empty(), full());
    assert.equal(d.action, 'pull');
    assert.equal(d.remoteCount, 4);
});

test('both populated means merge — never a silent overwrite', () => {
    assert.equal(decideSync(full(), full()).action, 'merge');
});

test('both empty means noop', () => {
    assert.equal(decideSync(empty(), empty()).action, 'noop');
});

test('a populated local over an empty server file is a safe push', () => {
    assert.equal(decideSync(full(), empty()).action, 'push');
});

test('every decision carries a reason for the status line', () => {
    for (const [local, remote] of [[full(), null], [empty(), full()], [full(), full()], [empty(), null]]) {
        assert.ok(decideSync(local, remote).reason.length > 0);
    }
});

// ------------------------------------------------------------- data loss ---

test('an empty roster may NOT overwrite a populated server copy', () => {
    const gate = canPush(empty(), full());
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /refusing/i);
    assert.match(gate.reason, /4 server record/);
});

test('the same push is allowed once the user forces it', () => {
    assert.equal(canPush(empty(), full(), { force: true }).allowed, true);
});

test('a populated push is always allowed', () => {
    assert.equal(canPush(full(), full()).allowed, true);
    assert.equal(canPush(full(), empty()).allowed, true);
    assert.equal(canPush(full(), null).allowed, true);
});

test('pushing nothing onto nothing is harmless', () => {
    assert.equal(canPush(empty(), empty()).allowed, true);
    assert.equal(canPush(empty(), null).allowed, true);
});

test('an empty server roster may NOT wipe local records', () => {
    const gate = canPull(full(), empty());
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /4 local record/);
});

test('a forced pull is allowed, and a populated pull needs no force', () => {
    assert.equal(canPull(full(), empty(), { force: true }).allowed, true);
    assert.equal(canPull(full(), full()).allowed, true);
    assert.equal(canPull(empty(), full()).allowed, true);
});

// ----------------------------------------------------------------- shape ---

test('pickCollections keeps only syncable collections and normalizes them', () => {
    const picked = pickCollections({ characters: [{ id: 'c1' }], images: [{ id: 'i1' }], junk: 1 });
    assert.deepEqual(Object.keys(picked).sort(), [...COLLECTIONS].sort());
    assert.equal(picked.images, undefined, 'image blobs must never enter a roster file');
    assert.deepEqual(picked.outfits, []);
});

test('pickCollections turns a malformed collection into an empty array', () => {
    const picked = pickCollections({ characters: 'nope', outfits: null, styles: undefined });
    for (const name of COLLECTIONS) assert.deepEqual(picked[name], [], name);
});

test('pickCollections survives null input', () => {
    assert.equal(countRecords(pickCollections(null)), 0);
});

// --------------------------------------------------------------- reporting --

test('summarize reports per-collection counts and a total', () => {
    const s = summarize(full());
    assert.equal(s.total, 4);
    assert.equal(s.byCollection.characters, 2);
    assert.equal(s.byCollection.styles, 0);
});

test('describe lists only non-empty collections', () => {
    const text = describe(full());
    assert.match(text, /2 characters/);
    assert.match(text, /1 outfits/);
    assert.ok(!text.includes('styles'), 'an empty collection would only add noise');
});

test('describe says "nothing" instead of an empty string', () => {
    assert.equal(describe(empty()), 'nothing');
    assert.equal(describe(null), 'nothing');
});

// --------------------------------------------------------------- migration --

test('migration is offered when local has records and the server has no file', () => {
    const m = shouldMigrate(full(), null);
    assert.equal(m.should, true);
    assert.match(m.reason, /never been synced/);
});

test('migration never re-runs once it has been recorded', () => {
    const m = shouldMigrate(full(), null, { migratedAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(m.should, false);
    assert.match(m.reason, /already migrated/);
});

test('migration is skipped when a server roster already exists', () => {
    assert.equal(shouldMigrate(full(), empty()).should, false,
        'an existing server file, even an empty one, belongs to the sync path');
    assert.equal(shouldMigrate(full(), full()).should, false);
});

test('migration is skipped when there is nothing to migrate', () => {
    assert.equal(shouldMigrate(empty(), null).should, false);
});
