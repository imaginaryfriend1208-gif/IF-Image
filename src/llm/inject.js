// IF Image - Marker injection for chat placements.
// Pure module: every ST touchpoint (chat array, saveChat, updateMessageBlock,
// event emit) is passed in, so the ordering below is testable offline.
//
// Ordering matters and is the whole point of this file. The marker runtime
// (src/runtime/events.js) detects markers by walking the message DOM via
// renderedSegments — it never reads chat[i].mes. SillyTavern's own edit path
// re-renders the message block BEFORE emitting MESSAGE_UPDATED, so a caller
// that mutates .mes and emits without re-rendering leaves the new marker
// invisible to detection until something unrelated redraws the message.

/**
 * Build the marker text for a prompt.
 *
 * Direct mode emits the configured start/end tags, which compile locally.
 * Assist/Full emit an <ifimage> block instead: those modes route markers
 * back through the LLM, and the placement prompt was already written by one.
 *
 * @param {string} prompt
 * @param {{ mode?: string, startTag?: string, endTag?: string }} opts
 * @returns {string}
 */
export function markerContent(prompt, endTag = '###') {
    return String(prompt ?? '').split(endTag).join(' ').trim();
}

export function buildMarker(prompt, { mode = 'direct', startTag = 'image###', endTag = '###' } = {}) {
    // A prompt containing the end tag would truncate its own marker.
    const promptText = markerContent(prompt, endTag);
    return mode === 'direct'
        ? `${startTag} ${promptText} ${endTag}`
        : `<ifimage>${promptText}</ifimage>`;
}

/**
 * Append markers to the messages named by `placements`.
 *
 * @param {Array<{ messageId: number, prompt: string }>} placements
 * @param {{
 *   chat: Array<object>,
 *   mode?: string,
 *   startTag?: string,
 *   endTag?: string,
 *   saveChat?: () => void,
 *   updateMessageBlock?: (id: number, message: object) => void,
 *   emit?: (id: number) => void,
 *   logger?: { warn: Function },
 * }} deps
 * Every stage reports its own outcome. Injecting text into chat[i].mes is
 * only the FIRST of four steps, and the three that follow can each fail
 * independently. A caller that looks at `touched` alone will announce
 * success for a marker that never became visible and never generated —
 * exactly the "Placed 1 image, but nothing happened" report this contract
 * exists to prevent.
 *
 * @returns {{
 *   touched: number[],        messages whose .mes gained a marker
 *   rendered: number,         how many were actually redrawn
 *   renderedIds: number[],    which ones
 *   emitted: number[],        which MESSAGE_UPDATED emits succeeded
 *   saved: boolean|null,      true/false, or null when the host has no saveChat
 *   skippedEmpty: number[],   placements dropped for having no prompt text
 * }}
 */
export function applyPlacements(placements, {
    chat = [], mode = 'direct', startTag = 'image###', endTag = '###',
    saveChat, updateMessageBlock, emit, onMarkerBuilt, logger = console,
} = {}) {
    const list = Array.isArray(placements) ? placements : [];
    const touched = [];
    const skippedEmpty = [];
    const seen = new Set();

    // Inject from the end so earlier indices stay valid as we go.
    for (const p of [...list].reverse()) {
        const message = chat[p?.messageId];
        if (!message || seen.has(p.messageId)) continue;
        const content = markerContent(p.prompt, endTag);
        // An empty prompt would build `image###  ###`: a real, detectable
        // marker that compiles to an empty prompt and burns a generation on
        // nothing. Drop it here and let the caller say so.
        if (!content) {
            skippedEmpty.push(p.messageId);
            continue;
        }
        const marker = buildMarker(content, { mode, startTag, endTag });
        try { onMarkerBuilt?.({ placement: p, content, marker }); } catch (err) {
            logger.warn?.(`[IF Image] placement metadata registration failed: ${err?.message ?? err}`);
        }
        const sep = message.mes && !/\s$/.test(message.mes) ? '\n' : '';
        message.mes = `${message.mes ?? ''}${sep}${marker}`;
        seen.add(p.messageId);
        touched.push(p.messageId);
    }

    if (!touched.length) {
        return { touched: [], rendered: 0, renderedIds: [], emitted: [], saved: null, skippedEmpty };
    }

    const saved = persist(saveChat, 'placement', logger);
    const renderedIds = rerender(touched, { chat, updateMessageBlock, logger });
    const emitted = emitAll(touched, emit, logger);
    // ST renders `extra.display_text ?? mes`. When a translation extension
    // owns display_text the redraw "succeeds" but paints the OLD text, so the
    // marker is invisible to DOM detection and no image is ever generated.
    const shadowed = touched.filter(id => chat[id]?.extra?.display_text);
    if (shadowed.length) {
        logger.warn?.(`[IF Image] ${shadowed.length} message(s) have extra.display_text; the injected marker will not be rendered or detected.`);
    }

    return { touched, rendered: renderedIds.length, renderedIds, emitted, saved, skippedEmpty, shadowed };
}

/**
 * Restore messages to snapshotted text, undoing a placement run.
 *
 * @param {Array<{ messageId: number, prevMes: string }>} snapshots
 * @param {object} deps - same shape as applyPlacements
 * Undo has the same honesty requirement as placement, and a worse failure
 * mode: if the message cannot be redrawn the marker text stays on screen
 * while .mes no longer contains it, so the user believes the undo worked.
 *
 * @returns {{ restored: number[], rendered: number, renderedIds: number[],
 *             emitted: number[], saved: boolean|null }}
 */
export function undoPlacements(snapshots, {
    chat = [], saveChat, updateMessageBlock, emit, logger = console,
} = {}) {
    const list = Array.isArray(snapshots) ? snapshots : [];
    const restored = [];

    for (const snap of list) {
        const message = chat[snap?.messageId];
        if (!message) continue;
        message.mes = snap.prevMes;
        restored.push(snap.messageId);
    }

    if (!restored.length) {
        return { restored: [], rendered: 0, renderedIds: [], emitted: [], saved: null };
    }

    const saved = persist(saveChat, 'undo', logger);
    // Without this the removed marker stays on screen.
    const renderedIds = rerender(restored, { chat, updateMessageBlock, logger });
    const emitted = emitAll(restored, emit, logger);

    return { restored, rendered: renderedIds.length, renderedIds, emitted, saved };
}

/**
 * Persist through the host, reporting whether it actually happened.
 * A failed save means the markers vanish on the next chat load, so the
 * caller has to be able to say so rather than only warning the console.
 * @returns {boolean|null} null when the host supplied no saveChat at all
 */
function persist(saveChat, stage, logger) {
    if (typeof saveChat !== 'function') return null;
    try {
        const result = saveChat();
        // ST's ctx.saveChat IS saveChatConditional, an async function. A
        // synchronous try/catch only proves the call started, so claiming
        // `true` here would be the very false-success this contract exists to
        // remove. Report 'pending' and keep the rejection from going unhandled.
        if (result && typeof result.then === 'function') {
            result.catch(err => logger.warn?.(`[IF Image] saveChat after ${stage} rejected: ${err?.message ?? err}`));
            return 'pending';
        }
        return true;
    } catch (err) {
        logger.warn?.(`[IF Image] saveChat after ${stage} failed: ${err?.message ?? err}`);
        return false;
    }
}

/**
 * Emit MESSAGE_UPDATED per id. Each emit is isolated: a listener that throws
 * used to abort the loop AND propagate out of applyPlacements, so already
 * injected markers were reported as a total failure.
 * @returns {number[]} ids whose emit completed
 */
function emitAll(ids, emit, logger) {
    const emitted = [];
    if (typeof emit !== 'function') return emitted;
    for (const id of ids) {
        try {
            const result = emit(id);
            // ST's EventEmitter.emit is async AND swallows listener errors
            // internally, so a sync catch can never see them. `emitted` means
            // "dispatch started", not "every listener finished".
            if (result && typeof result.then === 'function') {
                result.catch(err => logger.warn?.(`[IF Image] MESSAGE_UPDATED emit for message ${id} rejected: ${err?.message ?? err}`));
            }
            emitted.push(id);
        } catch (err) {
            logger.warn?.(`[IF Image] MESSAGE_UPDATED emit for message ${id} failed: ${err?.message ?? err}`);
        }
    }
    return emitted;
}

/**
 * Re-render message blocks, tolerating a host that lacks the helper.
 * Counts only redraws that actually completed: a throwing renderer must not
 * be counted, because the marker runtime walks the DOM and an unrendered
 * marker is invisible to detection.
 * @returns {number[]} ids that were redrawn
 */
function rerender(ids, { chat, updateMessageBlock, logger }) {
    const renderedIds = [];
    const hasRenderer = typeof updateMessageBlock === 'function';
    for (const id of ids) {
        const message = chat[id];
        if (!message || !hasRenderer) continue;
        try {
            updateMessageBlock(id, message);
            renderedIds.push(id);
        } catch (err) {
            logger.warn?.(`[IF Image] Re-render of message ${id} failed: ${err?.message ?? err}`);
        }
    }
    if (ids.length && !renderedIds.length) {
        logger.warn?.('[IF Image] No message could be re-rendered (updateMessageBlock unavailable); markers may not be detected until the chat is reloaded.');
    }
    return renderedIds;
}
