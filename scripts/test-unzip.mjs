// Test harness for src/backends/nai.js pngFromNaiZip.
// Builds minimal ZIPs in pure JS (stored + deflate), asserts round-trip.
// Run: node scripts/test-unzip.mjs
// Not imported by the extension.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const naiSource = readFileSync(path.join(here, '..', 'src', 'backends', 'nai.js'), 'utf8');

// Extract the pngFromNaiZip function body from the module source without
// resolving the full module (which imports SillyTavern globals).
const fnStart = naiSource.indexOf('export async function pngFromNaiZip');
if (fnStart < 0) throw new Error('pngFromNaiZip not found in nai.js');
const bodyStart = naiSource.indexOf('{', fnStart);
let depth = 0;
let bodyEnd = -1;
for (let i = bodyStart; i < naiSource.length; i++) {
    if (naiSource[i] === '{') depth++;
    else if (naiSource[i] === '}') {
        depth--;
        if (depth === 0) { bodyEnd = i + 1; break; }
    }
}
const fnSource = naiSource.slice(fnStart, bodyEnd).replace(/^export\s+/, '');
const pngFromNaiZip = new Function('return ' + fnSource)();

// ---- minimal ZIP builder ----

function crc32(bytes) {
    let table = crc32.table;
    if (!table) {
        table = crc32.table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c;
        }
    }
    let crc = -1;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xff];
    return (crc ^ -1) >>> 0;
}

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }

/**
 * Build a one-entry ZIP the way NovelAI does.
 * @param {string} name entry file name
 * @param {Buffer} data uncompressed payload
 * @param {0|8} method 0 = stored, 8 = deflate
 * @param {object} [quirks] force local-header name/extra lengths (default: mirror central)
 */
function buildZip(name, data, method, quirks = {}) {
    const nameBuf = Buffer.from(name, 'utf8');
    const localExtra = quirks.localExtra ?? Buffer.alloc(0);
    const centralExtra = quirks.centralExtra ?? Buffer.alloc(0);
    const comment = Buffer.alloc(0);

    const comp = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);

    const local = Buffer.concat([
        u32(0x04034b50), u16(20), u16(0), u16(method),
        u16(0), u16(0x21), u32(crc),
        u32(comp.length), u32(data.length),
        u16(nameBuf.length), u16(localExtra.length),
        nameBuf, localExtra, comp,
    ]);

    // Central directory fixed part is exactly 46 bytes:
    // sig(4) verMade(2) verNeed(2) flags(2) method(2) time(2) date(2) crc(4)
    // comp(4) uncomp(4) nameLen(2) extraLen(2) commentLen(2) disk(2)
    // iattr(2) eattr(4) localOff(4)
    const central = Buffer.concat([
        u32(0x02014b50),           // signature
        u16(20),                    // version made by
        u16(20),                    // version needed
        u16(0),                     // flags
        u16(method),                // compression method
        u16(0), u16(0x21),          // mod time, mod date
        u32(crc),                   // crc32
        u32(comp.length),           // compressed size
        u32(data.length),           // uncompressed size
        u16(nameBuf.length),        // file name length
        u16(centralExtra.length),   // extra field length
        u16(comment.length),        // file comment length
        u16(0),                     // disk number start
        u16(0),                     // internal attributes
        u32(0),                     // external attributes
        u32(0),                     // local header offset (this entry starts the file)
        nameBuf, centralExtra, comment,
    ]);

    const eocd = Buffer.concat([
        u32(0x06054b50), u16(0), u16(0),
        u16(1), u16(1),
        u32(central.length), u32(local.length), u16(0),
    ]);

    return Buffer.concat([local, central, eocd]);
}

// ---- fake PNG payload ----
const pngMagic = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(2048, 0xab), // filler so deflate actually compresses something
]);

async function roundTrip(label, zip) {
    const blob = await pngFromNaiZip(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));
    const out = Buffer.from(await blob.arrayBuffer());
    if (!out.equals(pngMagic)) {
        throw new Error(`${label}: round-trip mismatch (${out.length} vs ${pngMagic.length} bytes)`);
    }
    if (blob.type !== 'image/png') throw new Error(`${label}: wrong blob type ${blob.type}`);
    console.log(`PASS ${label}: ${zip.length} byte zip -> ${out.length} byte png`);
}

// ---- tests ----
await roundTrip('stored entry, image_0.png', buildZip('image_0.png', pngMagic, 0));
await roundTrip('deflate entry, image_0.png', buildZip('image_0.png', pngMagic, 8));
await roundTrip('stored + local extra field', buildZip('image_0.png', pngMagic, 0, { localExtra: Buffer.from([0x99, 0x99, 0x04, 0x00, 1, 2, 3, 4]) }));
await roundTrip('deflate + central extra field', buildZip('image_0.png', pngMagic, 8, { centralExtra: Buffer.from([0x77, 0x77, 0x02, 0x00, 9, 9]) }));
await roundTrip('skips non-png entry first', (() => {
    // zip containing image_0.csv then image_0.png: parser must skip the csv entry
    const csv = Buffer.from('a,b,c\n1,2,3\n', 'utf8');
    const inner = buildZip('image_0.csv', csv, 0);
    // Reuse builder but craft two entries by hand:
    const nameA = Buffer.from('image_0.csv');
    const nameB = Buffer.from('image_0.png');
    const crcA = crc32(csv);
    const crcB = crc32(pngMagic);
    const localA = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crcA), u32(csv.length), u32(csv.length), u16(nameA.length), u16(0), nameA, csv]);
    const localB = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crcB), u32(pngMagic.length), u32(pngMagic.length), u16(nameB.length), u16(0), nameB, pngMagic]);
    const cdA = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crcA), u32(csv.length), u32(csv.length), u16(nameA.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), nameA]);
    const cdB = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crcB), u32(pngMagic.length), u32(pngMagic.length), u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(localA.length), nameB]);
    const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(2), u16(2), u32(cdA.length + cdB.length), u32(localA.length + localB.length), u16(0)]);
    void inner;
    return Buffer.concat([localA, localB, cdA, cdB, eocd]);
})());

// negative tests
let failed = false;
try {
    await pngFromNaiZip(Buffer.from('not a zip at all, just text padding text padding').buffer);
    console.error('FAIL garbage input: parser should have thrown');
    failed = true;
} catch (e) {
    console.log('PASS garbage input rejected:', e.message);
}
try {
    await pngFromNaiZip(buildZip('image_0.jpg', pngMagic, 0).buffer.slice(0));
    console.error('FAIL no-png zip: parser should have thrown');
    failed = true;
} catch (e) {
    console.log('PASS zip without .png entry rejected:', e.message);
}

if (failed) process.exit(1);
console.log('All unzip tests passed.');
