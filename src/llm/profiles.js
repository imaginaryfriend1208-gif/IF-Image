// IF Image - LLM profile and context-profile CRUD helpers.
// Profiles live in settings.llm.apiProfiles (API connection details) and
// settings.llm.contextProfiles (scene-window/roster configuration), plus
// settings.llm.requestMapping which maps request types to profile pairs.

export const API_PROFILE_EXPORT_FORMAT = 'ifimage-llm-profiles';
export const API_PROFILE_EXPORT_VERSION = 1;

const API_PROFILE_METHODS = new Set(['generateRaw', 'connection_manager', 'direct_fetch']);
const PROFILE_METHOD_ALIASES = Object.freeze({
    direct: 'generateRaw',
    st_generate_raw: 'generateRaw',
    st_connection_manager: 'connection_manager',
});

function normalizeProfileMethod(method) {
    const normalized = PROFILE_METHOD_ALIASES[method] ?? method;
    return API_PROFILE_METHODS.has(normalized) ? normalized : null;
}

function sanitizeProfileBaseUrl(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    try {
        const url = new URL(text);
        if (!['http:', 'https:'].includes(url.protocol)) return '';
        url.username = '';
        url.password = '';
        url.hash = '';
        for (const key of [...url.searchParams.keys()]) {
            if (/^(?:x[-_]?api[-_]?key|api[_-]?key|access[_-]?token|token|authorization|auth|secret|password)$/i.test(key)) {
                url.searchParams.delete(key);
            }
        }
        return url.toString();
    } catch {
        // A malformed URL cannot be safely inspected for embedded secrets.
        return '';
    }
}

function boundedNumber(value, fallback, min, max, integer = false) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const bounded = Math.min(max, Math.max(min, number));
    return integer ? Math.round(bounded) : bounded;
}

function portableApiProfile(profile) {
    return {
        id: String(profile?.id ?? '').trim(),
        name: String(profile?.name ?? '').trim(),
        method: normalizeProfileMethod(profile?.method) ?? 'generateRaw',
        stProfileId: typeof profile?.stProfileId === 'string' ? profile.stProfileId : '',
        baseUrl: sanitizeProfileBaseUrl(profile?.baseUrl),
        model: typeof profile?.model === 'string' ? profile.model.trim() : '',
        temperature: boundedNumber(profile?.temperature, 0.7, 0, 2),
        maxTokens: boundedNumber(profile?.maxTokens, 4096, 1, 32768, true),
    };
}

/**
 * Create a new API profile with safe defaults.
 * @param {string} [name] - display name
 * @returns {object}
 */
export function createDefaultApiProfile(name = 'New API Profile') {
    return {
        id: crypto.randomUUID ? crypto.randomUUID() : 'ap_' + Date.now(),
        name,
        method: 'generateRaw', // generateRaw | connection_manager | direct_fetch
        // For method 'connection_manager': the id of a profile saved in
        // SillyTavern's own Connection Manager. Credentials stay on the
        // host; only this reference is stored here.
        stProfileId: '',
        baseUrl: '',
        apiKey: '',
        model: '',
        temperature: 0.7,
        maxTokens: 4096,
    };
}

/**
 * Create a new context profile with safe defaults.
 * @param {string} [name]
 * @returns {object}
 */
export function createDefaultContextProfile(name = 'New Context Profile') {
    return {
        id: crypto.randomUUID ? crypto.randomUUID() : 'cp_' + Date.now(),
        name,
        sceneWindow: 4,
        scope: 'scene',     // 'scene' | 'last' | 'raw'
        includeWorldbook: false,
        includeCharCard: true,
        includePersona: true,
    };
}

/**
 * Get the API profile array (mutates in place).
 * @param {object} settings
 * @returns {Array<object>}
 */
export function getApiProfiles(settings) {
    if (!settings.llm) settings.llm = {};
    if (!Array.isArray(settings.llm.apiProfiles)) settings.llm.apiProfiles = [];
    return settings.llm.apiProfiles;
}

/**
 * Get the context profile array.
 * @param {object} settings
 * @returns {Array<object>}
 */
export function getContextProfiles(settings) {
    if (!settings.llm) settings.llm = {};
    if (!Array.isArray(settings.llm.contextProfiles)) settings.llm.contextProfiles = [];
    return settings.llm.contextProfiles;
}

/**
 * Get the request mapping object.
 * @param {object} settings
 * @returns {object}
 */
export function getRequestMapping(settings) {
    if (!settings.llm) settings.llm = {};
    if (!settings.llm.requestMapping || typeof settings.llm.requestMapping !== 'object') {
        settings.llm.requestMapping = {};
    }
    return settings.llm.requestMapping;
}

/**
 * Look up an API profile by id.
 */
export function getApiProfileById(settings, id) {
    return getApiProfiles(settings).find(p => p.id === id) ?? null;
}

/**
 * Look up a context profile by id.
 */
export function getContextProfileById(settings, id) {
    return getContextProfiles(settings).find(p => p.id === id) ?? null;
}

/**
 * Save (upsert) an API profile.
 * @param {object} settings
 * @param {object} profile - must have .id
 */
export function saveApiProfile(settings, profile) {
    if (!profile?.id) throw new Error('API profile must have an id.');
    const list = getApiProfiles(settings);
    const idx = list.findIndex(p => p.id === profile.id);
    if (idx >= 0) list[idx] = profile;
    else list.push(profile);
}

/**
 * Save (upsert) a context profile.
 */
export function saveContextProfile(settings, profile) {
    if (!profile?.id) throw new Error('Context profile must have an id.');
    const list = getContextProfiles(settings);
    const idx = list.findIndex(p => p.id === profile.id);
    if (idx >= 0) list[idx] = profile;
    else list.push(profile);
}

/**
 * Delete an API profile by id. Also cleans up requestMapping references.
 */
export function deleteApiProfile(settings, id) {
    const list = getApiProfiles(settings);
    settings.llm.apiProfiles = list.filter(p => p.id !== id);
    // Remove mapping references
    const mapping = getRequestMapping(settings);
    for (const key of Object.keys(mapping)) {
        if (mapping[key]?.apiProfileId === id) mapping[key].apiProfileId = '';
    }
}

/**
 * Delete a context profile by id. Also cleans up requestMapping references.
 */
export function deleteContextProfile(settings, id) {
    const list = getContextProfiles(settings);
    settings.llm.contextProfiles = list.filter(p => p.id !== id);
    const mapping = getRequestMapping(settings);
    for (const key of Object.keys(mapping)) {
        if (mapping[key]?.contextProfileId === id) mapping[key].contextProfileId = '';
    }
}

/**
 * Get the resolved mapping for a request type (e.g. 'image_gen').
 * Returns { apiProfile, contextProfile } or nulls for missing profiles.
 */
export function resolveRequestMapping(settings, requestType) {
    const mapping = getRequestMapping(settings)[requestType] ?? {};
    return {
        apiProfile: mapping.apiProfileId ? getApiProfileById(settings, mapping.apiProfileId) : null,
        contextProfile: mapping.contextProfileId ? getContextProfileById(settings, mapping.contextProfileId) : null,
    };
}

/**
 * Build a portable API-profile document. API keys are intentionally omitted,
 * and credentials embedded in direct-fetch URLs are removed.
 */
export function buildApiProfileExport(settings, { profileIds } = {}) {
    const selected = Array.isArray(profileIds) ? new Set(profileIds) : null;
    const profiles = getApiProfiles(settings)
        .filter(profile => !selected || selected.has(profile.id))
        .map(portableApiProfile);
    return {
        format: API_PROFILE_EXPORT_FORMAT,
        version: API_PROFILE_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        credentialsIncluded: false,
        profiles,
    };
}

/** Validate and normalize a portable profile document without mutating it. */
export function validateApiProfileImport(document) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw new Error('LLM profile import must be a JSON object.');
    }
    if (document.format !== API_PROFILE_EXPORT_FORMAT) {
        throw new Error(`Unsupported LLM profile format. Expected "${API_PROFILE_EXPORT_FORMAT}".`);
    }
    if (document.version !== API_PROFILE_EXPORT_VERSION) {
        throw new Error(`Unsupported LLM profile version: ${document.version ?? '(missing)'}.`);
    }
    if (!Array.isArray(document.profiles) || document.profiles.length === 0) {
        throw new Error('LLM profile import contains no profiles.');
    }

    const seen = new Set();
    const profiles = document.profiles.map((source, index) => {
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
            throw new Error(`Profile ${index + 1} must be an object.`);
        }
        const profile = portableApiProfile(source);
        if (!profile.id) throw new Error(`Profile ${index + 1} has no id.`);
        if (!profile.name) throw new Error(`Profile ${index + 1} has no name.`);
        if (!normalizeProfileMethod(source.method)) {
            throw new Error(`Profile "${profile.name}" has an unsupported method.`);
        }
        if (seen.has(profile.id)) throw new Error(`Duplicate profile id: ${profile.id}`);
        seen.add(profile.id);
        if (profile.method === 'direct_fetch' && (!profile.baseUrl || !profile.model)) {
            throw new Error(`Direct-fetch profile "${profile.name}" requires a safe base URL and model.`);
        }
        // Never trust a credential field in an imported document, including
        // manually crafted files that did not come from our exporter.
        return { ...profile, apiKey: '' };
    });
    return { profiles };
}

/**
 * Merge imported profiles into settings. Conflict matching is by id; in
 * "copy" mode a conflicting profile receives a fresh id and "(Imported)".
 */
export function importApiProfiles(settings, document, { conflict = 'copy' } = {}) {
    if (!['copy', 'replace', 'skip'].includes(conflict)) {
        throw new Error(`Unsupported conflict mode: ${conflict}`);
    }
    const { profiles } = validateApiProfileImport(document);
    const target = getApiProfiles(settings);
    const result = { added: 0, replaced: 0, skipped: 0, profiles: [] };

    for (const incoming of profiles) {
        const index = target.findIndex(profile => profile.id === incoming.id);
        if (index < 0) {
            target.push(incoming);
            result.added += 1;
            result.profiles.push(incoming);
            continue;
        }
        if (conflict === 'skip') {
            result.skipped += 1;
            continue;
        }
        if (conflict === 'replace') {
            // Portable imports must not erase a key already stored locally.
            const replacement = { ...incoming, apiKey: target[index]?.apiKey ?? '' };
            target[index] = replacement;
            result.replaced += 1;
            result.profiles.push(replacement);
            continue;
        }
        const copy = {
            ...incoming,
            id: crypto.randomUUID ? crypto.randomUUID() : `ap_${Date.now()}_${result.added}`,
            name: `${incoming.name} (Imported)`,
        };
        target.push(copy);
        result.added += 1;
        result.profiles.push(copy);
    }
    return result;
}
