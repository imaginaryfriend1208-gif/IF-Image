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
import { replaceMarkers, createSlotElement, renderSlotState, renderImageFrame, renderRegenerateChip, renderIdleChip, openLightbox, contentHash } from './src/runtime/insert.js';
import { saveImageRecord, getImagesForMessage, getImageRecord, deleteImageRecord } from './src/storage/images.js';
import { getAllCharacters } from './src/storage/chars.js';
import { getAllStyles, getAllPersonas, getReplaceRules } from './src/storage/presets.js';
import { getAllOutfits } from './src/storage/outfits.js';
import { resolveActiveCharacters } from './src/prompt/binding.js';
import { parseTriggers } from './src/prompt/triggers.js';
import { assemblePrompt, resolveProfileKey, mergeProfileParams, applyMarkerParamOverrides, resolveLockedSeed, resolveSizeKeyword } from './src/prompt/render.js';
import { resolveCheckpointProfile, mergeParams } from './src/backends/checkpoint-profiles.js';
import { cleanupEnvelope } from './src/prompt/cleanup.js';
import { applyReplaceRules } from './src/prompt/replace.js';
import { PROFILES } from './src/profiles.js';
import { createEngine } from './src/llm/engine.js';
import { parseLlmReply } from './src/llm/parser.js';
import { event_types, eventSource } from '../../../../script.js';
import { getContext } from '../../../st-context.js';

// toastr is a page global (loaded via <script src="lib/toastr.min.js"> in index.html);
// ST extensions use it without importing it.
/* global toastr */

// ------------------------------------------------------------------
// Settings and backend clients
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
    // ------------------------------------------------------------------
    // Roster cache (characters/styles/persona/outfits) — refreshed on chat
    // change. Async loads are epoch-guarded so a stale load never overwrites
    // the cache after a newer refresh has started.
    // ------------------------------------------------------------------
    let roster = { characters: [], styles: [], persona: null, outfits: [], replaceRules: [] };
    let rosterEpoch = 0;
    async function refreshRoster() {
        rosterEpoch += 1;
        const epoch = rosterEpoch;
        try {
            const [characters, styles, personas, outfits, replaceRules] = await Promise.all([
                getAllCharacters(), getAllStyles(), getAllPersonas(), getAllOutfits(), getReplaceRules(),
            ]);
            if (epoch !== rosterEpoch) return;
            const persona = personas.find(p => p.isDefault) ?? personas[0] ?? null;
            roster = { characters, styles, persona, outfits, replaceRules };
        } catch (err) {
            if (epoch !== rosterEpoch) return;
            console.warn('[IF Image] Roster load failed:', err?.message ?? err);
        }
    }
    refreshRoster();

    // ------------------------------------------------------------------
    // C4: active character resolution. The current card id (avatar
    // filename) and chat id gate which characters resolveActiveCharacters()
    // returns as the "active" subset fed to parseTriggers; characters bound
    // elsewhere remain resolvable through the fallback tiers (with a
    // toastr warning) inside parseTriggers itself.
    // ------------------------------------------------------------------
    function currentCardId() {
        try {
            const ctx = getContext();
            return ctx.characters?.[ctx.characterId]?.avatar ?? null;
        } catch {
            return null;
        }
    }

    // ------------------------------------------------------------------
    // Queue + pipeline
    // ------------------------------------------------------------------
    const execute = createExecutor({ nai, comfy, a1111, getSettings: () => settings });

    function compile(content) {
        const activeRoster = resolveActiveCharacters(roster.characters, currentCardId(), getContext().getCurrentChatId?.());
        const parsed = parseTriggers(content, {
            roster: activeRoster,
            fullRoster: roster.characters,
            styles: roster.styles,
            defaultPersona: roster.persona,
            outfits: roster.outfits,
            onFallback: (tier, token) => notify('warning', `Character trigger "$${token}" resolved via ${tier} fallback (not active for this chat/card).`),
        });
        // R2: with the A1111-compatible SD connection, the selected
        // checkpoint's profile becomes the configured default (still beaten
        // by a marker {{dialect}} override). The checkpoint itself is NEVER
        // derived from the profile — only the reverse.
        const backendKind = defaultBackendKind();
        const checkpointTitle = backendKind === 'a1111'
            ? (settings.generation?.checkpoint || settings.backends.a1111.checkpoint || '')
            : '';
        const checkpointProfile = checkpointTitle ? resolveCheckpointProfile(settings, checkpointTitle) : null;
        const configuredProfileKey = checkpointProfile?.profileKey ?? defaultProfileKey();
        const { profileKey } = resolveProfileKey(parsed.dialectOverride, configuredProfileKey);
        const baseProfile = PROFILES[profileKey] ?? PROFILES.anima;
        const effectiveProfile = mergeProfileParams(baseProfile, settings.generation?.params?.[profileKey]);
        const assembled = assemblePrompt(parsed, baseProfile.dialect, effectiveProfile);

        // Pipeline order (C6/C7): compile -> non-final replace rules ->
        // cleanup -> final replace rules -> marker JSON param overrides.
        const isNsfw = parsed.characters.some(c => (c.modifiers || []).includes('nsfw'));
        const isBack = parsed.characters.some(c => (c.modifiers || []).includes('back'));
        const isFull = parsed.characters.some(c => (c.modifiers || []).includes('full'));
        const ruleCtx = { dialect: baseProfile.dialect, nsfw: isNsfw, back: isBack, full: isFull };
        const rules = roster.replaceRules || [];
        let envelope = applyReplaceRules(assembled, rules, 'pre', ruleCtx);
        envelope = cleanupEnvelope(envelope, baseProfile.dialect, {
            avoidTags: roster.persona?.avoidTags,
            rating: isNsfw ? 'nsfw' : 'sfw',
        });
        envelope = applyReplaceRules(envelope, rules, 'final', ruleCtx);

        const params = { ...envelope.params, seed: -1 };
        // D3: resolve a portrait/landscape/square keyword into the numeric
        // pair for THIS profile, so both param paths below see plain numbers.
        const markerOverrides = resolveSizeKeyword(parsed.paramOverrides, profileKey);
        // D2: character seed lock (single resolved character only; marker
        // JSON seed beats the lock) — logic lives in render.js for testing.
        const lockedSeed = resolveLockedSeed(parsed.characters, markerOverrides);
        if (lockedSeed !== undefined) params.seed = lockedSeed;
        if (backendKind === 'a1111' && checkpointTitle) {
            // R2: five-layer numeric precedence (PROFILES < settings params
            // < checkpoint profile < marker JSON; LLM <size> is applied
            // later by the pipeline's applyOverrides). checkpoint/sampler/
            // scheduler ride on params so they survive the queue's declared
            // snapshot projection (prompt envelope is cloned whole).
            const merged = mergeParams({
                profileKey,
                checkpointTitle,
                settings,
                markerOverrides,
            });
            Object.assign(params, merged);
        } else {
            // Legacy proxy and NAI paths: unchanged C0 behavior.
            applyMarkerParamOverrides(params, markerOverrides);
        }
        return {
            profileKey,
            envelope: {
                prompt: envelope.prompt,
                negative: envelope.negative,
                params,
                // C8: per-character rendered strings; NaiClient uses them as
                // characterPrompts/char_captions when there are 2+ entries.
                // SD backends ignore this field (already merged into prompt).
                characters: Array.isArray(envelope.characters) ? envelope.characters : [],
            },
        };
    }

    // ------------------------------------------------------------------
    // Generation log ring buffer (B7)
    // ------------------------------------------------------------------
    const genLog = [];
    function logEvent(type, detail) {
        const limit = settings.generation?.logLimit ?? 50;
        genLog.push({ timestamp: Date.now(), type, ...detail });
        while (genLog.length > limit) genLog.shift();
    }

    // ------------------------------------------------------------------
    // LLM rewrite engine (B6). The pipeline calls `rewriteWithAbort` for
    // assist/full markers; chat switch aborts every in-flight call.
    // ------------------------------------------------------------------
    const engine = createEngine({
        getSettings: () => settings,
        getContext: () => getContext(),
        roster: () => roster,
        substituteParams: (s) => {
            try { return getContext().substituteParams?.(s) ?? s; } catch { return s; }
        },
        compile,
        notify,
    });

    const activeLlmAborts = new Set();
    async function rewriteWithAbort(content, opts = {}) {
        const controller = new AbortController();
        activeLlmAborts.add(controller);
        logEvent('llm_request', { content: String(content).slice(0, 200) });
        try {
            const result = await engine.rewrite(content, { ...opts, signal: controller.signal });
            logEvent('llm_reply', { method: result.method, entries: result.entries.length, error: result.error });
            return result;
        } finally {
            activeLlmAborts.delete(controller);
        }
    }
    function abortAllLlm() {
        for (const controller of activeLlmAborts) controller.abort();
        activeLlmAborts.clear();
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
        renderRegenerateChip,
        renderIdleChip,
        openLightbox,
        deleteImageRecord,
        replaceMarkers,
        rewrite: rewriteWithAbort,
        logEvent,
        getMessage: id => getContext().chat?.[id],
        getMessageElement: messageElement,
        getSettings: () => settings,
        getCurrentChatId: () => getContext().getCurrentChatId(),
    });

    // C10: Gallery-tab regeneration waits on a specific task id's terminal
    // state. This map is separate from the marker-pipeline's own bookkeeping
    // (which owns in-chat slots) — the queue's single onStateChange fans out
    // to both so Gallery regen and marker generation share the SAME queue,
    // never a parallel execution path.
    const regenWaiters = new Map(); // taskId -> { resolve, reject }

    // The queue's onStateChange must call the pipeline's handler; the
    // pipeline in turn resolves the queue lazily via getQueue() above, so
    // construction order here (pipeline first, queue second) is safe.
    const queue = createTaskQueue({
        execute,
        concurrency: 1,
        maxQueued: 20,
        timeoutMs: 300000,
        onStateChange: (snapshot) => {
            pipeline.onTaskStateChange(snapshot);
            const waiter = regenWaiters.get(snapshot.id);
            if (!waiter) return;
            if (snapshot.status === 'succeeded') {
                regenWaiters.delete(snapshot.id);
                waiter.resolve(snapshot.result);
            } else if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
                regenWaiters.delete(snapshot.id);
                waiter.reject(new Error(snapshot.error?.message || `Image generation ${snapshot.status}.`));
            }
        },
    });

    // ------------------------------------------------------------------
    // C10: Gallery-tab regeneration. Reuses the SAME queue/executor as
    // marker generation (no parallel execution path) with seed -1, then
    // saves a NEW record carrying the same chat/message/swipe/occurrence/
    // content lineage as the source record — so it restores in-chat like any
    // other generation for that marker.
    // ------------------------------------------------------------------
    /**
     * Re-enqueue a gallery record and save the result as a NEW record.
     * D2: options.seed — pass record.seed to reproduce the exact image
     * (gallery "Repro"); default -1 keeps the classic random regenerate.
     */
    async function regenerateImageRecord(record, { seed = -1 } = {}) {
        if (!record) throw new Error('regenerateImageRecord: record is required.');
        const backendKind = record.backend || defaultBackendKind();
        const profileKey = record.profileKey || defaultProfileKey();
        const params = { ...(record.params || {}), seed };
        // R2: a regenerated image must use the same model as the original.
        // Fall back to the current selection only when the record has none
        // (pre-R2 records).
        if (backendKind === 'a1111') {
            params.checkpoint = record.checkpoint
                || params.checkpoint
                || settings.generation?.checkpoint
                || settings.backends.a1111.checkpoint
                || '';
        }
        const characters = Array.isArray(record.characters) ? record.characters : [];
        const taskId = queue.addTask({
            chatId: record.chatId,
            messageId: record.messageId,
            swipeId: record.swipeId,
            occurrence: record.occurrence,
            prompt: { prompt: record.prompt, negative: record.negative, params, characters },
            backend: { kind: backendKind },
            profile: profileKey,
        });
        const result = await new Promise((resolve, reject) => {
            regenWaiters.set(taskId, { resolve, reject });
        });
        return saveImageRecord({
            chatId: record.chatId,
            messageId: record.messageId,
            swipeId: record.swipeId,
            occurrence: record.occurrence,
            content: record.content,
            prompt: record.prompt,
            negative: record.negative,
            params,
            characters,
            backend: result.backend,
            profileKey: result.profileKey,
            checkpoint: result.checkpoint ?? params.checkpoint,
            seed: result.seed,
            blob: result.blob,
            width: result.width,
            height: result.height,
        });
    }

    // ------------------------------------------------------------------
    // Full mode: transform <ifimage> blocks in LLM replies into standard
    // image### markers BEFORE the message renders. ST sanitizes rendered
    // HTML through DOMPurify (MESSAGE_SANITIZE), which strips unknown tags
    // like <ifimage> from the DOM — so blocks are read from message.mes on
    // MESSAGE_RECEIVED (fires before render/CHARACTER_MESSAGE_RENDERED)
    // and rewritten in place. The resulting marker carries the FINAL
    // prompt; parser-level <size>/<negative> overrides ride along in a
    // hash-keyed side map consumed by the onMarker wrapper below.
    // ------------------------------------------------------------------
    const overridesByHash = new Map(); // contentHash(prompt) -> {width,height,negative}
    function transformIfImageBlocks(messageId) {
        if (!settings.enabled || !settings.generation.enabled) return;
        if (settings.generation.mode !== 'full') return;
        const id = Number(messageId);
        if (!Number.isSafeInteger(id) || id < 0) return;
        const ctx = getContext();
        const message = ctx.chat?.[id];
        if (!message || message.is_user || message.is_system) return;
        if (typeof message.mes !== 'string' || !/<ifimage/i.test(message.mes)) return;
        const tags = settings.generation;
        let changed = false;
        // Well-formed (closed) blocks only; the defensive parser handles the
        // inner repairs. An unclosed trailing block is left as-is.
        const mes = message.mes.replace(/<ifimage[\s\S]*?>[\s\S]*?<\/ifimage>/gi, (block) => {
            const entry = parseLlmReply(block)[0];
            if (!entry?.prompt) return block;
            // The prompt must never contain the end tag, or the marker would
            // terminate early on render.
            const promptText = entry.prompt.split(tags.endTag).join(' ').trim();
            if (!promptText) return block;
            // Bounded side map: parser-level overrides only matter for the
            // detection pass that follows this event; old hashes are evicted.
            if (overridesByHash.size > 64) {
                overridesByHash.delete(overridesByHash.keys().next().value);
            }
            overridesByHash.set(contentHash(promptText), {
                width: entry.width,
                height: entry.height,
                negative: entry.negative,
            });
            changed = true;
            return `${tags.startTag} ${promptText} ${tags.endTag}`;
        });
        if (!changed) return;
        message.mes = mes;
        // Persist the transformed text so revisits render the marker (and
        // the IDB restore path matches) without re-parsing <ifimage>.
        try { ctx.saveChat?.(); } catch (err) { console.warn('[IF Image] saveChat after transform failed:', err?.message ?? err); }
        logEvent('ifimage_transform', { messageId: id });
    }
    const onMessageReceived = (messageId) => {
        try { transformIfImageBlocks(messageId); } catch (err) {
            console.error('[IF Image] <ifimage> transform failed:', err?.message ?? err);
        }
    };
    const receivedType = event_types.MESSAGE_RECEIVED;
    if (receivedType) eventSource.on(receivedType, onMessageReceived);

    // ------------------------------------------------------------------
    // Drawer UI (mounted after queue/genLog/engine exist)
    // ------------------------------------------------------------------
    const drawer = renderDrawer({
        settings, save: saveSettings, nai, comfy, a1111, genLog, getQueue: () => queue,
        regenerateImage: regenerateImageRecord,
        getCurrentChatId: () => getContext().getCurrentChatId(),
    });
    $('#extensions_settings2').append(drawer);
    notify('info', 'IF Image loaded. Configure backends in the extensions drawer.');

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
        // Thin wrapper: attach Full-mode metadata, then hand off. The
        // pipeline owns the assist/full LLM rewrite (after its IDB restore
        // check) via the injected `rewrite` dependency.
        onMarker: (marker) => {
            const overrides = overridesByHash.get(contentHash(marker.content));
            if (overrides) {
                // Marker produced by the <ifimage> transform above: the
                // prompt is already final; never send it back to the LLM.
                pipeline.onMarker({ ...marker, final: true, overrides });
                return;
            }
            if (settings.generation.mode === 'full') {
                // Full mode: markers inside LLM replies are final prompts
                // authored by the LLM; only user-typed markers get rewritten.
                const message = getContext().chat?.[marker.messageId];
                if (message && !message.is_user) {
                    pipeline.onMarker({ ...marker, final: true });
                    return;
                }
            }
            pipeline.onMarker(marker);
        },
        onChatWillChange: (previous) => {
            abortAllLlm();
            queue.cancelAllForChat(previous);
            pipeline.forgetChat(previous);
        },
        onChatChanged: () => {
            refreshRoster();
            const chatId = getContext().getCurrentChatId();
            const length = getContext().chat?.length ?? 0;
            for (let i = 0; i < length; i++) pipeline.scheduleDomPass(chatId, i);
        },
        onDispose: () => {
            abortAllLlm();
            queue.cancelAll();
        },
    });
    runtime.register();

    // ------------------------------------------------------------------
    // Slash command /ifimg: append a marker to the last message and
    // re-render it. The regular detection → pipeline path then creates the
    // slot, runs the LLM rewrite (assist/full), and inserts the image —
    // no parallel enqueue path, and the image is visible in chat.
    // ------------------------------------------------------------------
    try {
        const { SlashCommandParser, SlashCommand } = getContext();
        if (SlashCommandParser && SlashCommand) {
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'ifimg',
                helpString: 'Append an image marker for the scene text to the last message (uses the configured mode).',
                callback: async (_args, sceneText) => {
                    const text = typeof sceneText === 'string' ? sceneText.trim() : '';
                    if (!text) return 'Usage: /ifimg <scene text>';
                    const ctx = getContext();
                    const messageId = (ctx.chat?.length ?? 0) - 1;
                    const message = ctx.chat?.[messageId];
                    if (!message) return 'No message to attach the image to.';
                    const tags = settings.generation;
                    // The scene text must not contain the end tag, or the
                    // marker would terminate early.
                    const safeText = text.split(tags.endTag).join(' ').trim();
                    message.mes = `${message.mes}\n${tags.startTag} ${safeText} ${tags.endTag}`;
                    try { ctx.saveChat?.(); } catch (err) { console.warn('[IF Image] saveChat failed:', err?.message ?? err); }
                    ctx.updateMessageBlock?.(messageId, message);
                    await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
                    return 'Image marker added.';
                },
                namedArgumentList: [],
            }));
        }
    } catch (err) {
        console.warn('[IF Image] Slash command registration failed:', err?.message ?? err);
    }

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
        if (receivedType) eventSource.removeListener(receivedType, onMessageReceived);
        runtime.unregister();
        queue.dispose();
        pipeline.disposeAll();
    });
});
