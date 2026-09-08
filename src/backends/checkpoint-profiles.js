// IF Image - checkpoint-profile model (Phase R1). Pure functions only: no
// DOM, no fetch, no settings mutation — callers persist the returned values.
//
// A "checkpoint profile" binds a DISCOVERED checkpoint title to a prompt
// profile key (krea2/anima/illustrious) plus optional per-checkpoint param
// overrides. It changes prompt dialect and generation params only; the
// checkpoint actually sent to the server is always resolved separately via
// resolveCheckpoint() against fresh /sdapi/v1/sd-models discovery — never
// derived from a profile/family name.

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
 * Seed the checkpoint-profile map from a discovery result. Returns a NEW
 * object: every entry already in `existing` is kept untouched (user edits
 * always survive a re-seed); entries are ADDED only for titles missing from
 * `existing`, with the inferred profile and any discovery defaults mapped to
 * override fields.
 * @param {Record<string, object>} existing settings.backends.a1111.checkpointProfiles
 * @param {Array<{title: string, family?: string, defaults?: object}>} models
 * @param {string} fallbackKey profile key used when inference has no signal
 * @param {{samplers?: string[], schedulers?: string[]}} [discovered] server
 *   sampler/scheduler lists; default sampler/scheduler names are aligned to
 *   these spellings (e.g. "euler" -> "Euler") when a match exists.
 * @returns {Record<string, object>}
 */
export function seedCheckpointProfiles(existing, models, fallbackKey, discovered = {}) {
    const base = existing && typeof existing === 'object' ? existing : {};
    const out = { ...base };
    for (const model of Array.isArray(models) ? models : []) {
        const title = model && typeof model.title === 'string' ? model.title : '';
        if (!title || out[title]) continue;
        out[title] = {
            profile: inferProfileKey(model, fallbackKey),
            ...overridesFromDefaults(model.defaults, discovered),
        };
    }
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
 * Look up the checkpoint profile for a title.
 * @param {object} settings live settings object (read-only here)
 * @param {string} title checkpoint title
 * @returns {{profileKey: string, overrides: object} | null}
 */
export function resolveCheckpointProfile(settings, title) {
    const entry = settings?.backends?.a1111?.checkpointProfiles?.[title];
    if (!entry || typeof entry !== 'object') return null;
    const profileKey = PROFILES[entry.profile] ? entry.profile : null;
    if (!profileKey) return null;
    const { profile, ...overrides } = entry;
    return { profileKey, overrides };
}

/**
 * Compute effective generation params through the full R1 precedence chain:
 *   PROFILES[profileKey]
 *   < settings.generation.params[profileKey]   (C0 per-profile overrides)
 *   < checkpointProfiles[checkpointTitle]      (per-checkpoint overrides)
 *   < markerOverrides                          (marker JSON size/steps/cfg)
 *   < llmOverrides                             (LLM <size> etc.)
 * Numeric values are clamped with the existing C0 policies (size [256,2048]
 * snapped to 64, steps [1,150], cfg [0,30]); width/height in marker/LLM
 * overrides apply only as a pair (aspect-ratio protection, same as C0).
 * @param {{profileKey: string, checkpointTitle?: string, settings: object,
 *          markerOverrides?: object, llmOverrides?: object}} args
 * @returns {{width: number, height: number, steps: number, cfg: number,
 *            sampler?: string, scheduler?: string, checkpoint?: string}}
 */
export function mergeParams({ profileKey, checkpointTitle, settings, markerOverrides, llmOverrides }) {
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
    if (checkpointTitle) {
        applyLayer(settings?.backends?.a1111?.checkpointProfiles?.[checkpointTitle], false);
        params.checkpoint = checkpointTitle;
    }
    applyLayer(markerOverrides, true);
    applyLayer(llmOverrides, true);
    return params;
}
