// IF Image - Active style resolution.
//
// A style used to apply only when a marker literally contained
// `{{style: Name}}`. The default LLM instructions forbid emitting style tags,
// so in the chat-placement flow no style was ever applied and a style's LoRA
// never loaded. This module lets a style be attached to a chat instead, while
// keeping the explicit marker directive authoritative.
//
// Pure: the chat id, the stored ids and the style list are all passed in, so
// the precedence is testable offline.

/** Metadata key holding the style id chosen for a chat. */
export const CHAT_STYLE_KEY = 'IF_Image_style';

/**
 * Resolve which style applies, and say where the answer came from.
 *
 * Precedence, highest first:
 *   1. 'marker'  — {{style: Name}} written into the marker text
 *   2. 'chat'    — the style attached to this chat
 *   3. 'default' — settings.generation.defaultStyleId, for a fresh chat
 *   4. 'none'
 *
 * A stored id whose style has since been deleted resolves to 'none' with
 * `missingId` set, so the UI can report a dangling reference instead of
 * quietly applying nothing.
 *
 * @param {{
 *   explicitStyles?: Array<object>,  // parseTriggers().styles
 *   chatStyleId?: string,
 *   defaultStyleId?: string,
 *   styles?: Array<object>,          // the full saved-style roster
 * }} args
 * @returns {{ style: object|null, source: 'marker'|'chat'|'default'|'none', missingId?: string }}
 */
export function resolveActiveStyle({
    explicitStyles = [], chatStyleId = '', defaultStyleId = '', styles = [],
} = {}) {
    // 1. The marker named a style: it wins outright, and never reports a
    // missing id — parseTriggers only ever puts resolved styles in this list.
    if (Array.isArray(explicitStyles) && explicitStyles.length) {
        return { style: explicitStyles[0], source: 'marker' };
    }

    const roster = Array.isArray(styles) ? styles : [];
    const byId = (id) => (id ? roster.find(s => s?.id === id) ?? null : null);

    // 2. This chat's own choice.
    if (chatStyleId) {
        const found = byId(chatStyleId);
        if (found) return { style: found, source: 'chat' };
        // Deliberately does NOT fall through to the default: the user made a
        // choice for this chat and it broke. Silently substituting a
        // different style would hide that.
        return { style: null, source: 'none', missingId: chatStyleId };
    }

    // 3. The default for chats that have made no choice.
    if (defaultStyleId) {
        const found = byId(defaultStyleId);
        if (found) return { style: found, source: 'default' };
        return { style: null, source: 'none', missingId: defaultStyleId };
    }

    return { style: null, source: 'none' };
}

/**
 * Read the style id attached to a chat.
 *
 * `chat_metadata` is REASSIGNED by SillyTavern on chat load, not mutated, so
 * the caller must pass a freshly obtained context object. Holding one across
 * a chat change reads the previous chat's data.
 *
 * @param {object} ctx - a fresh getContext()
 * @returns {string}
 */
export function readChatStyleId(ctx) {
    const value = ctx?.chatMetadata?.[CHAT_STYLE_KEY];
    return typeof value === 'string' ? value : '';
}

/**
 * Attach a style to the current chat (empty string detaches).
 * Returns false when there is no chat to write to, so the caller can say so
 * rather than appear to have saved.
 *
 * @param {object} ctx - a fresh getContext()
 * @param {string} styleId
 * @returns {boolean} whether the value was stored
 */
export function writeChatStyleId(ctx, styleId) {
    if (!ctx?.chatMetadata || typeof ctx.chatMetadata !== 'object') return false;
    if (styleId) {
        ctx.chatMetadata[CHAT_STYLE_KEY] = styleId;
    } else {
        delete ctx.chatMetadata[CHAT_STYLE_KEY];
    }
    try {
        ctx.saveMetadata?.();
    } catch (err) {
        console.warn('[IF Image] saveMetadata for the chat style failed:', err?.message ?? err);
        return false;
    }
    return true;
}
