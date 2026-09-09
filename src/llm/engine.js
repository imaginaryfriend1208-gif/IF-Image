// IF Image - LLM rewrite engine: bridges LLM client → parser → prompt → pipeline.
// Handles Assist and Full modes by calling the LLM, parsing the reply,
// and feeding the result into the existing compile → queue pipeline.

import { createLlmClient, LlmError } from './client.js';
import { buildContext } from './context.js';
import { renderSystemPrompt, renderUserPrompt, renderChatPlacePrompt, DIALECT_RULES, REQUEST_PROMPT_RENDERERS } from './prompts.js';
import { parseLlmReply } from './parser.js';
import { resolveRequestMapping } from './profiles.js';
import { validatePlacements } from './placements.js';
import { resolveProfileKey } from '../prompt/render.js';
import { PROFILES } from '../profiles.js';

/**
 * @param {{
 *   getSettings: () => object,
 *   getContext: () => object,
 *   roster: () => object,
 *   substituteParams: (text: string) => string,
 *   compile: (content: string) => { profileKey: string, envelope: object },
 *   notify: (kind: string, message: string) => void,
 *   [llmClient]: object,
 *   [fetchImpl]: typeof fetch,
 * }} deps
 */
export function createEngine({
    getSettings, getContext, roster, substituteParams,
    compile, notify,
    llmClient, fetchImpl,
} = {}) {
    // Injectable for offline tests; production builds it from settings/context.
    const client = llmClient ?? createLlmClient({ getSettings, getContext, fetchImpl });

    /**
     * Rewrite marker text through the LLM, then compile it.
     * @param {string} markerText - the scene description from the marker
     * @param {{ previousPrompt?: string, variationHint?: string, signal?: AbortSignal }} opts
     * @returns {Promise<{ entries: Array<{profileKey, envelope}>, method: string, elapsedMs: number }>}
     */
    async function rewrite(markerText, { previousPrompt, variationHint, signal } = {}) {
        const settings = getSettings();
        const ctx = getContext();
        const injectionStyle = settings.llm?.injectionStyle ?? 'compact';

        // Resolve the request mapping first: image_gen → {apiProfile,
        // contextProfile}. The mapped API profile wins over the global
        // default profile id.
        const mapping = resolveRequestMapping(settings, 'image_gen');
        const profileId = mapping.apiProfile?.id
            ?? settings.llm?.defaultApiProfileId
            ?? '';

        // Build context blocks
        const contextResult = buildContext({
            chat: ctx.chat ?? [],
            settings,
            contextProfile: mapping.contextProfile,
            substituteParams,
            roster: typeof roster === 'function' ? roster() : (roster ?? {}),
        });

        // Resolve dialect for the rules block
        const configuredProfileKey = settings.generation?.profile || 'anima';
        const { profileKey } = resolveProfileKey(null, configuredProfileKey);
        const profile = PROFILES[profileKey] ?? PROFILES.anima;
        const dialectKey = profile.dialect ?? 'anima';
        const dialectRules = DIALECT_RULES[dialectKey] ?? DIALECT_RULES.anima;

        // Build character card text from roster
        const rosterData = typeof roster === 'function' ? roster() : (roster ?? {});
        const chars = rosterData.characters ?? [];
        const styleCard = (rosterData.styles ?? []).map(s => {
            const parts = [`Style: ${s.name}`];
            if (s.dialectHints?.krea?.stylePhrase) parts.push(`Krea: ${s.dialectHints.krea.stylePhrase}`);
            if (s.dialectHints?.illus?.artists) parts.push(`Illus: ${s.dialectHints.illus.artists}`);
            return parts.join(' | ');
        }).join('\n');

        const systemPrompt = renderSystemPrompt('image_gen', {
            dialect_rules: dialectRules,
            character_cards: contextResult.charBlock,
            style_card: styleCard,
            persona_block: contextResult.personaBlock,
            scene_window: contextResult.sceneText,
        }, injectionStyle);

        const userPrompt = renderUserPrompt(markerText, { previousPrompt, variationHint });

        // Call the LLM
        let result;
        try {
            result = await client.request({
                type: 'image_gen',
                systemPrompt,
                userPrompt,
                profileId,
                signal,
            });
        } catch (err) {
            // Abort propagates; other failures fall back to direct compile.
            if (err?.code === 'ABORTED' || err?.name === 'AbortError' || signal?.aborted) throw err;
            console.warn('[IF Image] LLM request failed, falling back to direct compile:', err?.message ?? err);
            const fallback = compile(markerText);
            return { entries: [fallback], method: 'fallback_direct', elapsedMs: 0, error: err?.message ?? String(err) };
        }

        // Parse the LLM reply
        const entries = parseLlmReply(result.text);

        if (!entries.length) {
            console.warn('[IF Image] LLM returned no parseable image blocks; falling back to direct compile.');
            const fallback = compile(markerText);
            return { entries: [fallback], method: 'fallback_direct', elapsedMs: result.elapsedMs };
        }

        // Compile each entry through the existing prompt pipeline, then merge
        // the parser-level overrides (<size> dims, <negative> tags) into the
        // compiled envelope.
        const compiled = entries.map(entry => {
            // Use the entry's prompt as if it were a marker text
            const content = entry.prompt;
            try {
                const result = compile(content);
                const params = { ...result.envelope.params };
                if (Number.isFinite(entry.width) && Number.isFinite(entry.height)) {
                    params.width = entry.width;
                    params.height = entry.height;
                }
                let negative = result.envelope.negative;
                if (entry.negative) {
                    negative = negative ? `${negative}, ${entry.negative}` : entry.negative;
                }
                return { ...result, envelope: { ...result.envelope, negative, params } };
            } catch (err) {
                console.error('[IF Image] Compile failed for LLM entry:', err?.message ?? err);
                return null;
            }
        }).filter(Boolean);

        if (!compiled.length) {
            console.warn('[IF Image] All LLM entries failed to compile; falling back to direct compile.');
            const fallback = compile(markerText);
            return { entries: [fallback], method: 'fallback_direct', elapsedMs: result.elapsedMs };
        }

        return { entries: compiled, method: result.method, elapsedMs: result.elapsedMs };
    }

    /**
     * Regeneration: call the LLM with previous_prompt + variation_hint.
     * @param {string} markerText
     * @param {string} previousPrompt
     * @param {string} [variationHint]
     * @param {AbortSignal} [signal]
     */
    async function regenerate(markerText, previousPrompt, variationHint, signal) {
        return rewrite(markerText, {
            previousPrompt,
            variationHint: variationHint ?? 'Generate a different variation of this scene.',
            signal,
        });
    }

    // ------------------------------------------------------------------
    // Phase C5: request types beside image_gen (char_design, char_modify,
    // tag_modify, translation, persona_gen). All JSON parsing here is
    // defensive: strips code fences/think blocks, tolerates trailing
    // commas, and NEVER throws on malformed input — validation failures
    // are surfaced as an LlmError('MALFORMED', ...) after one retry with
    // the validator's errors appended to the prompt, per spec.
    // ------------------------------------------------------------------

    /** Best-effort JSON extraction from a free-form LLM reply. Returns null, never throws. */
    function parseJsonLoose(text) {
        if (typeof text !== 'string') return null;
        let cleaned = text.trim();
        cleaned = cleaned.replace(/```(?:json)?\s*([\s\S]*?)```/i, '$1').trim();
        cleaned = cleaned.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
        const match = cleaned.match(/[{[][\s\S]*[}\]]/);
        if (match) cleaned = match[0];
        // Repair a common LLM mistake: a trailing comma before a closing brace/bracket.
        cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
        try {
            return JSON.parse(cleaned);
        } catch {
            return null;
        }
    }

    /** @returns {string[]} validation errors; empty array = valid. */
    function validateCharJson(obj) {
        const errors = [];
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['Reply must be a single JSON object.'];
        if (typeof obj.name !== 'string' || !obj.name.trim()) errors.push('"name" must be a non-empty string.');
        if (typeof obj.countTag !== 'string' || !/^\d+(girl|boy|other)s?$/i.test(obj.countTag.trim())) {
            errors.push('"countTag" must be a danbooru count tag like "1girl", "1boy", or "2girls".');
        }
        if (obj.booru !== undefined && typeof obj.booru !== 'string') errors.push('"booru" must be a comma-separated tag string.');
        if (obj.facts !== undefined && !(Array.isArray(obj.facts) && obj.facts.every(f => typeof f === 'string'))) {
            errors.push('"facts" must be an array of strings.');
        }
        if (obj.negative !== undefined && typeof obj.negative !== 'string') errors.push('"negative" must be a string.');
        return errors;
    }

    function resolveProfileIdFor(requestType, settings) {
        const mapping = resolveRequestMapping(settings, requestType);
        return mapping.apiProfile?.id ?? settings.llm?.defaultApiProfileId ?? '';
    }

    /**
     * Shared JSON request/validate/retry-once flow for char_design and
     * char_modify (same schema, same validator).
     * @param {string} type - 'char_design' | 'char_modify'
     * @param {string} userPrompt
     * @param {AbortSignal} [signal]
     * @returns {Promise<{ char: object, raw: string, elapsedMs: number }>}
     */
    async function requestCharJson(type, userPrompt, signal) {
        const settings = getSettings();
        const systemPrompt = REQUEST_PROMPT_RENDERERS[type]();
        const profileId = resolveProfileIdFor(type, settings);
        let prompt = userPrompt;
        let lastErrors = [];
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await client.request({ type, systemPrompt, userPrompt: prompt, profileId, signal });
            const parsed = parseJsonLoose(result.text);
            const errors = validateCharJson(parsed);
            if (!errors.length) {
                return { char: parsed, raw: result.text, elapsedMs: result.elapsedMs };
            }
            lastErrors = errors;
            prompt = `${userPrompt}\n\nYour previous reply failed validation:\n- ${errors.join('\n- ')}\nReply again with corrected JSON only, following the schema exactly.`;
        }
        throw new LlmError('MALFORMED', `Character JSON failed validation after retry: ${lastErrors.join('; ')}`);
    }

    /**
     * char_design: description -> new character JSON (not saved here — the
     * caller previews and saves via src/storage/chars.js).
     * @param {string} description
     * @param {{ signal?: AbortSignal }} [opts]
     */
    async function generateCharacterDesign(description, { signal } = {}) {
        return requestCharJson('char_design', `Design a character from this description:\n${description}`, signal);
    }

    /**
     * char_modify: existing character JSON + instruction -> patched JSON.
     * Only the caller decides which fields actually changed; this returns
     * the full corrected record for the caller to diff/merge/save.
     * @param {object} existingChar
     * @param {string} instruction
     * @param {{ signal?: AbortSignal }} [opts]
     */
    async function modifyCharacter(existingChar, instruction, { signal } = {}) {
        const snapshot = JSON.stringify({
            name: existingChar?.name, countTag: existingChar?.countTag,
            booru: existingChar?.booru, facts: existingChar?.facts ? [existingChar.facts] : [],
            negative: existingChar?.negative,
        });
        const userPrompt = `Current character JSON:\n${snapshot}\n\nInstruction: ${instruction}`;
        return requestCharJson('char_modify', userPrompt, signal);
    }

    /**
     * tag_modify: tag list + instruction -> new single-line tag list.
     * @param {string} tagList
     * @param {string} instruction
     * @param {{ signal?: AbortSignal }} [opts]
     * @returns {Promise<{ tags: string, elapsedMs: number }>}
     */
    async function modifyTags(tagList, instruction, { signal } = {}) {
        const settings = getSettings();
        const systemPrompt = REQUEST_PROMPT_RENDERERS.tag_modify();
        const profileId = resolveProfileIdFor('tag_modify', settings);
        const userPrompt = `Current tags: ${tagList}\n\nInstruction: ${instruction}`;
        const result = await client.request({ type: 'tag_modify', systemPrompt, userPrompt, profileId, signal });
        const tags = result.text.trim().split('\n')[0].trim();
        return { tags, elapsedMs: result.elapsedMs };
    }

    /**
     * translation: lazy backfill facts (natural language) -> booru tags for
     * a character missing them.
     * @param {object} char - { facts }
     * @param {{ signal?: AbortSignal }} [opts]
     * @returns {Promise<{ tags: string, elapsedMs: number }>}
     */
    async function translateFacts(char, { signal } = {}) {
        const settings = getSettings();
        const systemPrompt = REQUEST_PROMPT_RENDERERS.translation();
        const profileId = resolveProfileIdFor('translation', settings);
        const userPrompt = `Character facts: ${char?.facts || char?.natural || char?.name || ''}`;
        const result = await client.request({ type: 'translation', systemPrompt, userPrompt, profileId, signal });
        const tags = result.text.trim().split('\n')[0].trim();
        return { tags, elapsedMs: result.elapsedMs };
    }

    /**
     * persona_gen: read the current ST persona (name + description) and
     * convert it into an IF-Image persona record via the LLM. Manual edits
     * win: the caller should skip applying this when persona.meta.updatedAt
     * is newer than persona.syncedAt (i.e. the user edited it since the
     * last sync) unless the sync is explicitly forced.
     * @param {{ signal?: AbortSignal }} [opts]
     * @returns {Promise<{ persona: object, raw: string, elapsedMs: number }>}
     */
    async function syncPersonaFromSt({ signal } = {}) {
        const ctx = getContext();
        const name = ctx?.name1 ?? 'User';
        const description = ctx?.powerUserSettings?.persona_description ?? '';
        const settings = getSettings();
        const systemPrompt = REQUEST_PROMPT_RENDERERS.persona_gen();
        const profileId = resolveProfileIdFor('persona_gen', settings);
        const userPrompt = `Persona name: ${name}\nPersona description: ${description || '(none set)'}`;
        const result = await client.request({ type: 'persona_gen', systemPrompt, userPrompt, profileId, signal });
        const parsed = parseJsonLoose(result.text);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string' || !parsed.name.trim()) {
            throw new LlmError('MALFORMED', 'persona_gen reply was not a valid persona JSON object.');
        }
        return { persona: parsed, raw: result.text, elapsedMs: result.elapsedMs };
    }

    // ------------------------------------------------------------------
    // chat_place: LLM plans N image placements across the current chat.
    // ------------------------------------------------------------------

    /**
     * LLM plans N image placements across the current chat.
     * @param {number} count - number of images to place (1..6)
     * @param {{ signal?: AbortSignal }} [opts]
     * @returns {Promise<{ placements: Array<{ messageId: number, prompt: string, negative?: string, width?: number, height?: number }>, method: string, elapsedMs: number }>}
     */
    async function planChatImages(count, { signal } = {}) {
        const settings = getSettings();
        const ctx = getContext();
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const chatPlaceSettings = settings.llm?.chatPlace ?? {};
        const onlyCharacter = chatPlaceSettings.onlyCharacter !== false;

        // Build full-chat context (wider scene window for placement planning)
        const maxWindow = Math.min(40, Math.max(2, chatPlaceSettings.maxChatWindow ?? 40));
        const contextResult = buildContext({
            chat,
            settings,
            contextProfile: { sceneWindow: maxWindow, scope: 'scene' },
            substituteParams,
            roster: typeof roster === 'function' ? roster() : (roster ?? {}),
        });

        // Resolve dialect rules (same logic as rewrite())
        const configuredProfileKey = settings.generation?.profile || 'anima';
        const { profileKey } = resolveProfileKey(null, configuredProfileKey);
        const profile = PROFILES[profileKey] ?? PROFILES.anima;
        const dialectKey = profile.dialect ?? 'anima';
        const dialectRules = DIALECT_RULES[dialectKey] ?? DIALECT_RULES.anima;

        // Build character cards text
        const rosterData = typeof roster === 'function' ? roster() : (roster ?? {});
        const chars = rosterData.characters ?? [];
        const charBlock = chars.map(c => {
            const parts = [];
            if (c.name) parts.push(`Name: ${c.name}`);
            if (c.countTag) parts.push(`Count: ${c.countTag}`);
            if (c.booru) parts.push(`Tags: ${c.booru}`);
            if (c.facts) parts.push(`Facts: ${c.facts}`);
            return parts.join(' | ');
        }).join('\n');

        // Persona block
        const persona = rosterData.persona ?? null;
        let personaBlock = '';
        if (persona) {
            const parts = [];
            if (persona.name) parts.push(`Name: ${persona.name}`);
            if (persona.booru) parts.push(`Tags: ${persona.booru}`);
            if (persona.natural) parts.push(`Description: ${persona.natural}`);
            if (Array.isArray(persona.aliases) && persona.aliases.length) {
                parts.push(`Aliases: ${persona.aliases.join(', ')}`);
            }
            const h = persona.dialectHints;
            if (h) {
                const hintParts = [];
                if (h.krea?.stylePhrase) hintParts.push(`Krea: ${h.krea.stylePhrase}`);
                if (h.anima?.booruTags) hintParts.push(`Anima: ${h.anima.booruTags}`);
                if (h.illus?.artists) hintParts.push(`Illus: ${h.illus.artists}`);
                if (hintParts.length) parts.push(`Style hints: ${hintParts.join(' | ')}`);
            }
            personaBlock = parts.join(' | ');
        }

        // System prompt
        const systemPrompt = renderChatPlacePrompt({
            count,
            dialect_rules: dialectRules,
            character_cards: charBlock,
            persona_block: personaBlock,
        });

        // User prompt: full scene text
        const userPrompt = `Plan ${count} image placements for this conversation.\n\n${contextResult.sceneText}`;

        // Resolve API profile (chat_place → fallback to image_gen mapping)
        const mapping = resolveRequestMapping(settings, 'chat_place');
        const fallbackMapping = resolveRequestMapping(settings, 'image_gen');
        const profileId = mapping.apiProfile?.id
            ?? fallbackMapping.apiProfile?.id
            ?? settings.llm?.defaultApiProfileId
            ?? '';

        // LLM call
        const result = await client.request({
            type: 'chat_place',
            systemPrompt,
            userPrompt,
            profileId,
            signal,
        });

        // Parse and validate
        const parsed = parseJsonLoose(result.text);
        const placements = validatePlacements(parsed, chat, count, { onlyCharacter });

        return { placements, method: result.method, elapsedMs: result.elapsedMs };
    }

    return {
        rewrite, regenerate,
        generateCharacterDesign, modifyCharacter, modifyTags, translateFacts, syncPersonaFromSt,
        planChatImages,
    };
}