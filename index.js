// IF Image - SillyTavern third-party image generation extension.
// Standalone: fetches NovelAI and the user's SD WebUI backends directly,
// never uses ST secrets or ST server APIs for generation.

import { getSettings, saveSettings } from './src/settings.js';
import { NaiClient } from './src/backends/nai.js';
import { ComfyProxyClient } from './src/backends/comfy.js';
import { A1111Client } from './src/backends/a1111.js';
import { renderDrawer, createEditDialog } from './src/ui.js';
import { createMarkerRuntime } from './src/runtime/events.js';
import { createTaskQueue } from './src/runtime/tasks.js';
import { createExecutor } from './src/runtime/executor.js';
import { createMarkerPipeline } from './src/runtime/marker-pipeline.js';
import { replaceMarkers, createSlotElement, renderSlotState, renderImageFrame, renderRegenerateChip, renderIdleChip, openLightbox, contentHash } from './src/runtime/insert.js';
import { saveImageRecord, getImagesForMessage, getImageRecord, deleteImageRecord, getStorageStats, pruneImages, toJpegBlob } from './src/storage/images.js';
import { getAllCharacters, saveCharacter } from './src/storage/chars.js';
import { getAllStyles, getAllPersonas, savePersona, saveStyle, createDefaultPersona, applyPersonaSync, getReplaceRules, saveReplaceRules } from './src/storage/presets.js';
import { getAllOutfits, saveOutfit } from './src/storage/outfits.js';
import { writeMetadata, isPng } from './src/storage/png-metadata.js';
import { resolveActiveCharacters } from './src/prompt/binding.js';
import { parseTriggers } from './src/prompt/triggers.js';
import { assemblePrompt, mergeProfileParams, applyMarkerParamOverrides, resolveLockedSeed, resolveSizeKeyword } from './src/prompt/render.js';
import { mergeParams } from './src/backends/checkpoint-profiles.js';
import { cleanupEnvelope } from './src/prompt/cleanup.js';
import { applyReplaceRules } from './src/prompt/replace.js';
import { maskLoras, unmaskLoras, reorderPrompt, collectLoras } from './src/prompt/ordering.js';
import { readChatStyleId, writeChatStyleId } from './src/prompt/active-style.js';
import { resolveBackendKind, resolveGenerationContext } from './src/prompt/generation-context.js';
import { buildSubjectCatalog, extractSubjectTokens, repairBareSubjectNames, resolveDeclaredSubjects, styleLeakFragments, validateScenePrompt } from './src/llm/subjects.js';
import { PROFILES } from './src/profiles.js';
import { createEngine } from './src/llm/engine.js';
import { applyPlacements as injectPlacements } from './src/llm/inject.js';
import { parseLlmReply } from './src/llm/parser.js';
import { event_types, eventSource, extension_prompts } from '../../../../script.js';
import { getContext } from '../../../st-context.js';

// toastr is a page global (loaded via <script src="lib/toastr.min.js"> in index.html);
// ST extensions use it without importing it.
/* global toastr */

// ------------------------------------------------------------------
// Settings and backend clients
// ------------------------------------------------------------------

const settings = getSettings();

// D5: the second (optional) argument surfaces the Variety+ toggle live.
const nai = new NaiClient(
    () => settings.backends.nai.apiKey,
    () => ({ variety: settings.backends.nai.variety === true }),
);
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
    // 'st-relay' routes through SillyTavern's /api/sd/* like the built-in
    // Image Generation extension (no backend CORS needed); 'direct' keeps
    // the browser-to-backend path. Read live so the UI toggle applies at once.
    getTransport: () => settings.backends.a1111.transport,
    getRequestHeaders: () => getContext().getRequestHeaders(),
});

function notify(kind, message) {
    if (settings?.notifications === false) return;
    if (typeof toastr !== 'undefined' && typeof toastr[kind] === 'function') toastr[kind](message, 'IF Image');
}

/** Effective backend kind for chat generation, derived from persisted settings. */
function defaultBackendKind() {
    return resolveBackendKind(settings);
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
    let roster = { characters: [], styles: [], persona: null, personas: [], outfits: [], replaceRules: [] };
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
            roster = { characters, styles, persona, personas, outfits, replaceRules };
        } catch (err) {
            if (epoch !== rosterEpoch) return;
            console.warn('[IF Image] Roster load failed:', err?.message ?? err);
        }
    }
    const initialRosterLoad = refreshRoster();
    // Storage writes announce themselves so generation sees edits immediately;
    // no page refresh or manual sync action is required.
    const onRosterDataChanged = () => refreshRoster();
    globalThis.addEventListener?.('if-image:data-changed', onRosterDataChanged);

    // ------------------------------------------------------------------
    // D6: image cache management.
    // - Save wrapper: fresh blobs are JPEG-converted when
    //   settings.cache.jpegQuality > 0 (never converts existing records;
    //   failure records have no blob and pass through untouched).
    // - Startup prune: fire-and-forget by ttlDays/maxMB when either > 0.
    // ------------------------------------------------------------------
    /**
     * Embed prompt/seed/params into a PNG as a tEXt chunk.
     *
     * Runs BEFORE the JPEG step on purpose: JPEG has no PNG chunks, so a
     * converted image can carry nothing. When both are enabled the user has
     * chosen size over portability, and the conversion silently wins.
     *
     * Every failure returns the original blob. A metadata problem must never
     * cost the user the image itself.
     */
    async function embedPngMetadata(blob, record) {
        if (!blob || settings.cache?.embedPngMetadata === false) return blob;
        if (typeof blob.arrayBuffer !== 'function') return blob;
        try {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            if (!isPng(bytes)) return blob; // JPEG/WebP: nothing to embed into
            const out = writeMetadata(bytes, record);
            return new Blob([out], { type: 'image/png' });
        } catch (err) {
            console.warn('[IF Image] PNG metadata embed failed; saving the original:', err?.message ?? err);
            return blob;
        }
    }

    async function saveImageRecordWithCache(record) {
        const quality = Number(settings.cache?.jpegQuality ?? 0);
        let blob = record?.blob ?? null;
        if (blob) blob = await embedPngMetadata(blob, record);
        if (blob && quality > 0) blob = await toJpegBlob(blob, quality);
        return blob === record?.blob ? saveImageRecord(record) : saveImageRecord({ ...record, blob });
    }
    {
        const ttlDays = Number(settings.cache?.ttlDays ?? 0);
        const maxMB = Number(settings.cache?.maxMB ?? 0);
        if (ttlDays > 0 || maxMB > 0) {
            pruneImages({
                olderThanMs: ttlDays > 0 ? ttlDays * 86400000 : undefined,
                maxBytes: maxMB > 0 ? maxMB * 1024 * 1024 : undefined,
            }).then(({ deleted, bytesFreed }) => {
                if (deleted > 0) console.log(`[IF Image] Cache prune: ${deleted} records, ${(bytesFreed / 1048576).toFixed(1)} MB freed.`);
            }).catch(err => console.warn('[IF Image] Cache prune failed:', err?.message ?? err));
        }
    }

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

    function parseContent(content, { warnFallback = true } = {}) {
        const activeRoster = resolveActiveCharacters(roster.characters, currentCardId(), getContext().getCurrentChatId?.());
        return parseTriggers(content, {
            roster: activeRoster,
            fullRoster: roster.characters,
            styles: roster.styles,
            defaultPersona: roster.persona,
            personas: roster.personas,
            outfits: roster.outfits,
            onFallback: warnFallback
                ? (tier, token) => notify('warning', `Character trigger "$${token}" resolved via ${tier} fallback (not active for this chat/card).`)
                : undefined,
        });
    }

    function effectiveGenerationContext(source = null) {
        const parsedTriggers = typeof source === 'string' ? parseContent(source, { warnFallback: false }) : source;
        return resolveGenerationContext({ settings, roster, chatStyleId: readChatStyleId(getContext()), parsedTriggers });
    }

    function fullSubjectCatalog() {
        return buildSubjectCatalog({
            characters: roster.characters, personas: roster.personas, persona: roster.persona,
            includeAll: true, maxSubjects: Number.MAX_SAFE_INTEGER,
        });
    }

    function compile(content) {
        const unknownSubjects = extractSubjectTokens(content, fullSubjectCatalog()).unknown;
        if (unknownSubjects.length) {
            const err = new Error(`Unknown subject token: ${unknownSubjects.join(', ')}`);
            err.code = 'UNKNOWN_SUBJECT';
            throw err;
        }
        const parsed = parseContent(content);
        // Planner and compiler consume this same effective context.
        const generation = effectiveGenerationContext(parsed);
        const activeStyle = generation.activeStyle;
        if (activeStyle.style && activeStyle.source !== 'marker') parsed.styles = [...parsed.styles, activeStyle.style];
        else if (activeStyle.missingId) notify('warning', 'The style chosen for this chat no longer exists — no style was applied. Pick another in the Generation tab.');
        const backendKind = generation.backendKind;
        const activeProfile = generation.activeCheckpointProfile;
        const checkpointTitle = generation.checkpointTitle;
        const profileKey = generation.profileKey;
        const baseProfile = generation.profile;
        const effectiveProfile = mergeProfileParams(baseProfile, settings.generation?.params?.[profileKey]);
        const assembled = assemblePrompt(parsed, baseProfile.dialect, effectiveProfile);

        // LoRA tokens must not reach the tag pipeline: normalizeBooruTags and
        // the anima cleanup branch replace every underscore, turning
        // <lora:my_cool_lora:1> into <lora:my cool lora:1>, and
        // dropTailByBudget can cut a trailing one. Mask them to opaque
        // placeholders here and re-emit the originals in the ordering stage.
        const masked = maskLoras(assembled.prompt);
        assembled.prompt = masked.text;

        // Pipeline order (C6/C7): compile -> non-final replace rules ->
        // cleanup -> final replace rules -> ordering -> marker JSON params.
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
        if (envelope.prompt !== assembled.prompt || envelope.negative !== assembled.negative) {
            notify('info', 'Prompt filters applied.');
        }

        // Final stage, deliberately last: a prefix-head replace rule inserts
        // at index 0 and would otherwise displace a leading LoRA.
        const order = settings.generation?.promptOrder ?? {};
        if (order.enabled !== false) {
            envelope = {
                ...envelope,
                prompt: reorderPrompt(envelope.prompt, {
                    loras: masked.loras,
                    extraLoras: collectLoras(parsed),
                    keepLoraPosition: order.keepLoraPosition === true,
                }),
            };
        } else {
            // Ordering off: still restore the masked LoRAs, or the prompt
            // would ship placeholder text to the backend.
            envelope = { ...envelope, prompt: unmaskLoras(envelope.prompt, masked.loras) };
        }

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
                profileId: activeProfile?.id,
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
        getContext: () => ({ ...getContext(), extensionPrompts: extension_prompts }),
        roster: () => roster,
        substituteParams: (s) => {
            try { return getContext().substituteParams?.(s) ?? s; } catch { return s; }
        },
        compile,
        notify,
        resolveGenerationContext: source => effectiveGenerationContext(source),
    });

    const activeLlmAborts = new Set();
    async function rewriteWithAbort(content, opts = {}) {
        const controller = new AbortController();
        activeLlmAborts.add(controller);
        logEvent('llm_request', { contentLength: String(content).length });
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

    async function syncPersonaRequest({ signal } = {}) {
        const controller = new AbortController();
        const forwardAbort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener('abort', forwardAbort, { once: true });
        activeLlmAborts.add(controller);
        try {
            return await engine.syncPersonaFromSt({ signal: controller.signal });
        } finally {
            signal?.removeEventListener('abort', forwardAbort);
            activeLlmAborts.delete(controller);
        }
    }

    // Fill an empty persona roster once per page load. This is deliberately
    // silent and only runs when the selected transport is actually usable.
    let initialPersonaSyncAttempted = false;
    async function autoSyncInitialPersona() {
        if (initialPersonaSyncAttempted) return false;
        initialPersonaSyncAttempted = true;
        await initialRosterLoad;
        if ((roster.personas?.length ?? 0) > 0) return false;

        let ctx;
        try { ctx = getContext(); } catch { return false; }
        const llm = settings.llm ?? {};
        const profiles = Array.isArray(llm.apiProfiles) ? llm.apiProfiles : [];
        const mappedId = llm.requestMapping?.persona_gen?.apiProfileId ?? '';
        const profile = profiles.find(item => item.id === mappedId)
            ?? profiles.find(item => item.id === llm.defaultApiProfileId)
            ?? null;
        const method = profile?.method ?? llm.defaultMethod ?? 'generateRaw';
        const rawMethod = ['direct', 'st_generate_raw', 'generateRaw'].includes(method);
        const cmMethod = ['st_connection_manager', 'connection_manager'].includes(method);
        const canUseRaw = typeof ctx?.generateRaw === 'function';
        const canUseCm = cmMethod && Boolean(profile?.stProfileId)
            && (typeof ctx?.ConnectionManagerRequestService?.sendRequest === 'function' || canUseRaw);
        const canUseDirectFetch = method === 'direct_fetch' && Boolean(profile?.baseUrl && profile?.model);
        if (!(rawMethod && canUseRaw) && !canUseCm && !canUseDirectFetch) return false;

        try {
            const result = await syncPersonaRequest();
            if (!result?.persona || typeof result.persona !== 'object') return false;
            // A user may have created/synced a persona while the LLM request
            // was running. Re-check storage to avoid creating a duplicate.
            if ((await getAllPersonas()).length > 0) {
                await refreshRoster();
                return false;
            }
            const persona = createDefaultPersona(result.persona.name || 'Default User');
            applyPersonaSync(persona, result.persona, true);
            await savePersona(persona);
            await refreshRoster();
            console.info('[IF Image] Initial SillyTavern persona sync completed.');
            return true;
        } catch (err) {
            if (err?.code !== 'ABORTED' && err?.name !== 'AbortError') {
                // Log only the error category; backend detail may contain secrets.
                console.warn('[IF Image] Initial persona sync skipped:', err?.code ?? err?.name ?? 'ERROR');
            }
            return false;
        }
    }
    const initialPersonaSync = autoSyncInitialPersona();

    // D4: edit-before-generate dialog. ui.js owns the DOM/popup; the LLM
    // assist goes through exactly one callback (engine.modifyTags) so ui.js
    // never imports the engine.
    const openEditDialog = createEditDialog({
        getContext: () => getContext(),
        modifyTags: (tagList, instruction, opts) => engine.modifyTags(tagList, instruction, opts),
        notify,
        profiles: PROFILES,
    });

    const pipeline = createMarkerPipeline({
        getQueue: () => queue,
        compile,
        getImagesForMessage,
        saveImageRecord: saveImageRecordWithCache,
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
        openEditDialog,
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
            if (snapshot.status === 'running') notify('info', 'Generating image…');
            else if (snapshot.status === 'succeeded') notify('success', 'Image generated.');
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
        return saveImageRecordWithCache({
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
    const finalSceneMetadata = new Map(); // exact marker content -> queued metadata
    function registerFinalScene(content, overrides = {}) {
        const queue = finalSceneMetadata.get(content) ?? [];
        const item = { overrides };
        queue.push(item);
        finalSceneMetadata.set(content, queue);
        while (finalSceneMetadata.size > 64) finalSceneMetadata.delete(finalSceneMetadata.keys().next().value);
        setTimeout(() => {
            const pending = finalSceneMetadata.get(content);
            if (!pending) return;
            const index = pending.indexOf(item);
            if (index >= 0) pending.splice(index, 1);
            if (!pending.length) finalSceneMetadata.delete(content);
        }, 15000);
    }
    function takeFinalScene(content) {
        const queue = finalSceneMetadata.get(content);
        if (!queue?.length) return null;
        const item = queue.shift();
        if (!queue.length) finalSceneMetadata.delete(content);
        return item;
    }
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
            const catalog = fullSubjectCatalog();
            const declared = resolveDeclaredSubjects(entry.subjects, catalog);
            if (declared.errors.length) return block;
            let promptText = entry.prompt.split(tags.endTag).join(' ').trim();
            if (declared.mode === 'structured' && declared.tokens.length) {
                promptText = repairBareSubjectNames(promptText, catalog, { requiredTokens: declared.tokens }).prompt;
            }
            const generation = effectiveGenerationContext(promptText);
            const validation = validateScenePrompt(promptText, catalog, {
                requiredTokens: declared.mode === 'structured' ? declared.tokens : [],
                allowedTokens: declared.mode === 'structured' ? declared.tokens : null,
                forbiddenFragments: styleLeakFragments(generation.activeStyle?.style, generation.dialectKey),
            });
            if (!validation.ok) return block;
            registerFinalScene(promptText, { width: entry.width, height: entry.height });
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
        getChatContext: () => getContext(),
        eventSource,
        event_types,
        // UI persistence happens before this refresh, so later LLM calls see
        // the newly imported/synced roster immediately.
        refreshRoster,
        initialPersonaSync,
        syncPersonaFromSt: ({ signal } = {}) => syncPersonaRequest({ signal }),
        planChatImages: async (count, { signal } = {}) => {
            const controller = new AbortController();
            activeLlmAborts.add(controller);
            if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
            logEvent('llm_request', { requestType: 'chat_place', count });
            try {
                const result = await engine.planChatImages(count, { signal: controller.signal });
                logEvent('llm_reply', { method: result.method, placements: result.placements.length });
                return result;
            } finally {
                activeLlmAborts.delete(controller);
            }
        },
        applyPlacements: (placements) => {
            const ctx = getContext();
            const tags = settings.generation ?? {};
            const result = injectPlacements(placements, {
                chat: ctx.chat ?? [],
                // The planner already returned validated scenes. Standard
                // markers let the one existing runtime/pipeline pick them up.
                mode: 'direct',
                startTag: tags.startTag ?? 'image###',
                endTag: tags.endTag ?? '###',
                saveChat: () => ctx.saveChat?.(),
                updateMessageBlock: ctx.updateMessageBlock
                    ? (id, message) => ctx.updateMessageBlock(id, message)
                    : undefined,
                emit: (id) => eventSource.emit(event_types.MESSAGE_UPDATED, id),
                onMarkerBuilt: ({ placement, content }) => registerFinalScene(content, {
                    width: placement.width,
                    height: placement.height,
                }),
            });
            // Forward the WHOLE outcome. `touched` = messages whose .mes
            // gained a marker; `rendered` = messages the host actually redrew.
            // The marker runtime walks the message DOM and never reads
            // chat[i].mes, so touched > rendered means those markers exist in
            // memory but are invisible to detection until the chat is
            // reloaded. Collapsing this to touched.length is what let
            // "Placed 1 image" report success for a marker that never
            // generated anything.
            return {
                placed: result.touched.length,
                rendered: result.rendered,
                touchedIds: result.touched,
                saved: result.saved,
                skippedEmpty: result.skippedEmpty,
                shadowed: result.shadowed,
            };
        },
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
            const finalScene = takeFinalScene(marker.content);
            if (finalScene) {
                // Validated planner/transformed scene: preserve restore-before-
                // rewrite, but do not ask an LLM to rewrite it a third time.
                pipeline.onMarker({ ...marker, final: true, overrides: finalScene.overrides });
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
        globalThis.removeEventListener?.('if-image:data-changed', onRosterDataChanged);
        for (const type of restoreEvents) eventSource.removeListener(type, onRendered);
        if (receivedType) eventSource.removeListener(receivedType, onMessageReceived);
        runtime.unregister();
        queue.dispose();
        pipeline.disposeAll();
    });
});
