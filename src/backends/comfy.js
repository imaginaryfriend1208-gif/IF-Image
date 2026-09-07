// IF Image - ComfyUI Cloud proxy backend (hardened).
// Talks to the user's own "comfy-cloud-forge-proxy" (SillytavernproxyComfyuicloud).
// Proxy schema verified from its src/server.ts:
//   GET  /internal/ping    -> { ok, service } (no auth)
//   GET  /internal/status  -> { cloudConfigured, activeJobs, settings, characterCount } (auth)
//   POST /sdapi/v1/txt2img -> zod schema: prompt, negative_prompt, model (optional),
//        seed (-1 = random), width, height, steps, cfg_scale, sampler_name,
//        scheduler, send_images, override_settings (record).
//        Response: { images: [base64...], parameters, info (JSON string) }
// Error shape from setErrorHandler: { error, detail, body, errors }

export const DISCOVERY_TIMEOUT_MS = 30000;
export const GENERATION_TIMEOUT_MS = 300000;

// Typed error codes for the proxy backend.
export class ComfyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ComfyError';
        this.code = code;
    }
}

function trimSlash(url) {
    return String(url || '').replace(/\/+$/, '');
}

/** Replace any occurrence of a secret with '***' in error details. */
function redact(text, secret) {
    const value = String(text);
    return secret ? value.split(secret).join('***') : value;
}

/**
 * Convert a base64 string (with or without data: prefix) to a Blob.
 */
export function base64ToBlob(base64, mime = 'image/png') {
    const clean = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

export class ComfyProxyClient {
    /**
     * @param {{getBaseUrl: () => string, getUsername: () => string, getPassword: () => string,
     *          fetchImpl?: typeof fetch}} cfg
     * fetchImpl is injectable for offline tests.
     */
    constructor(cfg) {
        this.cfg = cfg;
        this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch?.bind(globalThis);
        if (typeof this.fetchImpl !== 'function') {
            throw new TypeError('ComfyProxyClient: no fetch implementation available (pass fetchImpl).');
        }
    }

    baseUrl() {
        return trimSlash(this.cfg.getBaseUrl());
    }

    _authString() {
        const user = this.cfg.getUsername();
        const pass = this.cfg.getPassword();
        return (user || pass) ? `${user}:${pass}` : '';
    }

    headers(json = true) {
        const headers = {};
        if (json) headers['Content-Type'] = 'application/json';
        const auth = this._authString();
        if (auth) {
            headers['Authorization'] = 'Basic ' + btoa(auth);
        }
        return headers;
    }

    /** Bounded, credential-redacted error detail. */
    async _safeDetail(response) {
        let text = '';
        try { text = await response.text(); } catch { return ''; }
        if (!text) return '';
        const secret = this._authString();
        try {
            const parsed = JSON.parse(text);
            for (const key of ['detail', 'error', 'message', 'errors', 'body']) {
                const value = parsed?.[key];
                if (typeof value === 'string' && value) return redact(value.slice(0, 300), secret);
                if (Array.isArray(value) && value.length) {
                    const first = value[0];
                    return redact(String(first?.msg ?? first).slice(0, 300), secret);
                }
            }
        } catch { /* not JSON — fall through to plain text */ }
        return redact(text.slice(0, 300), secret);
    }

    /**
     * Core request runner with timeout, redirect guard, and credential
     * redaction — mirrors the A1111Client._request hardening pattern.
     * Exactly one fetch per call; no retries.
     */
    async _request(path, { method = 'GET', body, signal, timeoutMs } = {}) {
        const base = trimSlash(this.cfg.getBaseUrl());
        if (!base) throw new ComfyError('COMFY_CONFIG', 'Proxy base URL is not configured.');
        const url = `${base}${path}`;
        const headers = this.headers(body !== undefined);

        const controller = new AbortController();
        let timedOut = false;
        let userCancelled = false;
        const onExternalAbort = () => { userCancelled = true; controller.abort(); };
        if (signal) {
            if (signal.aborted) {
                throw new ComfyError('COMFY_ABORTED', `Request to ${path} was cancelled before it started.`);
            }
            signal.addEventListener('abort', onExternalAbort, { once: true });
        }
        const timeout = timeoutMs ?? (method === 'GET' ? DISCOVERY_TIMEOUT_MS : GENERATION_TIMEOUT_MS);
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);

        let response;
        try {
            response = await this.fetchImpl(url, {
                method,
                headers,
                redirect: 'error',
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                signal: controller.signal,
            });
        } catch (error) {
            if (timedOut) {
                throw new ComfyError('COMFY_TIMEOUT', `Request to ${path} timed out after ${timeout}ms. The server job (if any) was NOT cancelled.`);
            }
            if (userCancelled || signal?.aborted || error?.name === 'AbortError') {
                throw new ComfyError('COMFY_ABORTED', `Request to ${path} was cancelled. The proxy job (if already started) may still be running.`);
            }
            throw new ComfyError('COMFY_NETWORK', `Could not reach the proxy at ${base} (${error?.message ?? error}). Is it running?`);
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onExternalAbort);
        }

        if (response.status >= 300 && response.status < 400) {
            throw new ComfyError('COMFY_REDIRECT', `Proxy answered with HTTP ${response.status} (redirect). Credentials are never sent across redirects — configure the final URL directly.`);
        }
        if (response.status === 401 || response.status === 403) {
            const detail = await this._safeDetail(response);
            throw new ComfyError('COMFY_AUTH', `Proxy rejected the credentials (HTTP ${response.status}).${detail ? ` Server message: ${detail}` : ''}`);
        }
        if (!response.ok) {
            const detail = await this._safeDetail(response);
            throw new ComfyError('COMFY_HTTP', `Proxy returned HTTP ${response.status}.${detail ? ` ${detail}` : ''}`);
        }
        return response;
    }

    async _json(response, path) {
        let text;
        try { text = await response.text(); } catch (err) {
            throw new ComfyError('COMFY_MALFORMED', `${path} returned an unreadable body (${err?.message ?? err}).`);
        }
        try { return JSON.parse(text); } catch {
            throw new ComfyError('COMFY_MALFORMED', `${path} did not return valid JSON.`);
        }
    }

    /**
     * Liveness check. /internal/ping is exempt from auth in the proxy.
     * @param {{signal?: AbortSignal}} [options] aborts the browser request only
     */
    async ping({ signal } = {}) {
        const response = await this._request('/internal/ping', { signal });
        return this._json(response, '/internal/ping');
    }

    /**
     * Full status: cloud key configured, active jobs, model profiles, character count.
     * Requires valid credentials.
     * @param {{signal?: AbortSignal}} [options]
     */
    async status({ signal } = {}) {
        const response = await this._request('/internal/status', { signal });
        return this._json(response, '/internal/status');
    }

    /**
     * List enabled model profiles from the proxy (sd-models endpoint).
     * Each entry: { title, model_name, filename }. `title` is accepted as the
     * txt2img `model` field (proxy matches id / title / checkpoint file name).
     * @param {{signal?: AbortSignal}} [options]
     */
    async models({ signal } = {}) {
        const response = await this._request('/sdapi/v1/sd-models', { signal });
        return this._json(response, '/sdapi/v1/sd-models');
    }

    /**
     * SD-style text-to-image through the proxy.
     * `model` must be a proxy model id / title / checkpoint file name (from models()).
     * Family names (krea2/anima/illustrious) are NOT matched by the proxy.
     * @param {{prompt: string, negative_prompt: string, model?: string, seed?: number,
     *          width?: number, height?: number, steps?: number, cfg_scale?: number}} body
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{image: Blob, dataUrl: string, raw: object, info: object}>}
     */
    async txt2img(body, { signal } = {}) {
        const int = (value, fallback) => Number.isFinite(value) ? Math.trunc(value) : fallback;
        const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
        const width = body.width === undefined ? undefined : clamp(int(Number(body.width), 832), 64, 4096);
        const height = body.height === undefined ? undefined : clamp(int(Number(body.height), 1216), 64, 4096);
        const steps = body.steps === undefined ? undefined : clamp(int(Number(body.steps), 16), 1, 200);
        const cfg = body.cfg_scale === undefined ? undefined : clamp(Number(body.cfg_scale) || 0, 0, 100);
        const payload = {
            prompt: body.prompt ?? '',
            negative_prompt: body.negative_prompt ?? '',
            model: body.model || undefined,
            seed: clamp(int(Number(body.seed ?? -1), -1), -1, Number.MAX_SAFE_INTEGER),
            width,
            height,
            steps,
            cfg_scale: cfg,
            send_images: true,
        };

        const response = await this._request('/sdapi/v1/txt2img', {
            method: 'POST',
            body: payload,
            signal,
            timeoutMs: GENERATION_TIMEOUT_MS,
        });
        const data = await this._json(response, '/sdapi/v1/txt2img');
        if (!Array.isArray(data.images) || data.images.length === 0 || !data.images[0]) {
            throw new ComfyError('COMFY_MALFORMED', 'Proxy returned no image data.');
        }
        let info = {};
        try { info = JSON.parse(data.info); } catch { /* info is optional */ }
        const blob = base64ToBlob(data.images[0], 'image/png');
        return { image: blob, dataUrl: URL.createObjectURL(blob), raw: data, info };
    }
}
