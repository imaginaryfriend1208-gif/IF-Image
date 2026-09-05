// IF Image - model profile presets for the Comfy proxy families.
// Each profile holds generation defaults AND dialect metadata.
// cfg/steps/prefix/negative are per-checkpoint guidance, not hard limits.

export const PROFILES = {
    krea2: {
        label: 'Krea 2',
        dialect: 'krea',
        // Krea 2 Turbo: DiT 12B + Qwen3-VL, distilled 8-step, CFG baked in.
        steps: 8,
        cfg: 1,
        width: 1344,
        height: 768,
        prefix: '',
        negative: '',
        // CFG 1 = no conditioning contrast, negative has no effect.
        negativeDisabled: true,
        promptStyle: 'prose',  // NL prose 35-90 words, English only
        verified: true,
        notes: 'Krea 2 Turbo distilled. CFG 1 = negative disabled. Prompt = NL prose.',
        testPrompt: 'a young woman with long silver hair standing in a sunlit city street, looking at the camera, photorealistic, natural lighting, detailed skin, 35mm photograph',
    },
    anima: {
        label: 'Anima',
        dialect: 'anima',
        // rdbt Anima (ym1f v2): finetune of Cosmos-Predict2 2B, Qwen3-0.6B TE.
        // rdbt card recommends CFG 1-3, steps 16+; base Anima card says CFG 4-5.
        // Using rdbt values since proxy runs rdbt checkpoint.
        steps: 16,
        cfg: 2,
        width: 832,
        height: 1216,
        // rdbt finetune: quality tags are ineffective (high-quality dataset).
        // Base Anima would use 'masterpiece, best quality, score_7, safe, '
        prefix: '',
        negative: 'bad hands, bad fingers',
        negativeDisabled: false,
        promptStyle: 'hybrid',  // quality tags + NL captions + detail tags
        verified: false,
        notes: 'rdbt Anima defaults. CFG 2 (rdbt range 1-3). Quality prefix dropped per rdbt card. Verify with actual proxy checkpoint.',
        testPrompt: '1girl, solo, long white hair, red eyes, black dress, standing in a flower field at sunset, wind, detailed background',
    },
    illustrious: {
        label: 'Illustrious',
        dialect: 'illus',
        // NoobAI/Illustrious SDXL: CLIP TE, ~225-248 tokens effective.
        // Research consensus: CFG 4-6, never >6. Changed from 8 to 5.
        steps: 20,
        cfg: 5,
        width: 832,
        height: 1216,
        prefix: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, newest, ',
        negative: 'worst quality, low quality, lowres, bad anatomy, bad hands, text, error, missing fingers, jpeg artifacts, signature, watermark, blurry',
        negativeDisabled: false,
        promptStyle: 'tags',  // danbooru tags, spaces not underscores, no score_ tags
        verified: false,
        notes: 'Illustrious/NoobAI defaults. CFG 5 (range 4-6). No score_ tags. Spaces not underscores. Verify with actual checkpoint.',
        testPrompt: '1girl, solo, blonde hair, blue eyes, school uniform, classroom, afternoon light, anime style, detailed face',
    },
};

export const PROFILE_KEYS = Object.keys(PROFILES);

/**
 * Fill the test form fields from a profile preset.
 * @param {object} test settings.test object (mutated)
 * @param {string} key profile key
 * @param {boolean} overwritePrompt also replace prompt/negative text
 */
export function applyProfile(test, key, overwritePrompt = true) {
    const profile = PROFILES[key];
    if (!profile) return;
    test.steps = profile.steps;
    test.cfg = profile.cfg;
    test.width = profile.width;
    test.height = profile.height;
    if (overwritePrompt) {
        test.prompt = profile.testPrompt;
        test.negative = profile.negative;
    }
}

