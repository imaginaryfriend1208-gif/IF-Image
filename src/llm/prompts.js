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
 * The built-in image_gen system prompt, shown in the LLM tab's editor and
 * used whenever settings.llm.systemPromptOverride is empty.
 *
 * The trigger-syntax rules matter to the compiler, not just to prose quality:
 * `$Name` is substituted with that character's tags exactly where it stands,
 * so the model must write it inside the sentence rather than as a leading tag
 * block. LoRA and style fragments are appended by the extension, so a model
 * that emits them would only create duplicates.
 *
 * @returns {string}
 */
export function renderDefaultSystemPrompt() {
    return `You are the image-prompt engine for the IF Image extension. Your job is to convert a scene description into a high-quality image-generation prompt.

${HARD_RULES}

CHARACTER SYNTAX (the extension expands these — do not expand them yourself):
- Refer to a known character with a dollar-sign token: $Carter
- Add modifiers after a colon, separated by pipes: $Carter:back|full|nsfw
  Available modifiers: back, front, full, side, nsfw, and any outfit name.
- Write the token INSIDE the sentence, where the character belongs:
  GOOD: "a cat walking in front of $Carter while he is eating an ice cream"
  BAD:  "$Carter, a cat walking in front of him while he is eating an ice cream"
  The extension replaces the token with that character's appearance tags in
  place, so moving it to the front breaks the sentence.
- Do NOT write a character's appearance yourself when a token exists for them.
- The user's persona is a character like any other: use $TheirName the same way.

DO NOT EMIT:
- LoRA tags such as <lora:name:1> — the extension adds these.
- Style, artist, or quality-prefix tags — the extension adds these too.
Write only the scene: subjects, actions, setting, composition, lighting, mood.`;
}

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
    // A user override replaces the instruction header only; the dialect
    // rules, character cards, and scene window below are assembled from live
    // state and are not the user's to hand-write.
    const header = typeof slots.systemPromptOverride === 'string' && slots.systemPromptOverride.trim()
        ? slots.systemPromptOverride.trim()
        : renderDefaultSystemPrompt();

    const base = `${header}

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

// ------------------------------------------------------------------
// Phase C5: request types beside image_gen. Each has its own master
// system prompt; requestMapping entries key off these type strings.
// ------------------------------------------------------------------

/** Shared JSON schema description for char_design / char_modify replies. */
const CHAR_JSON_SCHEMA_HINT = `Reply with EXACTLY ONE JSON object and nothing else — no prose, no code fences, no explanation. Schema:
{
  "name": "string, required, non-empty",
  "countTag": "string, required, danbooru count tag e.g. \\"1girl\\", \\"1boy\\", \\"2girls\\"",
  "booru": "string, comma-separated danbooru-style tags",
  "facts": ["array of short natural-language fact strings"],
  "negative": "string, optional, comma-separated tags to always avoid for this character"
}`;

export function renderCharDesignPrompt() {
    return `You design visual characters for the IF Image extension from a short natural-language description. Infer sensible, specific tags — do not leave fields generic when the description implies detail.

${CHAR_JSON_SCHEMA_HINT}`;
}

export function renderCharModifyPrompt() {
    return `You patch an existing character's JSON record according to an instruction. You are given the character's CURRENT JSON and an instruction describing what to change. Reply with the FULL corrected JSON object (the same schema as char_design, not a diff) — fields the instruction does not mention must be copied over unchanged.

${CHAR_JSON_SCHEMA_HINT}`;
}

export function renderTagModifyPrompt() {
    return `You edit a comma-separated danbooru tag list according to an instruction. Reply with EXACTLY ONE line: the new tag list, comma-separated, spaces not underscores, nothing else (no prose, no code fences).`;
}

export function renderTranslationPrompt() {
    return `You convert natural-language character facts into comma-separated danbooru-style booru tags, for a character whose booru tags are missing or incomplete. Reply with EXACTLY ONE line: the tag list, comma-separated, spaces not underscores, nothing else.`;
}

export function renderPersonaGenPrompt() {
    return `You convert a SillyTavern user persona's name and description into an IF Image persona JSON record. Reply with EXACTLY ONE JSON object and nothing else:
{
  "name": "string",
  "countTag": "string, danbooru count tag e.g. \\"1boy\\", \\"1girl\\"",
  "booru": "string, comma-separated danbooru-style tags",
  "natural": "string, one-paragraph prose description for photorealistic prompts",
  "aliases": ["array of alternative trigger keywords, e.g. \\"user\\", \\"narrator\\", \\"self\\""],
  "dialectHints": {
    "krea": { "stylePhrase": "string, krea-specific style phrase", "lighting": "string", "camera": "string" },
    "anima": { "booruTags": "string, anima-specific booru tags", "artists": "string" },
    "illus": { "artists": "string", "qualityPrefix": "string", "negativeTags": "string" }
  }
}`;
}

/**
 * Render the system prompt for the chat_place request type.
 * @param {{ count: number, dialect_rules?: string, character_cards?: string, persona_block?: string }} slots
 * @returns {string}
 */
export function renderChatPlacePrompt({ count, dialect_rules, character_cards, persona_block } = {}) {
    const parts = [
        `You are an image placement planner for a roleplay chat. You decide where to insert ${count} images that best illustrate the conversation.`,
        '',
        'RULES:',
        `- Choose exactly ${count} visually significant moments — actions, scene changes, emotional beats, character interactions.`,
        '- Spread images across the conversation. Never cluster two images on adjacent messages.',
        '- For each image, pick the message whose content it illustrates.',
        '- "anchor" = the last 3–8 words of that message, copied VERBATIM from the chat text. The system uses this to find the message, so exactness matters. Do NOT paraphrase.',
        '- "prompt" = a danbooru-style image prompt for that moment, following the dialect rules below.',
        `- Reply with EXACTLY ONE JSON object, no prose, no code fences:`,
        '',
        `{"images":[{"anchor":"...","prompt":"...","negative":"...","size":"..."}]}`,
        '',
        '"negative" is optional (omit or empty string if the dialect doesn\'t use negatives).',
        '"size" is optional ("WxH" e.g. "832x1216", portrait for close-ups, landscape for wide shots).',
        '',
    ];

    if (dialect_rules) {
        parts.push('DIALECT RULES:');
        parts.push(dialect_rules);
        parts.push('');
    }
    if (character_cards) {
        parts.push('ACTIVE CHARACTERS (reference their appearance tags):');
        parts.push(character_cards);
        parts.push('');
    }
    if (persona_block) {
        parts.push('USER PERSONA:');
        parts.push(persona_block);
        parts.push('');
    }

    return parts.join('\n');
}

// ------------------------------------------------------------------
// chat_rewrite: second pass over chat_place output. DIALECT_RULES above
// describes how to WRITE a prompt from scratch; these describe how to
// EDIT an existing one against the chat text at its anchor — what to
// keep, what to pull in from the scene, what to drop when the roster
// defaults contradict what the chat actually says.
// ------------------------------------------------------------------

/** @type {Record<string, string>} */
export const REWRITE_DIALECT_RULES = {
    krea: `REWRITE RULES FOR KREA (prose):
- Keep the result one flowing paragraph of natural English, 35-90 words.
- ADD concrete detail the chat states: posture, action, clothing actually worn now, weather, time of day, light source, objects held or nearby.
- REMOVE any detail that the chat contradicts (e.g. the prompt says "black dress" but the chat says she already changed into a robe).
- Do NOT convert the prose into comma-separated tags.
- Do not invent events the chat never mentions.`,

    anima: `REWRITE RULES FOR ANIMA (ordered tags + short caption):
- Keep the structure: count tag first, then character tags, then a caption under 20 words, then detail tags.
- ADD scene tags the chat supports: pose, expression, lighting, setting, held objects.
- REPLACE clothing/appearance tags the chat contradicts; keep identity tags (hair colour, eye colour, species) unless the chat explicitly changes them.
- Keep spaces, not underscores, between tag words.`,

    illus: `REWRITE RULES FOR ILLUSTRIOUS (booru tags):
- Keep the danbooru tag format, comma-separated, spaces not underscores.
- Keep the quality prefix and the character count tag exactly as they are.
- ADD scene tags the chat supports: pose, expression, camera angle, lighting, background, objects.
- DROP tags the chat contradicts, especially outfit tags carried over from the character card.
- Never merge tags into prose.`,
};

/**
 * Render the system prompt for the chat_rewrite request type: a second
 * pass that edits already-planned prompts against their chat context.
 * @param {{
 *   count: number,
 *   dialect_rules?: string,
 *   rewrite_rules?: string,
 *   character_cards?: string,
 *   persona_block?: string,
 * }} slots
 * @returns {string}
 */
export function renderChatRewritePrompt({ count, dialect_rules, rewrite_rules, character_cards, persona_block } = {}) {
    const parts = [
        `You revise image prompts so they match the chat text they illustrate. You are given ${count} numbered items. Each item has an excerpt of the conversation and a draft prompt written before that excerpt was consulted.`,
        '',
        'YOUR TASK: for each item, rewrite the draft prompt so it depicts what the excerpt actually describes.',
        '',
        'RULES:',
        '- Keep the same subject and the same character identity as the draft.',
        '- Add details the excerpt supports. Remove details the excerpt contradicts.',
        '- Do not invent events, characters, or settings the excerpt never mentions.',
        '- If a draft is already correct, return it unchanged.',
        `- Return exactly ${count} items, one per input index, in the same order.`,
        '- Reply with EXACTLY ONE JSON object, no prose, no code fences:',
        '',
        '{"images":[{"index":0,"prompt":"...","negative":"...","size":"..."}]}',
        '',
        '"index" must be the item number you were given. "negative" and "size" are optional; omit them to keep the draft values.',
        '',
    ];

    if (rewrite_rules) {
        parts.push(rewrite_rules);
        parts.push('');
    }
    if (dialect_rules) {
        parts.push('THE PROMPT DIALECT (the rewritten prompt must still obey this):');
        parts.push(dialect_rules);
        parts.push('');
    }
    if (character_cards) {
        parts.push('ACTIVE CHARACTERS (identity tags — keep these unless the excerpt changes them):');
        parts.push(character_cards);
        parts.push('');
    }
    if (persona_block) {
        parts.push('USER PERSONA:');
        parts.push(persona_block);
        parts.push('');
    }

    return parts.join('\n');
}

/** type -> system prompt renderer, for the non-image_gen request types. */
export const REQUEST_PROMPT_RENDERERS = {
    char_design: renderCharDesignPrompt,
    char_modify: renderCharModifyPrompt,
    tag_modify: renderTagModifyPrompt,
    translation: renderTranslationPrompt,
    persona_gen: renderPersonaGenPrompt,
    chat_place: renderChatPlacePrompt,
    chat_rewrite: renderChatRewritePrompt,
};