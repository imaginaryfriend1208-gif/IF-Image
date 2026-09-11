// IF Image - Shared effective generation-context resolution.
// Pure and dependency-free: index.js supplies current settings/roster/chat
// metadata, while both the LLM planner and compiler consume the same result.

import { getActiveProfile } from '../backends/checkpoint-profiles.js';
import { PROFILES } from '../profiles.js';
import { resolveActiveStyle } from './active-style.js';
import { resolveProfileKey } from './render.js';

/** Effective backend kind for chat generation. */
export function resolveBackendKind(settings = {}) {
    if (settings.generation?.backend === 'nai') return 'nai';
    return settings.backends?.comfy?.connection === 'a1111' ? 'a1111' : 'comfy';
}

/**
 * Resolve checkpoint profile, prompt dialect, and deterministic active style.
 * Marker directives remain authoritative when parsedTriggers is supplied.
 */
export function resolveGenerationContext({
    settings = {}, roster = {}, chatStyleId = '', parsedTriggers = null,
} = {}) {
    const backendKind = resolveBackendKind(settings);
    const activeCheckpointProfile = backendKind === 'a1111' ? getActiveProfile(settings) : null;
    const configuredProfileKey = activeCheckpointProfile?.entry?.profile
        ?? settings.generation?.profile
        ?? settings.backends?.comfy?.profile
        ?? 'anima';
    const dialectOverride = parsedTriggers?.dialectOverride ?? null;
    const resolvedProfile = resolveProfileKey(dialectOverride, configuredProfileKey);
    const profileKey = PROFILES[resolvedProfile.profileKey] ? resolvedProfile.profileKey : 'anima';
    const profile = PROFILES[profileKey] ?? PROFILES.anima;
    const styles = Array.isArray(roster.styles) ? roster.styles : [];
    const explicitStyles = Array.isArray(parsedTriggers?.styles) ? parsedTriggers.styles : [];
    const activeStyle = resolveActiveStyle({
        explicitStyles,
        chatStyleId,
        defaultStyleId: settings.generation?.defaultStyleId,
        styles,
    });
    const checkpointTitle = backendKind === 'a1111'
        ? (activeCheckpointProfile?.entry?.checkpoint
            || settings.generation?.checkpoint
            || settings.backends?.a1111?.checkpoint
            || '')
        : '';

    return {
        backendKind,
        activeCheckpointProfile,
        checkpointTitle,
        configuredProfileKey,
        profileKey,
        profile,
        dialectKey: profile.dialect ?? 'anima',
        activeStyle,
        usedDialectOverride: resolvedProfile.usedOverride,
    };
}
