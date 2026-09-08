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
 * @param {(doc, opts: {records, index?, onDelete?, onRegenerate?, getObjectUrl?}) => () => void} deps.openLightbox
 * @param {(root, tags, onFound) => number} deps.replaceMarkers
 * @param {(content: string) => Promise<{entries: Array<{profileKey, envelope}>}>} [deps.rewrite]
 *   Assist-mode LLM hook. Called AFTER the IDB restore check misses, with the
 *   ORIGINAL marker content (entry identity/hash stays bound to the marker
 *   text in the DOM). Must reject with code 'ABORTED' on abort; any other
 *   rejection falls back to local compile.
 * @param {(type: string, detail: object) => void} [deps.logEvent] - B7 log sink
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
        renderImageFrame, openLightbox, replaceMarkers, rewrite, logEvent,
        getMessage,
        getMessageElement, getSettings, getCurrentChatId, setTimeoutImpl = setTimeout,
        // C10 (optional): enable the hover-overlay Delete action on in-chat
        // frames. Without both, frames still render with View/Regen only.
        deleteImageRecord, renderRegenerateChip,
        // R3 (optional): visible "Image not generated" chip with a Generate
        // button for slots with nothing persisted and no live task. Without
        // it, such slots fall back to the old invisible idle placeholder.
        renderIdleChip,
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
        const openView = async () => {
            if (activeLightbox) activeLightbox.close();
            // D1: the lightbox browses every persisted image for this slot
            // (same occurrence + marker hash), newest first. IDB errors fall
            // back to the live record so View still works.
            let records = [];
            try {
                const all = await getImagesForMessage(entry.chatId, entry.messageId, entry.swipeId);
                records = all.filter(r => r.blob && r.occurrence === entry.occurrence && contentHash(r.content) === entry.hash);
            } catch (err) {
                console.warn('[IF Image] Lightbox record fetch failed:', err?.message ?? err);
            }
            if (!records.length) {
                // Live task result whose save failed: view the in-memory URL.
                records = [{
                    id: entry.recordId ?? null,
                    seed: entry.envelope?.params?.seed,
                    checkpoint: entry.envelope?.params?.checkpoint,
                    width: entry.envelope?.params?.width,
                    height: entry.envelope?.params?.height,
                    profileKey: entry.profileKey,
                    blob: null,
                }];
            }
            const startIndex = Math.max(0, records.findIndex(r => r.id === entry.recordId));
            const deletedIds = new Set(); // the lightbox splices its own copy
            const close = openLightbox(doc, {
                records,
                index: startIndex,
                getObjectUrl: (record) => (record.id === entry.recordId && entry.objectUrl) ? entry.objectUrl : null,
                onRegenerate: () => regenerate(entry),
                onDelete: deleteImageRecord ? async (record) => {
                    try {
                        await deleteImageRecord(record.id);
                    } catch (err) {
                        notify('error', `Delete failed: ${err?.message ?? err}`);
                        throw err; // lightbox keeps the record on failure
                    }
                    deletedIds.add(record.id);
                    if (record.id !== entry.recordId) return;
                    // The slot's shown image was deleted. Swap the slot to
                    // the newest remaining record, or collapse when none.
                    const remaining = records.filter(r => !deletedIds.has(r.id) && r.blob);
                    if (remaining.length) {
                        entry.recordId = remaining[0].id;
                        if (Number.isInteger(remaining[0].seed)) entry.lastSeed = remaining[0].seed;
                        showImage(entry, remaining[0].blob);
                        return;
                    }
                    entry.recordId = null;
                    releaseUrl(entry);
                    if (!entry.slot) return;
                    if (renderRegenerateChip) renderRegenerateChip(entry.slot, doc, () => regenerate(entry));
                    else { entry.slot.dataset.ifimgState = 'idle'; entry.slot.textContent = ''; }
                } : undefined,
            });
            activeLightbox = { close, entry };
        };
        const actions = {
            onSingleClick: openView,
            onDoubleClick: () => regenerate(entry),
            // C10 explicit hover-overlay buttons (same handlers; the overlay
            // stopPropagation()s so they never also fire click/dblclick).
            onView: openView,
            onRegen: () => regenerate(entry),
        };
        // D2: Repro = regenerate with the SHOWN image's actual seed (known
        // from the saved record / task result). Hidden when seed is unknown
        // or random (-1) — reproducing a random seed is meaningless.
        if (Number.isInteger(entry.lastSeed) && entry.lastSeed >= 0) {
            actions.onRepro = () => regenerate(entry, { seed: entry.lastSeed });
        }
        // Delete only when the record id is known and a delete backend was
        // injected — restored frames and fresh saves both stamp recordId.
        if (deleteImageRecord && entry.recordId) {
            actions.onDelete = async () => {
                const id = entry.recordId;
                try {
                    await deleteImageRecord(id);
                } catch (err) {
                    notify('error', `Delete failed: ${err?.message ?? err}`);
                    return;
                }
                entry.recordId = null;
                releaseUrl(entry);
                if (!entry.slot) return;
                if (renderRegenerateChip) renderRegenerateChip(entry.slot, doc, () => regenerate(entry));
                else { entry.slot.dataset.ifimgState = 'idle'; entry.slot.textContent = ''; }
            };
        }
        return actions;
    }

    /**
     * Re-enqueue an entry's envelope. Default (Regen) uses seed -1; D2's
     * Repro passes { seed: record.seed } to reproduce the exact image —
     * that path also skips the assist/full LLM variation rewrite, because a
     * different prompt would defeat reproduction.
     * @param {{seed?: number}} [options]
     */
    async function regenerate(entry, { seed = -1 } = {}) {
        if (!entry?.envelope) return;
        releaseUrl(entry); // closes any open lightbox for this entry first (FIX 4)
        // Assist/Full: re-call the LLM with previous_prompt + a variation
        // hint so the regeneration is a genuine new take, not the same
        // prompt with a new seed. Direct mode keeps prompt/params, seed -1.
        const mode = getSettings().generation?.mode ?? 'direct';
        if (seed < 0 && (mode === 'assist' || mode === 'full') && typeof rewrite === 'function') {
            entry.rewriting = true;
            if (entry.slot) renderSlotState(entry.slot, { status: 'running' }, doc);
            try {
                const result = await rewrite(entry.content, {
                    previousPrompt: entry.envelope.prompt,
                    variationHint: 'Generate a different variation of this scene.',
                });
                entry.rewriting = false;
                if (slots.get(entry.key) !== entry) return; // superseded during await
                const first = result?.entries?.[0];
                if (first?.envelope) {
                    entry.profileKey = first.profileKey ?? entry.profileKey;
                    entry.envelope = first.envelope;
                }
            } catch (err) {
                entry.rewriting = false;
                if (err?.code === 'ABORTED' || err?.name === 'AbortError') return;
                console.warn('[IF Image] Regenerate rewrite failed; reusing previous prompt:', err?.message ?? err);
            }
        }
        const envelope = { ...entry.envelope, params: { ...entry.envelope.params, seed } };
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
            // D2: remember the actual seed so the overlay's Repro can
            // reproduce this exact image.
            if (Number.isInteger(result.seed)) entry.lastSeed = result.seed;
            try {
                entry.recordId = await saveImageRecord({
                    chatId: entry.chatId,
                    messageId: entry.messageId,
                    swipeId: entry.swipeId,
                    occurrence: entry.occurrence,
                    content: entry.content,
                    prompt: entry.envelope.prompt,
                    negative: entry.envelope.negative,
                    params: entry.envelope.params,
                    characters: entry.envelope.characters,
                    backend: result.backend,
                    profileKey: result.profileKey,
                    // R2: the checkpoint actually used (executor-resolved),
                    // falling back to the compiled envelope's request.
                    checkpoint: result.checkpoint ?? entry.envelope.params?.checkpoint,
                    seed: result.seed,
                    blob: result.blob,
                    width: result.width,
                    height: result.height,
                });
            } catch (err) {
                console.warn('[IF Image] Image record save failed:', err?.message ?? err);
            }
            // R3: a success supersedes any persisted failure marker for this
            // slot — remove it so revisits restore the image, not the error.
            if (entry.failedRecordId && deleteImageRecord) {
                const staleId = entry.failedRecordId;
                entry.failedRecordId = null;
                try {
                    await deleteImageRecord(staleId);
                } catch (err) {
                    console.warn('[IF Image] Failed-record cleanup failed:', err?.message ?? err);
                }
            }
            if (entry.taskId !== snapshot.id) return; // superseded during the await
            showImage(entry, result.blob);
            return;
        }
        // R3: persist terminal failures (NOT cancellations) as light blob-less
        // records so the failed chip + its sanitized error survive chat
        // revisits. Reusing failedRecordId overwrites the previous failure for
        // this slot instead of accumulating one record per retry.
        if (snapshot.status === 'failed') {
            try {
                const savedId = await saveImageRecord({
                    ...(entry.failedRecordId ? { id: entry.failedRecordId } : {}),
                    chatId: entry.chatId,
                    messageId: entry.messageId,
                    swipeId: entry.swipeId,
                    occurrence: entry.occurrence,
                    content: entry.content,
                    prompt: entry.envelope?.prompt ?? '',
                    negative: entry.envelope?.negative ?? '',
                    params: entry.envelope?.params ?? {},
                    backend: entry.backend,
                    profileKey: entry.profileKey,
                    checkpoint: entry.envelope?.params?.checkpoint,
                    seed: entry.envelope?.params?.seed ?? -1,
                    status: 'failed',
                    // snapshot.error.message is already sanitized upstream
                    // (backend clients redact secrets before throwing).
                    error: String(snapshot.error?.message ?? 'Generation failed').slice(0, 300),
                });
                entry.failedRecordId = savedId;
            } catch (err) {
                console.warn('[IF Image] Failure record save failed:', err?.message ?? err);
            }
            if (entry.taskId !== snapshot.id) return; // superseded during the await
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

    /** Merge parser-derived overrides (Full-mode <ifimage> size/negative)
     *  into a compiled envelope without mutating the original. */
    function applyOverrides(envelope, overrides) {
        if (!overrides) return envelope;
        const params = { ...envelope.params };
        if (Number.isFinite(overrides.width) && Number.isFinite(overrides.height)) {
            params.width = overrides.width;
            params.height = overrides.height;
        }
        let negative = envelope.negative;
        if (overrides.negative) {
            negative = negative ? `${negative}, ${overrides.negative}` : overrides.negative;
        }
        return { ...envelope, negative, params };
    }

    async function onMarker(marker) {
        const settings = getSettings();
        if (!settings.enabled || !settings.generation.enabled) return;
        const mode = settings.generation.mode ?? 'direct';
        if (mode !== 'direct' && mode !== 'assist' && mode !== 'full') {
            console.log(`[IF Image] generation.mode="${mode}" is unknown; marker skipped.`);
            return;
        }
        const key = slotKey(marker.chatId, marker.messageId, marker.swipeId, marker.occurrence);
        // Entry identity is ALWAYS the marker text as it appears in the
        // message (never an LLM-rewritten prompt): the DOM pass and the IDB
        // restore check both hash the rendered marker content, so identity
        // must match it in every mode.
        let compiled;
        try {
            compiled = compile(marker.content);
        } catch (err) {
            console.error('[IF Image] compile failed:', err?.message ?? err);
            return;
        }
        compiled = { ...compiled, envelope: applyOverrides(compiled.envelope, marker.overrides) };

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
            rewriting: false,
            failedRecordId: null,
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
            // Restore path: a persisted record already matches this exact
            // marker content. Do NOT generate (or call the LLM) again — the
            // DOM pass's restoreImages() attaches the image from IDB, or (R3)
            // renders the persisted failure as a failed chip with Retry.
            if (existingRecord.status === 'failed' && !existingRecord.blob) {
                entry.failedRecordId = existingRecord.id;
            }
            scheduleDomPass(marker.chatId, marker.messageId);
            return;
        }

        // Assist/Full mode: LLM rewrite AFTER the restore check missed, so
        // chat revisits never re-call the LLM. `marker.final` (markers whose
        // content is already a final prompt: Full-mode LLM-reply markers and
        // transformed <ifimage> blocks) bypasses the rewrite.
        if ((mode === 'assist' || mode === 'full') && typeof rewrite === 'function' && !marker.final) {
            // Show a spinner while the LLM call runs: the DOM pass renders
            // `rewriting` entries as 'running'.
            entry.rewriting = true;
            scheduleDomPass(marker.chatId, marker.messageId);
            try {
                const result = await rewrite(marker.content);
                entry.rewriting = false;
                if (slots.get(key) !== entry) { scheduleDomPass(marker.chatId, marker.messageId); return; }
                const first = result?.entries?.[0];
                if (first?.envelope) {
                    if (result.entries.length > 1) {
                        console.warn(`[IF Image] LLM returned ${result.entries.length} entries for one marker; using the first.`);
                    }
                    entry.profileKey = first.profileKey ?? entry.profileKey;
                    entry.envelope = first.envelope;
                }
            } catch (err) {
                entry.rewriting = false;
                if (err?.code === 'ABORTED' || err?.name === 'AbortError') {
                    // Chat switch or dispose: the slot map is being torn down.
                    logEvent?.('llm_reply', { key, method: 'aborted' });
                    return;
                }
                // Engine-level failures already fall back internally; this
                // catch covers unexpected throws. Keep the local compile.
                console.warn('[IF Image] LLM rewrite failed; using direct compile:', err?.message ?? err);
                notify('warning', 'LLM rewrite failed; generated with direct compile instead.');
            }
            if (slots.get(key) !== entry) { scheduleDomPass(marker.chatId, marker.messageId); return; }
        }

        startGeneration(entry);
    }

    /**
     * R3: shared tail of the generation flow — dry-run check → enqueue →
     * scheduleDomPass — used by onMarker AND by the visible idle/failed chips'
     * Generate/Retry buttons (the explicit user action for a marker the
     * runtime already deduplicated, so events.js is never involved again).
     *
     * `entryInfo` is either a live entry (has .envelope; onMarker path) or a
     * chip descriptor `{ chatId, messageId, swipeId, occurrence, content,
     * slot?, failedRecordId? }` — the chip path compiles fresh (compile →
     * overrides) and registers a new entry, replacing any stale one.
     * @returns {object|null} the live entry, or null if compile failed.
     */
    function startGeneration(entryInfo) {
        const settings = getSettings();
        let entry = entryInfo;
        if (!entry.envelope) {
            let compiled;
            try {
                compiled = compile(entryInfo.content);
            } catch (err) {
                console.error('[IF Image] compile failed:', err?.message ?? err);
                notify('error', 'Prompt compile failed; see console.');
                return null;
            }
            compiled = { ...compiled, envelope: applyOverrides(compiled.envelope, entryInfo.overrides) };
            const key = slotKey(entryInfo.chatId, entryInfo.messageId, entryInfo.swipeId, entryInfo.occurrence);
            const previous = slots.get(key);
            if (previous) releaseUrl(previous);
            entry = {
                key,
                chatId: entryInfo.chatId,
                messageId: entryInfo.messageId,
                swipeId: entryInfo.swipeId,
                occurrence: entryInfo.occurrence,
                content: entryInfo.content,
                hash: contentHash(entryInfo.content),
                backend: defaultBackendKind(),
                profileKey: compiled.profileKey,
                envelope: compiled.envelope,
                slot: entryInfo.slot ?? previous?.slot ?? null,
                taskId: null,
                objectUrl: null,
                pendingError: null,
                rewriting: false,
                // Keep the persisted failure record's id so the NEXT outcome
                // overwrites it (fail) or deletes it (success).
                failedRecordId: entryInfo.failedRecordId ?? previous?.failedRecordId ?? null,
            };
            slots.set(key, entry);
        }

        // Dry-run: log the final envelope, never enqueue.
        if (settings.generation.dryRun === true) {
            logEvent?.('dry_run', {
                key: entry.key,
                prompt: entry.envelope.prompt,
                negative: entry.envelope.negative,
                params: entry.envelope.params,
                profileKey: entry.profileKey,
                backend: entry.backend,
            });
            notify('info', 'Dry-run: envelope logged, generation skipped.');
            scheduleDomPass(entry.chatId, entry.messageId);
            return entry;
        }

        const id = enqueue(entry, entry.envelope);
        // Chip path: the slot already exists in the DOM (marker text is long
        // gone), so the deferred DOM pass cannot re-render it — paint the
        // queued state directly, like retry() does.
        if (id && entry.slot) renderSlotState(entry.slot, { status: 'queued' }, doc);
        scheduleDomPass(entry.chatId, entry.messageId);
        return entry;
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
                } else if (entry.rewriting) {
                    // LLM rewrite in flight (no queue task yet): spinner.
                    renderSlotState(slot, { status: 'running' }, doc);
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
                // Live-race guard: this restore pass may resolve AFTER a task
                // enqueued by the same event's onMarker (its IDB check queued
                // earlier). Never clobber a slot that now has a live task or a
                // pending queue error — render that state instead of idle.
                const live = slots.get(target.key);
                const task = live?.taskId ? getQueue().getTask(live.taskId) : null;
                if (task && task.status === 'succeeded' && live.objectUrl) {
                    renderImageFrame(target.slot, doc, live.objectUrl, bindImageActions(live));
                    continue;
                }
                if (task) {
                    renderSlotState(target.slot, task, doc, { onRetry: () => retry(live) });
                    continue;
                }
                if (live?.rewriting) {
                    renderSlotState(target.slot, { status: 'running' }, doc);
                    continue;
                }
                if (live?.pendingError) {
                    renderSlotState(target.slot, { status: 'failed', error: live.pendingError }, doc, { onRetry: () => retry(live) });
                    continue;
                }
                // R3: a chip's Generate/Retry re-enters the shared generation
                // path. A live entry compiled by onMarker (envelope present)
                // is reused so marker overrides survive; otherwise a chip
                // descriptor makes startGeneration compile fresh.
                const generate = (failedRecordId) => {
                    const current = slots.get(target.key);
                    if (current?.envelope) {
                        current.slot = target.slot;
                        if (failedRecordId && !current.failedRecordId) current.failedRecordId = failedRecordId;
                        startGeneration(current);
                        return;
                    }
                    startGeneration({
                        chatId, messageId, swipeId,
                        occurrence: target.occurrence,
                        content: target.content,
                        slot: target.slot,
                        failedRecordId: failedRecordId ?? null,
                    });
                };
                if (record?.status === 'failed') {
                    // Persisted failure: visible failed chip with the stored
                    // sanitized error and a Retry that reuses this record id.
                    if (live) { live.slot = target.slot; live.failedRecordId = record.id; }
                    renderSlotState(target.slot, { status: 'failed', error: { message: record.error || 'Generation failed' } }, doc, {
                        onRetry: () => generate(record.id),
                    });
                    continue;
                }
                // Nothing persisted and no live task owns it. R3: visible
                // "Image not generated" chip with an explicit Generate button,
                // so a marker never silently vanishes. Fallback (no injected
                // renderIdleChip): old invisible idle placeholder.
                if (renderIdleChip) {
                    renderIdleChip(target.slot, doc, { onGenerate: () => generate(null) });
                } else {
                    target.slot.dataset.ifimgState = 'idle';
                    target.slot.textContent = '';
                }
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
                    envelope: {
                        prompt: record.prompt,
                        negative: record.negative,
                        // R2: rehydrate the record's checkpoint into the
                        // envelope params so a retry/regenerate from this
                        // restored entry reuses the SAME model.
                        params: {
                            ...record.params,
                            ...(record.checkpoint ? { checkpoint: record.checkpoint } : {}),
                        },
                        characters: Array.isArray(record.characters) ? [...record.characters] : [],
                    },
                    slot: target.slot,
                    taskId: null,
                    objectUrl: null,
                    pendingError: null,
                };
                slots.set(target.key, entry);
            } else {
                entry.slot = target.slot;
                // R2: the entry may have been registered by onMarker with a
                // freshly compiled envelope (current settings). A restored
                // image must regenerate with the SAME model it was made
                // with, so the record's checkpoint wins over the compile-
                // time one.
                if (record.checkpoint && entry.envelope?.params) {
                    entry.envelope = {
                        ...entry.envelope,
                        params: { ...entry.envelope.params, checkpoint: record.checkpoint },
                    };
                }
            }
            entry.recordId = record.id;
            // D2: the record's seed backs the overlay's Repro action.
            if (Number.isInteger(record.seed)) entry.lastSeed = record.seed;
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
