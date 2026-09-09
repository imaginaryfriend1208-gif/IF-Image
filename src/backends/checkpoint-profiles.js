// IF Image - checkpoint-profile model (Phase R1, reworked in D9/D14). Pure
// functions only: no DOM, no fetch, no settings mutation — callers persist
// the returned values.
//
// A "checkpoint profile" binds a DISCOVERED checkpoint title to a prompt
// profile key (krea2/anima/illustrious) plus generation params (size/steps/
// cfg/sampler/scheduler). Since D14 the map is keyed by a UNIQUE PROFILE ID
// (not the checkpoint title), each row carries `checkpoint` (the title) and
// a display `name`, and `backends.a1111.activeProfileId` selects the one
// profile that drives generation — so one checkpoint can have any number of
// saved profiles. Rows are created ONLY when the user clicks "Save profile"
// in the Settings tab — discovery never seeds them. A profile changes prompt
// dialect and generation params only; the checkpoint actually sent to the
// server is always resolved separately via resolveCheckpoint() against fresh
// /sdapi/v1/sd-models discovery — never derived from a profile/family name.

import { PROFILES } from '../profiles.js';
import { clampDim, clampSteps, clampCfg } from '../prompt/render.js';

/**
 * Infer the prompt-profile key for a discovered model.
 * Explicit `family` from /internal/models wins; otherwise the title is
 * matched with the heuristics below; otherwise the fallback key.
 * @param {{title?: string, family?: string}} model
 * @param {string} fallbackKey e.g. settings.generation.profile
 * @returns {string} a PROFILES key
 */
export function inferProfileKey(model, fallbackKey) {
    const family = model && typeof model.family === 'string' ? model.family : '';
    if (PROFILES[family]) return family;
    const title = model && typeof model.title === 'string' ? model.title : '';
    if (/krea/i.test(title)) return 'krea2';
    if (/anima/i.test(title)) return 'anima';
    if (/illus|noob|pony|xl/i.test(title)) return 'illustrious';
    return fallbackKey;
}

/**
 * Canonical spelling key for sampler/scheduler names: lower-case, with
 * spaces/underscores/"++" collapsed so ComfyUI-style ids ("dpmpp_2m_sde",
 * "euler_ancestral") and A1111 display names ("DPM++ 2M SDE", "Euler a")
 * fall on the same key.
 */
function nameKey(name) {
    return String(name ?? '')
        .toLowerCase()
        .replace(/\+\+/g, 'pp')
        .replace(/_ancestral\b|\bancestral\b/g, ' a')
        .replace(/[\s_\-]+/g, '');
}

/**
 * Map a sampler/scheduler name coming from an enrichment source (e.g. the
 * proxy's /internal/models defaults, ComfyUI spelling) onto the name the
 * server actually lists in /sdapi/v1/samplers or /schedulers. Exact match
 * first, then the spelling-insensitive key. Returns the original string
 * when the discovered list is empty or has no match, so a value is never
 * silently dropped — the table shows it as "(not discovered)".
 * @param {string} name
 * @param {string[]} discovered
 * @returns {string}
 */
export function matchDiscoveredName(name, discovered) {
    if (typeof name !== 'string' || !name) return name;
    const list = Array.isArray(discovered) ? discovered.filter(v => typeof v === 'string') : [];
    if (list.includes(name)) return name;
    const key = nameKey(name);
    const hit = list.find(v => nameKey(v) === key);
    return hit ?? name;
}

/** Map /internal/models-style defaults onto override field names, clamped
 *  with the C0 policies. Unknown/invalid fields are simply absent. Sampler/
 *  scheduler names are aligned with the discovered lists when given. */
function overridesFromDefaults(defaults, { samplers, schedulers } = {}) {
    if (!defaults || typeof defaults !== 'object') return {};
    const out = {};
    const width = clampDim(defaults.width);
    const height = clampDim(defaults.height);
    const steps = clampSteps(defaults.steps);
    const cfg = clampCfg(defaults.cfg);
    if (width !== undefined) out.width = width;
    if (height !== undefined) out.height = height;
    if (steps !== undefined) out.steps = steps;
    if (cfg !== undefined) out.cfg = cfg;
    if (typeof defaults.sampler === 'string' && defaults.sampler) out.sampler = matchDiscoveredName(defaults.sampler, samplers);
    if (typeof defaults.scheduler === 'string' && defaults.scheduler) out.scheduler = matchDiscoveredName(defaults.scheduler, schedulers);
    return out;
}

/**
 * Size presets offered by the checkpoint-profile editor. Every pair is a
 * multiple of 64 inside the clampDim range. "custom" is implied for any
 * width/height not listed here (see matchSizePreset).
 * @type {ReadonlyArray<{key: string, label: string, width: number, height: number}>}
 */
export const SIZE_PRESETS = Object.freeze([
    { key: 'portrait', label: 'Portrait 2:3 (832×1216)', width: 832, height: 1216 },
    { key: 'landscape', label: 'Landscape 3:2 (1216×832)', width: 1216, height: 832 },
    { key: 'square', label: 'Square (1024×1024)', width: 1024, height: 1024 },
    { key: 'tall', label: 'Tall 9:16 (768×1344)', width: 768, height: 1344 },
    { key: 'wide', label: 'Wide 16:9 (1344×768)', width: 1344, height: 768 },
    { key: 'portrait_hd', label: 'Portrait HD (1024×1536)', width: 1024, height: 1536 },
    { key: 'landscape_hd', label: 'Landscape HD (1536×1024)', width: 1536, height: 1024 },
    { key: 'square_hd', label: 'Square HD (1536×1536)', width: 1536, height: 1536 },
]);

/**
 * Find the preset key for a width/height pair, or 'custom' when no preset
 * matches (including non-numeric input).
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function matchSizePreset(width, height) {
    const w = Number(width);
    const h = Number(height);
    const hit = SIZE_PRESETS.find(p => p.width === w && p.height === h);
    return hit ? hit.key : 'custom';
}

/**
 * Build a fully populated STARTING POINT for the checkpoint-profile editor
 * when the checkpoint has no saved profile yet. Prompt style comes from the
 * model's family hint or title; numeric fields come from the server's
 * per-model defaults (when /internal/models enrichment ran) and otherwise
 * from PROFILES[style]; sampler/scheduler are included only when the
 * server suggested them. Nothing is persisted — the user still has to click
 * "Save profile".
 * @param {{title?: string, family?: string, defaults?: object} | null | undefined} model
 * @param {string} fallbackKey profile key used when inference has no signal
 * @param {{samplers?: string[], schedulers?: string[]}} [discovered]
 * @returns {{profile: string, width: number, height: number, steps: number,
 *            cfg: number, sampler?: string, scheduler?: string, source: 'server' | 'profile'}}
 */
export function suggestCheckpointProfile(model, fallbackKey, discovered = {}) {
    const profileKey = inferProfileKey(model ?? {}, fallbackKey);
    const base = PROFILES[profileKey] ?? PROFILES.anima;
    const fromServer = overridesFromDefaults(model?.defaults, discovered);
    const hasServerNumbers = ['width', 'height', 'steps', 'cfg'].some(k => fromServer[k] !== undefined);
    const out = {
        profile: profileKey,
        width: fromServer.width ?? base.width,
        height: fromServer.height ?? base.height,
        steps: fromServer.steps ?? base.steps,
        cfg: fromServer.cfg ?? base.cfg,
        source: hasServerNumbers ? 'server' : 'profile',
    };
    if (fromServer.sampler) out.sampler = fromServer.sampler;
    if (fromServer.scheduler) out.scheduler = fromServer.scheduler;
    return out;
}

/**
 * Normalize editor form values into the persisted checkpoint-profile row
 * shape, or null when the row would be unusable (unknown profile key or no
 * checkpoint title — D14: a row must say which checkpoint it targets).
 * Numeric fields are clamped with the C0 policies and dropped when invalid;
 * blank sampler/scheduler are omitted (= let the server decide); a blank
 * display name falls back to the checkpoint title.
 * @param {{profile?: string, checkpoint?: unknown, name?: unknown,
 *          width?: unknown, height?: unknown, steps?: unknown,
 *          cfg?: unknown, sampler?: unknown, scheduler?: unknown}} form
 * @returns {{profile: string, checkpoint: string, name: string,
 *            width?: number, height?: number, steps?: number,
 *            cfg?: number, sampler?: string, scheduler?: string} | null}
 */
export function normalizeCheckpointProfile(form) {
    if (!form || typeof form !== 'object' || !PROFILES[form.profile]) return null;
    const checkpoint = typeof form.checkpoint === 'string' ? form.checkpoint.trim() : '';
    if (!checkpoint) return null;
    const name = typeof form.name === 'string' && form.name.trim() ? form.name.trim() : checkpoint;
    const out = { profile: form.profile, checkpoint, name };
    const width = clampDim(form.width);
    const height = clampDim(form.height);
    const steps = clampSteps(form.steps);
    const cfg = clampCfg(form.cfg);
    if (width !== undefined) out.width = width;
    if (height !== undefined) out.height = height;
    if (steps !== undefined) out.steps = steps;
    if (cfg !== undefined) out.cfg = cfg;
    if (typeof form.sampler === 'string' && form.sampler) out.sampler = form.sampler;
    if (typeof form.scheduler === 'string' && form.scheduler) out.scheduler = form.scheduler;
    return out;
}

/**
 * Align the sampler/scheduler spelling of EXISTING checkpoint-profile rows
 * with the server's discovered lists. Only rows whose current value is not
 * in the list but has a spelling-insensitive match are rewritten (e.g. a row
 * seeded before name matching existed with "euler" while the server lists
 * "Euler"). Values with no match are left verbatim (they still show as
 * "(not discovered)" in the table), so nothing the user typed is lost.
 * Returns a NEW object; entries that need no change are shared as-is.
 * @param {Record<string, object>} profiles settings.backends.a1111.checkpointProfiles
 * @param {{samplers?: string[], schedulers?: string[]}} discovered
 * @returns {{profiles: Record<string, object>, changed: number}}
 */
export function alignCheckpointProfileNames(profiles, { samplers, schedulers } = {}) {
    const base = profiles && typeof profiles === 'object' ? profiles : {};
    const out = {};
    let changed = 0;
    for (const [title, entry] of Object.entries(base)) {
        if (!entry || typeof entry !== 'object') { out[title] = entry; continue; }
        const sampler = typeof entry.sampler === 'string' && entry.sampler ? matchDiscoveredName(entry.sampler, samplers) : entry.sampler;
        const scheduler = typeof entry.scheduler === 'string' && entry.scheduler ? matchDiscoveredName(entry.scheduler, schedulers) : entry.scheduler;
        if (sampler === entry.sampler && scheduler === entry.scheduler) { out[title] = entry; continue; }
        out[title] = { ...entry };
        if (sampler !== entry.sampler) out[title].sampler = sampler;
        if (scheduler !== entry.scheduler) out[title].scheduler = scheduler;
        changed += 1;
    }
    return { profiles: out, changed };
}

/**
 * Look up a checkpoint-profile row by its unique profile id (D14 keying).
 * @param {object} settings live settings object (read-only here)
 * @param {string} profileId key into backends.a1111.checkpointProfiles
 * @returns {{profileKey: string, overrides: object} | null} overrides carry
 *   only generation params — checkpoint/name metadata is stripped.
 */
export function resolveCheckpointProfile(settings, profileId) {
    const entry = settings?.backends?.a1111?.checkpointProfiles?.[profileId];
    if (!entry || typeof entry !== 'object') return null;
    const profileKey = PROFILES[entry.profile] ? entry.profile : null;
    if (!profileKey) return null;
    const { profile, checkpoint, name, ...overrides } = entry;
    return { profileKey, overrides };
}

/**
 * The one saved profile that drives generation (Settings → "Checkpoint
 * profile (active)"). Null when none is selected, the row is gone, or the
 * row is unusable (unknown prompt style / no checkpoint title).
 * @param {object} settings live settings object (read-only here)
 * @returns {{id: string, entry: {profile: string, checkpoint: string,
 *            name?: string}} | null}
 */
export function getActiveProfile(settings) {
    const a1111 = settings?.backends?.a1111;
    const id = typeof a1111?.activeProfileId === 'string' ? a1111.activeProfileId : '';
    if (!id) return null;
    const entry = a1111?.checkpointProfiles?.[id];
    if (!entry || typeof entry !== 'object') return null;
    if (!PROFILES[entry.profile]) return null;
    if (typeof entry.checkpoint !== 'string' || !entry.checkpoint) return null;
    return { id, entry };
}

/**
 * Compute effective generation params through the full R1 precedence chain:
 *   PROFILES[profileKey]
 *   < settings.generation.params[profileKey]   (C0 per-profile overrides)
 *   < checkpointProfiles[profileId]            (saved-profile overrides)
 *   < markerOverrides                          (marker JSON size/steps/cfg)
 *   < llmOverrides                             (LLM <size> etc.)
 * Numeric values are clamped with the existing C0 policies (size [256,2048]
 * snapped to 64, steps [1,150], cfg [0,30]); width/height in marker/LLM
 * overrides apply only as a pair (aspect-ratio protection, same as C0).
 * D14: the saved-profile layer is looked up by `profileId`; `checkpointTitle`
 * is only stamped into params.checkpoint (the real server model title).
 * @param {{profileKey: string, checkpointTitle?: string, profileId?: string,
 *          settings: object, markerOverrides?: object, llmOverrides?: object}} args
 * @returns {{width: number, height: number, steps: number, cfg: number,
 *            sampler?: string, scheduler?: string, checkpoint?: string}}
 */
export function mergeParams({ profileKey, checkpointTitle, profileId, settings, markerOverrides, llmOverrides }) {
    const profile = PROFILES[profileKey] ?? PROFILES.anima;
    const params = {
        width: profile.width,
        height: profile.height,
        steps: profile.steps,
        cfg: profile.cfg,
    };
    const applyLayer = (layer, pairedSize) => {
        if (!layer || typeof layer !== 'object') return;
        const width = clampDim(layer.width);
        const height = clampDim(layer.height);
        if (pairedSize) {
            if (width !== undefined && height !== undefined) {
                params.width = width;
                params.height = height;
            }
        } else {
            if (width !== undefined) params.width = width;
            if (height !== undefined) params.height = height;
        }
        const steps = clampSteps(layer.steps);
        if (steps !== undefined) params.steps = steps;
        const cfg = clampCfg(layer.cfg);
        if (cfg !== undefined) params.cfg = cfg;
        if (typeof layer.sampler === 'string' && layer.sampler) params.sampler = layer.sampler;
        if (typeof layer.scheduler === 'string' && layer.scheduler) params.scheduler = layer.scheduler;
        // D2: seed override (marker JSON layer); integer >= -1, no clamping.
        if (Number.isInteger(layer.seed) && layer.seed >= -1) params.seed = layer.seed;
    };
    applyLayer(settings?.generation?.params?.[profileKey], false);
    if (profileId) {
        applyLayer(settings?.backends?.a1111?.checkpointProfiles?.[profileId], false);
    }
    if (checkpointTitle) params.checkpoint = checkpointTitle;
    applyLayer(markerOverrides, true);
    applyLayer(llmOverrides, true);
    return params;
}
