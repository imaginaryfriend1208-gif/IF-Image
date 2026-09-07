// IF Image - LLM rewrite engine: bridges LLM client → parser → prompt → pipeline.
// Handles Assist and Full modes by calling the LLM, parsing the reply,
// and feeding the result into the existing compile → queue pipeline.

import { createLlmClient } from './client.js';
import { buildContext } from './context.js';
import { renderSystemPrompt, renderUserPrompt, DIALECT_RULES } from './prompts.js';
import { parseLlmReply } from './parser.js';
import { resolveRequestMapping } from './profiles.js';
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

    return { rewrite, regenerate };
}