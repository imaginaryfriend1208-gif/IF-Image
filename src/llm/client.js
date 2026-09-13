// IF Image - one-target LLM client (V2 connection-first).
// Every request type uses settings.connection.llm; credentials never enter
// task snapshots, diagnostics, exports, or return values.

export class LlmError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'LlmError';
        this.code = code;
    }
}

function safeDetail(error, maxLength = 200, secret = '') {
    let detail = error instanceof Error ? error.message : String(error ?? '');
    detail = detail
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/Basic\s+\S+/gi, 'Basic [redacted]')
        .replace(/"api[_-]?key"\s*:\s*"[^"]*"/gi, '"api_key": [redacted]')
        .replace(/pst-[A-Za-z0-9._-]+/g, 'pst-[redacted]');
    if (secret) detail = detail.split(secret).join('[redacted]');
    return detail.length > maxLength ? `${detail.slice(0, maxLength)}…` : detail;
}

export function formatLlmError(error, action = 'LLM request') {
    const code = typeof error?.code === 'string' ? error.code : 'NETWORK';
    if (code === 'ABORTED' || error?.name === 'AbortError') return `${action} was cancelled.`;
    const guidance = {
        CONFIG: 'LLM is not configured correctly. Open Connection and select one LLM target.',
        NETWORK: 'LLM connection failed. Check the selected target and try again.',
        TIMEOUT: 'LLM request timed out. Check the endpoint and try again.',
        HTTP: 'LLM provider rejected the request. Check the target configuration and provider status.',
        MALFORMED: 'LLM returned an unreadable response. Try again or choose another model.',
        METHOD_UNAVAILABLE: 'SillyTavern Connection Manager is unavailable. Enable it or choose a custom LLM target.',
    }[code] ?? 'LLM request failed.';
    const detail = safeDetail(error);
    return detail && !guidance.includes(detail) ? `${guidance} Details: ${detail}` : guidance;
}

/** Resolve the sole LLM target. No request type or legacy profile is read. */
export function resolveLlmTarget(settings = {}) {
    const llm = settings?.connection?.llm;
    if (!llm || typeof llm !== 'object') {
        throw new LlmError('CONFIG', 'No LLM target configured in Connection settings.');
    }
    if (llm.mode === 'st_profile') {
        return { mode: 'st_profile', stProfileId: typeof llm.stProfileId === 'string' ? llm.stProfileId : '' };
    }
    if (llm.mode === 'custom') {
        const custom = llm.custom && typeof llm.custom === 'object' ? llm.custom : {};
        return {
            mode: 'custom',
            baseUrl: typeof custom.baseUrl === 'string' ? custom.baseUrl.trim() : '',
            apiKey: typeof custom.apiKey === 'string' ? custom.apiKey : '',
            model: typeof custom.model === 'string' ? custom.model.trim() : '',
        };
    }
    throw new LlmError('CONFIG', 'Unknown LLM target mode. Choose an ST profile or custom target.');
}

/** Return only safe dropdown metadata from ST Connection Manager. */
export function listStProfiles(context = {}) {
    const root = context?.extensionSettings ?? context?.extension_settings ?? context;
    const profiles = root?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) return [];
    return profiles
        .filter(profile => profile && typeof profile.id === 'string' && profile.id)
        .map(profile => ({ id: profile.id, name: typeof profile.name === 'string' && profile.name ? profile.name : profile.id }));
}

function extractText(result) {
    if (typeof result === 'string') return result;
    if (typeof result?.content === 'string') return result.content;
    if (typeof result?.choices?.[0]?.message?.content === 'string') return result.choices[0].message.content;
    return '';
}

export function createLlmClient({ getSettings, getContext, fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    if (typeof getSettings !== 'function' || typeof getContext !== 'function') {
        throw new TypeError('createLlmClient: getSettings and getContext are required.');
    }

    /** Dispatch through the one configured target. */
    async function request({ type, systemPrompt = '', userPrompt, signal } = {}) {
        if (!type || !userPrompt) throw new LlmError('CONFIG', 'request() requires type and userPrompt.');
        const target = resolveLlmTarget(getSettings());
        const context = getContext() ?? {};
        const requestId = globalThis.crypto?.randomUUID?.() ?? `llm_${Date.now()}`;
        const startedAt = performance.now();
        const messages = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: userPrompt });

        if (target.mode === 'st_profile') {
            if (!target.stProfileId || !listStProfiles(context).some(profile => profile.id === target.stProfileId)) {
                throw new LlmError('CONFIG', 'The selected SillyTavern connection profile no longer exists. Choose another profile in Connection.');
            }
            const service = context.ConnectionManagerRequestService;
            if (!service || typeof service.sendRequest !== 'function') {
                throw new LlmError('METHOD_UNAVAILABLE', 'SillyTavern Connection Manager request service is unavailable.');
            }
            try {
                const result = await service.sendRequest(target.stProfileId, messages, 4096, {
                    stream: false,
                    signal,
                    extractData: true,
                });
                const text = extractText(result);
                if (!text) throw new LlmError('MALFORMED', 'LLM reply contained no content.');
                return { text, requestId, elapsedMs: performance.now() - startedAt, method: 'st_profile' };
            } catch (error) {
                if (error instanceof LlmError) throw error;
                if (error?.name === 'AbortError' || signal?.aborted) throw new LlmError('ABORTED', 'LLM request was aborted.');
                throw new LlmError('NETWORK', `Connection Manager request failed: ${safeDetail(error)}`);
            }
        }

        if (!target.baseUrl || !target.model) {
            throw new LlmError('CONFIG', 'Custom LLM target requires base URL and model.');
        }
        if (typeof fetchImpl !== 'function') throw new LlmError('METHOD_UNAVAILABLE', 'Browser fetch is unavailable.');
        let url;
        try {
            const base = new URL(target.baseUrl);
            if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('invalid');
            url = `${base.toString().replace(/\/+$/, '')}/v1/chat/completions`;
        } catch {
            throw new LlmError('CONFIG', 'Custom LLM base URL must be an HTTP(S) URL without embedded credentials.');
        }

        const controller = new AbortController();
        let timedOut = false;
        const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, 600000);
        const forwardAbort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener('abort', forwardAbort, { once: true });
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (target.apiKey) headers.Authorization = `Bearer ${target.apiKey}`;
            const response = await fetchImpl(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ model: target.model, messages, temperature: 0.7, max_tokens: 4096 }),
                signal: controller.signal,
            });
            if (!response.ok) {
                const detail = safeDetail(await response.text().catch(() => ''), 200, target.apiKey);
                throw new LlmError('HTTP', `HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
            }
            const text = extractText(await response.json());
            if (!text) throw new LlmError('MALFORMED', 'LLM reply contained no content.');
            return { text, requestId, elapsedMs: performance.now() - startedAt, method: 'custom' };
        } catch (error) {
            if (error instanceof LlmError) throw error;
            if (error?.name === 'AbortError' || controller.signal.aborted) {
                throw new LlmError(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut ? 'LLM request timed out.' : 'LLM request was aborted.');
            }
            throw new LlmError('NETWORK', `Custom LLM request failed: ${safeDetail(error, 200, target.apiKey)}`);
        } finally {
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', forwardAbort);
        }
    }

    return { request };
}
