// IF Image - LLM profile and context-profile CRUD helpers.
// Profiles live in settings.llm.apiProfiles (API connection details) and
// settings.llm.contextProfiles (scene-window/roster configuration), plus
// settings.llm.requestMapping which maps request types to profile pairs.

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
