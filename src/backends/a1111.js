// IF Image - AUTOMATIC1111-compatible API client (browser-direct).
// Mirrors the SillyTavern "Stable Diffusion WebUI (AUTOMATIC1111)" source
// contract, verified from D:/SillyTavern:
//   src/util.js getBasicAuthHeader(auth) -> `Basic ${Buffer.from(auth).toString('base64')}`
//     - the WHOLE auth string is encoded as UTF-8 base64, exactly as typed:
//       no trimming, no inserted ':', never converted to Bearer.
//   src/endpoints/stable-diffusion.js endpoints used here:
//     GET  /sdapi/v1/options   (read-only; never POSTed by this client)
//     GET  /sdapi/v1/sd-models
//     GET  /sdapi/v1/samplers
//     POST /sdapi/v1/txt2img   with override_settings.sd_model_checkpoint
// ST's /api/sd/set-model POSTs to options; this extension deliberately does
// NOT switch the server model: checkpoint selection rides on per-request
// override_settings + override_settings_restore_afterwards (ST payload shape).
// /sdapi/v1/interrupt is never called: on a shared hosted instance it could
// kill someone else's job. Aborting here only cancels the browser request.

import { base64ToBlob } from './comfy.js';

export const DISCOVERY_TIMEOUT_MS = 30000;
export const GENERATION_TIMEOUT_MS = 300000;

/** Error codes: A1111_CONFIG, A1111_NETWORK, A1111_TIMEOUT, A1111_ABORTED,
 *  A1111_REDIRECT, A1111_AUTH, A1111_HTTP, A1111_MALFORMED. */
export class A1111Error extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'A1111Error';
        this.code = code;
    }
}

// ---------------------------------------------------------------------------
// Pure helpers (also used by offline tests)
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Base64 of the UTF-8 bytes of `text` — the exact browser equivalent of
 * ST's Buffer.from(auth).toString('base64'). No trimming, no transformation.
 */
export function utf8Base64(text) {
    const bytes = new TextEncoder().encode(String(text));
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
        out += B64_ALPHABET[b0 >> 2];
        out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
        out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
        out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 0x3f];
    }
    return out;
}

/** `Authorization: Basic <utf8-base64>` from the raw Authentication string. */
export function buildBasicAuthHeader(auth) {
    return `Basic ${utf8Base64(auth)}`;
}

/**
 * Validate + normalize a configured base URL.
 * Only http/https; no embedded credentials, query or fragment; trailing
 * slashes collapse; the base path is preserved (e.g. https://host/a1111).
 * @returns {{ok: true, url: string} | {ok: false, error: string}}
 */
export function normalizeBaseUrl(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { ok: false, error: 'the URL is empty' };
    let url;
    try {
        url = new URL(text);
    } catch {
        return { ok: false, error: `"${text}" is not a valid URL` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, error: 'only http:// and https:// URLs are allowed' };
    }
    if (url.username || url.password) {
        return { ok: false, error: 'embedded credentials (user:pass@host) are not allowed — put the whole string in the Authentication field' };
    }
    if (url.search) {
        return { ok: false, error: 'query strings are not allowed in the base URL' };
    }
    if (url.hash) {
        return { ok: false, error: 'fragments are not allowed in the base URL' };
    }
    const path = url.pathname.replace(/\/+$/, '');
    return { ok: true, url: `${url.protocol}//${url.host}${path}` };
}

/**
 * Normalize an /sdapi/v1/sd-models response into checkpoint descriptors.
 * @returns {Array<{title: string, model_name: string, filename: string|null}> | null}
 * null when the response is not an array (malformed).
 */
export function normalizeModels(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const title = typeof entry.title === 'string' && entry.title
            ? entry.title
            : (typeof entry.model_name === 'string' && entry.model_name ? entry.model_name : null);
        if (!title) continue;
        out.push({
            title,
            model_name: typeof entry.model_name === 'string' && entry.model_name ? entry.model_name : title,
            filename: typeof entry.filename === 'string' ? entry.filename : null,
        });
    }
    return out;
}

/**
 * Pure UI-model resolution: a stored checkpoint is only valid when it is
 * present in the freshly discovered list. Family/dialect names are never
 * inferred or substituted. Returns the canonical title, or null (caller
 * must block generation with guidance).
 */
export function resolveCheckpoint(models, stored) {
    const list = Array.isArray(models) ? models : [];
    if (typeof stored !== 'string' || !stored) return null;
    const hit = list.find(m => m && typeof m.title === 'string' && (m.title === stored || m.model_name === stored));
    return hit ? hit.title : null;
}

/** Replace any occurrence of the secret with '***' in error details. */
function redact(text, secret) {
    const value = String(text);
    return secret ? value.split(secret).join('***') : value;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class A1111Client {
    /**
     * @param {{getBaseUrl: () => string, getAuth: () => string,
     *          fetchImpl?: typeof fetch, timeoutMs?: number}} cfg
     * fetchImpl is injectable for offline tests. timeoutMs (when set)
     * overrides the per-kind defaults for every request.
     */
    constructor(cfg) {
        if (!cfg || typeof cfg.getBaseUrl !== 'function' || typeof cfg.getAuth !== 'function') {
            throw new TypeError('A1111Client: getBaseUrl and getAuth functions are required.');
        }
        this.cfg = cfg;
        this.fetchImpl = cfg.fetchImpl ?? globalThis.fetch?.bind(globalThis);
        this.timeoutMs = cfg.timeoutMs ?? null;
        if (typeof this.fetchImpl !== 'function') {
            throw new TypeError('A1111Client: no fetch implementation available (pass fetchImpl).');
        }
    }

    /**
     * Core request runner: URL validation, exact ST Basic auth header,
     * redirect:'error' (credentials must never travel across redirects),
     * timeout vs user-abort distinction, safe errors without credential
     * leakage. Exactly one fetch per call — no retries.
     */
    async _request(path, { method = 'GET', body, signal, timeoutMs } = {}) {
        const base = normalizeBaseUrl(this.cfg.getBaseUrl());
        if (!base.ok) {
            throw new A1111Error('A1111_CONFIG', `Invalid AUTOMATIC1111 base URL: ${base.error}.`);
        }
        // The Authentication string is used exactly as configured: no trim,
        // no colon insertion, no Bearer fallback attempts.
        const auth = String(this.cfg.getAuth() ?? '');
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (auth) headers['Authorization'] = buildBasicAuthHeader(auth);
        const url = `${base.url}${path}`;

        const controller = new AbortController();
        let timedOut = false;
        let userCancelled = false;
        const onExternalAbort = () => {
            userCancelled = true;
            controller.abort();
        };
        if (signal) {
            if (signal.aborted) {
                throw new A1111Error('A1111_ABORTED', `Request to ${path} was cancelled before it started. Only the browser request is aborted; the server may still be processing.`);
            }
            signal.addEventListener('abort', onExternalAbort, { once: true });
        }
        const timeout = timeoutMs ?? this.timeoutMs ?? (method === 'GET' ? DISCOVERY_TIMEOUT_MS : GENERATION_TIMEOUT_MS);
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeout);

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
                throw new A1111Error('A1111_TIMEOUT', `Request to ${path} timed out after ${timeout} ms. The server job (if any) was NOT cancelled — only the browser request was abandoned.`);
            }
            if (userCancelled || signal?.aborted || error?.name === 'AbortError') {
                throw new A1111Error('A1111_ABORTED', `Request to ${path} was cancelled. Only the browser request was aborted; the server job (if any) may still be running.`);
            }
            // Browser fetch reports network failure, CORS rejection and
            // (with redirect:'error') redirects all as TypeError. Do not
            // claim a specific cause.
            throw new A1111Error('A1111_NETWORK', `Could not reach ${base.url}${path} (${error?.message ?? error}). Network-level failure: server down, wrong URL, blocked cross-origin request (CORS), or a redirect. The browser cannot distinguish these cases.`);
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onExternalAbort);
        }

        if (response.status >= 300 && response.status < 400) {
            throw new A1111Error('A1111_REDIRECT', `${base.url}${path} answered with HTTP ${response.status} (redirect). Credentials are never sent across redirects — configure the final URL directly.`);
        }
        if (response.status === 401 || response.status === 403) {
            const detail = await this._safeDetail(response, auth);
            throw new A1111Error('A1111_AUTH', `The server rejected the Authentication string (HTTP ${response.status}). Enter the whole string exactly as the service provides it (user:password, or the bare key) — no quotes, no trimming.${detail ? ` Server message: ${detail}` : ''}`);
        }
        if (!response.ok) {
            const detail = await this._safeDetail(response, auth);
            throw new A1111Error('A1111_HTTP', `HTTP ${response.status} from ${path}${detail ? `: ${detail}` : '.'}`);
        }
        return response;
    }

    /** Bounded, JSON-preferring, credential-redacted error detail. */
    async _safeDetail(response, secret) {
        let text = '';
        try {
            text = await response.text();
        } catch {
            return '';
        }
        if (!text) return '';
        try {
            const parsed = JSON.parse(text);
            for (const key of ['detail', 'error', 'message', 'errors']) {
                const value = parsed?.[key];
                if (typeof value === 'string' && value) return redact(value.slice(0, 300), secret);
                if (Array.isArray(value) && value.length) {
                    const first = value[0];
                    return redact(String(first?.msg ?? first).slice(0, 300), secret);
                }
            }
        } catch { /* not JSON — fall through to plain text */ }
        return redact(text.slice(0, 200), secret);
    }

    async _json(response, path) {
        let text;
        try {
            text = await response.text();
        } catch (error) {
            throw new A1111Error('A1111_MALFORMED', `${path} returned an unreadable body (${error?.message ?? error}).`);
        }
        try {
            return JSON.parse(text);
        } catch {
            throw new A1111Error('A1111_MALFORMED', `${path} did not return valid JSON (first 120 chars: "${text.slice(0, 120)}").`);
        }
    }

    /** GET /sdapi/v1/options — read-only. Never writes options. */
    async options({ signal } = {}) {
        const response = await this._request('/sdapi/v1/options', { signal });
        const data = await this._json(response, '/sdapi/v1/options');
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new A1111Error('A1111_MALFORMED', '/sdapi/v1/options did not return a JSON object.');
        }
        return data;
    }

    /** GET /sdapi/v1/sd-models — normalized checkpoint list. */
    async models({ signal } = {}) {
        const response = await this._request('/sdapi/v1/sd-models', { signal });
        const data = await this._json(response, '/sdapi/v1/sd-models');
        const list = normalizeModels(data);
        if (list === null) {
            throw new A1111Error('A1111_MALFORMED', '/sdapi/v1/sd-models did not return a JSON array.');
        }
        return list;
    }

    /** GET /sdapi/v1/samplers — raw array. */
    async samplers({ signal } = {}) {
        const response = await this._request('/sdapi/v1/samplers', { signal });
        const data = await this._json(response, '/sdapi/v1/samplers');
        if (!Array.isArray(data)) {
            throw new A1111Error('A1111_MALFORMED', '/sdapi/v1/samplers did not return a JSON array.');
        }
        return data;
    }

    /**
     * Connectivity + credential check: GET options and models.
     * Never writes options or switches the server model. A samplers failure
     * is reported but never treated as an auth/connection failure.
     * @returns {Promise<{currentCheckpoint: string|null, models: Array,
     *                    samplers: Array|null, samplersError: string|null}>}
     */
    async testConnection({ signal } = {}) {
        const options = await this.options({ signal });
        const models = await this.models({ signal });
        let samplers = null;
        let samplersError = null;
        try {
            samplers = await this.samplers({ signal });
        } catch (error) {
            if (error instanceof A1111Error && (error.code === 'A1111_ABORTED' || error.code === 'A1111_TIMEOUT')) {
                throw error;
            }
            // Optional endpoint: tolerate HTTP/malformed failures, including
            // a 401 on this one route (options+models already authenticated).
            samplersError = error?.message ?? String(error);
        }
        const current = options.sd_model_checkpoint;
        return {
            currentCheckpoint: typeof current === 'string' && current ? current : null,
            models,
            samplers,
            samplersError,
        };
    }

    /**
     * POST /sdapi/v1/txt2img — one image per request, no auto-retry.
     * The checkpoint must be a title/model_name from models() (validated by
     * the caller with resolveCheckpoint); it is sent via
     * override_settings.sd_model_checkpoint with
     * override_settings_restore_afterwards — no top-level legacy `model`.
     * @param {{prompt: string, negative_prompt: string, checkpoint: string,
     *          seed?: number, width?: number, height?: number, steps?: number,
     *          cfg_scale?: number, sampler_name?: string, scheduler?: string}} body
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{image: Blob, dataUrl: string, info: object, raw: object}>}
     */
    async txt2img(body, { signal } = {}) {
        if (!body || typeof body !== 'object') {
            throw new A1111Error('A1111_CONFIG', 'txt2img requires a request body.');
        }
        const checkpoint = typeof body.checkpoint === 'string' ? body.checkpoint : '';
        if (!checkpoint) {
            throw new A1111Error('A1111_CONFIG', 'No checkpoint selected. In Backends, use Refresh Models under the AUTOMATIC1111 section and pick a discovered checkpoint.');
        }
        const int = (value, fallback) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
        const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
        const width = clamp(int(body.width, 832), 64, 4096);
        const height = clamp(int(body.height, 1216), 64, 4096);
        const steps = clamp(int(body.steps, 16), 1, 200);
        const cfg = clamp(Number.isFinite(Number(body.cfg_scale)) ? Number(body.cfg_scale) : 5, 0, 100);
        const seed = clamp(int(body.seed, -1), -1, Number.MAX_SAFE_INTEGER);
        const payload = {
            prompt: body.prompt ?? '',
            negative_prompt: body.negative_prompt ?? '',
            steps,
            cfg_scale: cfg,
            width,
            height,
            seed,
            batch_size: 1,
            n_iter: 1,
            send_images: true,
            save_images: false,
            override_settings: {
                sd_model_checkpoint: checkpoint,
            },
            override_settings_restore_afterwards: true,
        };
        if (typeof body.sampler_name === 'string' && body.sampler_name) payload.sampler_name = body.sampler_name;
        if (typeof body.scheduler === 'string' && body.scheduler) payload.scheduler = body.scheduler;

        const response = await this._request('/sdapi/v1/txt2img', { method: 'POST', body: payload, signal });
        const data = await this._json(response, '/sdapi/v1/txt2img');
        if (!data || typeof data !== 'object' || !Array.isArray(data.images) || !data.images[0]) {
            throw new A1111Error('A1111_MALFORMED', '/sdapi/v1/txt2img returned no image data (expected a non-empty images array).');
        }
        let info = {};
        if (typeof data.info === 'string' && data.info) {
            try { info = JSON.parse(data.info); } catch { info = {}; }
        } else if (data.info && typeof data.info === 'object') {
            info = data.info;
        }
        const blob = base64ToBlob(data.images[0], 'image/png');
        return { image: blob, dataUrl: URL.createObjectURL(blob), info, raw: data };
    }
}
