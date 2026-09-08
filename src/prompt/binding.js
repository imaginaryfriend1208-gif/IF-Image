// IF Image - Character binding resolution (Phase C4).
// A character can be bound to a specific character card (binding.cardId) or
// to one or more chat ids (binding.chatIds). resolveActiveCharacters() picks
// the "active" roster subset for the current card/chat context,
// deterministically — never a random selection.

function hasBinding(char) {
    return Boolean(char?.binding?.cardId) || Boolean(char?.binding?.chatIds?.length);
}

/**
 * Resolve the active character subset for a given card/chat context.
 * Active = the UNION of characters bound to the current card, characters
 * bound to the current chat id, and characters with no binding at all
 * (available anywhere). Binding is a scoping tool, not an exclusivity
 * switch: an unbound character stays usable in every chat even when other
 * characters are bound to this card/chat — otherwise every $UnboundName
 * trigger would fall through to a fallback tier and raise a spurious
 * warning. Only characters bound to a DIFFERENT card/chat are excluded
 * from the active subset; they remain resolvable via the trigger fallback
 * tiers in resolveCharacterTrigger.
 * @param {Array<object>} roster - full character roster
 * @param {string|null} cardId - current character card avatar/id
 * @param {string|null} chatId - current chat id
 * @returns {Array<object>}
 */
export function resolveActiveCharacters(roster = [], cardId = null, chatId = null) {
    const list = Array.isArray(roster) ? roster : [];
    return list.filter(c =>
        !hasBinding(c)
        || (c.binding?.cardId && c.binding.cardId === cardId)
        || (Array.isArray(c.binding?.chatIds) && c.binding.chatIds.includes(chatId)),
    );
}

/**
 * Resolve a $Name trigger token against the active roster subset, falling
 * back through wider tiers when no match is found there. Never random —
 * every tier is a plain filter + the existing fuzzy matchCharacter scoring.
 * @param {(token: string, roster: Array<object>) => object|null} matchFn - matchCharacter
 * @param {string} token
 * @param {Array<object>} activeRoster - resolveActiveCharacters() output
 * @param {Array<object>} fullRoster - the entire roster
 * @returns {{ char: object|null, usedFallback: boolean, tier: 'active'|'bound'|'all'|'none' }}
 */
export function resolveCharacterTrigger(matchFn, token, activeRoster, fullRoster) {
    const active = matchFn(token, activeRoster || []);
    if (active) return { char: active, usedFallback: false, tier: 'active' };

    // Tier 2: any character with a deliberate binding, even to a different
    // card/chat — still an intentional assignment, just not for this one.
    const bound = (fullRoster || []).filter(hasBinding);
    const boundMatch = matchFn(token, bound);
    if (boundMatch) return { char: boundMatch, usedFallback: true, tier: 'bound' };

    // Tier 3: the entire roster.
    const allMatch = matchFn(token, fullRoster || []);
    if (allMatch) return { char: allMatch, usedFallback: true, tier: 'all' };

    return { char: null, usedFallback: false, tier: 'none' };
}
