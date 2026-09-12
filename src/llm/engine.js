// IF Image - LLM rewrite engine: bridges LLM client → parser → prompt → pipeline.
// Handles Assist and Full modes by calling the LLM, parsing the reply,
// and feeding the result into the existing compile → queue pipeline.

import { createLlmClient, LlmError } from './client.js';
import { buildContext, stripRenderedArtifacts } from './context.js';
import { renderSystemPrompt, renderUserPrompt, renderChatPlacePrompt, renderChatRewritePrompt, DIALECT_RULES, REWRITE_DIALECT_RULES, REQUEST_PROMPT_RENDERERS } from './prompts.js';
import { parseLlmReply } from './parser.js';
import { resolveRequestMapping } from './profiles.js';
import { validatePlacements, validateRewrites } from './placements.js';
import { extractSubjectTokens, repairBareSubjectNames, resolveDeclaredSubjects, styleLeakFragments, validateScenePrompt } from './subjects.js';

/**
 * @param {{
 *   getSettings: () => object,
 *   getContext: () => object,
 *   roster: () => object,
 *   substituteParams: (text: string) => string,
 *   compile: (content: string) => { profileKey: string, envelope: object },
 *   notify: (kind: string, message: string) => void,
 *   resolveGenerationContext?: (parsedTriggers?: object|null) => object,
 *   resolveSubjectContext?: (options?: object) => object,
 *   [llmClient]: object,
 *   [fetchImpl]: typeof fetch,
 * }} deps
 */
export function createEngine({
    getSettings, getContext, roster, substituteParams,
    compile, notify, resolveGenerationContext, resolveSubjectContext,
    llmClient, fetchImpl,
} = {}) {
    // Injectable for offline tests; production builds it from settings/context.
    const client = llmClient ?? createLlmClient({ getSettings, getContext, fetchImpl });

    function rosterData() {
        return typeof roster === 'function' ? (roster() ?? {}) : (roster ?? {});
    }

    function generationContext(source = null) {
        if (typeof resolveGenerationContext === 'function') return resolveGenerationContext(source) ?? {};
        const configured = getSettings()?.generation?.profile ?? 'anima';
        const fallback = configured === 'krea2' ? 'krea' : configured === 'illustrious' ? 'illus' : 'anima';
        return { profileKey: configured, dialectKey: fallback, activeStyle: { style: null, source: 'none' } };
    }

    function subjectContext(options = {}) {
        if (typeof resolveSubjectContext === 'function') return resolveSubjectContext(options) ?? {};
        const settings = getSettings();
        const ctx = getContext();
        return buildContext({
            chat: options.chat ?? ctx.chat ?? [],
            settings,
            contextProfile: options.contextProfile,
            substituteParams,
            roster: rosterData(),
            host: ctx,
            activeCardId: (() => {
                const id = ctx?.characterId ?? ctx?.character_id;
                return ctx?.characters?.[id]?.avatar ?? null;
            })(),
            chatId: ctx?.getCurrentChatId?.() ?? null,
            activeCharacterName: ctx?.name2 ?? '',
            includeAllSubjects: options.includeAllSubjects === true,
            maxSubjects: options.maxSubjects ?? 12,
            additionalRelevanceText: options.additionalRelevanceText ?? '',
        });
    }

    function forbiddenStyleFragments(gen) {
        return styleLeakFragments(gen?.activeStyle?.style, gen?.dialectKey);
    }

    function safeDirectFallback(markerText, error, elapsedMs = 0) {
        const fallback = compile(markerText);
        return {
            entries: [fallback],
            method: 'fallback_direct',
            elapsedMs,
            ...(error ? { error: error?.message ?? String(error) } : {}),
        };
    }

    function validateImageEntry(entry, catalog, forbiddenFragments, sourceTokens = []) {
        const declared = resolveDeclaredSubjects(entry?.subjects, catalog);
        if (declared.errors.length) return { ok: false, errors: declared.errors };
        const required = sourceTokens.length ? sourceTokens : declared.tokens;
        if (sourceTokens.length && declared.mode === 'structured'
            && (declared.tokens.length !== sourceTokens.length
                || declared.tokens.some(token => !sourceTokens.includes(token)))) {
            return { ok: false, errors: ['Reply subjects differ from the source marker.'] };
        }
        let prompt = typeof entry?.prompt === 'string' ? entry.prompt.trim() : '';
        if (required.length) prompt = repairBareSubjectNames(prompt, catalog, { requiredTokens: required }).prompt;
        const scene = validateScenePrompt(prompt, catalog, {
            requiredTokens: required,
            allowedTokens: required.length ? required : null,
            forbiddenFragments,
        });
        return { ok: scene.ok, prompt, subjects: required, errors: scene };
    }

    /** Rewrite marker text through the LLM, validate identity, then compile. */
    async function rewrite(markerText, { previousPrompt, variationHint, signal } = {}) {
        const settings = getSettings();
        const mapping = resolveRequestMapping(settings, 'image_gen');
        const profileId = mapping.apiProfile?.id ?? settings.llm?.defaultApiProfileId ?? '';
        const contextResult = subjectContext({ contextProfile: mapping.contextProfile, additionalRelevanceText: markerText });
        const gen = generationContext(markerText);
        const dialectRules = DIALECT_RULES[gen.dialectKey] ?? DIALECT_RULES.anima;
        const systemPrompt = renderSystemPrompt('image_gen', {
            dialect_rules: dialectRules,
            subject_catalog: contextResult.subjectBlock,
            scene_window: contextResult.sceneText,
            systemPromptOverride: settings.llm?.systemPromptOverride,
        }, settings.llm?.injectionStyle ?? 'compact');
        const userPrompt = renderUserPrompt(markerText, { previousPrompt, variationHint });

        let result;
        try {
            result = await client.request({ type: 'image_gen', systemPrompt, userPrompt, profileId, signal });
        } catch (err) {
            if (err?.code === 'ABORTED' || err?.name === 'AbortError' || signal?.aborted) throw err;
            console.warn('[IF Image] LLM request failed; using direct marker compilation.');
            return safeDirectFallback(markerText, err);
        }

        const catalog = contextResult.subjectCatalog ?? [];
        const forbiddenFragments = forbiddenStyleFragments(gen);
        const sourceTokens = extractSubjectTokens(markerText, catalog).tokens;
        const validEntries = [];
        for (const entry of parseLlmReply(result.text)) {
            const validation = validateImageEntry(entry, catalog, forbiddenFragments, sourceTokens);
            if (validation.ok) validEntries.push({ ...entry, prompt: validation.prompt, subjects: validation.subjects });
        }
        if (!validEntries.length) {
            console.warn('[IF Image] LLM scene failed identity/style validation; using direct marker compilation.');
            return safeDirectFallback(markerText, null, result.elapsedMs);
        }

        const compiled = validEntries.map(entry => {
            try {
                const compiledEntry = compile(entry.prompt);
                const params = { ...compiledEntry.envelope.params };
                if (Number.isFinite(entry.width) && Number.isFinite(entry.height)) {
                    params.width = entry.width;
                    params.height = entry.height;
                }
                // LLM negatives are never merged; active profile/style owns them.
                return { ...compiledEntry, envelope: { ...compiledEntry.envelope, params } };
            } catch {
                return null;
            }
        }).filter(Boolean);
        if (!compiled.length) return safeDirectFallback(markerText, null, result.elapsedMs);
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

    /** LLM plans validated scene-template placements across the chat. */
    async function planChatImages(count, { signal } = {}) {
        const settings = getSettings();
        const ctx = getContext();
        const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
        const chatPlaceSettings = settings.llm?.chatPlace ?? {};
        const onlyCharacter = chatPlaceSettings.onlyCharacter !== false;
        const planningMode = chatPlaceSettings.planningMode === 'separate' ? 'separate' : 'together';
        const configuredWindow = Number(chatPlaceSettings.maxChatWindow);
        const maxWindow = configuredWindow === 0 ? 0 : Math.min(200, Math.max(1, configuredWindow || 40));
        const contextResult = subjectContext({
            chat,
            contextProfile: {
                sceneWindow: maxWindow,
                maxSceneWindow: 200,
                scope: 'scene',
                includeCharCard: true,
                includePersona: true,
                includeCharacterMessages: chatPlaceSettings.includeCharacterMessages !== false,
                includeUserMessages: chatPlaceSettings.includeUserMessages !== false,
                includeFirstMessage: chatPlaceSettings.includeFirstMessage === true,
                includeCharacterCard: chatPlaceSettings.includeCharacterCard === true,
                includeExtensionPrompts: chatPlaceSettings.includeExtensionPrompts === true,
            },
            maxSubjects: 12,
        });
        const gen = generationContext();
        const dialectRules = DIALECT_RULES[gen.dialectKey] ?? DIALECT_RULES.anima;
        const forbiddenFragments = forbiddenStyleFragments(gen);
        const systemPrompt = renderChatPlacePrompt({
            count,
            planning_mode: planningMode,
            dialect_rules: dialectRules,
            subject_catalog: contextResult.subjectBlock,
        });
        const baseUserPrompt = `Plan ${count} image placements for this conversation.\n\n${contextResult.sceneText}`;
        const mapping = resolveRequestMapping(settings, 'chat_place');
        const fallbackMapping = resolveRequestMapping(settings, 'image_gen');
        const profileId = mapping.apiProfile?.id
            ?? fallbackMapping.apiProfile?.id
            ?? settings.llm?.defaultApiProfileId
            ?? '';

        let result;
        let placements = [];
        let lastDiagnostics = [];
        let attempts = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
            attempts += 1;
            const correction = attempt === 0 ? '' : [
                '',
                'Your previous placement JSON failed deterministic validation.',
                'Correct every item using only exact tokens from the catalog. Keep "subjects" and prompt tokens identical.',
                'Do not use generic replacements for known subjects. Remove style, quality, artist, appearance and LoRA content.',
                lastDiagnostics.length
                    ? `Validation summary: ${lastDiagnostics.map(item => item.errors.join('; ')).join(' | ')}`
                    : 'Validation summary: malformed or missing placement JSON.',
                'Return corrected JSON only.',
            ].join('\n');
            result = await client.request({
                type: 'chat_place',
                systemPrompt,
                userPrompt: baseUserPrompt + correction,
                profileId,
                signal,
            });
            const parsed = parseJsonLoose(result.text);
            placements = validatePlacements(parsed, chat, count, {
                onlyCharacter,
                subjectCatalog: contextResult.subjectCatalog,
                forbiddenFragments,
            });
            lastDiagnostics = placements.diagnostics ?? [];
            const correctable = Boolean(parsed) && lastDiagnostics.some(item =>
                item.errors.some(error => !/anchor did not resolve|duplicate message anchor|prompt is empty/i.test(error)));
            if (placements.length >= count || attempt === 1 || !correctable) break;
        }

        if (planningMode === 'separate') placements.sort((a, b) => a.messageId - b.messageId);

        if (!placements.length || chatPlaceSettings.rewrite === false) {
            return {
                placements,
                method: result?.method ?? 'unknown',
                elapsedMs: result?.elapsedMs ?? 0,
                plannerAttempts: attempts,
                rewritten: false,
            };
        }

        const rewriteResult = await rewritePlacements(placements, {
            chat,
            settings,
            dialectRules,
            dialectKey: gen.dialectKey,
            contextResult,
            forbiddenFragments,
            signal,
        });
        return {
            placements: rewriteResult.placements,
            method: result.method,
            elapsedMs: result.elapsedMs,
            plannerAttempts: attempts,
            rewritten: rewriteResult.rewritten,
            rewriteChanged: rewriteResult.changed,
            rewriteRejected: rewriteResult.rejected,
            rewriteElapsedMs: rewriteResult.elapsedMs,
            rewriteError: rewriteResult.error,
        };
    }

    /** Rewrite is an improvement-only pass; invalid items keep their drafts. */
    async function rewritePlacements(placements, {
        chat, settings, dialectRules, dialectKey, contextResult, forbiddenFragments, signal,
    } = {}) {
        const rewriteRules = REWRITE_DIALECT_RULES[dialectKey] ?? REWRITE_DIALECT_RULES.anima;
        const host = getContext();
        const items = placements.map((placement, index) => {
            const from = Math.max(0, placement.messageId - 1);
            const to = Math.min(chat.length - 1, placement.messageId + 1);
            const excerpt = [];
            for (let i = from; i <= to; i++) {
                const message = chat[i];
                if (!message || message.is_system) continue;
                const body = stripRenderedArtifacts(message.mes ?? message.content ?? '');
                if (!body) continue;
                const role = message.role === 'user' || message.is_user === true
                    ? (host?.name1 || 'User')
                    : (message.name || host?.name2 || 'Character');
                excerpt.push(`${role}${i === placement.messageId ? ' <- illustrated message' : ''}: ${body}`);
            }
            return [
                `### ITEM ${index}`,
                `SUBJECTS: ${JSON.stringify(placement.subjects ?? [])}`,
                'CHAT EXCERPT:',
                excerpt.join('\n') || '(no readable text)',
                `DRAFT PROMPT: ${placement.prompt}`,
            ].join('\n');
        });
        const systemPrompt = renderChatRewritePrompt({
            count: placements.length,
            dialect_rules: dialectRules,
            rewrite_rules: rewriteRules,
            subject_catalog: contextResult.subjectBlock,
        });
        const userPrompt = `Rewrite these ${placements.length} prompts against their chat excerpts.\n\n${items.join('\n\n')}`;
        const profileId = resolveRequestMapping(settings, 'chat_rewrite').apiProfile?.id
            ?? resolveRequestMapping(settings, 'chat_place').apiProfile?.id
            ?? resolveRequestMapping(settings, 'image_gen').apiProfile?.id
            ?? settings.llm?.defaultApiProfileId
            ?? '';

        try {
            const result = await client.request({ type: 'chat_rewrite', systemPrompt, userPrompt, profileId, signal });
            const parsed = parseJsonLoose(result.text);
            if (!parsed) {
                return { placements, rewritten: false, changed: 0, rejected: [], elapsedMs: result.elapsedMs, error: 'reply was not valid JSON' };
            }
            const merged = validateRewrites(parsed, placements, {
                subjectCatalog: contextResult.subjectCatalog,
                forbiddenFragments,
            });
            const allRejected = placements.length > 0 && merged.rejected.length >= placements.length;
            return {
                placements: merged.placements,
                rewritten: !allRejected,
                changed: merged.changed,
                rejected: merged.rejected.length,
                elapsedMs: result.elapsedMs,
                ...(allRejected ? { error: 'all rewritten scenes failed identity/style validation' } : {}),
            };
        } catch (err) {
            if (err?.code === 'ABORTED' || err?.name === 'AbortError' || signal?.aborted) throw err;
            console.warn('[IF Image] chat_rewrite failed; keeping validated draft scenes.');
            return { placements, rewritten: false, changed: 0, rejected: 0, elapsedMs: 0, error: err?.message ?? String(err) };
        }
    }

    return {
        rewrite, regenerate,
        generateCharacterDesign, modifyCharacter, modifyTags, translateFacts, syncPersonaFromSt,
        planChatImages,
    };
}