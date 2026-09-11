// IF Image - Per-user roster sync through SillyTavern's file storage.
//
// WHY this exists: every roster record (characters, outfits, styles, personas,
// replace rules) lives in browser IndexedDB, so switching device or clearing
// site data loses all of it. SillyTavern already stores per-user files on the
// server; this module is the bridge to it.
//
// WHERE it writes: request.user.directories.files === '<dataRoot>/<handle>/user/files'.
// The directory is per ST account, NOT per browser, and NOT inside the shared
// extension folder (public/scripts/extensions/third-party/IF-Image). Writing
// into the extension folder is impossible anyway: no ST endpoint targets it,
// and an update would overwrite whatever landed there.
//
// HARD CONSTRAINT verified in src/endpoints/assets.js validateAssetFileName():
//     if (!/^[a-zA-Z0-9_\-.]+$/.test(inputFilename)) -> rejected
// The '/' character is not in that class, so SUBDIRECTORIES ARE IMPOSSIBLE on
// this endpoint. Everything must be a flat filename. (/api/images/upload does
// allow one subfolder via ch_name, but only accepts MEDIA_EXTENSIONS, so it
// cannot carry JSON.)
//
// Pure module: every ST touchpoint (fetch, headers) is injected, so the whole
// contract is testable offline with no DOM, no network, and no ST import.

/** Flat filename holding the whole roster. Bump the suffix on a breaking shape change. */
export const ROSTER_FILENAME = 'ifimage-roster-v1.json';

/** Envelope format marker, independent of the preset export format. */
export const ROSTER_FORMAT = 'ifimage-roster';
export const ROSTER_VERSION = 1;

/** Mirrors src/endpoints/assets.js UNSAFE_EXTENSIONS for the subset we can hit. */
const UNSAFE_EXTENSIONS = new Set([
    '.php', '.exe', '.com', '.dll', '.pif', '.application', '.gadget',
    '.msi', '.jar', '.cmd', '.bat', '.reg', '.sh', '.py', '.js', '.html', '.htm',
]);

export class ServerSyncError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ServerSyncError';
        this.code = code;
    }
}

/**
 * Reject a filename the server would reject, with the same rules, before
 * spending a request on it. Returning the reason lets the UI explain itself
 * instead of surfacing a bare 400.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateRosterFilename(name) {
    // Strict type check, not String(name): coercing 42 to "42" would produce a
    // name that passes every rule below while meaning nothing to the caller.
    if (typeof name !== 'string') return { ok: false, error: 'the filename must be a string' };
    const text = name;
    if (!text) return { ok: false, error: 'the filename is empty' };
    if (!/^[a-zA-Z0-9_\-.]+$/.test(text)) {
        return { ok: false, error: 'only letters, digits, "_", "-" and "." are allowed — subdirectories are not supported by this endpoint' };
    }
    if (text.startsWith('.')) return { ok: false, error: 'the filename cannot start with "."' };
    const dot = text.lastIndexOf('.');
    const ext = dot > 0 ? text.slice(dot).toLowerCase() : '';
    if (UNSAFE_EXTENSIONS.has(ext)) return { ok: false, error: `"${ext}" is a forbidden file extension` };
    return { ok: true };
}

/**
 * Base64 of the UTF-8 bytes of `text`.
 *
 * btoa() alone throws InvalidCharacterError on anything outside Latin-1, and a
 * roster routinely carries Vietnamese names, Japanese tags, and emoji. Encoding
 * to UTF-8 bytes first is what makes those survive the round trip.
 */
export function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(String(text ?? ''));
    let binary = '';
    // Chunked to keep String.fromCharCode from blowing the argument limit on
    // a large roster (~64k arguments is the practical ceiling).
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/**
 * Wrap collections in a versioned envelope. `savedAt` is informational only —
 * conflict resolution is the caller's decision, never a silent overwrite here.
 */
export function buildRosterPayload(collections = {}) {
    const pick = (value) => (Array.isArray(value) ? value : []);
    return {
        format: ROSTER_FORMAT,
        version: ROSTER_VERSION,
        savedAt: new Date().toISOString(),
        characters: pick(collections.characters),
        outfits: pick(collections.outfits),
        styles: pick(collections.styles),
        personas: pick(collections.personas),
        replaceRules: pick(collections.replaceRules),
    };
}

/**
 * Validate a downloaded envelope. Never throws: a corrupt remote file must not
 * be able to take down the extension, and the caller needs the reason to show.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateRosterPayload(json) {
    const errors = [];
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return { ok: false, errors: ['not a JSON object'] };
    }
    if (json.format !== ROSTER_FORMAT) {
        errors.push(`unknown format ${JSON.stringify(json.format ?? null)} (expected "${ROSTER_FORMAT}")`);
    }
    if (json.version !== ROSTER_VERSION) {
        errors.push(`unsupported version ${JSON.stringify(json.version ?? null)} (expected ${ROSTER_VERSION})`);
    }
    for (const name of ['characters', 'outfits', 'styles', 'personas', 'replaceRules']) {
        if (json[name] !== undefined && !Array.isArray(json[name])) {
            errors.push(`"${name}" must be an array`);
        }
    }
    return { ok: errors.length === 0, errors };
}

function requireFetch(deps) {
    const doFetch = deps?.fetch;
    if (typeof doFetch !== 'function') {
        throw new ServerSyncError('SYNC_CONFIG', 'No fetch implementation was supplied.');
    }
    return doFetch;
}

function headersOf(deps) {
    try {
        return deps?.getRequestHeaders?.() ?? {};
    } catch (err) {
        throw new ServerSyncError('SYNC_CONFIG', `Could not build request headers: ${err?.message ?? err}`);
    }
}

/**
 * Upload the roster as a flat per-user file.
 *
 * @param {object} collections - { characters, outfits, styles, personas, replaceRules }
 * @param {{ fetch: Function, getRequestHeaders: Function, filename?: string }} deps
 * @returns {Promise<{ path: string, bytes: number, savedAt: string }>}
 */
export async function uploadRoster(collections, deps = {}) {
    const doFetch = requireFetch(deps);
    const filename = deps.filename ?? ROSTER_FILENAME;
    const check = validateRosterFilename(filename);
    if (!check.ok) throw new ServerSyncError('SYNC_FILENAME', `Invalid roster filename: ${check.error}`);

    const payload = buildRosterPayload(collections);
    const text = JSON.stringify(payload);
    const data = utf8ToBase64(text);

    let response;
    try {
        response = await doFetch('/api/files/upload', {
            method: 'POST',
            headers: headersOf(deps),
            body: JSON.stringify({ name: filename, data }),
        });
    } catch (err) {
        throw new ServerSyncError('SYNC_NETWORK', `Roster upload failed: ${err?.message ?? err}`);
    }
    if (!response?.ok) {
        const detail = await response?.text?.().catch(() => '') ?? '';
        throw new ServerSyncError('SYNC_HTTP', `Roster upload rejected (${response?.status ?? '?'})${detail ? `: ${detail}` : ''}`);
    }

    let body;
    try {
        body = await response.json();
    } catch (err) {
        throw new ServerSyncError('SYNC_MALFORMED', `Roster upload returned unreadable JSON: ${err?.message ?? err}`);
    }
    if (!body || typeof body.path !== 'string' || !body.path) {
        throw new ServerSyncError('SYNC_MALFORMED', 'Roster upload returned no path.');
    }
    // byteLength, not text.length: the count has to mean stored bytes, and a
    // roster full of non-ASCII names is much larger than its character count.
    return { path: body.path, bytes: new TextEncoder().encode(text).length, savedAt: payload.savedAt };
}

/**
 * Download and validate the roster file.
 *
 * A missing file is NOT an error — it is the normal first-run state, and the
 * caller distinguishes it by the null return rather than by parsing a message.
 * @returns {Promise<object|null>} the validated payload, or null when absent
 */
export async function downloadRoster(path, deps = {}) {
    const doFetch = requireFetch(deps);
    const url = String(path ?? '').trim();
    if (!url) throw new ServerSyncError('SYNC_CONFIG', 'No roster path was supplied.');

    let response;
    try {
        response = await doFetch(url, { method: 'GET', headers: headersOf(deps), cache: 'no-cache' });
    } catch (err) {
        throw new ServerSyncError('SYNC_NETWORK', `Roster download failed: ${err?.message ?? err}`);
    }
    if (response?.status === 404) return null;
    if (!response?.ok) {
        throw new ServerSyncError('SYNC_HTTP', `Roster download rejected (${response?.status ?? '?'}).`);
    }

    let text;
    try {
        text = await response.text();
    } catch (err) {
        throw new ServerSyncError('SYNC_NETWORK', `Roster download could not be read: ${err?.message ?? err}`);
    }
    // An empty body is an empty file, not valid JSON — treat it as absent.
    if (!text.trim()) return null;

    let json;
    try {
        json = JSON.parse(text);
    } catch (err) {
        throw new ServerSyncError('SYNC_MALFORMED', `Roster file is not valid JSON: ${err?.message ?? err}`);
    }
    const validation = validateRosterPayload(json);
    if (!validation.ok) {
        throw new ServerSyncError('SYNC_MALFORMED', `Roster file is invalid: ${validation.errors.join('; ')}`);
    }
    return json;
}

/**
 * Check whether the roster file exists without downloading it.
 * @returns {Promise<boolean>}
 */
export async function rosterExists(path, deps = {}) {
    const doFetch = requireFetch(deps);
    const url = String(path ?? '').trim();
    if (!url) return false;
    let response;
    try {
        response = await doFetch('/api/files/verify', {
            method: 'POST',
            headers: headersOf(deps),
            body: JSON.stringify({ urls: [url] }),
        });
    } catch (err) {
        throw new ServerSyncError('SYNC_NETWORK', `Roster verify failed: ${err?.message ?? err}`);
    }
    if (!response?.ok) return false;
    try {
        const body = await response.json();
        return body?.[url] === true;
    } catch {
        return false;
    }
}

/**
 * Delete the roster file. The server guards the path with
 * `startsWith(request.user.directories.files)`, so this cannot escape the
 * per-user directory even if handed a traversal string.
 * @returns {Promise<boolean>} true when deleted, false when it was not there
 */
export async function deleteRoster(path, deps = {}) {
    const doFetch = requireFetch(deps);
    const url = String(path ?? '').trim();
    if (!url) throw new ServerSyncError('SYNC_CONFIG', 'No roster path was supplied.');
    let response;
    try {
        response = await doFetch('/api/files/delete', {
            method: 'POST',
            headers: headersOf(deps),
            body: JSON.stringify({ path: url }),
        });
    } catch (err) {
        throw new ServerSyncError('SYNC_NETWORK', `Roster delete failed: ${err?.message ?? err}`);
    }
    if (response?.status === 404) return false;
    if (!response?.ok) {
        throw new ServerSyncError('SYNC_HTTP', `Roster delete rejected (${response?.status ?? '?'}).`);
    }
    return true;
}
