// IF Image - SillyTavern third-party image generation extension.
// Standalone: fetches NovelAI and the user's SD WebUI backends directly,
// never uses ST secrets or ST server APIs for generation.

import { getSettings, saveSettings } from './src/settings.js';
import { NaiClient } from './src/backends/nai.js';
import { ComfyProxyClient } from './src/backends/comfy.js';
import { A1111Client } from './src/backends/a1111.js';
import { renderDrawer } from './src/ui.js';
import { createMarkerRuntime } from './src/runtime/events.js';
import { createTaskQueue } from './src/runtime/tasks.js';
import { createExecutor } from './src/runtime/executor.js';
import { createMarkerPipeline } from './src/runtime/marker-pipeline.js';
import { replaceMarkers, createSlotElement, renderSlotState, renderImageFrame, openLightbox, contentHash } from './src/runtime/insert.js';
import { saveImageRecord, getImagesForMessage } from './src/storage/images.js';
import { getAllCharacters } from './src/storage/chars.js';
import { getAllStyles, getAllPersonas } from './src/storage/presets.js';
import { parseTriggers } from './src/prompt/triggers.js';
import { assemblePrompt, resolveProfileKey } from './src/prompt/render.js';
import { PROFILES } from './src/profiles.js';
import { event_types, eventSource } from '../../../../script.js';
import { getContext } from '../../../st-context.js';

// toastr is a page global (loaded via <script src="lib/toastr.min.js"> in index.html);
// ST extensions use it without importing it.
/* global toastr */

// ------------------------------------------------------------------
// Runtime-only settings fields — written at UI or pipeline time but
// absent from defaultSettings (src/settings.js is off-limits here).
// Phase B: promote to defaultSettings + add migrator v4.
//   settings.generation.backend  ('comfy' | 'nai') — default backend for chat gen
//   settings.generation.profile  (PROFILE_KEYS string) — default profile
//   settings.backends.comfy.proxyModel — selected proxy checkpoint title
// ------------------------------------------------------------------

const settings = getSettings();

const nai = new NaiClient(() => settings.backends.nai.apiKey);
const comfy = new ComfyProxyClient({
    getBaseUrl: () => settings.backends.comfy.baseUrl,
    getUsername: () => settings.backends.comfy.username,
    getPassword: () => settings.backends.comfy.password,
});
// AUTOMATIC1111-compatible hosted API. The Authentication string is passed
// through verbatim (ST getBasicAuthHeader semantics: UTF-8 base64 of the raw
// string, no colon insertion, no Bearer fallback).
const a1111 = new A1111Client({
    getBaseUrl: () => settings.backends.a1111.baseUrl,
    getAuth: () => settings.backends.a1111.auth,
});

function notify(kind, message) {
    if (typeof toastr !== 'undefined' && typeof toastr[kind] === 'function') toastr[kind](message, 'IF Image');
}

/** Effective backend kind for chat generation, derived from persisted settings. */
function defaultBackendKind() {
    const pref = settings.generation.backend;   // null-safe: undefined !== 'nai'
    if (pref === 'nai') return 'nai';
    return settings.backends.comfy.connection === 'a1111' ? 'a1111' : 'comfy';
}

function defaultProfileKey() {
    // null-safe: undefined → fallback chain
    return settings.generation.profile || settings.backends.comfy.profile || 'anima';
}

function messageElement(id) {
    return document.querySelector(`#chat .mes[mesid="${id}"] .mes_text`);
}

jQuery(async () => {
    const drawer = renderDrawer({ settings, save: saveSettings, nai, comfy, a1111 });
    $('#extensions_settings2').append(drawer);
    notify('info', 'IF Image loaded. Configure backends in the extensions drawer.');

    // ------------------------------------------------------------------
    // Roster cache (characters/styles/persona) — refreshed on chat change.
    // Async loads are epoch-guarded so a stale load never overwrites the
    // cache after a newer refresh has started.
    // ------------------------------------------------------------------
    let roster = { characters: [], styles: [], persona: null };
    let rosterEpoch = 0;
    async function refreshRoster() {
        rosterEpoch += 1;
        const epoch = rosterEpoch;
        try {
            const [characters, styles, personas] = await Promise.all([getAllCharacters(), getAllStyles(), getAllPersonas()]);
            if (epoch !== rosterEpoch) return;
            roster = { characters, styles, persona: personas[0] ?? null };
        } catch (err) {
            if (epoch !== rosterEpoch) return;
            console.warn('[IF Image] Roster load failed:', err?.message ?? err);
        }
    }
    refreshRoster();

    // ------------------------------------------------------------------
    // Queue + pipeline
    // ------------------------------------------------------------------
    const execute = createExecutor({ nai, comfy, a1111, getSettings: () => settings });

    function compile(content) {
        const parsed = parseTriggers(content, {
            roster: roster.characters,
            styles: roster.styles,
            defaultPersona: roster.persona,
        });
        const { profileKey } = resolveProfileKey(parsed.dialectOverride, defaultProfileKey());
        const profile = PROFILES[profileKey] ?? PROFILES.anima;
        const assembled = assemblePrompt(parsed, profile.dialect, profile);
        return {
            profileKey,
            envelope: {
                prompt: assembled.prompt,
                negative: assembled.negative,
                params: { ...assembled.params, seed: -1 },
            },
        };
    }

    const pipeline = createMarkerPipeline({
        getQueue: () => queue,
        compile,
        getImagesForMessage,
        saveImageRecord,
        contentHash,
        defaultBackendKind,
        defaultProfileKey,
        notify,
        doc: document,
        createSlotElement,
        renderSlotState,
        renderImageFrame,
        openLightbox,
        replaceMarkers,
        getMessage: id => getContext().chat?.[id],
        getMessageElement: messageElement,
        getSettings: () => settings,
        getCurrentChatId: () => getContext().getCurrentChatId(),
    });

    // The queue's onStateChange must call the pipeline's handler; the
    // pipeline in turn resolves the queue lazily via getQueue() above, so
    // construction order here (pipeline first, queue second) is safe.
    const queue = createTaskQueue({
        execute,
        concurrency: 1,
        maxQueued: 20,
        timeoutMs: 300000,
        onStateChange: pipeline.onTaskStateChange,
    });

    // ------------------------------------------------------------------
    // Runtime registration and lifecycle.
    // ------------------------------------------------------------------
    const runtime = createMarkerRuntime({
        eventSource,
        eventTypes: event_types,
        getChatId: () => getContext().getCurrentChatId(),
        getMessage: (id) => getContext().chat?.[id],
        getMessageElement: messageElement,
        isStreaming: (id) => {
            const stream = getContext().streamingProcessor;
            return Boolean(stream && !stream.isStopped && Number(stream.messageId) === id);
        },
        settings,
        onMarker: pipeline.onMarker,
        onChatWillChange: (previous) => {
            queue.cancelAllForChat(previous);
            pipeline.forgetChat(previous);
        },
        onChatChanged: () => { refreshRoster(); },
        onDispose: () => { queue.cancelAll(); },
    });
    runtime.register();

    // Restore listener: registered AFTER the runtime so it runs after
    // detection on the same event. Handles re-renders/swipes where the
    // runtime dedups (no onMarker) but the marker text is back in the DOM.
    const restoreEvents = ['USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED']
        .map(name => event_types[name]).filter(Boolean);
    const onRendered = (id) => {
        if (!settings.enabled || !settings.generation.enabled) return;
        const messageId = Number(id);
        if (!Number.isSafeInteger(messageId) || messageId < 0) return;
        const chatId = getContext().getCurrentChatId();
        pipeline.scheduleDomPass(chatId, messageId);
    };
    for (const type of restoreEvents) eventSource.on(type, onRendered);

    $(window).on('beforeunload.if_image', () => {
        for (const type of restoreEvents) eventSource.removeListener(type, onRendered);
        runtime.unregister();
        queue.dispose();
        pipeline.disposeAll();
    });
});
