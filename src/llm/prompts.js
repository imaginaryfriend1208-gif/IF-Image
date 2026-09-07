// IF Image - Master system prompts for the LLM rewrite engine.
// Pure functions: renderSystemPrompt(type, slots, style) is unit-testable.
// The per-dialect rules are written from the profile definitions in
// src/profiles.js (krea prose / anima hybrid / illustrious booru).

/**
 * Per-dialect rules blocks, derived from PROFILES metadata.
 * @type {Record<string, string>}
 */
export const DIALECT_RULES = {
    krea: `DIALECT: KREA (prose style)
- Write the prompt as natural English prose, 35-90 words, one flowing paragraph.
- Describe the scene, subject, lighting, camera, and mood in plain language.
- Do NOT use comma-separated booru tags.
- No negative prompt is used for this dialect (CFG 1); keep the prompt self-contained.
- Example: "a young woman with long silver hair standing in a sunlit city street, looking at the camera, photorealistic, natural lighting, detailed skin, 35mm photograph"`,

    anima: `DIALECT: ANIMA (hybrid: ordered tags + short captions)
- Start with the character count tag (e.g. "1girl, solo"), then character tags,
  then a short natural-language caption of the scene, then detail tags.
- Use spaces, not underscores, between tag words.
- Keep the caption under 20 words.
- Negative prompt is allowed; keep it short (bad hands, bad fingers, etc.).
- Example: "1girl, solo, long white hair, red eyes, black dress, standing in a flower field at sunset, wind, detailed background"`,

    illus: `DIALECT: ILLUSTRIOUS (booru tags + quality)
- Use danbooru-style tags separated by commas, spaces not underscores.
- Begin with the quality prefix: "masterpiece, best quality, amazing quality, very aesthetic, absurdres, newest".
- Include the character count tag and character tags, then scene tags.
- Do NOT use score_ tags.
- Keep the negative prompt to standard quality tags (worst quality, low quality, bad anatomy, bad hands, etc.).`,
};

/**
 * The 8 hard rules shared by every request type.
 */
export const HARD_RULES = `HARD RULES (violations are rejected):
1. OUTPUT FORMAT: Reply with EXACTLY ONE <ifimage> block. No prose before or after it.
2. The block must contain the child tags <image>, <prompt>, and <negative> (if the dialect uses negatives). <title> and <size> are optional.
3. <prompt> must be a single line. Do not wrap it in quotes or code fences.
4. <negative> must be a single line of negative tags, or empty.
5. <size> must be WxH (e.g. 832x1216). Default 832x1216.
6. Character fidelity: if a character is named in the scene, include their tags/description exactly as given in the character card block.
7. ONE image per request. Never emit multiple <ifimage> blocks.
8. Never leak negative-prompt content into <prompt>.`;

/**
 * Render the master system prompt for a request type.
 * @param {string} type - 'image_gen' (only Phase B type)
 * @param {{
 *   dialect_rules?: string,
 *   character_cards?: string,
 *   style_card?: string,
 *   persona_block?: string,
 *   rating?: string,
 *   scene_window?: string,
 * }} slots
 * @param {'compact'|'xml'|'full'} [style] - injection style for character cards
 * @returns {string}
 */
export function renderSystemPrompt(type, slots = {}, style = 'compact') {
    const base = `You are the image-prompt engine for the IF Image extension. Your job is to convert a scene description into a high-quality image-generation prompt.

${HARD_RULES}

${slots.dialect_rules || DIALECT_RULES.anima}

${renderInjection(slots, style)}

${slots.rating ? `RATING: ${slots.rating}` : ''}

SCENE WINDOW (the most recent chat messages; use them for context, but the user's direct instruction takes priority):
${slots.scene_window || '(no scene window provided)'}

Respond with only the <ifimage> block.`;

    return base;
}

/**
 * Render the character/persona/style injection block in the requested style.
 * @param {object} slots
 * @param {'compact'|'xml'|'full'} style
 * @returns {string}
 */
function renderInjection(slots, style) {
    const parts = [];
    if (slots.character_cards) parts.push(slots.character_cards);
    if (slots.style_card) parts.push(slots.style_card);
    if (slots.persona_block) parts.push(slots.persona_block);
    if (!parts.length) return '';

    if (style === 'xml') {
        return `CHARACTER CONTEXT:\n<context>\n${parts.map(p => `  <block>${p}</block>`).join('\n')}\n</context>`;
    }
    if (style === 'full') {
        return `CHARACTER CONTEXT:\n${parts.map(p => `---\n${p}\n---`).join('\n')}`;
    }
    // compact (default): one line per block
    return `CHARACTER CONTEXT:\n${parts.map(p => `- ${p.replace(/\n/g, ' ')}`).join('\n')}`;
}

/**
 * Build the user prompt for a rewrite request.
 * @param {string} sceneText - the residual scene text (marker content or last scene)
 * @param {{ previousPrompt?: string, variationHint?: string }} [opts]
 * @returns {string}
 */
export function renderUserPrompt(sceneText, { previousPrompt, variationHint } = {}) {
    let out = `Generate an image prompt for this scene: ${sceneText}`;
    if (previousPrompt) out += `\n\nPrevious prompt (for reference, do not repeat verbatim): ${previousPrompt}`;
    if (variationHint) out += `\n\nVariation hint: ${variationHint}`;
    return out;
}