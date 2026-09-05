// IF Image - model profile presets for the Comfy proxy families.
// steps/cfg defaults mirror the proxy's own src/defaults.ts per family.
// Width/height/prefix/negative follow the IF Image dialect spec.

export const PROFILES = {
    krea2: {
        label: 'Krea 2',
        steps: 8,
        cfg: 1,
        width: 1344,
        height: 768,
        prefix: '',
        negative: '',
        // Krea 2 runs at CFG 1: a negative prompt has no effect.
        negativeDisabled: true,
        testPrompt: 'a young woman with long silver hair standing in a sunlit city street, looking at the camera, photorealistic, natural lighting, detailed skin, 35mm photograph',
    },
    anima: {
        label: 'Anima',
        steps: 16,
        cfg: 4,
        width: 832,
        height: 1216,
        prefix: 'masterpiece, best quality, score_7, safe, ',
        negative: 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts',
        negativeDisabled: false,
        testPrompt: '1girl, solo, long white hair, red eyes, black dress, standing in a flower field at sunset, wind, detailed background',
    },
    illustrious: {
        label: 'Illustrious',
        steps: 20,
        cfg: 8,
        width: 832,
        height: 1216,
        prefix: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, newest, ',
        negative: 'worst quality, low quality, lowres, bad anatomy, bad hands, text, error, missing fingers, jpeg artifacts, signature, watermark, blurry',
        negativeDisabled: false,
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
