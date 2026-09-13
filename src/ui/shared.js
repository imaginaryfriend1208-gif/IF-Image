// IF Image - shared helpers for split UI modules (P5a).
// Each mount factory receives its own element scope; helpers are created per
// call so there is no module-global DOM state.

/** Create scoped helpers for a mounted subtree. */
export function makeHelpers(el) {
    /** id lookup inside the mounted subtree only. */
    function $(id) {
        return el.querySelector(`#${CSS.escape(id)}`);
    }

    /** One-line status writer; mirrors legacy ui.js behaviour. */
    function showResult(node, text, isError = false) {
        if (!node) return;
        node.textContent = text;
        node.classList.toggle('error', Boolean(isError));
        node.classList.add('visible');
        clearTimeout(showResult._t?.get(node));
        const t = setTimeout(() => {
            node.classList.remove('visible');
            showResult._t?.delete(node);
        }, 6000);
        (showResult._t ??= new Map()).set(node, t);
    }

    return { $, showResult };
}

/** Escape text for interpolation into innerHTML templates. */
export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
