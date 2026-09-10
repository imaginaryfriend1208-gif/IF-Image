// IF Image - LLM client for Assist/Full mode rewrite engine.
// Dispatches to the user's SillyTavern LLM connection via one of:
//   1. generateRaw (default — uses the user's active ST connection)
//   2. ConnectionManagerRequestService (feature-detected from getContext())
//   3. Direct fetch to an OpenAI-compatible endpoint (from an API profile)
//   4. ST proxy (/api/backends/chat-completions/generate) — stub (METHOD_UNAVAILABLE)
//
// Never logs API keys or auth strings. Redaction follows the a1111 _safeDetail
// pattern: cap detail length, strip credential substrings, replace with [redacted].

/**
 * Typed LLM error.
 */
export class LlmError extends Error {
    /**
     * @param {string} code - one of CONFIG, NETWORK, TIMEOUT, ABORTED, HTTP, MALFORMED, METHOD_UNAVAILABLE
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'LlmError';
        this.code = code;
    }
}

/**
 * Bounded, redacted detail string — ported from a1111._safeDetail.
 * @param {unknown} err
 * @param {number} maxLen
 */
function safeDetail(err, maxLen = 200) {
    let raw = '';
    if (err instanceof Error) raw = String(err.message ?? err);
    else if (typeof err === 'string') raw = err;
    else if (err && typeof err === 'object') {
        try { raw = JSON.stringify(err); } catch { raw = String(err); }
    } else raw = String(err);
    // Strip potential credential substrings
    raw = raw.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/Basic\s+\S+/gi, 'Basic [redacted]')
        .replace(/"api[_-]?key"\s*:\s*"[^"]*"/gi, '"api_key": [redacted]')
        .replace(/pst-[A-Za-z0-9._-]+/g, 'pst-[redacted]');
    if (raw.length > maxLen) raw = raw.slice(0, maxLen) + '…';
    return raw;
}

/**
 * @param {{
 *   getSettings: () => object,
 *   getContext: () => object,
 *   [fetchImpl]: typeof fetch,
 * }} deps
 */
export function createLlmClient({ getSettings, getContext, fetchImpl = fetch } = {}) {
    /**
     * Dispatch an LLM request.
     * @param {{ type: string, systemPrompt: string, userPrompt: string,
     *           profileId?: string, signal?: AbortSignal }} req
     * @returns {Promise<{ text: string, requestId: string, elapsedMs: number, method: string }>}
     */
    async function request({ type, systemPrompt, userPrompt, profileId, signal } = {}) {
        if (!type || !userPrompt) {
            throw new LlmError('CONFIG', 'request() requires type and userPrompt.');
        }

        const requestId = crypto.randomUUID ? crypto.randomUUID() : 'llm_' + Date.now();
        const settings = getSettings();
        const ctx = getContext();
        const profiles = settings.llm?.apiProfiles ?? [];
        const activeProfileId = profileId ?? settings.llm?.defaultApiProfileId ?? '';
        const activeProfile = profiles.find(p => p.id === activeProfileId) ?? null;
        // Method is selected per API profile's `method` field; falls back to
        // the legacy global defaultMethod when no profile is configured.
        const method = activeProfile?.method
            ?? settings.llm?.defaultMethod
            ?? 'generateRaw';

        // Build a combined user prompt. ST's generateRaw expects a single string
        // prompt (not chat messages), with systemPrompt passed separately.
        const fullUserPrompt = userPrompt;

        const startMs = performance.now();
        let text = '';

        // Method 1: ST generateRaw (default) — uses the user's current ST API connection.
        if (method === 'direct' || method === 'st_generate_raw' || method === 'generateRaw') {
            try {
                text = await callGenerateRaw(ctx, {
                    prompt: fullUserPrompt,
                    systemPrompt,
                    signal,
                });
                return { text, requestId, elapsedMs: performance.now() - startMs, method: 'generateRaw' };
            } catch (err) {
                if (err?.name === 'AbortError' || signal?.aborted) {
                    throw new LlmError('ABORTED', 'LLM request was aborted.');
                }
                if (err instanceof LlmError) throw err;
                throw new LlmError('NETWORK', `generateRaw failed: ${safeDetail(err)}`);
            }
        }

        // Method 2: ConnectionManagerRequestService — use the user's connection profile.
        // The target is the SillyTavern connection profile id stored on the
        // API profile as stProfileId, NOT this extension's own profile id:
        // sendRequest resolves it against extension_settings.connectionManager.
        if (method === 'st_connection_manager' || method === 'connection_manager') {
            const stProfileId = activeProfile?.stProfileId ?? '';
            if (!stProfileId) {
                throw new LlmError('CONFIG', 'This API profile has no SillyTavern connection profile selected. Pick one in the LLM tab, or switch the method to ST generateRaw.');
            }
            try {
                const CMRS = ctx.ConnectionManagerRequestService;
                if (!CMRS || typeof CMRS.sendRequest !== 'function') {
                    console.warn('[IF Image] ConnectionManagerRequestService unavailable, falling back to generateRaw.');
                    text = await callGenerateRaw(ctx, { prompt: fullUserPrompt, systemPrompt, signal });
                    return { text, requestId, elapsedMs: performance.now() - startMs, method: 'generateRaw' };
                }
                const messages = [];
                if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
                messages.push({ role: 'user', content: fullUserPrompt });
                const result = await CMRS.sendRequest(stProfileId, messages, 4096, {
                    stream: false,
                    signal,
                    extractData: true,
                });
                // result may be ExtractedData with a .content property
                text = typeof result === 'string' ? result
                    : typeof result?.content === 'string' ? result.content
                    : typeof result?.choices?.[0]?.message?.content === 'string' ? result.choices[0].message.content
                    : JSON.stringify(result);
                return { text, requestId, elapsedMs: performance.now() - startMs, method: 'connection_manager' };
            } catch (err) {
                if (err?.name === 'AbortError' || signal?.aborted) {
                    throw new LlmError('ABORTED', 'LLM request was aborted.');
                }
                if (err instanceof LlmError) throw err;
                throw new LlmError('NETWORK', `ConnectionManager request failed: ${safeDetail(err)}`);
            }
        }

        // Method 3: Direct fetch to an OpenAI-compatible endpoint.
        if (method === 'direct_fetch') {
            if (!activeProfile) {
                throw new LlmError('CONFIG', 'No API profile selected for direct fetch. Configure one in the LLM tab.');
            }
            const { baseUrl, apiKey, model, temperature = 0.7, maxTokens = 4096 } = activeProfile;
            if (!baseUrl || !model) {
                throw new LlmError('CONFIG', 'API profile requires baseUrl and model.');
            }
            const messages = [];
            if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
            messages.push({ role: 'user', content: fullUserPrompt });

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 600000);
            // Chain caller's signal
            if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

            const url = baseUrl.replace(/\/+$/, '') + '/v1/chat/completions';
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

            let lastError = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const resp = await fetchImpl(url, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            model,
                            messages,
                            temperature,
                            max_tokens: maxTokens,
                        }),
                        signal: controller.signal,
                    });
                    if (!resp.ok) {
                        const bodyText = await resp.text().catch(() => '');
                        const detail = safeDetail(bodyText);
                        // Retry on 5xx
                        if (resp.status >= 500 && attempt === 0) {
                            lastError = new LlmError('HTTP', `HTTP ${resp.status}: ${detail}`);
                            await new Promise(r => setTimeout(r, 2000));
                            continue;
                        }
                        throw new LlmError('HTTP', `HTTP ${resp.status}: ${detail}`);
                    }
                    const data = await resp.json();
                    text = data?.choices?.[0]?.message?.content ?? '';
                    if (!text) throw new LlmError('MALFORMED', 'LLM reply contained no content.');
                    clearTimeout(timeoutId);
                    return { text, requestId, elapsedMs: performance.now() - startMs, method: 'direct_fetch' };
                } catch (err) {
                    if (err?.name === 'AbortError') {
                        clearTimeout(timeoutId);
                        throw new LlmError('ABORTED', 'LLM request was aborted.');
                    }
                    if (err instanceof LlmError) {
                        // Not retryable here: 4xx/MALFORMED throw directly, and
                        // the 5xx path already used `continue` for its one retry
                        // before throwing on the second attempt.
                        clearTimeout(timeoutId);
                        throw err;
                    }
                    lastError = new LlmError('NETWORK', `Direct fetch failed: ${safeDetail(err)}`);
                    if (attempt === 0) {
                        await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }
                }
            }
            clearTimeout(timeoutId);
            throw lastError ?? new LlmError('NETWORK', 'Direct fetch failed after retries.');
        }

        // Method 4: ST proxy — not yet implemented.
        throw new LlmError('METHOD_UNAVAILABLE', 'ST proxy method is not yet implemented. Use direct, st_generate_raw, or direct_fetch.');
    }

    return { request };
}

/**
 * Call ST's generateRaw with abort chaining.
 */
async function callGenerateRaw(ctx, { prompt, systemPrompt, signal }) {
    console.log('[IF Image] callGenerateRaw:', {
        hasGenerateRaw: typeof ctx?.generateRaw === 'function',
        mainApi: ctx?.main_api,
        promptLen: prompt?.length,
        systemPromptLen: systemPrompt?.length,
    });

    const generateRaw = ctx?.generateRaw;
    if (typeof generateRaw !== 'function') {
        throw new LlmError('CONFIG', 'SillyTavern generateRaw is not available. Create an API profile in IF-Image LLM tab (method: direct_fetch or connection_manager), or check ST main API connection.');
    }

    let stopListener = null;
    if (signal) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        stopListener = () => {
            try { ctx.stopGeneration?.(); } catch { /* best-effort */ }
        };
        signal.addEventListener('abort', stopListener, { once: true });
    }

    let result;
    try {
        result = await generateRaw({ prompt, systemPrompt, responseLength: 4096 });
        console.log('[IF Image] generateRaw success, result type:', typeof result, 'len:', result?.length);
    } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) throw err;
        const detail = safeDetail(err);
        // Never expose the raw error object: provider errors may embed headers.
        console.error('[IF Image] generateRaw threw:', detail);
        throw new LlmError('NETWORK', `generateRaw failed: ${detail}`);
    } finally {
        if (stopListener && signal) signal.removeEventListener('abort', stopListener);
    }

    if (typeof result !== 'string') {
        throw new LlmError('MALFORMED', 'generateRaw returned non-string result.');
    }
    return result;
}
