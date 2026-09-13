// Shared character/persona record normalization. Pure: no storage or host IO.

export function foldIdentity(value) {
    return typeof value === 'string'
        ? value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').trim().toLocaleLowerCase()
        : '';
}

export function keywordFromName(value, fallback = 'entity') {
    const keyword = foldIdentity(value).replace(/[^\p{L}\p{N}_]+/gu, '');
    return keyword || fallback;
}

export function normalizeKeyword(value, name = '', fallback = 'entity') {
    const source = typeof value === 'string' && value.trim() ? value : name;
    return keywordFromName(source, fallback);
}

export function normalizeAliases(value) {
    const input = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
    const result = [];
    const seen = new Set();
    for (const item of input) {
        if (typeof item !== 'string') continue;
        const alias = foldIdentity(item);
        if (!alias || seen.has(alias)) continue;
        seen.add(alias);
        result.push(alias);
    }
    return result;
}

export function normalizeBinding(value = {}) {
    const binding = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const legacyCard = typeof binding.cardId === 'string' && binding.cardId ? [binding.cardId] : [];
    const cardIds = Array.isArray(binding.cardIds) ? binding.cardIds : legacyCard;
    const chatIds = Array.isArray(binding.chatIds) ? binding.chatIds : [];
    const clean = list => [...new Set(list.filter(item => typeof item === 'string' && item))];
    return { cardIds: clean(cardIds), chatIds: clean(chatIds), global: binding.global === true };
}

export function resolveEntityKeyword(record, fallback = '') {
    return normalizeKeyword(record?.keyword, record?.name, fallback);
}

export function claimUniqueKeyword(record, usedKeywords, fallback = 'entity') {
    const base = normalizeKeyword(record?.keyword, record?.name, fallback);
    if (!(usedKeywords instanceof Set)) {
        record.keyword = base;
        return base;
    }
    if (!usedKeywords.has(base)) {
        usedKeywords.add(base);
        record.keyword = base;
        return base;
    }
    let suffix = 2;
    let keyword = `${base}${suffix++}`;
    while (usedKeywords.has(keyword)) keyword = `${base}${suffix++}`;
    usedKeywords.add(keyword);
    record.keyword = keyword;
    return keyword;
}
