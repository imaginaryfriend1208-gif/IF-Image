#!/usr/bin/env node
// IF Image - PNG tEXt metadata.
//
// A wrong byte here produces a file that some decoders open and others reject,
// which is worse than an outright failure. These tests pin the chunk layout
// against the PNG spec (11.3.4.3) and against real decoding: every generated
// file is re-read, and the CRC is verified independently.
//
// Run: node scripts/test-png-metadata.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    IFIMAGE_KEYWORD, PNG_SIGNATURE, METADATA_VERSION,
    crc32, isPng, listChunks, buildTextChunk, buildMetadataPayload,
    writeMetadata, readMetadata, hasMetadata, PngMetadataError,
} from '../src/storage/png-metadata.js';

if (typeof globalThis.btoa !== 'function') {
    globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}
if (typeof globalThis.atob !== 'function') {
    globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}

// --- helpers ---------------------------------------------------------------

const ascii = (s) => Uint8Array.from(s, c => c.charCodeAt(0));
const u32 = (n) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

function chunk(type, data = new Uint8Array(0)) {
    const t = ascii(type);
    const body = new Uint8Array(t.length + data.length);
    body.set(t); body.set(data, t.length);
    return [...u32(data.length), ...body, ...u32(crc32(body))];
}

/** Smallest structurally valid PNG: signature + IHDR + IDAT + IEND. */
function makePng() {
    const ihdr = new Uint8Array([
        0, 0, 0, 1, 0, 0, 0, 1, // 1x1
        8, 6, 0, 0, 0,          // depth 8, RGBA
    ]);
    return new Uint8Array([
        ...PNG_SIGNATURE,
        ...chunk('IHDR', ihdr),
        ...chunk('IDAT', new Uint8Array([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
        ...chunk('IEND'),
    ]);
}

/** Independent CRC verification of every chunk in a file. */
function verifyAllCrcs(bytes) {
    for (const c of listChunks(bytes)) {
        const body = bytes.subarray(c.start + 4, c.dataStart + c.length);
        const stored = new DataView(bytes.buffer, bytes.byteOffset + c.dataStart + c.length, 4).getUint32(0);
        assert.equal(crc32(body), stored, `CRC mismatch on ${c.type}`);
    }
}

// --- CRC -------------------------------------------------------------------

test('crc32 matches the known PNG IEND value', () => {
    // IEND is a fixed, empty chunk; its CRC is a documented constant.
    assert.equal(crc32(ascii('IEND')), 0xae426082);
});

test('crc32 of the empty input is 0', () => {
    assert.equal(crc32(new Uint8Array(0)), 0);
});

// --- signature -------------------------------------------------------------

test('isPng accepts a real PNG and rejects everything else', () => {
    assert.equal(isPng(makePng()), true);
    assert.equal(isPng(ascii('GIF89a-------')), false);
    assert.equal(isPng(new Uint8Array(3)), false);
    assert.equal(isPng(null), false);
    assert.equal(isPng('not bytes'), false);
});

test('a non-PNG throws a typed error instead of corrupting anything', () => {
    for (const fn of [() => writeMetadata(ascii('nope'), {}), () => readMetadata(ascii('nope'))]) {
        assert.throws(fn, (err) => err instanceof PngMetadataError && err.code === 'NOT_PNG');
    }
});

// --- chunk walking ---------------------------------------------------------

test('listChunks finds the standard chunks in order', () => {
    assert.deepEqual(listChunks(makePng()).map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
});

test('a truncated tail is tolerated rather than throwing', () => {
    const png = makePng();
    const cut = png.subarray(0, png.length - 6);
    assert.doesNotThrow(() => listChunks(cut));
    assert.ok(listChunks(cut).length >= 1);
});

// --- tEXt chunk ------------------------------------------------------------

test('buildTextChunk lays out length, type, keyword\\0text, and a valid CRC', () => {
    const c = buildTextChunk('ifimage', 'abc');
    const length = new DataView(c.buffer, c.byteOffset, 4).getUint32(0);
    assert.equal(length, 'ifimage'.length + 1 + 'abc'.length);
    assert.equal(String.fromCharCode(...c.subarray(4, 8)), 'tEXt');
    assert.equal(c[8 + 'ifimage'.length], 0, 'keyword must be NUL-terminated');
    const crcStored = new DataView(c.buffer, c.byteOffset + c.length - 4, 4).getUint32(0);
    assert.equal(crc32(c.subarray(4, c.length - 4)), crcStored, 'CRC must cover type + data');
});

test('an out-of-range keyword is rejected (PNG allows 1-79 bytes)', () => {
    assert.throws(() => buildTextChunk('', 'x'), (e) => e.code === 'BAD_KEYWORD');
    assert.throws(() => buildTextChunk('k'.repeat(80), 'x'), (e) => e.code === 'BAD_KEYWORD');
    assert.doesNotThrow(() => buildTextChunk('k'.repeat(79), 'x'));
});

// --- payload ---------------------------------------------------------------

test('buildMetadataPayload keeps generation fields and stamps a version', () => {
    const p = buildMetadataPayload({
        prompt: '1girl', negative: 'bad', backend: 'a1111', profileKey: 'illustrious',
        params: { seed: 42, steps: 28, cfg: 5, sampler: 'Euler a', width: 832, height: 1216 },
    });
    assert.equal(p.v, METADATA_VERSION);
    assert.equal(p.prompt, '1girl');
    assert.equal(p.seed, 42);
    assert.equal(p.width, 832);
});

test('absent fields are omitted rather than stored as null', () => {
    const p = buildMetadataPayload({ prompt: 'x' });
    assert.equal('negative' in p, false);
    assert.equal('seed' in p, false);
});

test('a record-level seed wins over the params copy', () => {
    assert.equal(buildMetadataPayload({ seed: 7, params: { seed: 9 } }).seed, 7);
});

test('no chat, user, or backend URL is ever embedded — these files get shared', () => {
    const p = buildMetadataPayload({
        prompt: 'x', chatId: 'chat-1', messageId: 42, baseUrl: 'http://secret:7860', apiKey: 'k',
    });
    for (const leak of ['chatId', 'messageId', 'baseUrl', 'apiKey']) {
        assert.equal(leak in p, false, leak);
    }
});

// --- round trip ------------------------------------------------------------

test('metadata survives a write/read round trip', () => {
    const record = {
        prompt: '1girl, silver hair', negative: 'worst quality', backend: 'a1111',
        params: { seed: 12345, steps: 28, cfg: 5, sampler: 'Euler a' },
    };
    const out = writeMetadata(makePng(), record);
    const got = readMetadata(out);
    assert.equal(got.prompt, record.prompt);
    assert.equal(got.seed, 12345);
    assert.equal(got.sampler, 'Euler a');
});

test('the result is still a valid PNG with correct CRCs', () => {
    const out = writeMetadata(makePng(), { prompt: 'x' });
    assert.equal(isPng(out), true);
    assert.deepEqual(listChunks(out).map(c => c.type), ['IHDR', 'IDAT', 'tEXt', 'IEND']);
    verifyAllCrcs(out);
});

test('the chunk is placed immediately before IEND', () => {
    const types = listChunks(writeMetadata(makePng(), { prompt: 'x' })).map(c => c.type);
    assert.equal(types[types.length - 2], 'tEXt');
    assert.equal(types[types.length - 1], 'IEND');
});

test('pixel data is byte-identical afterwards', () => {
    const png = makePng();
    const out = writeMetadata(png, { prompt: 'x' });
    const idatIn = listChunks(png).find(c => c.type === 'IDAT');
    const idatOut = listChunks(out).find(c => c.type === 'IDAT');
    assert.deepEqual(
        Array.from(out.subarray(idatOut.dataStart, idatOut.dataStart + idatOut.length)),
        Array.from(png.subarray(idatIn.dataStart, idatIn.dataStart + idatIn.length)),
    );
});

test('the input array is never mutated', () => {
    const png = makePng();
    const before = Array.from(png);
    writeMetadata(png, { prompt: 'x' });
    assert.deepEqual(Array.from(png), before);
});

// --- unicode ---------------------------------------------------------------

test('Vietnamese, Japanese, and emoji survive — raw Latin-1 could not carry them', () => {
    const prompt = 'Lyna mặc đồ ngủ, 日本語のタグ, 🎨';
    const got = readMetadata(writeMetadata(makePng(), { prompt }));
    assert.equal(got.prompt, prompt);
});

test('a long prompt round-trips intact', () => {
    const prompt = 'tag, '.repeat(2000);
    assert.equal(readMetadata(writeMetadata(makePng(), { prompt })).prompt, prompt);
});

// --- rewrite ---------------------------------------------------------------

test('re-saving replaces the chunk instead of stacking copies', () => {
    const once = writeMetadata(makePng(), { prompt: 'first' });
    const twice = writeMetadata(once, { prompt: 'second' });
    const texts = listChunks(twice).filter(c => c.type === 'tEXt');
    assert.equal(texts.length, 1, 'a second save must not leave the old chunk behind');
    assert.equal(readMetadata(twice).prompt, 'second');
    verifyAllCrcs(twice);
});

test('three saves still leave exactly one chunk and a valid file', () => {
    let png = makePng();
    for (const prompt of ['a', 'b', 'c']) png = writeMetadata(png, { prompt });
    assert.equal(listChunks(png).filter(c => c.type === 'tEXt').length, 1);
    assert.equal(readMetadata(png).prompt, 'c');
    verifyAllCrcs(png);
});

// --- foreign / corrupt input ----------------------------------------------

test('a PNG without our chunk reads as null, not as an error', () => {
    assert.equal(readMetadata(makePng()), null);
    assert.equal(hasMetadata(makePng()), false);
});

test('a foreign tEXt chunk is left alone and not mistaken for ours', () => {
    const png = makePng();
    const iend = listChunks(png).find(c => c.type === 'IEND');
    const foreign = buildTextChunk('parameters', 'a1111 style metadata');
    const withForeign = new Uint8Array([
        ...png.subarray(0, iend.start), ...foreign, ...png.subarray(iend.start),
    ]);
    assert.equal(readMetadata(withForeign), null);

    const out = writeMetadata(withForeign, { prompt: 'ours' });
    assert.equal(listChunks(out).filter(c => c.type === 'tEXt').length, 2,
        'another tool\'s metadata must survive');
    assert.equal(readMetadata(out).prompt, 'ours');
    verifyAllCrcs(out);
});

test('a corrupt payload reads as null so the image still opens', () => {
    const png = makePng();
    const iend = listChunks(png).find(c => c.type === 'IEND');
    const broken = buildTextChunk(IFIMAGE_KEYWORD, 'not-base64-at-all!!!');
    const out = new Uint8Array([...png.subarray(0, iend.start), ...broken, ...png.subarray(iend.start)]);
    assert.equal(readMetadata(out), null);
    assert.equal(hasMetadata(out), false);
});

test('hasMetadata never throws, whatever it is handed', () => {
    assert.equal(hasMetadata(ascii('nope')), false);
    assert.equal(hasMetadata(null), false);
    assert.equal(hasMetadata(writeMetadata(makePng(), { prompt: 'x' })), true);
});
