// IF Image - In-chat marker replacement, image slot rendering, and click
// interactions. Replaces literal `startTag...endTag` marker text inside a
// rendered message with a slot element, then swaps in the image when its
// task settles.
//
// Coordinate with src/runtime/events.js: it detects markers over
// `renderedSegments` (skipping excluded tags/blocks and aria-hidden nodes),
// and numbers occurrences via `segments.flatMap(...)` — a flat index across
// all segments in order. This module MUST walk the same eligible text with
// the SAME skip/flush sets so insertion occurrence numbering matches
// detection numbering exactly. Keep EXCLUDED/BLOCKS in sync with events.js.
//
// Re-emission is prevented naturally only if the marker text is REMOVED from
// the DOM (replaced by a slot): the runtime's revision string is built from
// live rendered segments, so leaving any marker text behind would let a
// later scan re-detect it under a fresh revision. Therefore every marker in
// a message is replaced in one `replaceMarkers` pass. The slot span carries
// aria-hidden="true" so its own dynamic status text never re-enters segments.

import { buildMarkerRegex } from './events.js';

// Keep in sync with events.js renderedSegments.
const EXCLUDED = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'BUTTON', 'SVG']);
const BLOCKS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'TABLE', 'TR', 'TD', 'H1', 'H2', 'H3']);

/** Cheap non-cryptographic hash of marker content, for slot/record identity. */
export function contentHash(str) {
    let h = 5381;
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
}

function isEligible(node) {
    if (EXCLUDED.has(node.tagName)) return false;
    if (node.hidden) return false;
    if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return false;
    return true;
}

/**
 * Walk `root` exactly like events.js renderedSegments, but instead of
 * returning plain strings, return per-segment { text, chunks } where each
 * chunk records the text/br node backing a slice of `text`. A BR contributes
 * exactly one '\n' character and is always either fully inside or fully
 * outside any marker match (integer boundaries), so it never needs splitting
 * — only 'text' chunks are ever split at a match boundary.
 */
function collectSegments(root) {
    if (!root) return [];
    const segments = [];
    let text = '';
    let chunks = [];
    let cumulative = 0;
    function flush() {
        if (text) segments.push({ text, chunks });
        text = '';
        chunks = [];
        cumulative = 0;
    }
    function visit(node) {
        if (node.nodeType === 3) {
            const value = node.nodeValue || '';
            if (value) {
                chunks.push({ start: cumulative, end: cumulative + value.length, kind: 'text', node });
                cumulative += value.length;
                text += value;
            }
            return;
        }
        if (node.nodeType !== 1) return;
        if (!isEligible(node)) { flush(); return; }
        if (node.tagName === 'BR') {
            chunks.push({ start: cumulative, end: cumulative + 1, kind: 'br', node });
            cumulative += 1;
            text += '\n';
            return;
        }
        const boundary = node !== root && BLOCKS.has(node.tagName);
        if (boundary) flush();
        for (const child of node.childNodes) visit(child);
        if (boundary) flush();
    }
    visit(root);
    flush();
    return segments;
}

/**
 * Remove the [start, end) text range described by `chunks` (local offsets
 * into that segment's text) and insert `replacement` in its place. Handles
 * ranges spanning multiple text/br nodes, including nodes nested inside
 * inline elements (e.g. <b>, <span>) at different depths — the exact list of
 * overlapping chunks (already in document order from collectSegments) is
 * used directly, so no sibling-chasing across parents is needed.
 *
 * Boundary text chunks are split with the standard "split the end first,
 * then the start" ordering so a match fully inside a single text node (with
 * unrelated content on both sides) is handled correctly in one pass.
 */
function removeChunkRange(chunks, start, end, replacement) {
    const overlapping = chunks.filter(c => c.end > start && c.start < end);
    if (!overlapping.length) return false;

    const nodesToRemove = [];
    let insertParent = null;
    let insertRef = null;

    // Process in document order. Split TEXT chunks to isolate the marker
    // range; BR/element chunks are simply removed whole.
    overlapping.forEach((chunk, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === overlapping.length - 1;
        let node = chunk.node;

        if (chunk.kind === 'text') {
            if (isLast && chunk.end > end) {
                const localEnd = end - chunk.start;
                node.splitText(localEnd); // tail goes back, node keeps [0, localEnd)
            }
            if (isFirst && chunk.start < start) {
                const localStart = start - chunk.start;
                node = node.splitText(localStart); // marker-only portion returned
            }
            // Push the marker-only text node for removal.
            nodesToRemove.push(node);
        } else {
            // BR or other element: fully inside the range — remove entirely.
            nodesToRemove.push(chunk.node);
        }

        if (insertParent === null) {
            insertParent = chunk.node.parentNode;
            insertRef = (chunk.kind === 'text') ? node : chunk.node;
        }
    });

    insertParent.insertBefore(replacement, insertRef);
    for (const node of nodesToRemove) node.remove();
    return true;
}

/**
 * Find every marker in `root` (matching events.js detection exactly) and
 * replace each with a slot node built by `onFound`. Processes matches within
 * each segment in reverse so earlier offsets stay valid, and numbers
 * occurrences the same way events.js does (a flat index across all segments
 * in order).
 * @param {Node} root - .mes_text element
 * @param {{startTag: string, endTag: string}} tags
 * @param {(info: {occurrence: number, content: string}) => Node|null} onFound
 * @returns {number} number of markers replaced
 */
export function replaceMarkers(root, tags, onFound) {
    if (!root || typeof onFound !== 'function') return 0;
    const regex = buildMarkerRegex(tags);
    const segments = collectSegments(root);
    let occurrence = 0;
    let replaced = 0;
    for (const segment of segments) {
        const matches = Array.from(segment.text.matchAll(regex)).filter(m => m[1].trim());
        for (let i = matches.length - 1; i >= 0; i--) {
            const m = matches[i];
            const start = m.index;
            const end = start + m[0].length;
            const content = m[1].trim();
            const occIndex = occurrence + i;
            const slot = onFound({ occurrence: occIndex, content });
            if (slot && removeChunkRange(segment.chunks, start, end, slot)) replaced += 1;
        }
        occurrence += matches.length;
    }
    return replaced;
}

// ---------------------------------------------------------------------------
// Slot creation and state rendering
// ---------------------------------------------------------------------------

function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
}

/** Build a marker slot element with stable identity datasets. */
export function createSlotElement(doc, info) {
    const span = doc.createElement('span');
    span.className = 'ifimg-slot';
    span.setAttribute('aria-hidden', 'true');
    span.dataset.ifimgProcessed = 'true';
    span.dataset.ifimgOcc = String(info.occurrence);
    span.dataset.ifimgHash = contentHash(info.content);
    span.dataset.ifimgState = 'queued';
    return span;
}

/**
 * Render a non-succeeded task state (queued/running/failed/cancelled) into a
 * slot. 'succeeded' is handled separately by renderImageFrame, once the
 * generated Blob/object URL is available.
 * @param {{onRetry?: () => void}} actions
 */
export function renderSlotState(slot, snapshot, doc, actions = {}) {
    const status = snapshot?.status || 'queued';
    slot.dataset.ifimgState = status;
    clearChildren(slot);
    if (status === 'queued' || status === 'running') {
        const spinner = doc.createElement('div');
        spinner.className = 'ifimg-spinner';
        slot.appendChild(spinner);
        return;
    }
    if (status === 'failed' || status === 'cancelled') {
        const chip = doc.createElement('span');
        chip.className = `ifimg-chip ifimg-chip-${status}`;
        chip.textContent = status === 'failed'
            ? `Image failed${snapshot?.error?.message ? `: ${snapshot.error.message}` : ''}`
            : 'Cancelled';
        slot.appendChild(chip);
        if (status === 'failed' && typeof actions.onRetry === 'function') {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'ifimg-retry menu_button';
            btn.textContent = 'Retry';
            btn.addEventListener('click', actions.onRetry);
            slot.appendChild(btn);
        }
    }
}

/**
 * 300ms single/double-click disambiguation (st8u §22.1 pattern). A second
 * click within the window cancels the pending single-click action and fires
 * the double-click action instead.
 */
function attachClickBehavior(el, { onSingleClick, onDoubleClick } = {}) {
    let timer = null;
    el.addEventListener('click', () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
            if (typeof onDoubleClick === 'function') onDoubleClick();
            return;
        }
        timer = setTimeout(() => {
            timer = null;
            if (typeof onSingleClick === 'function') onSingleClick();
        }, 300);
    });
}

/**
 * Swap a slot to the succeeded image frame. Wires the 300ms click/dblclick
 * disambiguation: single click opens a lightbox, double click regenerates.
 * Also adds a hover overlay with explicit View/Regen/Delete buttons (Phase
 * C10) — each stopPropagation()s so it never also triggers the frame's own
 * click/dblclick handlers. Buttons are only rendered for actions the caller
 * actually supplies. The caller owns the object URL's lifetime (create/revoke).
 * @param {{onSingleClick?: () => void, onDoubleClick?: () => void,
 *           onView?: () => void, onRegen?: () => void, onDelete?: () => void}} actions
 */
export function renderImageFrame(slot, doc, objectUrl, actions = {}) {
    slot.dataset.ifimgState = 'succeeded';
    clearChildren(slot);
    const frame = doc.createElement('div');
    frame.className = 'ifimg-frame';
    const img = doc.createElement('img');
    img.src = objectUrl;
    img.alt = 'Generated image';
    frame.appendChild(img);

    const overlayActions = [
        ['View', actions.onView],
        ['Regen', actions.onRegen],
        ['Delete', actions.onDelete],
    ].filter(([, handler]) => typeof handler === 'function');
    if (overlayActions.length) {
        const overlay = doc.createElement('div');
        overlay.className = 'if-image-frame-overlay';
        for (const [label, handler] of overlayActions) {
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = `menu_button ifimg-overlay-${label.toLowerCase()}`;
            btn.textContent = label;
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                handler();
            });
            overlay.appendChild(btn);
        }
        frame.appendChild(overlay);
    }

    slot.appendChild(frame);
    attachClickBehavior(frame, actions);
    return frame;
}

/**
 * Collapse a slot back to a compact "regenerate" chip (Phase C10) — used
 * after the hover-overlay Delete button removes the image record, so the
 * marker slot stays usable instead of going blank. All text is set via
 * textContent (never innerHTML), so no HTML escaping is needed here.
 * @param {Node} slot
 * @param {Document} doc
 * @param {() => void} [onRegenerate]
 * @returns {Node} the chip element
 */
export function renderRegenerateChip(slot, doc, onRegenerate) {
    slot.dataset.ifimgState = 'idle';
    clearChildren(slot);
    const chip = doc.createElement('span');
    chip.className = 'ifimg-chip ifimg-chip-regenerate';
    chip.textContent = 'Image deleted';
    slot.appendChild(chip);
    if (typeof onRegenerate === 'function') {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ifimg-retry menu_button';
        btn.textContent = 'Regenerate';
        btn.addEventListener('click', onRegenerate);
        slot.appendChild(btn);
    }
    return chip;
}

/**
 * Full-size preview overlay. Click or Escape closes it. Returns a close()
 * function the caller may invoke early (e.g. on chat change).
 */
export function openLightbox(doc, imgSrc) {
    const overlay = doc.createElement('div');
    overlay.className = 'ifimg-lightbox';
    const img = doc.createElement('img');
    img.src = imgSrc;
    img.alt = 'Generated image (full size)';
    overlay.appendChild(img);
    function onKey(event) {
        if (event.key === 'Escape') close();
    }
    function close() {
        overlay.remove();
        doc.removeEventListener('keydown', onKey);
    }
    overlay.addEventListener('click', close);
    doc.addEventListener('keydown', onKey);
    const container = doc.body || doc;
    container.appendChild(overlay);
    return close;
}
