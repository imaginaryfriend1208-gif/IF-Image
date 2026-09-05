// IF Image - NovelAI backend (browser-direct, no proxy).
// CORS verified: image.novelai.net and api.novelai.net both allow browser origins.
// Request body mirrors SillyTavern src/endpoints/novelai.js (generate-image route).

const API_NOVELAI = 'https://api.novelai.net';
const IMAGE_NOVELAI = 'https://image.novelai.net';

// Variety+ sigma constants (mirrors ST novelai.js)
const REFERENCE_PIXEL_COUNT = 832 * 1216;
const SIGMA_MAGIC_NUMBER = 19;
const SIGMA_MAGIC_NUMBER_V4_5 = 58;

export const NAI_MODELS = [
    { value: 'nai-diffusion-4-5-full', text: 'NAI Diffusion Anime V4.5 (Full)' },
    { value: 'nai-diffusion-4-5-curated', text: 'NAI Diffusion Anime V4.5 (Curated)' },
    { value: 'nai-diffusion-4-full', text: 'NAI Diffusion Anime V4 (Full)' },
];

// Tier mapping mirrors ST public/scripts/nai-settings.js
const NAI_TIERS = { 0: 'Paper', 1: 'Tablet', 2: 'Scroll', 3: 'Opus' };

function calculateSkipCfgAboveSigma(width, height, model) {
    const magic = model?.includes('nai-diffusion-4-5') ? SIGMA_MAGIC_NUMBER_V4_5 : SIGMA_MAGIC_NUMBER;
    return Math.sqrt((width * height) / REFERENCE_PIXEL_COUNT) * magic;
}

/**
 * Extract the first .png entry from a NovelAI response ZIP (ArrayBuffer),
 * fully in the browser with no external library.
 * Supports stored (method 0) and deflate (method 8) entries.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Blob>} PNG blob
 */
export async function pngFromNaiZip(buffer) {
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);

    // 1. Find End of Central Directory record (scan backwards, last 64KB is plenty).
    const scanStart = Math.max(0, u8.length - 65536 - 22);
    let eocd = -1;
    for (let i = u8.length - 22; i >= scanStart; i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Response is not a ZIP archive.');

    // 2. Walk central directory entries, take the first .png one.
    const entries = view.getUint16(eocd + 10, true); // total entries this disk
    let cdOffset = view.getUint32(eocd + 16, true);
    let found = null;
    for (let i = 0; i < entries; i++) {
        if (view.getUint32(cdOffset, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
        const nameLen = view.getUint16(cdOffset + 28, true);
        const extraLen = view.getUint16(cdOffset + 30, true);
        const commentLen = view.getUint16(cdOffset + 32, true);
        const localOff = view.getUint32(cdOffset + 42, true);
        const name = new TextDecoder().decode(u8.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
        if (name.toLowerCase().endsWith('.png')) {
            const method = view.getUint16(cdOffset + 10, true);
            const compSize = view.getUint32(cdOffset + 20, true);
            found = { name, method, compSize, localOff };
            break;
        }
        cdOffset += 46 + nameLen + extraLen + commentLen;
    }
    if (!found) throw new Error('No PNG file found inside the ZIP.');

    // 3. Local file header: skip name + extra using the LOCAL header's own lengths.
    if (view.getUint32(found.localOff, true) !== 0x04034b50) throw new Error('Corrupt ZIP local header.');
    const lhNameLen = view.getUint16(found.localOff + 26, true);
    const lhExtraLen = view.getUint16(found.localOff + 28, true);
    const dataStart = found.localOff + 30 + lhNameLen + lhExtraLen;
    const compressed = u8.subarray(dataStart, dataStart + found.compSize);

    // 4. Stored -> as-is; deflate -> native DecompressionStream.
    if (found.method === 0) {
        return new Blob([compressed], { type: 'image/png' });
    }
    if (found.method === 8) {
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const png = new Uint8Array(await new Response(stream).arrayBuffer());
        return new Blob([png], { type: 'image/png' });
    }
    throw new Error(`Unsupported ZIP compression method: ${found.method}`);
}

/**
 * Maps a fetch failure to a human-readable message for the UI.
 */
export function describeNaiError(status, bodyText) {
    if (status === 401) return 'Invalid NovelAI API token (401). Check the persistent token (pst-...).';
    if (status === 402) return 'Payment required (402): subscription inactive or not enough Anlas for this request.';
    if (status === 429) return 'Rate limited (429). Wait a moment and try again.';
    const detail = String(bodyText ?? '').slice(0, 200);
    return `NovelAI error ${status}${detail ? ': ' + detail : ''}`;
}

export class NaiClient {
    /**
     * @param {() => string} getApiKey
     */
    constructor(getApiKey) {
        this.getApiKey = getApiKey;
    }

    authHeaders() {
        const key = this.getApiKey();
        if (!key) throw new Error('NovelAI API token is not set. Add it in the Backends tab.');
        return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    }

    /**
     * Verify the token and read the subscription state. Free, costs no Anlas.
     * @returns {Promise<{tier: string, active: boolean, anlas: number, unlimitedImageGeneration: boolean}>}
     */
    async ping() {
        const response = await fetch(`${API_NOVELAI}/user/subscription`, { headers: this.authHeaders() });
        if (!response.ok) {
            throw new Error(describeNaiError(response.status, await response.text().catch(() => '')));
        }
        const data = await response.json();
        return {
            tier: NAI_TIERS[data.tier] ?? String(data.tier ?? 'unknown'),
            active: Boolean(data.active),
            // ST reads fixedTrainingStepsLeft for its Anlas counter (nai-settings.js:155).
            // fixed + purchased together equal the Anlas balance shown on novelai.net.
            anlas: (data.trainingStepsLeft?.fixedTrainingStepsLeft ?? 0)
                + (data.trainingStepsLeft?.purchasedTrainingStepsLeft ?? 0),
            unlimitedImageGeneration: Boolean(data.perks?.unlimitedImageGeneration),
        };
    }

    /**
     * Generate one image. Mirrors ST src/endpoints/novelai.js request body.
     * @param {{model: string, prompt: string, negative: string, width: number, height: number,
     *          steps: number, scale: number, seed: number,
     *          sampler?: string, scheduler?: string, signal?: AbortSignal}} opts
     * @returns {Promise<Blob>} PNG blob
     */
    async generate(opts) {
        const model = opts.model || 'nai-diffusion-4-5-full';
        const width = Math.trunc(Number(opts.width) || 832);
        const height = Math.trunc(Number(opts.height) || 1216);
        // NAI accepts seeds up to 4294967295; `| 0` would wrap anything over 2^31 - 1.
        const seed = opts.seed >= 0 ? Math.trunc(Number(opts.seed)) : Math.floor(Math.random() * 9999999999);
        const body = {
            action: 'generate',
            input: opts.prompt ?? '',
            model,
            parameters: {
                params_version: 3,
                prefer_brownian: true,
                negative_prompt: opts.negative ?? '',
                height,
                width,
                scale: opts.scale ?? 6,
                seed,
                sampler: opts.sampler ?? 'k_euler_ancestral',
                noise_schedule: opts.scheduler ?? 'karras',
                steps: opts.steps ?? 28,
                n_samples: 1,
                ucPreset: 0,
                qualityToggle: false,
                add_original_image: false,
                controlnet_strength: 1,
                deliberate_euler_ancestral_bug: false,
                dynamic_thresholding: false,
                legacy: false,
                legacy_v3_extend: false,
                // SMEA only applies to v3 models; v4/v4.5 must send false.
                sm: false,
                sm_dyn: false,
                uncond_scale: 1,
                skip_cfg_above_sigma: null,
                use_coords: false,
                characterPrompts: [],
                reference_image_multiple: [],
                reference_information_extracted_multiple: [],
                reference_strength_multiple: [],
                v4_negative_prompt: {
                    caption: {
                        base_caption: opts.negative ?? '',
                        char_captions: [],
                    },
                },
                v4_prompt: {
                    caption: {
                        base_caption: opts.prompt ?? '',
                        char_captions: [],
                    },
                    use_coords: false,
                    use_order: true,
                },
            },
        };

        const response = await fetch(`${IMAGE_NOVELAI}/ai/generate-image`, {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify(body),
            // Optional AbortSignal: cancelling aborts the browser request only;
            // a generation already accepted by NovelAI is not refundable.
            ...(opts.signal ? { signal: opts.signal } : {}),
        });

        if (!response.ok) {
            throw new Error(describeNaiError(response.status, await response.text().catch(() => '')));
        }

        const buffer = await response.arrayBuffer();
        return pngFromNaiZip(buffer);
    }
}
