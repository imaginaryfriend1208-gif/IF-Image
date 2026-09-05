// IF Image - ComfyUI Cloud proxy backend.
// Talks to the user's own "comfy-cloud-forge-proxy" (SillytavernproxyComfyuicloud).
// Proxy schema verified from its src/server.ts:
//   GET  /internal/ping    -> { ok, service } (no auth)
//   GET  /internal/status  -> { cloudConfigured, activeJobs, settings, characterCount } (auth)
//   POST /sdapi/v1/txt2img -> zod schema: prompt, negative_prompt, model (optional),
//        seed (-1 = random), width, height, steps, cfg_scale, sampler_name,
//        scheduler, send_images, override_settings (record).
//        Response: { images: [base64...], parameters, info (JSON string) }
// Error shape from setErrorHandler: { error, detail, body, errors }

function trimSlash(url) {
    return String(url || '').replace(/\/+$/, '');
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
     * @param {{getBaseUrl: () => string, getUsername: () => string, getPassword: () => string}} cfg
     */
    constructor(cfg) {
        this.cfg = cfg;
    }

    baseUrl() {
        return trimSlash(this.cfg.getBaseUrl());
    }

    headers(json = true) {
        const headers = {};
        if (json) headers['Content-Type'] = 'application/json';
        const user = this.cfg.getUsername();
        const pass = this.cfg.getPassword();
        if (user || pass) {
            headers['Authorization'] = 'Basic ' + btoa(`${user}:${pass}`);
        }
        return headers;
    }

    async _fetchTextOnError(response) {
        try {
            return await response.text();
        } catch {
            return '';
        }
    }

    /**
     * Liveness check. /internal/ping is exempt from auth in the proxy.
     * @param {{signal?: AbortSignal}} [options] aborts the browser request only
     */
    async ping({ signal } = {}) {
        let response;
        try {
            response = await fetch(`${this.baseUrl()}/internal/ping`, { headers: this.headers(), signal });
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error('Connection test cancelled.');
            throw new Error(`Cannot reach the proxy at ${this.baseUrl()}. Is it running? Start it with "npm start" (or start.bat) in the SillytavernproxyComfyuicloud folder. (${error.message})`);
        }
        if (!response.ok) {
            throw new Error(`Proxy ping failed (${response.status}): ${await this._fetchTextOnError(response)}`);
        }
        return response.json();
    }

    /**
     * Full status: cloud key configured, active jobs, model profiles, character count.
     * Requires valid credentials.
     * @param {{signal?: AbortSignal}} [options] aborts the browser request only
     */
    async status({ signal } = {}) {
        let response;
        try {
            response = await fetch(`${this.baseUrl()}/internal/status`, { headers: this.headers(), signal });
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error('Status request cancelled.');
            throw new Error(`Cannot reach the proxy at ${this.baseUrl()}. (${error.message})`);
        }
        if (response.status === 401) {
            throw new Error('Proxy rejected the credentials (401). Set PROXY_USERNAME / PROXY_PASSWORD in the proxy .env and enter the same username/password here.');
        }
        if (!response.ok) {
            throw new Error(`Proxy status failed (${response.status}): ${await this._fetchTextOnError(response)}`);
        }
        return response.json();
    }

    /**
     * List enabled model profiles from the proxy (sd-models endpoint).
     * Each entry: { title, model_name, filename }. `title` is accepted as the
     * txt2img `model` field (proxy matches id / title / checkpoint file name).
     * @param {{signal?: AbortSignal}} [options] aborts the browser request only
     */
    async models({ signal } = {}) {
        let response;
        try {
            response = await fetch(`${this.baseUrl()}/sdapi/v1/sd-models`, { headers: this.headers(), signal });
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw new Error('Model list request cancelled. Only the browser request was aborted; the proxy was not told to stop anything.');
            }
            throw new Error(`Cannot reach the proxy at ${this.baseUrl()}. (${error.message})`);
        }
        if (response.status === 401) {
            throw new Error('Proxy rejected the credentials (401).');
        }
        if (!response.ok) {
            throw new Error(`Proxy sd-models failed (${response.status}).`);
        }
        return response.json();
    }

    /**
     * SD-style text-to-image through the proxy.
     * `model` must be a proxy model id / title / checkpoint file name (from models()).
     * Family names (krea2/anima/illustrious) are NOT matched by the proxy.
     * @param {{prompt: string, negative_prompt: string, model?: string, seed?: number,
     *          width?: number, height?: number, steps?: number, cfg_scale?: number}} body
     * @param {{signal?: AbortSignal}} [options] aborts the browser request only —
     *        the cloud job may still run on the proxy; nothing is interrupted server-side
     * @returns {Promise<{image: Blob, dataUrl: string, raw: object, info: object}>}
     */
    async txt2img(body, { signal } = {}) {
        // Coerce to the proxy's zod bounds: ints for seed/width/height/steps,
        // 64..4096 px, 1..200 steps, 0..100 cfg. Avoids opaque 400/500 on
        // fractional values typed into the UI number inputs.
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

        let response;
        try {
            response = await fetch(`${this.baseUrl()}/sdapi/v1/txt2img`, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify(payload),
                signal,
            });
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw new Error('Generation cancelled. Only the browser request was aborted; the proxy job (if it already started) may still be running on the cloud.');
            }
            throw new Error(`Cannot reach the proxy at ${this.baseUrl()}. Is it running? (${error.message})`);
        }

        const text = await this._fetchTextOnError(response);
        if (!response.ok) {
            let detail = text;
            try {
                const parsed = JSON.parse(text);
                detail = parsed.detail || parsed.error || text;
            } catch { /* keep raw text */ }
            if (response.status === 401) {
                throw new Error(`Proxy rejected the credentials (401). ${detail}`);
            }
            throw new Error(`Proxy txt2img failed (${response.status}): ${String(detail).slice(0, 500)}`);
        }

        const data = JSON.parse(text);
        if (!Array.isArray(data.images) || data.images.length === 0 || !data.images[0]) {
            throw new Error('Proxy returned no image data (send_images is false or cloud job produced no output).');
        }
        let info = {};
        try { info = JSON.parse(data.info); } catch { /* info is optional */ }
        const blob = base64ToBlob(data.images[0], 'image/png');
        return { image: blob, dataUrl: URL.createObjectURL(blob), raw: data, info };
    }
}
