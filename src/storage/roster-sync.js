// IF Image - roster synchronisation policy.
//
// src/storage/server-sync.js is the TRANSPORT (upload/download/verify/delete).
// This module is the POLICY: which side wins, when a push is allowed, and how
// a first-run migration is decided. They are separate because the dangerous
// part is not the network call, it is the decision to overwrite.
//
// THE RULE THAT MATTERS: a sync must never be able to destroy data. Every
// decision below is biased toward keeping records. The one irreversible
// action (replacing a populated side with an empty one) is refused outright
// and must be done by an explicit user action instead.
//
// Pure module: no IndexedDB, no network, no DOM. Callers supply collections
// and persist the result.

export const COLLECTIONS = Object.freeze([
    'characters', 'outfits', 'styles', 'personas', 'replaceRules',
]);

/** Total record count across every collection. */
export function countRecords(collections = {}) {
    let total = 0;
    for (const name of COLLECTIONS) {
        const list = collections?.[name];
        if (Array.isArray(list)) total += list.length;
    }
    return total;
}

/** True when every collection is absent or empty. */
export function isEmpty(collections) {
    return countRecords(collections) === 0;
}

/**
 * Decide what a sync should do, without doing it.
 *
 * Returned actions:
 *   'push'          local -> server (server absent or empty)
 *   'pull'          server -> local (local empty, server has data)
 *   'merge'         both populated; caller resolves with planMerge()
 *   'noop'          both empty
 *   'refuse-empty'  a populated side would be replaced by an empty one
 *
 * @param {object} local
 * @param {object|null} remote - null when the server file does not exist
 * @returns {{ action: string, reason: string, localCount: number, remoteCount: number }}
 */
export function decideSync(local, remote) {
    const localCount = countRecords(local);
    const remoteCount = countRecords(remote ?? {});

    if (remote === null || remote === undefined) {
        return localCount === 0
            ? { action: 'noop', reason: 'nothing stored locally and no roster on the server yet', localCount, remoteCount: 0 }
            : { action: 'push', reason: 'no roster on the server yet', localCount, remoteCount: 0 };
    }
    if (localCount === 0 && remoteCount === 0) {
        return { action: 'noop', reason: 'both sides are empty', localCount, remoteCount };
    }
    if (localCount === 0) {
        return { action: 'pull', reason: 'nothing stored locally', localCount, remoteCount };
    }
    if (remoteCount === 0) {
        // Pushing over an empty remote is safe: nothing is lost.
        return { action: 'push', reason: 'the server roster is empty', localCount, remoteCount };
    }
    return { action: 'merge', reason: 'both sides have records', localCount, remoteCount };
}

/**
 * Gate every upload. An empty roster overwriting a populated server file is
 * indistinguishable from data loss, and it is exactly what a failed IndexedDB
 * read would produce — so it is refused unless the caller passes `force`
 * (i.e. the user explicitly asked to clear the server copy).
 *
 * @returns {{ allowed: boolean, reason: string }}
 */
export function canPush(local, remote, { force = false } = {}) {
    const localCount = countRecords(local);
    const remoteCount = countRecords(remote ?? {});
    if (localCount === 0 && remoteCount > 0 && !force) {
        return {
            allowed: false,
            reason: `refusing to replace ${remoteCount} server record(s) with an empty roster; use an explicit overwrite if that is intended`,
        };
    }
    return { allowed: true, reason: '' };
}

/**
 * Symmetric guard for the download direction.
 * @returns {{ allowed: boolean, reason: string }}
 */
export function canPull(local, remote, { force = false } = {}) {
    const localCount = countRecords(local);
    const remoteCount = countRecords(remote ?? {});
    if (remoteCount === 0 && localCount > 0 && !force) {
        return {
            allowed: false,
            reason: `refusing to replace ${localCount} local record(s) with an empty server roster`,
        };
    }
    return { allowed: true, reason: '' };
}

/**
 * Extract only the syncable collections, dropping anything else the caller
 * happens to be holding (blobs, caches, UI state).
 */
export function pickCollections(source = {}) {
    const out = {};
    for (const name of COLLECTIONS) {
        out[name] = Array.isArray(source?.[name]) ? source[name] : [];
    }
    return out;
}

/**
 * Per-collection counts for a status line.
 * @returns {{ total: number, byCollection: Record<string, number> }}
 */
export function summarize(collections = {}) {
    const byCollection = {};
    let total = 0;
    for (const name of COLLECTIONS) {
        const count = Array.isArray(collections?.[name]) ? collections[name].length : 0;
        byCollection[name] = count;
        total += count;
    }
    return { total, byCollection };
}

/**
 * Human-readable one-liner, e.g. "5 characters, 2 outfits".
 * Empty collections are omitted so the line stays readable.
 */
export function describe(collections = {}) {
    const { total, byCollection } = summarize(collections);
    if (!total) return 'nothing';
    return COLLECTIONS
        .filter(name => byCollection[name] > 0)
        .map(name => `${byCollection[name]} ${name}`)
        .join(', ');
}

/**
 * Decide whether a first-run migration should be offered.
 *
 * Deliberately conservative: it fires only when local has records AND the
 * server has no roster file at all. Once a server file exists, the normal
 * sync path owns the decision — migration must never re-run and clobber it.
 *
 * @param {object} local
 * @param {object|null} remote
 * @param {{ migratedAt?: string|null }} [state]
 * @returns {{ should: boolean, reason: string }}
 */
export function shouldMigrate(local, remote, { migratedAt = null } = {}) {
    if (migratedAt) return { should: false, reason: 'already migrated' };
    if (remote !== null && remote !== undefined) {
        return { should: false, reason: 'a server roster already exists' };
    }
    const localCount = countRecords(local);
    if (localCount === 0) return { should: false, reason: 'nothing stored locally' };
    return { should: true, reason: `${localCount} local record(s) have never been synced` };
}
