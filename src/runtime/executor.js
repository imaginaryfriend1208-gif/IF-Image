// IF Image - generation executor for the connection-first backend facade.
// Contract: execute(taskSnapshot, signal).

/**
 * @param {{
 *   imageBackend: ReturnType<import('../backends/image-backend.js').createImageBackend>,
 *   getSettings: () => object,
 * }} deps
 * @returns {(task: object, signal: AbortSignal) => Promise<object>}
 */
export function createExecutor({ imageBackend, getSettings }) {
    if (!imageBackend || typeof imageBackend.generate !== 'function' || typeof getSettings !== 'function') {
        throw new TypeError('createExecutor: imageBackend and getSettings are required.');
    }

    return async function execute(task, signal) {
        const envelope = task?.prompt ?? {};
        const sourceParams = envelope.params && typeof envelope.params === 'object' ? envelope.params : {};
        const settings = getSettings() ?? {};
        const connection = settings.connection ?? {};
        const configuredKind = connection.imageBackend === 'nai' ? 'nai' : 'comfy';
        const requestedKind = task?.backend?.kind;
        const backend = requestedKind === 'nai' ? 'nai'
            : requestedKind === 'comfy' || requestedKind === 'a1111' ? 'comfy'
                : configuredKind;
        if (requestedKind && !['comfy', 'a1111', 'nai'].includes(requestedKind)) {
            throw Object.assign(new Error(`Unknown backend kind "${requestedKind}". Expected 'comfy' or 'nai'.`), { code: 'EXECUTOR_CONFIG' });
        }

        const params = {
            width: Math.trunc(Number(sourceParams.width) || 832),
            height: Math.trunc(Number(sourceParams.height) || 1216),
            steps: Math.trunc(Number(sourceParams.steps) || 16),
            cfg: Number.isFinite(Number(sourceParams.cfg)) ? Number(sourceParams.cfg) : 4,
            seed: Number.isFinite(Number(sourceParams.seed)) ? Math.trunc(Number(sourceParams.seed)) : -1,
        };
        if (typeof sourceParams.sampler === 'string' && sourceParams.sampler) params.sampler = sourceParams.sampler;
        if (typeof sourceParams.scheduler === 'string' && sourceParams.scheduler) params.scheduler = sourceParams.scheduler;
        if (backend === 'comfy') {
            params.checkpoint = typeof sourceParams.checkpoint === 'string' && sourceParams.checkpoint
                ? sourceParams.checkpoint : connection.comfy?.model ?? '';
        } else {
            params.model = typeof sourceParams.model === 'string' && sourceParams.model
                ? sourceParams.model : connection.nai?.model ?? 'nai-diffusion-4-5-full';
            // Fix the random seed before dispatch so the saved record can
            // reproduce the exact request even when the backend generates it.
            if (params.seed < 0) params.seed = Math.floor(Math.random() * 9999999999);
        }

        const startedAt = performance.now();
        const result = await imageBackend.generate({
            backend,
            prompt: typeof envelope.prompt === 'string' ? envelope.prompt : '',
            negative: typeof envelope.negative === 'string' ? envelope.negative : '',
            params,
            characters: Array.isArray(envelope.characters)
                ? envelope.characters.filter(value => typeof value === 'string' && value)
                : [],
        }, { signal });

        return {
            blob: result.blob,
            seed: result.seed,
            width: params.width,
            height: params.height,
            backend,
            profileKey: typeof task?.profile === 'string' ? task.profile : '',
            ...(backend === 'comfy' ? { checkpoint: result.checkpoint ?? result.model ?? params.checkpoint } : {}),
            elapsedMs: performance.now() - startedAt,
        };
    };
}
