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
export function buildMarker(prompt, { mode = 'direct', startTag = 'image###', endTag = '###' } = {}) {
    // A prompt containing the end tag would truncate its own marker.
    const promptText = String(prompt ?? '').split(endTag).join(' ').trim();
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
 * @returns {{ touched: number[], rendered: number }}
 */
export function applyPlacements(placements, {
    chat = [], mode = 'direct', startTag = 'image###', endTag = '###',
    saveChat, updateMessageBlock, emit, logger = console,
} = {}) {
    const list = Array.isArray(placements) ? placements : [];
    const touched = [];
    const seen = new Set();

    // Inject from the end so earlier indices stay valid as we go.
    for (const p of [...list].reverse()) {
        const message = chat[p?.messageId];
        if (!message || seen.has(p.messageId)) continue;
        const marker = buildMarker(p.prompt, { mode, startTag, endTag });
        const sep = message.mes && !/\s$/.test(message.mes) ? '\n' : '';
        message.mes = `${message.mes ?? ''}${sep}${marker}`;
        seen.add(p.messageId);
        touched.push(p.messageId);
    }

    if (!touched.length) return { touched: [], rendered: 0 };

    try {
        saveChat?.();
    } catch (err) {
        logger.warn?.(`[IF Image] saveChat after placement failed: ${err?.message ?? err}`);
    }

    const rendered = rerender(touched, { chat, updateMessageBlock, logger });
    for (const id of touched) emit?.(id);

    return { touched, rendered };
}

/**
 * Restore messages to snapshotted text, undoing a placement run.
 *
 * @param {Array<{ messageId: number, prevMes: string }>} snapshots
 * @param {object} deps - same shape as applyPlacements
 * @returns {{ restored: number[], rendered: number }}
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

    if (!restored.length) return { restored: [], rendered: 0 };

    try {
        saveChat?.();
    } catch (err) {
        logger.warn?.(`[IF Image] saveChat after undo failed: ${err?.message ?? err}`);
    }

    // Without this the removed marker stays on screen.
    const rendered = rerender(restored, { chat, updateMessageBlock, logger });
    for (const id of restored) emit?.(id);

    return { restored, rendered };
}

/**
 * Re-render message blocks, tolerating a host that lacks the helper.
 * @returns {number} how many messages were actually redrawn
 */
function rerender(ids, { chat, updateMessageBlock, logger }) {
    let rendered = 0;
    for (const id of ids) {
        const message = chat[id];
        if (!message) continue;
        try {
            updateMessageBlock?.(id, message);
            if (typeof updateMessageBlock === 'function') rendered++;
        } catch (err) {
            logger.warn?.(`[IF Image] Re-render of message ${id} failed: ${err?.message ?? err}`);
        }
    }
    if (ids.length && !rendered) {
        logger.warn?.('[IF Image] No message could be re-rendered (updateMessageBlock unavailable); markers may not be detected until the chat is reloaded.');
    }
    return rendered;
}
