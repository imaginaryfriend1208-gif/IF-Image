// IF Image - connection-first image backend facade.
// The public backend names are "comfy" (A1111-compatible API) and "nai".

import { A1111Client, resolveCheckpoint } from './a1111.js';
import { NaiClient, NAI_MODELS } from './nai.js';

/** Create the canonical image backend facade. */
export function createImageBackend(getConnection, {
    fetchImpl = globalThis.fetch?.bind(globalThis),
    getRequestHeaders = () => ({}),
} = {}) {
    if (typeof getConnection !== 'function') {
        throw new TypeError('createImageBackend: getConnection must be a function.');
    }

    const connection = () => {
        const value = getConnection();
        return value && typeof value === 'object' ? value : {};
    };
    const comfyConfig = () => connection().comfy ?? {};
    const naiConfig = () => connection().nai ?? {};

    const comfy = new A1111Client({
        getBaseUrl: () => comfyConfig().url ?? '',
        getAuth: () => comfyConfig().auth ?? '',
        getTransport: () => comfyConfig().transport ?? 'st-relay',
        getRequestHeaders,
        fetchImpl,
    });
    const nai = new NaiClient(
        () => naiConfig().apiKey ?? '',
        () => naiConfig(),
        fetchImpl,
    );

    function kind(requested) {
        const value = requested ?? connection().imageBackend;
        // Legacy records used "a1111" for what V2 exposes as "comfy".
        return value === 'nai' ? 'nai' : 'comfy';
    }

    function getClient(requested) {
        return kind(requested) === 'nai' ? nai : comfy;
    }

    async function verifyKey({ signal } = {}) {
        if (kind() !== 'nai') return false;
        try {
            await nai.verifyKey({ signal });
            return true;
        } catch {
            return false;
        }
    }

    async function fetchModels({ signal } = {}) {
        const selected = kind();
        const now = Date.now();
        if (selected === 'nai') {
            const verified = await verifyKey({ signal });
            const models = NAI_MODELS.map(model => model.value);
            const target = naiConfig();
            target.modelList = models;
            target.lastFetchedAt = now;
            return { backend: 'nai', models, verified };
        }

        const discovery = await comfy.discover({ signal });
        const models = discovery.models.map(model => model.title);
        const target = comfyConfig();
        target.modelList = models;
        target.lastFetchedAt = now;
        return { backend: 'comfy', models, discovery };
    }

    async function generate({ backend, prompt = '', negative = '', params = {}, characters = [] } = {}, { signal } = {}) {
        const selected = kind(backend);
        if (selected === 'nai') {
            const model = typeof params.model === 'string' && params.model
                ? params.model : naiConfig().model;
            const seed = Number.isFinite(Number(params.seed)) && Number(params.seed) >= 0
                ? Math.trunc(Number(params.seed))
                : Math.floor(Math.random() * 9999999999);
            const blob = await nai.generate({
                model,
                prompt,
                negative,
                width: params.width,
                height: params.height,
                steps: params.steps,
                scale: params.cfg,
                seed,
                sampler: params.sampler,
                scheduler: params.scheduler,
                characters,
                signal,
            });
            return { blob, seed, backend: 'nai', model };
        }

        const requested = typeof params.checkpoint === 'string' && params.checkpoint
            ? params.checkpoint : comfyConfig().model;
        const models = await comfy.models({ signal });
        const checkpoint = resolveCheckpoint(models, requested);
        if (!checkpoint) {
            const message = requested
                ? `Model "${requested}" is no longer offered by the server. Open Connection and fetch models again.`
                : 'No image model selected. Open Connection, fetch models, and choose the default model.';
            throw Object.assign(new Error(message), { code: 'EXECUTOR_CONFIG' });
        }
        const body = {
            prompt,
            negative_prompt: negative,
            checkpoint,
            seed: params.seed,
            width: params.width,
            height: params.height,
            steps: params.steps,
            cfg_scale: params.cfg,
        };
        if (typeof params.sampler === 'string' && params.sampler) body.sampler_name = params.sampler;
        if (typeof params.scheduler === 'string' && params.scheduler) body.scheduler = params.scheduler;
        const { image: blob, info } = await comfy.txt2img(body, { signal });
        return {
            blob,
            seed: typeof info?.seed === 'number' ? info.seed : params.seed,
            backend: 'comfy',
            model: checkpoint,
            checkpoint,
        };
    }

    return { kind, getClient, fetchModels, verifyKey, generate };
}
