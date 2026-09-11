// IF Image - PNG tEXt metadata (read + write).
//
// WHY: an image in IndexedDB is worth nothing on another device. A PNG that
// carries its own prompt/seed/params can be downloaded, re-uploaded, shared,
// or recovered after a cache wipe and still explain itself. ST8U solves this
// with msgpack + JSZip + LSB steganography; a plain tEXt chunk gets the same
// practical benefit in ~200 lines with no dependency and no pixel mutation.
//
// FORMAT (PNG spec 11.3.4.3): a tEXt chunk is
//     length(4) type(4)='tEXt' keyword \0 text crc(4)
// keyword: 1-79 bytes, Latin-1, no leading/trailing/consecutive spaces.
// text:    Latin-1, NUL-free.
//
// Latin-1 is the hard constraint here, and a prompt routinely contains
// Vietnamese names, Japanese tags, or emoji. Those cannot be stored raw, so
// the payload is JSON -> UTF-8 -> base64, which is ASCII and therefore always
// Latin-1 safe. That is also why the chunk is NOT human-readable in a hex
// editor; correctness beats convenience for something meant to survive.
//
// Pure module: Uint8Array in, Uint8Array out. No DOM, no canvas, no ST.
// Deliberately NOT used: iTXt (UTF-8 capable but far less widely supported)
// and zTXt (compression is pointless for a payload this small).

/** Chunk keyword. Kept ASCII, no spaces, well inside the 79-byte limit. */
export const IFIMAGE_KEYWORD = 'ifimage';

export const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Payload envelope version. Bump only on a breaking shape change. */
export const METADATA_VERSION = 1;

export class PngMetadataError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PngMetadataError';
        this.code = code;
    }
}

// --------------------------------------------------------------------- CRC --

// PNG uses CRC-32 (IEEE 802.3) over chunk type + data. Table built once.
let crcTable = null;
function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crcTable[n] = c >>> 0;
    }
    return crcTable;
}

/** CRC-32 over `bytes`. Returns an unsigned 32-bit value. */
export function crc32(bytes) {
    const table = getCrcTable();
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------ base64 --

function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(String(text ?? ''));
    let binary = '';
    const CHUNK = 0x8000; // keeps fromCharCode inside its argument limit
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

function base64ToUtf8(b64) {
    const binary = atob(String(b64 ?? ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

// ------------------------------------------------------------------- bytes --

function u32(value) {
    return new Uint8Array([
        (value >>> 24) & 0xff, (value >>> 16) & 0xff,
        (value >>> 8) & 0xff, value & 0xff,
    ]);
}

function readU32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16)
        | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function latin1Bytes(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
}

function latin1String(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
}

function concat(parts) {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** True when `bytes` starts with the 8-byte PNG signature. */
export function isPng(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 8) return false;
    for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
    return true;
}

// ------------------------------------------------------------------ chunks --

/**
 * Walk the chunk list. Stops at IEND, and tolerates a truncated tail rather
 * than throwing: a partially downloaded image should degrade, not explode.
 * @returns {Array<{type: string, start: number, dataStart: number, length: number, end: number}>}
 */
export function listChunks(bytes) {
    if (!isPng(bytes)) throw new PngMetadataError('NOT_PNG', 'Not a PNG file.');
    const chunks = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const length = readU32(bytes, offset);
        const type = latin1String(bytes.subarray(offset + 4, offset + 8));
        const end = offset + 12 + length; // length + type + data + crc
        if (end > bytes.length) break;    // truncated tail
        chunks.push({ type, start: offset, dataStart: offset + 8, length, end });
        if (type === 'IEND') break;
        offset = end;
    }
    return chunks;
}

/** Build one complete tEXt chunk (length + type + keyword\0text + crc). */
export function buildTextChunk(keyword, text) {
    const key = String(keyword ?? '');
    if (!key || key.length > 79) {
        throw new PngMetadataError('BAD_KEYWORD', 'A tEXt keyword must be 1-79 characters.');
    }
    const body = concat([latin1Bytes(key), new Uint8Array([0]), latin1Bytes(String(text ?? ''))]);
    const typeBytes = latin1Bytes('tEXt');
    // The CRC covers the chunk TYPE as well as the data — a frequent mistake
    // that produces a file every strict decoder rejects.
    return concat([u32(body.length), typeBytes, body, u32(crc32(concat([typeBytes, body])))]);
}

// ----------------------------------------------------------------- payload --

/**
 * Shape the record ONCE so reader and writer cannot drift apart.
 * Only generation-reproducing fields belong here. Nothing that identifies a
 * user, a chat, or a backend URL is included: these files get shared.
 */
export function buildMetadataPayload(record = {}) {
    const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : undefined);
    const str = (value) => (typeof value === 'string' && value ? value : undefined);
    const params = record.params && typeof record.params === 'object' ? record.params : {};
    const payload = {
        v: METADATA_VERSION,
        prompt: str(record.prompt),
        negative: str(record.negative),
        seed: num(record.seed ?? params.seed),
        steps: num(params.steps),
        cfg: num(params.cfg),
        sampler: str(params.sampler),
        scheduler: str(params.scheduler),
        width: num(record.width ?? params.width),
        height: num(record.height ?? params.height),
        checkpoint: str(record.checkpoint ?? params.checkpoint),
        backend: str(record.backend),
        profileKey: str(record.profileKey),
        createdAt: str(record.createdAt) ?? new Date().toISOString(),
    };
    for (const key of Object.keys(payload)) {
        if (payload[key] === undefined) delete payload[key];
    }
    return payload;
}

// ------------------------------------------------------------- read / write --

/**
 * Insert (or replace) the IF-Image tEXt chunk.
 *
 * Placement is immediately before IEND. Putting it after IHDR would be legal
 * too, but appending keeps the pixel data byte-identical and makes a rewrite a
 * pure tail operation.
 *
 * @param {Uint8Array} bytes - original PNG
 * @param {object} record - anything buildMetadataPayload understands
 * @returns {Uint8Array} a NEW array; the input is never mutated
 */
export function writeMetadata(bytes, record) {
    if (!isPng(bytes)) throw new PngMetadataError('NOT_PNG', 'Not a PNG file.');
    const payload = buildMetadataPayload(record);
    const chunk = buildTextChunk(IFIMAGE_KEYWORD, utf8ToBase64(JSON.stringify(payload)));

    const chunks = listChunks(bytes);
    const iend = chunks.find(c => c.type === 'IEND');
    if (!iend) throw new PngMetadataError('NO_IEND', 'PNG has no IEND chunk.');

    // Drop any previous ifimage chunk so re-saving cannot stack copies.
    const stale = chunks.filter(c => c.type === 'tEXt' && readKeyword(bytes, c) === IFIMAGE_KEYWORD);
    const parts = [];
    let cursor = 0;
    for (const chunk_ of stale) {
        parts.push(bytes.subarray(cursor, chunk_.start));
        cursor = chunk_.end;
    }
    const tail = bytes.subarray(cursor);
    // IEND offset shifts once earlier chunks are removed, so split on the tail.
    const iendInTail = iend.start - cursor;
    parts.push(tail.subarray(0, iendInTail), chunk, tail.subarray(iendInTail));
    return concat(parts);
}

/** Keyword of a tEXt chunk, or '' when it is malformed. */
function readKeyword(bytes, chunk) {
    const data = bytes.subarray(chunk.dataStart, chunk.dataStart + chunk.length);
    const nul = data.indexOf(0);
    return nul < 0 ? '' : latin1String(data.subarray(0, nul));
}

/**
 * Read the IF-Image payload back.
 *
 * Returns null rather than throwing for every "not ours" case — a foreign PNG
 * is the normal case, not an error. Only a structurally invalid PNG throws.
 * @returns {object|null}
 */
export function readMetadata(bytes) {
    if (!isPng(bytes)) throw new PngMetadataError('NOT_PNG', 'Not a PNG file.');
    for (const chunk of listChunks(bytes)) {
        if (chunk.type !== 'tEXt') continue;
        if (readKeyword(bytes, chunk) !== IFIMAGE_KEYWORD) continue;
        const data = bytes.subarray(chunk.dataStart, chunk.dataStart + chunk.length);
        const nul = data.indexOf(0);
        const text = latin1String(data.subarray(nul + 1));
        try {
            const parsed = JSON.parse(base64ToUtf8(text));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
            // A corrupt chunk must not break opening the image.
            return null;
        }
    }
    return null;
}

/** Convenience: does this PNG already carry our metadata? */
export function hasMetadata(bytes) {
    try {
        return readMetadata(bytes) !== null;
    } catch {
        return false;
    }
}
