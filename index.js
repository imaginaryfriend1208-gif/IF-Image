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
    const pref = settings.generation.backend;
    if (pref === 'nai') return 'nai';
    return settings.backends.comfy.connection === 'a1111' ? 'a1111' : 'comfy';
}

function defaultProfileKey() {
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
    // Slot registry: (chatId, messageId, swipeId, occurrence) -> state.
    // Holds the DOM slot (may be detached after a re-render), the compiled
    // envelope for retry/regenerate, the live task id, and any object URL.
    // ------------------------------------------------------------------
    const slots = new Map();
    const taskToKey = new Map();
    const slotKey = (chatId, messageId, swipeId, occurrence) => `${chatId}|${messageId}|${swipeId}|${occurrence}`;

    function releaseUrl(entry) {
        if (entry?.objectUrl) {
            URL.revokeObjectURL(entry.objectUrl);
            entry.objectUrl = null;
        }
    }

    function forgetChat(chatId) {
        for (const [key, entry] of slots) {
            if (entry.chatId !== chatId) continue;
            releaseUrl(entry);
            if (entry.taskId) taskToKey.delete(entry.taskId);
            slots.delete(key);
        }
    }

    // ------------------------------------------------------------------
    // Queue + executor
    // ------------------------------------------------------------------
    const execute = createExecutor({ nai, comfy, a1111, getSettings: () => settings });
    const queue = createTaskQueue({
        execute,
        concurrency: 1,
        maxQueued: 20,
        timeoutMs: 300000,
        onStateChange: onTaskStateChange,
    });

    function enqueue(entry, envelope) {
        try {
            const id = queue.addTask({
                chatId: entry.chatId,
                messageId: entry.messageId,
                swipeId: entry.swipeId,
                occurrence: entry.occurrence,
                prompt: envelope,
                backend: { kind: entry.backend },
                profile: entry.profileKey,
            });
            entry.taskId = id;
            taskToKey.set(id, entry.key);
            return id;
        } catch (err) {
            if (err?.code === 'QUEUE_FULL') {
                notify('warning', 'Image queue is full (20 waiting). Wait for running jobs to finish.');
            } else {
                console.error('[IF Image] addTask failed:', err?.message ?? err);
            }
            if (entry.slot) renderSlotState(entry.slot, { status: 'failed', error: { message: err?.message ?? 'queue error' } }, document, { onRetry: () => retry(entry) });
            return null;
        }
    }

    function retry(entry) {
        if (!entry?.envelope) return;
        enqueue(entry, entry.envelope);
        if (entry.slot) renderSlotState(entry.slot, { status: 'queued' }, document);
    }

    function regenerate(entry) {
        if (!entry?.envelope) return;
        releaseUrl(entry);
        const envelope = {
            ...entry.envelope,
            params: { ...entry.envelope.params, seed: -1 },
        };
        entry.envelope = envelope;
        enqueue(entry, envelope);
        if (entry.slot) renderSlotState(entry.slot, { status: 'queued' }, document);
    }

    function showImage(entry, blob) {
        releaseUrl(entry);
        entry.objectUrl = URL.createObjectURL(blob);
        if (!entry.slot) return;
        renderImageFrame(entry.slot, document, entry.objectUrl, {
            onSingleClick: () => openLightbox(document, entry.objectUrl),
            onDoubleClick: () => regenerate(entry),
        });
    }

    async function onTaskStateChange(snapshot) {
        const key = taskToKey.get(snapshot.id);
        if (!key) return;
        const entry = slots.get(key);
        if (!entry) return;
        // A newer task owns this slot (retry/regenerate); stale updates are dropped.
        if (entry.taskId !== snapshot.id) return;

        if (snapshot.status === 'succeeded' && snapshot.result?.blob) {
            const result = snapshot.result;
            try {
                await saveImageRecord({
                    chatId: entry.chatId,
                    messageId: entry.messageId,
                    swipeId: entry.swipeId,
                    occurrence: entry.occurrence,
                    content: entry.content,
                    prompt: entry.envelope.prompt,
                    negative: entry.envelope.negative,
                    params: entry.envelope.params,
                    backend: result.backend,
                    profileKey: result.profileKey,
                    seed: result.seed,
                    blob: result.blob,
                    width: result.width,
                    height: result.height,
                });
            } catch (err) {
                console.warn('[IF Image] Image record save failed:', err?.message ?? err);
            }
            if (entry.taskId !== snapshot.id) return; // superseded during the await
            showImage(entry, result.blob);
            return;
        }
        if (entry.slot) renderSlotState(entry.slot, snapshot, document, { onRetry: () => retry(entry) });
    }

    // ------------------------------------------------------------------
    // Compile a marker into a task envelope.
    // ------------------------------------------------------------------
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

    // ------------------------------------------------------------------
    // Marker consumer: the runtime emits once per (message, revision,
    // occurrence). Compile + enqueue immediately, then schedule a DOM pass
    // that replaces every marker in that message with a slot.
    // ------------------------------------------------------------------
    const pendingDom = new Map(); // `${chatId}|${messageId}` -> { chatId, messageId }
    let domPassScheduled = false;

    function scheduleDomPass(chatId, messageId) {
        if (chatId === undefined || chatId === null || chatId === '') return;
        const key = `${chatId}|${messageId}`;
        pendingDom.set(key, { chatId, messageId });
        if (domPassScheduled) return;
        domPassScheduled = true;
        // Deferred past the current event dispatch so the runtime (which
        // scanned the same event) is done reading the original segments.
        setTimeout(() => {
            domPassScheduled = false;
            const targets = Array.from(pendingDom.values());
            pendingDom.clear();
            for (const t of targets) attachSlots(t.chatId, t.messageId);
        }, 0);
    }

    function onMarker(marker) {
        if (!settings.enabled || !settings.generation.enabled) return;
        if (settings.generation.mode !== 'direct') {
            console.log(`[IF Image] generation.mode="${settings.generation.mode}" is not available yet (Phase B); marker skipped.`);
            return;
        }
        const key = slotKey(marker.chatId, marker.messageId, marker.swipeId, marker.occurrence);
        let compiled;
        try {
            compiled = compile(marker.content);
        } catch (err) {
            console.error('[IF Image] compile failed:', err?.message ?? err);
            return;
        }
        const previous = slots.get(key);
        if (previous) releaseUrl(previous);
        const entry = {
            key,
            chatId: marker.chatId,
            messageId: marker.messageId,
            swipeId: marker.swipeId,
            occurrence: marker.occurrence,
            content: marker.content,
            hash: contentHash(marker.content),
            backend: defaultBackendKind(),
            profileKey: compiled.profileKey,
            envelope: compiled.envelope,
            slot: null,
            taskId: null,
            objectUrl: null,
        };
        slots.set(key, entry);
        enqueue(entry, entry.envelope);
        scheduleDomPass(marker.chatId, marker.messageId);
    }

    // ------------------------------------------------------------------
    // DOM pass: replace markers with slots, bind to live entries, and
    // restore persisted images for occurrences without a live task.
    // ------------------------------------------------------------------
    function attachSlots(chatId, messageId) {
        // If the user switched chats between scheduling and this deferred pass,
        // drop it: getContext().chat and the DOM now belong to the new chat,
        // and a message index from the old chat must never be matched there.
        if (getContext().getCurrentChatId() !== chatId) return;
        const message = getContext().chat?.[messageId];
        const root = messageElement(messageId);
        if (!message || !root) return;
        const swipeId = message.swipe_id ?? 0;
        const tags = settings.generation;
        const restore = [];

        replaceMarkers(root, tags, ({ occurrence, content }) => {
            const key = slotKey(chatId, messageId, swipeId, occurrence);
            const slot = createSlotElement(document, { occurrence, content });
            let entry = slots.get(key);
            if (entry && entry.hash !== contentHash(content)) {
                // Edited marker text: the old entry belongs to other content.
                releaseUrl(entry);
                entry = null;
            }
            if (entry) {
                entry.slot = slot;
                const task = entry.taskId ? queue.getTask(entry.taskId) : null;
                if (task?.status === 'succeeded' && entry.objectUrl) {
                    renderImageFrame(slot, document, entry.objectUrl, {
                        onSingleClick: () => openLightbox(document, entry.objectUrl),
                        onDoubleClick: () => regenerate(entry),
                    });
                } else if (task && task.status !== 'succeeded') {
                    renderSlotState(slot, task, document, { onRetry: () => retry(entry) });
                } else {
                    restore.push({ key, slot, occurrence, content });
                }
            } else {
                restore.push({ key, slot, occurrence, content });
            }
            return slot;
        });

        if (restore.length) restoreImages(chatId, messageId, swipeId, restore);
    }

    async function restoreImages(chatId, messageId, swipeId, targets) {
        let records;
        try {
            records = await getImagesForMessage(chatId, messageId, swipeId);
        } catch (err) {
            console.warn('[IF Image] Image restore failed:', err?.message ?? err);
            return;
        }
        for (const target of targets) {
            const hash = contentHash(target.content);
            const record = records.find(r => r.occurrence === target.occurrence && contentHash(r.content) === hash);
            if (!record?.blob) {
                // Nothing persisted for this marker and no live task owns it
                // (e.g. deduped emission after a record loss): quiet invisible
                // placeholder, aria-hidden so it never re-enters detection.
                target.slot.dataset.ifimgState = 'idle';
                target.slot.textContent = '';
                continue;
            }
            let entry = slots.get(target.key);
            if (!entry) {
                entry = {
                    key: target.key,
                    chatId, messageId, swipeId,
                    occurrence: target.occurrence,
                    content: target.content,
                    hash,
                    backend: record.backend || defaultBackendKind(),
                    profileKey: record.profileKey || defaultProfileKey(),
                    envelope: { prompt: record.prompt, negative: record.negative, params: { ...record.params } },
                    slot: target.slot,
                    taskId: null,
                    objectUrl: null,
                };
                slots.set(target.key, entry);
            } else {
                entry.slot = target.slot;
            }
            showImage(entry, record.blob);
        }
    }

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
        onMarker,
        onChatWillChange: (previous) => {
            queue.cancelAllForChat(previous);
            forgetChat(previous);
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
        scheduleDomPass(getContext().getCurrentChatId(), messageId);
    };
    for (const type of restoreEvents) eventSource.on(type, onRendered);

    $(window).on('beforeunload.if_image', () => {
        for (const type of restoreEvents) eventSource.removeListener(type, onRendered);
        runtime.unregister();
        queue.dispose();
        for (const entry of slots.values()) releaseUrl(entry);
        slots.clear();
        taskToKey.clear();
    });
});
