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

/**
 * R3: a slot with VISIBLE content (chips, buttons, images) must not stay
 * aria-hidden. Spinner-only and empty slots keep aria-hidden="true" so their
 * transient status never enters the runtime's rendered segments; chip text
 * is static and contains no marker tags, so exposing it cannot re-trigger
 * detection (the original marker text was removed from the DOM).
 */
function setSlotVisible(slot, visible) {
    if (visible) slot.removeAttribute('aria-hidden');
    else slot.setAttribute('aria-hidden', 'true');
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
        setSlotVisible(slot, false);
        const spinner = doc.createElement('div');
        spinner.className = 'ifimg-spinner';
        slot.appendChild(spinner);
        return;
    }
    if (status === 'failed' || status === 'cancelled') {
        setSlotVisible(slot, true);
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
    setSlotVisible(slot, true);
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
        ['Repro', actions.onRepro], // D2: regenerate with the record's seed
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
    setSlotVisible(slot, true);
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
 * R3: visible idle chip for a marker slot with nothing persisted and no
 * live task — "Image not generated" (or a caller-supplied label) plus an
 * explicit Generate button, so a marker can never silently vanish. All text
 * goes through textContent, never innerHTML.
 * @param {Node} slot
 * @param {Document} doc
 * @param {{onGenerate?: () => void, label?: string}} [options]
 * @returns {Node} the chip element
 */
export function renderIdleChip(slot, doc, { onGenerate, label } = {}) {
    slot.dataset.ifimgState = 'idle';
    setSlotVisible(slot, true);
    clearChildren(slot);
    const chip = doc.createElement('span');
    chip.className = 'ifimg-chip ifimg-chip-idle';
    chip.textContent = label || 'Image not generated';
    slot.appendChild(chip);
    if (typeof onGenerate === 'function') {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ifimg-retry menu_button';
        btn.textContent = 'Generate';
        btn.addEventListener('click', onGenerate);
        slot.appendChild(btn);
    }
    return chip;
}

// D1: only one lightbox may exist at a time, enforced at module level so
// even independent callers cannot stack overlays.
let activeLightboxClose = null;

/**
 * D1: full-size preview lightbox over a slot's saved image records (newest
 * first). Features:
 * - prev/next buttons and ArrowLeft/ArrowRight with wrap-around;
 * - Escape and backdrop click close; clicking the image/content does NOT
 *   (the inner container stops propagation);
 * - Download link (a[download]) with a dedicated object URL;
 * - Delete: awaits onDelete(record), removes it from the local array and
 *   shows the next record (wraps); when the array empties, closes — the
 *   caller collapses the slot from its own onDelete bookkeeping;
 * - Regen: calls onRegenerate() then closes;
 * - caption "seed · checkpoint · WxH · profile" (+ position when >1).
 * Every object URL created here is revoked on navigation and on close;
 * URLs returned by getObjectUrl belong to the caller and are never revoked.
 * Opening a second lightbox closes the first. Returns close().
 *
 * @param {Document} doc
 * @param {{records: Array<object>, index?: number,
 *          onDelete?: (record: object) => Promise<void>|void,
 *          onRegenerate?: () => void,
 *          getObjectUrl?: (record: object) => string|null}} options
 * @returns {() => void} close
 */
export function openLightbox(doc, { records, index = 0, onDelete, onRegenerate, getObjectUrl } = {}) {
    if (activeLightboxClose) activeLightboxClose();
    const list = Array.isArray(records) ? records.filter(Boolean) : [];
    if (!list.length) return () => {};
    let i = Math.min(Math.max(index, 0), list.length - 1);
    let closed = false;
    const owned = []; // object URLs created HERE; revoked on navigation/close

    const overlay = doc.createElement('div');
    overlay.className = 'ifimg-lightbox';
    const inner = doc.createElement('div');
    inner.className = 'ifimg-lightbox-inner';
    overlay.appendChild(inner);

    const makeButton = (cls, label, handler) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = label;
        b.addEventListener('click', handler);
        return b;
    };

    const stage = doc.createElement('div');
    stage.className = 'ifimg-lb-stage';
    const prevBtn = makeButton('ifimg-lb-prev menu_button', '‹', () => nav(-1));
    const img = doc.createElement('img');
    img.alt = 'Generated image (full size)';
    const nextBtn = makeButton('ifimg-lb-next menu_button', '›', () => nav(1));
    stage.appendChild(prevBtn);
    stage.appendChild(img);
    stage.appendChild(nextBtn);
    inner.appendChild(stage);

    const caption = doc.createElement('div');
    caption.className = 'ifimg-lb-caption';
    inner.appendChild(caption);

    const actions = doc.createElement('div');
    actions.className = 'ifimg-lb-actions';
    const downloadLink = doc.createElement('a');
    downloadLink.className = 'ifimg-lb-download menu_button';
    downloadLink.textContent = 'Download';
    actions.appendChild(downloadLink);
    if (typeof onRegenerate === 'function') {
        actions.appendChild(makeButton('ifimg-lb-regen menu_button', 'Regen', () => {
            onRegenerate();
            close();
        }));
    }
    if (typeof onDelete === 'function') {
        actions.appendChild(makeButton('ifimg-lb-delete menu_button', 'Delete', async () => {
            const record = list[i];
            try {
                await onDelete(record);
            } catch {
                return; // caller already notified; keep the record and stay open
            }
            if (closed) return;
            list.splice(i, 1);
            if (!list.length) { close(); return; }
            if (i >= list.length) i = 0; // "next" wraps past the end
            show();
        }));
    }
    inner.appendChild(actions);

    function revokeOwned() {
        for (const url of owned) URL.revokeObjectURL(url);
        owned.length = 0;
    }

    function show() {
        revokeOwned();
        const record = list[i];
        let displayUrl = typeof getObjectUrl === 'function' ? getObjectUrl(record) : null;
        if (!displayUrl && record.blob) {
            displayUrl = URL.createObjectURL(record.blob);
            owned.push(displayUrl);
        }
        img.src = displayUrl ?? '';
        if (record.blob) {
            // Dedicated download URL, revoked with the rest on nav/close.
            const dl = URL.createObjectURL(record.blob);
            owned.push(dl);
            downloadLink.href = dl;
            downloadLink.setAttribute('download', `ifimage-${record.id ?? 'live'}.png`);
            downloadLink.hidden = false;
        } else {
            downloadLink.href = '';
            downloadLink.hidden = true; // live-only view (record save failed)
        }
        const position = list.length > 1 ? ` · ${i + 1}/${list.length}` : '';
        caption.textContent = [
            `seed ${record.seed ?? '?'}`,
            record.checkpoint || '(no checkpoint)',
            `${record.width ?? '?'}x${record.height ?? '?'}`,
            record.profileKey || '(no profile)',
        ].join(' · ') + position;
        prevBtn.hidden = list.length < 2;
        nextBtn.hidden = list.length < 2;
    }

    function nav(delta) {
        i = (i + delta + list.length) % list.length;
        show();
    }

    function onKey(event) {
        if (event.key === 'Escape') close();
        else if (event.key === 'ArrowLeft') nav(-1);
        else if (event.key === 'ArrowRight') nav(1);
    }

    function close() {
        if (closed) return;
        closed = true;
        revokeOwned();
        overlay.remove();
        doc.removeEventListener('keydown', onKey);
        if (activeLightboxClose === close) activeLightboxClose = null;
    }

    inner.addEventListener('click', (event) => event.stopPropagation());
    overlay.addEventListener('click', close);
    doc.addEventListener('keydown', onKey);
    (doc.body || doc).appendChild(overlay);
    activeLightboxClose = close;
    show();
    return close;
}
