// IF Image - Read-only rendered chat marker detection.
// Task cancellation and IDB restoration belong to subsequent runtime steps.

export function buildMarkerRegex(tags = {}) {
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const start = typeof tags.startTag === 'string' && tags.startTag ? tags.startTag : 'image###';
    const end = typeof tags.endTag === 'string' && tags.endTag ? tags.endTag : '###';
    return new RegExp(`${escape(start)}([\\s\\S]*?)${escape(end)}`, 'g');
}

// Pure text helper; runtime supplies only eligible rendered text segments.
export function extractMarkers(text, tags = {}) {
    if (typeof text !== 'string' || !text) return [];
    return Array.from(text.matchAll(buildMarkerRegex(tags)))
        .map(match => ({ content: match[1].trim() }))
        .filter(marker => marker.content);
}

/** Collect rendered text without joining across excluded nodes or blocks. */
export function renderedSegments(root) {
    if (!root) return [];
    const excluded = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'BUTTON', 'SVG']);
    const blocks = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'TABLE', 'TR', 'TD', 'H1', 'H2', 'H3']);
    const segments = [];
    let text = '';
    function flush() {
        if (text) segments.push(text);
        text = '';
    }
    function visit(node) {
        if (node.nodeType === 3) {
            text += node.nodeValue || '';
            return;
        }
        if (node.nodeType !== 1) return;
        if (excluded.has(node.tagName) || node.hidden || node.getAttribute?.('aria-hidden') === 'true') {
            flush();
            return;
        }
        if (node.tagName === 'BR') {
            text += '\n';
            return;
        }
        const boundary = node !== root && blocks.has(node.tagName);
        if (boundary) flush();
        for (const child of node.childNodes) visit(child);
        if (boundary) flush();
    }
    visit(root);
    flush();
    return segments;
}

/** ST dependencies are injected for offline lifecycle and DOM tests. */
export function createMarkerRuntime({
    eventSource, eventTypes = {}, getChatId = () => '', getMessage = () => null,
    getMessageElement = () => null, isStreaming = () => false,
    settings, onMarker = () => {}, logger = console,
    // Optional lifecycle hooks (Step 2.2). Observers only: a throwing
    // callback is logged and must never break reset or listener cleanup.
    onChatWillChange = null, onChatChanged = null, onDispose = null,
} = {}) {
    // ST chat objects survive index shifts; deleted objects are collectible.
    let seen = new WeakMap();
    let activeChat;
    let registered = false;
    let detach = [];

    function resetChat() {
        seen = new WeakMap();
        activeChat = getChatId();
    }

    function safeCall(callback, ...args) {
        if (typeof callback !== 'function') return;
        try {
            callback(...args);
        } catch (err) {
            logger.error?.(`[IF Image] lifecycle callback failed: ${err?.message ?? err}`);
        }
    }

    // `initial === true` strictly: event payloads (numbers, strings) passed by
    // CHAT_CHANGED or MESSAGE_DELETED must never be mistaken for options.
    function handleChatChanged(options) {
        const initial = options?.initial === true;
        const previous = activeChat;
        if (!initial) safeCall(onChatWillChange, previous);
        resetChat();
        if (!initial) safeCall(onChatChanged, previous, getChatId());
    }

    function processMessage(id) {
        if (!registered || settings?.enabled === false || settings?.generation?.enabled === false) return;
        if (typeof id !== 'number' && typeof id !== 'string') return;
        if (typeof id === 'string' && !/^\d+$/.test(id)) return;
        const messageId = Number(id);
        if (!Number.isSafeInteger(messageId) || messageId < 0) return;
        const chatId = getChatId();
        if (chatId === undefined || chatId === null || chatId === '') return;
        if (chatId !== activeChat) handleChatChanged();
        if (isStreaming(messageId)) return;
        const message = getMessage(messageId);
        if (!message || message.is_system) return;
        const root = getMessageElement(messageId);
        if (!root) return;
        const segments = renderedSegments(root);
        const tags = settings?.generation || {};
        const swipeId = message.swipe_id ?? 0;
        // Exact strings, not a lossy hash. Per-swipe history prevents regeneration
        // on switching away and back; changed revisions are processed separately.
        const revision = JSON.stringify([swipeId, message.mes, tags.startTag, tags.endTag, segments]);
        let revisions = seen.get(message);
        if (!revisions) {
            revisions = new Map();
            seen.set(message, revisions);
        }
        let emitted = revisions.get(revision);
        if (!emitted) {
            emitted = new Set();
            revisions.set(revision, emitted);
        }
        const markers = segments.flatMap(segment => extractMarkers(segment, tags));
        for (let occurrence = 0; occurrence < markers.length; occurrence++) {
            if (emitted.has(occurrence)) continue;
            const { content } = markers[occurrence];
            const marker = { chatId, messageId, swipeId, revision, occurrence, content };
            onMarker(marker);
            emitted.add(occurrence);
            logger.log(`[IF Image] Tag detected: ${content}`);
        }
    }

    return {
        register() {
            if (registered || !eventSource?.on || !eventSource?.removeListener) return false;
            handleChatChanged({ initial: true });
            registered = true;
            // MESSAGE_SENT/RECEIVED/EDITED can precede the final DOM update.
            const bindings = [
                ['USER_MESSAGE_RENDERED', processMessage],
                ['CHARACTER_MESSAGE_RENDERED', processMessage],
                ['MESSAGE_UPDATED', processMessage],
                ['MESSAGE_SWIPED', processMessage],
                ['CHAT_CHANGED', handleChatChanged],
                // Payload is remaining chat length, not a deleted message id.
                // WeakMap identity already handles deletion and index reuse.
                ['MESSAGE_DELETED', () => { if (getChatId() !== activeChat) handleChatChanged(); }],
            ];
            detach = bindings.filter(([name]) => eventTypes[name]).map(([name, listener]) => {
                const type = eventTypes[name];
                eventSource.on(type, listener);
                return () => eventSource.removeListener(type, listener);
            });
            return true;
        },
        unregister() {
            detach.forEach(remove => remove());
            detach = [];
            seen = new WeakMap();
            // onDispose fires only for a real unregister, never twice.
            if (registered) {
                registered = false;
                safeCall(onDispose);
            }
        },
    };
}
