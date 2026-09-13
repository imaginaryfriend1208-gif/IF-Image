// IF Image - entity binding + the single entry point for trigger context.
//
// Binding rule (V2): an entity is ACTIVE only when it is explicitly bound to
// the current character card, bound to the current chat, or marked global.
// "Not bound = not active = never triggers." There is no fallback tier.
//
// buildTriggerContext() below is the ONLY place that rule is applied. The
// trigger parser is deliberately unaware of cardId/chatId so the rule cannot
// be bypassed (or duplicated, and thus drift) by a caller.

function cleanIds(value) {
    return [...new Set((Array.isArray(value) ? value : []).filter(id => typeof id === 'string' && id))];
}

function bindingOf(record) {
    const binding = record?.binding && typeof record.binding === 'object' ? record.binding : {};
    return {
        cardIds: cleanIds(binding.cardIds),
        chatIds: cleanIds(binding.chatIds),
        global: binding.global === true,
    };
}

/**
 * Filter a record list down to the entities active for this card/chat.
 * Only explicitly bound or global entities are active.
 * @param {Array<object>} list
 * @param {string|null} cardId - current character card avatar/id
 * @param {string|null} chatId - current chat id
 * @returns {Array<object>} a new array; input order is preserved
 */
export function resolveActiveEntities(list = [], cardId = null, chatId = null) {
    return (Array.isArray(list) ? list : []).filter(record => {
        const binding = bindingOf(record);
        return binding.global
            || (typeof cardId === 'string' && cardId && binding.cardIds.includes(cardId))
            || (typeof chatId === 'string' && chatId && binding.chatIds.includes(chatId));
    });
}

/** Compatibility alias; carries the same strict semantics. */
export const resolveActiveCharacters = resolveActiveEntities;

/**
 * Build the context object for parseTriggers().
 *
 * This is the single entry point that applies the binding rule. Everything it
 * returns is already filtered, so parseTriggers() can treat `roster` and
 * `personas` as authoritative and never needs to know the card/chat.
 *
 * `defaultPersona` is resolved from the ACTIVE persona subset only: when the
 * default persona is not bound here it comes back null, and `$me` therefore
 * does not resolve. There is intentionally no `personas[0]` fallback — that
 * would resurrect an unbound persona through the back door.
 *
 * @param {{characters?: Array<object>, personas?: Array<object>,
 *          styles?: Array<object>, outfits?: Array<object>,
 *          cardId?: string|null, chatId?: string|null}} input
 * @returns {{roster: Array<object>, personas: Array<object>,
 *            defaultPersona: object|null, styles: Array<object>,
 *            outfits: Array<object>}}
 */
export function buildTriggerContext({
    characters = [], personas = [], styles = [], outfits = [], cardId = null, chatId = null,
} = {}) {
    const activePersonas = resolveActiveEntities(personas, cardId, chatId);
    return {
        roster: resolveActiveEntities(characters, cardId, chatId),
        personas: activePersonas,
        defaultPersona: activePersonas.find(persona => persona?.isDefault) ?? null,
        styles: Array.isArray(styles) ? styles : [],
        outfits: Array.isArray(outfits) ? outfits : [],
    };
}

export function bindEntity(record, scope, id) {
    if (!record || typeof record !== 'object') throw new TypeError('bindEntity requires a record.');
    if (!['card', 'chat'].includes(scope)) throw new TypeError('Binding scope must be "card" or "chat".');
    if (typeof id !== 'string' || !id) throw new TypeError('Binding id must be a non-empty string.');
    const binding = bindingOf(record);
    const key = scope === 'card' ? 'cardIds' : 'chatIds';
    if (!binding[key].includes(id)) binding[key].push(id);
    return { ...record, binding };
}

export function unbindEntity(record, scope, id) {
    if (!record || typeof record !== 'object') throw new TypeError('unbindEntity requires a record.');
    if (!['card', 'chat'].includes(scope)) throw new TypeError('Binding scope must be "card" or "chat".');
    const binding = bindingOf(record);
    const key = scope === 'card' ? 'cardIds' : 'chatIds';
    binding[key] = binding[key].filter(value => value !== id);
    return { ...record, binding };
}
