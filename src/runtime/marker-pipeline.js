// IF Image - Marker-to-image pipeline: compiles markers, enqueues generation,
// restores persisted images, and renders slot state. Extracted from index.js
// so it can be unit-tested with mocked dependencies (no real IndexedDB/ST).
//
// FIX 2 (restore-before-regenerate): on CHAT_CHANGED the marker runtime resets
// its dedup state (src/runtime/events.js resetChat()), and switching back to
// a chat re-renders messages from chat[i].mes (confirmed against SillyTavern
// script.js: reloadCurrentChatUnsafe -> clearChat -> printMessages ->
// updateMessageElement -> messageFormatting(message.mes) -> .mes_text.html()).
// The marker text is therefore still present and the runtime re-emits it as a
// "new" marker. Before enqueueing, onMarker checks IndexedDB for an existing
// record with the same (chatId, messageId, swipeId, occurrence) identity AND
// matching content hash; if found, it skips generation entirely and lets the
// DOM pass restore the persisted image instead.

/**
 * @param {object} deps
 * @param {() => object} deps.getQueue - lazy getter for the createTaskQueue()
 *   instance (resolves the circular dependency: the queue's onStateChange
 *   option must point at this pipeline's onTaskStateChange, so the queue is
 *   normally constructed AFTER the pipeline, using this instance's methods).
 * @param {(content: string) => {profileKey: string, envelope: object}} deps.compile
 * @param {(chatId, messageId, swipeId) => Promise<Array>} deps.getImagesForMessage
 * @param {(record: object) => Promise<string>} deps.saveImageRecord
 * @param {(str: string) => string} deps.contentHash
 * @param {() => string} deps.defaultBackendKind
 * @param {(kind: string, message: string) => void} deps.notify
 * @param {Document} deps.doc - injectable for tests
 * @param {(doc, info) => Node} deps.createSlotElement
 * @param {(slot, snapshot, doc, actions?) => void} deps.renderSlotState
 * @param {(slot, doc, objectUrl, actions?) => Node} deps.renderImageFrame
 * @param {(doc, src) => () => void} deps.openLightbox
 * @param {(root, tags, onFound) => number} deps.replaceMarkers
 * @param {(messageId: number) => object|null} deps.getMessage
 * @param {(messageId: number) => Node|null} deps.getMessageElement
 * @param {() => object} deps.getSettings - live settings reference
 * @param {() => string} deps.getCurrentChatId
 * @param {(fn: () => void, ms: number) => any} [deps.setTimeoutImpl]
 */
export function createMarkerPipeline(deps) {
    const {
        getQueue, compile, getImagesForMessage, saveImageRecord, contentHash,
        defaultBackendKind, defaultProfileKey, notify, doc, createSlotElement, renderSlotState,
        renderImageFrame, openLightbox, replaceMarkers, getMessage,
        getMessageElement, getSettings, getCurrentChatId, setTimeoutImpl = setTimeout,
    } = deps;

    // key -> entry. Entry holds the DOM slot (may be detached after a
    // re-render), the compiled envelope (for retry/regenerate), the live
    // task id, and any object URL currently shown.
    const slots = new Map();
    const taskToKey = new Map();
    const slotKey = (chatId, messageId, swipeId, occurrence) => `${chatId}|${messageId}|${swipeId}|${occurrence}`;

    // FIX 4: only one lightbox can be open at a time. Track which entry it
    // belongs to so releasing that entry's object URL closes it first —
    // revoking a URL does not break an already-decoded <img> in every
    // browser/spec-guaranteed way, so we close proactively rather than rely
    // on that.
    let activeLightbox = null; // { close, entry }

    function closeActiveLightboxFor(entry) {
        if (activeLightbox && activeLightbox.entry === entry) {
            activeLightbox.close();
            activeLightbox = null;
        }
    }

    function releaseUrl(entry) {
        if (entry?.objectUrl) {
            closeActiveLightboxFor(entry);
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

    function disposeAll() {
        for (const entry of slots.values()) releaseUrl(entry);
        slots.clear();
        taskToKey.clear();
    }

    /** @returns {string|null} the new task id, or null if enqueue failed. */
    function enqueue(entry, envelope) {
        try {
            const id = getQueue().addTask({
                chatId: entry.chatId,
                messageId: entry.messageId,
                swipeId: entry.swipeId,
                occurrence: entry.occurrence,
                prompt: envelope,
                backend: { kind: entry.backend },
                profile: entry.profileKey,
            });
            entry.taskId = id;
            entry.pendingError = null;
            taskToKey.set(id, entry.key);
            return id;
        } catch (err) {
            const message = err?.code === 'QUEUE_FULL'
                ? 'Image queue is full (20 waiting). Wait for running jobs to finish.'
                : (err?.message ?? 'Failed to queue generation.');
            if (err?.code === 'QUEUE_FULL') notify('warning', message);
            else console.error('[IF Image] addTask failed:', err?.message ?? err);
            // FIX 3: remember the failure on the entry itself. At enqueue time
            // the slot usually doesn't exist yet (compiled before the DOM
            // pass runs), so the DOM pass must render this as a failed/retry
            // chip instead of falling through to a blank "idle" placeholder.
            entry.pendingError = { message };
            if (entry.slot) renderSlotState(entry.slot, { status: 'failed', error: { message } }, doc, { onRetry: () => retry(entry) });
            return null;
        }
    }

    function retry(entry) {
        if (!entry?.envelope) return;
        const id = enqueue(entry, entry.envelope);
        if (id && entry.slot) renderSlotState(entry.slot, { status: 'queued' }, doc);
    }

    function bindImageActions(entry) {
        return {
            onSingleClick: () => {
                if (activeLightbox) activeLightbox.close();
                const close = openLightbox(doc, entry.objectUrl);
                activeLightbox = { close, entry };
            },
            onDoubleClick: () => regenerate(entry),
        };
    }

    function regenerate(entry) {
        if (!entry?.envelope) return;
        releaseUrl(entry); // closes any open lightbox for this entry first (FIX 4)
        const envelope = { ...entry.envelope, params: { ...entry.envelope.params, seed: -1 } };
        entry.envelope = envelope;
        const id = enqueue(entry, envelope);
        if (id && entry.slot) renderSlotState(entry.slot, { status: 'queued' }, doc);
    }

    function showImage(entry, blob) {
        releaseUrl(entry);
        entry.objectUrl = URL.createObjectURL(blob);
        if (!entry.slot) return;
        renderImageFrame(entry.slot, doc, entry.objectUrl, bindImageActions(entry));
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
        if (entry.slot) renderSlotState(entry.slot, snapshot, doc, { onRetry: () => retry(entry) });
    }
    // The queue used in this codebase takes onStateChange at construction
    // time instead; callers must pass `onTaskStateChange` (exported below)
    // into createTaskQueue({ onStateChange }) themselves.

    // ------------------------------------------------------------------
    // Marker consumer. See FIX 2 header comment for the restore-before-
    // regenerate check. Async: never let a rejected IDB read block
    // generation — on error, log and fall through to enqueue.
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
        setTimeoutImpl(() => {
            domPassScheduled = false;
            const targets = Array.from(pendingDom.values());
            pendingDom.clear();
            for (const t of targets) attachSlots(t.chatId, t.messageId);
        }, 0);
    }

    let sequence = 0;

    async function onMarker(marker) {
        const settings = getSettings();
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

        sequence += 1;
        const hash = contentHash(marker.content);
        const previous = slots.get(key);
        if (previous) releaseUrl(previous);
        const entry = {
            key,
            chatId: marker.chatId,
            messageId: marker.messageId,
            swipeId: marker.swipeId,
            occurrence: marker.occurrence,
            content: marker.content,
            hash,
            backend: defaultBackendKind(),
            profileKey: compiled.profileKey,
            envelope: compiled.envelope,
            slot: null,
            taskId: null,
            objectUrl: null,
            pendingError: null,
        };
        // Registered synchronously (before the IDB await below) so a
        // concurrent DOM pass or click has something to find immediately.
        slots.set(key, entry);

        let existingRecord = null;
        try {
            const records = await getImagesForMessage(marker.chatId, marker.messageId, marker.swipeId);
            existingRecord = records.find(r => r.occurrence === marker.occurrence && contentHash(r.content) === hash) ?? null;
        } catch (err) {
            console.warn('[IF Image] Restore check failed, generating instead:', err?.message ?? err);
        }

        // A later onMarker call for the same key (e.g. the message was
        // edited again before this async check resolved) already replaced
        // this entry — this stale continuation must not enqueue or clobber it.
        if (slots.get(key) !== entry) {
            scheduleDomPass(marker.chatId, marker.messageId);
            return;
        }

        if (existingRecord) {
            // Restore path: a persisted image already matches this exact
            // marker content. Do NOT generate again — the DOM pass's
            // restoreImages() will attach it from IDB.
            scheduleDomPass(marker.chatId, marker.messageId);
            return;
        }

        enqueue(entry, entry.envelope);
        scheduleDomPass(marker.chatId, marker.messageId);
    }

    // ------------------------------------------------------------------
    // DOM pass: replace markers with slots, bind to live entries, and
    // restore persisted images for occurrences without a live task.
    // ------------------------------------------------------------------
    function attachSlots(chatId, messageId) {
        // If the user switched chats between scheduling and this deferred
        // pass, drop it: the DOM/chat array now belong to the new chat, and a
        // message index from the old chat must never be matched there.
        if (getCurrentChatId() !== chatId) return;
        const message = getMessage(messageId);
        const root = getMessageElement(messageId);
        if (!message || !root) return;
        const swipeId = message.swipe_id ?? 0;
        const tags = getSettings().generation;
        const restore = [];

        replaceMarkers(root, tags, ({ occurrence, content }) => {
            const key = slotKey(chatId, messageId, swipeId, occurrence);
            const slot = createSlotElement(doc, { occurrence, content });
            let entry = slots.get(key);
            if (entry && entry.hash !== contentHash(content)) {
                // Edited marker text: the old entry belongs to other content.
                releaseUrl(entry);
                entry = null;
            }
            if (entry) {
                entry.slot = slot;
                const task = entry.taskId ? getQueue().getTask(entry.taskId) : null;
                if (task?.status === 'succeeded' && entry.objectUrl) {
                    renderImageFrame(slot, doc, entry.objectUrl, bindImageActions(entry));
                } else if (task && task.status !== 'succeeded') {
                    renderSlotState(slot, task, doc, { onRetry: () => retry(entry) });
                } else if (entry.pendingError) {
                    // FIX 3: queue-full (or other pre-task) failure — always a
                    // visible failed/retry chip, never a silent blank slot.
                    renderSlotState(slot, { status: 'failed', error: entry.pendingError }, doc, { onRetry: () => retry(entry) });
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
                // Nothing persisted for this marker and no live task owns it:
                // quiet invisible placeholder (slot is aria-hidden already).
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
                    pendingError: null,
                };
                slots.set(target.key, entry);
            } else {
                entry.slot = target.slot;
            }
            showImage(entry, record.blob);
        }
    }

    return {
        onMarker,
        attachSlots,
        scheduleDomPass,
        forgetChat,
        disposeAll,
        onTaskStateChange,
    };
}
