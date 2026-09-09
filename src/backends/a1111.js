// IF Image - AUTOMATIC1111-compatible API client.
// Two transports (cfg.getTransport):
//   'st-relay' (default in settings): browser -> SillyTavern server
//       (/api/sd/*) -> backend. Same path ST's own Image Generation
//       extension uses; needs no CORS on the backend. See ST_RELAY_ROUTES.
//   'direct': browser -> backend. Needs CORS on the backend.
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

/**
 * Extract a bounded, credential-redacted detail string from a raw error
 * body (JSON-preferring). Pure counterpart of A1111Client._safeDetail so
 * callers that already hold the body text can reuse it.
 */
function extractDetail(text, secret) {
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

const VALIDATION_SUMMARY_PREFIX = 'Server workflow references missing files:';

/**
 * Turn a ComfyUI-style workflow validation error (`node_errors` /
 * `value_not_in_list` entries) into one legible line naming the missing
 * files, e.g. "Server workflow references missing files:
 * ckpt_name=X.safetensors; lora_name=Y.safetensors" — at most 3 items,
 * never longer than 300 chars. Any other text passes through as the
 * existing bounded detail. Pure and shared with the Comfy proxy client.
 *
 * Callers must pass text that is ALREADY sanitized/redacted: this helper
 * never sees (and never re-adds) the base URL, the auth string, or the
 * full JSON body.
 * @param {string} detailText sanitized error body/detail text
 * @returns {string} summary line, or the bounded input text
 */
export function summarizeValidationError(detailText) {
    const text = String(detailText ?? '');
    const bounded = text.slice(0, 300);
    if (!/node_errors|value_not_in_list/.test(text)) return bounded;
    // Bound the scan work, and tolerate one level of JSON string escaping
    // (proxies often carry the ComfyUI JSON stringified inside "detail").
    const norm = text.slice(0, 20000).replace(/\\"/g, '"');
    const items = [];
    const seen = new Set();
    const push = (name, value) => {
        const entry = `${name}=${value}`;
        if (!seen.has(entry) && items.length < 3) {
            seen.add(entry);
            items.push(entry);
        }
    };
    // ComfyUI "details" strings: `ckpt_name: 'file.safetensors' not in [...]`
    for (const m of norm.matchAll(/(\w+):\s*'([^']{1,160})'\s+not in/g)) push(m[1], m[2]);
    // extra_info fallback: "input_name": "ckpt_name" ... "received_value": "f"
    for (const m of norm.matchAll(/"input_name"\s*:\s*"(\w+)"[\s\S]{0,300}?"received_value"\s*:\s*"([^"]{1,160})"/g)) push(m[1], m[2]);
    if (!items.length) return bounded;
    const summary = `${VALIDATION_SUMMARY_PREFIX} ${items.join('; ')}`;
    return summary.length <= 300 ? summary : `${summary.slice(0, 297)}...`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Re-wrap a SillyTavern relay response body into the matching /sdapi/v1 JSON
 * text. Returns null when the body is not what the relay endpoint promises.
 *   options -> ST /get-model returns the bare checkpoint title (text or JSON
 *              string) -> `{ sd_model_checkpoint }`
 *   models  -> ST /models returns [{value,text}] -> [{title, model_name}]
 *   names   -> ST /samplers,/schedulers return [string] -> [{name}]
 *   raw     -> ST /generate forwards the txt2img JSON unchanged
 * @param {'options'|'models'|'names'|'raw'} shape
 * @param {string} text raw relay body
 * @returns {string|null}
 */
export function reshapeRelayBody(shape, text) {
    if (shape === 'raw') {
        try { JSON.parse(text); } catch { return null; }
        return text;
    }
    if (shape === 'options') {
        let title = String(text ?? '');
        try {
            const parsed = JSON.parse(text);
            if (typeof parsed === 'string') title = parsed;
            else if (parsed && typeof parsed === 'object' && typeof parsed.sd_model_checkpoint === 'string') title = parsed.sd_model_checkpoint;
            else title = '';
        } catch { /* plain text title */ }
        return JSON.stringify({ sd_model_checkpoint: title.trim() });
    }
    let data;
    try { data = JSON.parse(text); } catch { return null; }
    if (!Array.isArray(data)) return null;
    if (shape === 'models') {
        return JSON.stringify(data
            .map(entry => {
                if (typeof entry === 'string') return { title: entry, model_name: entry };
                const title = entry && typeof entry.value === 'string' && entry.value
                    ? entry.value
                    : (entry && typeof entry.title === 'string' ? entry.title : '');
                return title ? { title, model_name: title } : null;
            })
            .filter(Boolean));
    }
    if (shape === 'names') {
        return JSON.stringify(data
            .map(entry => (typeof entry === 'string' ? entry : (entry && typeof entry.name === 'string' ? entry.name : null)))
            .filter(Boolean)
            .map(name => ({ name })));
    }
    return null;
}

/**
 * ST-relay route table: our /sdapi/v1 path -> SillyTavern's own server-side
 * proxy endpoint (src/endpoints/stable-diffusion.js, mounted at /api/sd).
 * Every relay endpoint is a POST whose JSON body carries { url, auth } plus,
 * for generate, the txt2img payload; the ST server adds the Basic header and
 * talks to the backend itself, so the browser never hits CORS.
 * `shape` re-wraps the relay's trimmed responses into the /sdapi/v1 shapes
 * the rest of this client already understands.
 */
export const ST_RELAY_ROUTES = {
    '/sdapi/v1/options': { endpoint: '/api/sd/get-model', shape: 'options' },
    '/sdapi/v1/sd-models': { endpoint: '/api/sd/models', shape: 'models' },
    '/sdapi/v1/samplers': { endpoint: '/api/sd/samplers', shape: 'names' },
    '/sdapi/v1/schedulers': { endpoint: '/api/sd/schedulers', shape: 'names' },
    '/sdapi/v1/txt2img': { endpoint: '/api/sd/generate', shape: 'raw' },
};

/** Transport identifiers accepted by A1111Client. */
export const A1111_TRANSPORTS = ['st-relay', 'direct'];

export class A1111Client {
    /**
     * @param {{getBaseUrl: () => string, getAuth: () => string,
     *          getTransport?: () => string,
     *          getRequestHeaders?: () => object,
     *          fetchImpl?: typeof fetch, timeoutMs?: number}} cfg
     * fetchImpl is injectable for offline tests. timeoutMs (when set)
     * overrides the per-kind defaults for every request.
     * getTransport returns 'direct' (browser -> backend, needs CORS on the
     * backend) or 'st-relay' (browser -> SillyTavern server -> backend, the
     * same path ST's own Image Generation extension uses). Default: direct
     * when the getter is absent, so existing single-purpose callers/tests
     * keep their behavior. getRequestHeaders supplies ST's CSRF headers for
     * the relay (getContext().getRequestHeaders).
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

    /** Effective transport: 'st-relay' or 'direct'. Unknown values -> direct. */
    transport() {
        let value = '';
        try { value = String(this.cfg.getTransport?.() ?? ''); } catch { value = ''; }
        return value === 'st-relay' ? 'st-relay' : 'direct';
    }

    /**
     * Core request runner: URL validation, exact ST Basic auth header,
     * redirect:'error' (credentials must never travel across redirects),
     * timeout vs user-abort distinction, safe errors without credential
     * leakage. Exactly one fetch per call — no retries.
     */
    async _request(path, { method = 'GET', body, signal, timeoutMs, summarizeDetail = false } = {}) {
        const base = normalizeBaseUrl(this.cfg.getBaseUrl());
        if (!base.ok) {
            throw new A1111Error('A1111_CONFIG', `Invalid AUTOMATIC1111 base URL: ${base.error}.`);
        }
        if (this.transport() === 'st-relay') {
            return this._relayRequest(path, base.url, { body, signal, timeoutMs });
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
            let text = '';
            try { text = await response.text(); } catch { /* detail stays empty */ }
            // Generation failures (R0): distill ComfyUI-style workflow
            // validation bodies (node_errors / value_not_in_list) into one
            // legible "missing files" line for the in-chat chip. The raw
            // body is redacted BEFORE summarization and never reaches the
            // error object; other bodies keep the existing bounded detail.
            const detail = summarizeDetail && /node_errors|value_not_in_list/.test(text)
                ? summarizeValidationError(redact(text, auth))
                : extractDetail(text, auth);
            throw new A1111Error('A1111_HTTP', `HTTP ${response.status} from ${path}${detail ? `: ${detail}` : '.'}`);
        }
        return response;
    }

    /**
     * ST-relay transport. Posts { url, auth, ...payload } to SillyTavern's
     * /api/sd/* endpoint for `path`; the ST server performs the backend call
     * (server-side, so no CORS) and returns a trimmed body which is re-shaped
     * here into a Response-like object whose text() yields the /sdapi/v1
     * shape the normal parsers expect.
     *
     * Rules specific to this path:
     * - The backend URL must be the FINAL https/http origin: Node drops the
     *   Authorization header on a cross-origin redirect, so an http:// URL
     *   that 301s to https fails with a bare relay 500.
     * - txt2img is NEVER aborted mid-flight. ST's /api/sd/generate reacts to
     *   a closed browser socket by POSTing /sdapi/v1/interrupt on the
     *   backend, which on a shared host can kill another user's job. The
     *   caller's signal is honored only BEFORE the request is sent; an abort
     *   that arrives while it is in flight is surfaced as A1111_ABORTED
     *   after the relay settles, and the result is discarded.
     * - The relay collapses every failure into HTTP 500 with no detail. The
     *   error text points at the ST server console, where the real backend
     *   response is logged.
     */
    async _relayRequest(path, backendUrl, { body, signal, timeoutMs } = {}) {
        const route = ST_RELAY_ROUTES[path];
        if (!route) {
            throw new A1111Error('A1111_CONFIG', `${path} is not available through the SillyTavern relay. Switch the connection to "Direct" for this call.`);
        }
        const auth = String(this.cfg.getAuth() ?? '');
        let headers = {};
        try {
            const supplied = this.cfg.getRequestHeaders?.();
            if (supplied && typeof supplied === 'object') headers = { ...supplied };
        } catch { headers = {}; }
        headers['Content-Type'] = 'application/json';
        const isGenerate = path === '/sdapi/v1/txt2img';

        if (signal?.aborted) {
            throw new A1111Error('A1111_ABORTED', `Request to ${path} was cancelled before it started.`);
        }
        const controller = new AbortController();
        let timedOut = false;
        let userCancelled = false;
        const onExternalAbort = () => {
            userCancelled = true;
            // Discovery calls are cheap and side-effect free: abort them.
            // Generation must run to completion (see the interrupt note).
            if (!isGenerate) controller.abort();
        };
        if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });
        const timeout = timeoutMs ?? this.timeoutMs ?? (isGenerate ? GENERATION_TIMEOUT_MS : DISCOVERY_TIMEOUT_MS);
        // A timeout on generate would also close the socket -> interrupt.
        // Discovery keeps its timeout; generation waits for the relay.
        const timer = isGenerate ? null : setTimeout(() => { timedOut = true; controller.abort(); }, timeout);

        let response;
        try {
            response = await this.fetchImpl(route.endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({ url: backendUrl, auth, ...(body && typeof body === 'object' ? body : {}) }),
                signal: controller.signal,
            });
        } catch (error) {
            if (timedOut) {
                throw new A1111Error('A1111_TIMEOUT', `Relay request for ${path} timed out after ${timeout} ms.`);
            }
            if (userCancelled || error?.name === 'AbortError') {
                throw new A1111Error('A1111_ABORTED', `Request to ${path} was cancelled.`);
            }
            throw new A1111Error('A1111_NETWORK', `Could not reach the SillyTavern server relay (${route.endpoint}): ${error?.message ?? error}.`);
        } finally {
            if (timer) clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onExternalAbort);
        }
        if (userCancelled) {
            // Generation finished on the server after the caller gave up:
            // report the cancellation and drop the (already produced) image.
            throw new A1111Error('A1111_ABORTED', `Request to ${path} was cancelled; the server job ran to completion and its result was discarded.`);
        }
        if (response.status === 401 || response.status === 403) {
            throw new A1111Error('A1111_AUTH', `SillyTavern rejected the relay request (HTTP ${response.status}). Reload the page to refresh the session, then try again.`);
        }
        if (!response.ok) {
            const hint = /^http:\/\//i.test(backendUrl)
                ? ' The API base URL uses http:// — if the service redirects to https, the relay drops the credentials; enter the https:// URL directly.'
                : '';
            if (isGenerate) {
                // The relay hides the backend's answer, so tell apart "cannot
                // reach / wrong key" from "reachable but the job was refused"
                // with one cheap model-list probe over the same relay.
                const reachable = await this._relayProbe(backendUrl, auth, headers);
                const reason = reachable === true
                    ? 'The connection and key work (a model-list probe succeeded), so the backend refused this generation job. On a ComfyUI-backed proxy this usually means the workflow behind the selected checkpoint references a checkpoint or LoRA file that is missing on the server — only the server owner can fix that; try another checkpoint meanwhile.'
                    : reachable === false
                        ? 'A model-list probe over the same relay also failed — check the API base URL and the key (Settings → Test Connection).'
                        : 'The backend answer is logged in the SillyTavern server console.';
                throw new A1111Error('A1111_HTTP', `The SillyTavern relay returned HTTP ${response.status} for ${path}. ${reason}${hint}`);
            }
            throw new A1111Error('A1111_HTTP', `The SillyTavern relay returned HTTP ${response.status} for ${path}. The backend answer (wrong URL, rejected key, or a generation failure) is logged in the SillyTavern server console.${hint}`);
        }
        let text = '';
        try { text = await response.text(); } catch (error) {
            throw new A1111Error('A1111_MALFORMED', `${path} (relay) returned an unreadable body (${error?.message ?? error}).`);
        }
        const reshaped = reshapeRelayBody(route.shape, text);
        if (reshaped === null) {
            throw new A1111Error('A1111_MALFORMED', `${path} (relay) did not return the expected JSON (first 120 chars: "${text.slice(0, 120)}").`);
        }
        return { ok: true, status: response.status, headers: { get: () => 'application/json' }, text: async () => reshaped };
    }

    /**
     * Diagnostic model-list probe over the relay after a failed generate.
     * @returns {Promise<boolean | null>} true = backend reachable with this
     *   URL/key, false = probe rejected too, null = probe itself could not run.
     */
    async _relayProbe(backendUrl, auth, headers) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(DISCOVERY_TIMEOUT_MS, 15000));
        try {
            const probe = await this.fetchImpl(ST_RELAY_ROUTES['/sdapi/v1/sd-models'].endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({ url: backendUrl, auth }),
                signal: controller.signal,
            });
            return Boolean(probe.ok);
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    /** Bounded, JSON-preferring, credential-redacted error detail. */
    async _safeDetail(response, secret) {
        let text = '';
        try {
            text = await response.text();
        } catch {
            return '';
        }
        return extractDetail(text, secret);
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

    /** GET /sdapi/v1/schedulers — raw array. Optional endpoint (Forge/new
     *  A1111 only); callers must tolerate a 404. */
    async schedulers({ signal } = {}) {
        const response = await this._request('/sdapi/v1/schedulers', { signal });
        const data = await this._json(response, '/sdapi/v1/schedulers');
        if (!Array.isArray(data)) {
            throw new A1111Error('A1111_MALFORMED', '/sdapi/v1/schedulers did not return a JSON array.');
        }
        return data;
    }

    /**
     * GET /internal/models — comfy-cloud-forge enrichment endpoint:
     * [{ id, title, family: 'krea2'|'anima'|'illustrious', checkpointFile,
     *    defaults: { steps, cfg, sampler, scheduler, width, height } }].
     * Strictly optional: plain A1111 hosts do not have it; callers must
     * tolerate ANY failure (401/404/network) and proceed without it.
     */
    async internalModels({ signal } = {}) {
        const response = await this._request('/internal/models', { signal });
        const data = await this._json(response, '/internal/models');
        if (!Array.isArray(data)) {
            throw new A1111Error('A1111_MALFORMED', '/internal/models did not return a JSON array.');
        }
        return data;
    }

    /**
     * Full discovery pass (R1): models + samplers + schedulers +
     * /internal/models enrichment in parallel. Models are required — a
     * models() failure rejects. Samplers/schedulers failures yield empty
     * lists; /internal/models failures are ignored entirely.
     *
     * Enrichment matching: exact title first, then checkpointFile ==
     * model_name or filename. Matched entries gain `family` and mapped
     * `defaults` ({width,height,steps,cfg,sampler,scheduler}).
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{models: Array<{title: string, modelName: string,
     *   family?: string, defaults?: object}>, samplers: string[],
     *   schedulers: string[], enrichment: 'internal'|'none'}>}
     */
    async discover({ signal } = {}) {
        const [modelsRes, samplersRes, schedulersRes, internalRes] = await Promise.allSettled([
            this.models({ signal }),
            this.samplers({ signal }),
            this.schedulers({ signal }),
            this.internalModels({ signal }),
        ]);
        if (modelsRes.status === 'rejected') throw modelsRes.reason;

        const asName = entry => {
            if (typeof entry === 'string') return entry;
            if (entry && typeof entry.name === 'string') return entry.name;
            return null;
        };
        const samplers = samplersRes.status === 'fulfilled'
            ? samplersRes.value.map(asName).filter(Boolean)
            : [];
        const schedulers = schedulersRes.status === 'fulfilled'
            ? schedulersRes.value.map(s => asName(s) ?? (s && typeof s.label === 'string' ? s.label : null)).filter(Boolean)
            : [];

        const internal = internalRes.status === 'fulfilled' ? internalRes.value : null;
        const byTitle = new Map();
        const byFile = new Map();
        if (internal) {
            for (const entry of internal) {
                if (!entry || typeof entry !== 'object') continue;
                if (typeof entry.title === 'string' && entry.title) byTitle.set(entry.title, entry);
                if (typeof entry.checkpointFile === 'string' && entry.checkpointFile) byFile.set(entry.checkpointFile, entry);
            }
        }
        const mapDefaults = d => {
            if (!d || typeof d !== 'object') return undefined;
            const out = {};
            if (Number.isFinite(Number(d.width))) out.width = Number(d.width);
            if (Number.isFinite(Number(d.height))) out.height = Number(d.height);
            if (Number.isFinite(Number(d.steps))) out.steps = Number(d.steps);
            if (Number.isFinite(Number(d.cfg))) out.cfg = Number(d.cfg);
            if (typeof d.sampler === 'string' && d.sampler) out.sampler = d.sampler;
            if (typeof d.scheduler === 'string' && d.scheduler) out.scheduler = d.scheduler;
            return Object.keys(out).length ? out : undefined;
        };
        const models = modelsRes.value.map(m => {
            const match = byTitle.get(m.title)
                ?? byFile.get(m.model_name)
                ?? (m.filename ? byFile.get(m.filename) : undefined);
            const out = { title: m.title, modelName: m.model_name };
            if (match) {
                if (typeof match.family === 'string' && match.family) out.family = match.family;
                const defaults = mapDefaults(match.defaults);
                if (defaults) out.defaults = defaults;
            }
            return out;
        });
        return { models, samplers, schedulers, enrichment: internal ? 'internal' : 'none' };
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

        const response = await this._request('/sdapi/v1/txt2img', { method: 'POST', body: payload, signal, summarizeDetail: true });
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
