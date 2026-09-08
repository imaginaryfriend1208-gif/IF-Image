// IF Image - Generation executor: bridges task queue to backend clients.
// Contract: execute(taskSnapshot, signal) where taskSnapshot is the defensive
// copy from createTaskQueue (src/runtime/tasks.js). Returns
// { blob, seed, width, height, backend, profileKey, elapsedMs }.
//
// The taskSnapshot.prompt field carries a compiled envelope:
//   { prompt: string, negative: string,
//     params: { width, height, steps, cfg, seed,
//               checkpoint?, sampler?, scheduler? },  // R2: a1111 only
//     characters?: string[] }  // C8 per-character strings; NAI-only
// params.checkpoint is the checkpoint TITLE captured at compile time so a
// task/regeneration reuses the same model even if settings change later; it
// is still validated against fresh discovery here before every generation.
// The taskSnapshot.backend field is { kind: 'comfy' | 'a1111' | 'nai' }.
// The taskSnapshot.profile field is a profile key string (e.g. 'anima').
//
// Cancellation is cooperative: aborting the signal cancels the browser request
// only. A generation already accepted by NovelAI, the proxy, or an A1111
// server is not refundable or interruptible.

import { resolveCheckpoint } from '../backends/a1111.js';

/** Pre-computed random seed for NAI when task specifies -1. */
function randomSeed() {
    return Math.floor(Math.random() * 9999999999);
}

/**
 * @param {{
 *   nai: import('../backends/nai.js').NaiClient,
 *   comfy: import('../backends/comfy.js').ComfyProxyClient,
 *   a1111: import('../backends/a1111.js').A1111Client,
 *   getSettings: () => object,
 * }} deps
 * @returns {(task: object, signal: AbortSignal) => Promise<object>}
 */
export function createExecutor({ nai, comfy, a1111, getSettings }) {
    if (!nai || !comfy || !a1111) {
        throw new TypeError('createExecutor: nai, comfy, and a1111 clients are required.');
    }

    /**
     * @param {object} task - defensive snapshot from createTaskQueue
     * @param {AbortSignal} signal
     */
    async function execute(task, signal) {
        const envelope = task.prompt ?? {};
        const prompt = typeof envelope.prompt === 'string' ? envelope.prompt : '';
        const negative = typeof envelope.negative === 'string' ? envelope.negative : '';
        const params = envelope.params && typeof envelope.params === 'object' ? envelope.params : {};
        const seed = Number.isFinite(Number(params.seed)) ? Math.trunc(Number(params.seed)) : -1;
        const width = Math.trunc(Number(params.width) || 832);
        const height = Math.trunc(Number(params.height) || 1216);
        const steps = Math.trunc(Number(params.steps) || 16);
        const cfg = Number.isFinite(Number(params.cfg)) ? Number(params.cfg) : 4;
        // C8: per-character rendered strings from the compiled envelope.
        // Only NAI consumes them (characterPrompts/char_captions); the SD
        // clients receive the already-grouped prompt string instead.
        const characters = Array.isArray(envelope.characters)
            ? envelope.characters.filter(c => typeof c === 'string' && c)
            : [];

        const backendInfo = task.backend && typeof task.backend === 'object' ? task.backend : {};
        const kind = typeof backendInfo.kind === 'string' ? backendInfo.kind : 'comfy';
        const profileKey = typeof task.profile === 'string' ? task.profile : '';
        const startedAt = performance.now();
        const settings = getSettings();

        let result;

        if (kind === 'nai') {
            // NAI: precompute seed if -1 so it is recordable in the image record.
            const resolvedSeed = seed < 0 ? randomSeed() : seed;
            const blob = await nai.generate({
                model: settings.backends.nai.model,
                prompt,
                negative,
                width,
                height,
                steps,
                scale: cfg,
                seed: resolvedSeed,
                characters,
                signal,
            });
            result = { blob, seed: resolvedSeed, width, height, backend: 'nai', profileKey, elapsedMs: performance.now() - startedAt };
        } else if (kind === 'comfy') {
            const model = settings.backends.comfy.proxyModel;
            if (!model) {
                throw Object.assign(
                    new Error('No proxy model selected. Open Backends, click Refresh Models, and select a checkpoint under the Comfy Cloud Proxy section.'),
                    { code: 'COMFY_CONFIG' },
                );
            }
            const { image: blob, info } = await comfy.txt2img({
                prompt,
                negative_prompt: negative,
                model,
                seed,
                width,
                height,
                steps,
                cfg_scale: cfg,
            }, { signal });
            const resolvedSeed = typeof info?.seed === 'number' ? info.seed : seed;
            result = { blob, seed: resolvedSeed, width, height, backend: 'comfy', profileKey, elapsedMs: performance.now() - startedAt };
        } else if (kind === 'a1111') {
            // R2: the envelope's checkpoint (captured at compile/record time)
            // wins; fall back to the current settings selection. Still
            // resolved against fresh per-task discovery — never inferred
            // from dialect/profile names.
            const requested = (typeof params.checkpoint === 'string' && params.checkpoint)
                || settings.generation?.checkpoint
                || settings.backends.a1111.checkpoint
                || '';
            const models = await a1111.models({ signal });
            const checkpoint = resolveCheckpoint(models, requested);
            if (!checkpoint) {
                const message = requested
                    ? `Checkpoint "${requested}" is no longer offered by the server. Open Backends → Test connection and pick another.`
                    : 'No checkpoint selected for AUTOMATIC1111. Open Backends, click Refresh Models, and select a checkpoint.';
                throw Object.assign(new Error(message), { code: 'EXECUTOR_CONFIG' });
            }
            const body = {
                prompt,
                negative_prompt: negative,
                checkpoint,
                seed,
                width,
                height,
                steps,
                cfg_scale: cfg,
            };
            if (typeof params.sampler === 'string' && params.sampler) body.sampler_name = params.sampler;
            if (typeof params.scheduler === 'string' && params.scheduler) body.scheduler = params.scheduler;
            const { image: blob, info } = await a1111.txt2img(body, { signal });
            const resolvedSeed = typeof info?.seed === 'number' ? info.seed : seed;
            result = { blob, seed: resolvedSeed, width, height, backend: 'a1111', profileKey, checkpoint, elapsedMs: performance.now() - startedAt };
        } else {
            throw Object.assign(new Error(`Unknown backend kind "${kind}". Expected 'comfy', 'nai', or 'a1111'.`), { code: 'EXECUTOR_CONFIG' });
        }

        return result;
    }

    return execute;
}
