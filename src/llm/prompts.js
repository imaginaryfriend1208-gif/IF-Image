// IF Image - Master prompt contracts for LLM scene generation.
// LLM output is a scene template; compiler-owned identity expansion, style,
// quality, negatives and LoRA are deliberately excluded.

export const DIALECT_RULES = {
    krea: `SCENE DIALECT: KREA
- Write natural English scene prose, one flowing paragraph.
- Describe actions, pose, expression, current clothing, environment, concrete light source, framing and mood.
- Do not add photographic/aesthetic labels, quality boilerplate, artists, style presets, LoRAs or appearance copied from subject records.`,

    anima: `SCENE DIALECT: ANIMA
- Write a compact hybrid scene: short concrete action/caption plus supported scene tags.
- Describe pose, expression, current clothing, environment, concrete light source and framing.
- Do not emit count/appearance tags, quality boilerplate, artists, style presets or LoRAs; the compiler adds those.`,

    illus: `SCENE DIALECT: ILLUSTRIOUS
- Write concise comma-separated scene tags with spaces instead of underscores.
- Include only action, pose, expression, current clothing, environment, concrete light source and framing.
- Do not emit quality prefixes, count/appearance tags, score tags, artists, style presets or LoRAs; the compiler adds those.`,
};

export const SUBJECT_TOKEN_CONTRACT = `SUBJECT TOKEN CONTRACT (strict):
- KNOWN SUBJECT TOKENS below are the only identity tokens you may use.
- Whenever a listed subject is visibly present, copy its Exact token byte-for-byte into the scene prompt and declare that same token in "subjects".
- Keep each token where that subject belongs in the action. Never hoist all subjects into a detached leading list.
- Never replace a known subject with a bare name, alias, pronoun-only reference, generic description, or appearance tags.
- Do not invent unknown $tokens or \${char: ...} objects. Incidental unnamed NPCs stay ordinary generic prose and are not declared.
- "subjects" contains each visibly present known subject once. It is validation metadata, not prose.
- Current clothing stated by the chat belongs in the scene; fixed physical appearance does not.`;

export const COMPILER_OWNED_CONTRACT = `COMPILER-OWNED CONTENT (forbidden in a raw scene):
- style preset names or style directives
- artist names and aesthetic labels
- quality boilerplate such as masterpiece, best quality, absurdres or score tags
- LoRA tags
- fixed character/persona appearance or default outfit tags copied from roster
- backend/checkpoint/sampler boilerplate
- generic photographic labels such as photorealistic, anime style, digital art or cinematic lighting
Use concrete scene lighting such as dim window light or a desk lamp instead.`;

export const HARD_RULES = `HARD RULES (violations are rejected):
1. Reply with EXACTLY ONE <ifimage> block and no surrounding prose.
2. Include <image>, <subjects>, <prompt>, and <negative> child tags. <title> and <size> are optional.
3. <subjects> is a JSON array of exact canonical subject tokens, e.g. ["$Carter","$me"].
4. <prompt> and <negative> must each be a single line with no quotes or code fences.
5. <size> must be WxH when present.
6. Character fidelity: use the exact $Name token from the catalog. Do not copy their appearance tags into the scene.
7. Emit exactly one image and preserve canonical subject tokens byte-for-byte.
8. Raw scene prompts must contain no compiler-owned style, quality, appearance or LoRA content.`;

export function renderDefaultSystemPrompt() {
    return `You are the image-prompt engine and scene-planning half of the IF Image extension. You turn a roleplay moment into one structured image scene. The extension compiles your scene afterward.

${HARD_RULES}

${SUBJECT_TOKEN_CONTRACT}

${COMPILER_OWNED_CONTRACT}

NEVER emit compiler-owned content such as <lora:SomeName:1>, artist/style names, or quality boilerplate.

Put tokens in semantic sentence position:
GOOD: a cat walking in front of $Carter while he is eating ice cream
BAD: $Carter, a cat walking in front of him while he eats ice cream
GOOD: $Ann hands a cup to $Carter across a low table
BAD: $Ann, $Carter, handing a cup, low table

The direct marker compiler also understands $Carter:back|full|nsfw and the back, front, side, full, nsfw modifiers, but LLM output must keep the catalog Exact token unchanged and describe framing in scene text. The user persona is a character for identity resolution, represented by the catalog token (normally $me).

Ground every visible detail in the scene window or direct request. Do not invent events, subjects, clothing or setting. Choose portrait size for one-person close framing and landscape for rooms, vistas or subjects side by side.`;
}

/** Render the image_gen system prompt. */
export function renderSystemPrompt(type, slots = {}, style = 'compact') {
    const hasOverride = typeof slots.systemPromptOverride === 'string' && Boolean(slots.systemPromptOverride.trim());
    const header = hasOverride ? slots.systemPromptOverride.trim() : renderDefaultSystemPrompt();
    const safetyContract = hasOverride ? `\n\n${SUBJECT_TOKEN_CONTRACT}\n\n${COMPILER_OWNED_CONTRACT}` : '';
    return `${header}${safetyContract}

${slots.dialect_rules || DIALECT_RULES.anima}

${renderInjection(slots, style)}

${slots.rating ? `RATING: ${slots.rating}` : ''}

SCENE WINDOW (the direct instruction outranks this context):
${slots.scene_window || '(no scene window provided)'}

Respond only with the <ifimage> block.`;
}

function renderInjection(slots, style) {
    const subjectBlock = slots.subject_catalog || slots.character_cards || '';
    if (!subjectBlock) return '';
    if (style === 'xml') return `SUBJECT TOKEN CATALOG:\n<context>\n${subjectBlock}\n</context>`;
    if (style === 'full') return `SUBJECT TOKEN CATALOG:\n---\n${subjectBlock}\n---`;
    return `SUBJECT TOKEN CATALOG:\n${subjectBlock}`;
}

export function renderUserPrompt(sceneText, { previousPrompt, variationHint } = {}) {
    let out = `Generate a structured image scene for: ${sceneText}`;
    if (previousPrompt) out += `\n\nPrevious compiled result is reference only; do not copy style/quality/appearance boilerplate from it: ${previousPrompt}`;
    if (variationHint) out += `\n\nVariation hint: ${variationHint}`;
    return out;
}

const CHAR_JSON_SCHEMA_HINT = `Reply with EXACTLY ONE JSON object and nothing else — no prose, no code fences, no explanation. Schema:
{
  "name": "string, required, non-empty",
  "countTag": "string, required, danbooru count tag e.g. \\"1girl\\", \\"1boy\\", \\"2girls\\"",
  "booru": "string, comma-separated danbooru-style tags",
  "facts": ["array of short natural-language fact strings"],
  "negative": "string, optional, comma-separated tags to always avoid for this character"
}`;

export function renderCharDesignPrompt() {
    return `You design visual characters for the IF Image extension from a short natural-language description. Infer sensible, specific tags.\n\n${CHAR_JSON_SCHEMA_HINT}`;
}

export function renderCharModifyPrompt() {
    return `You patch an existing character JSON record according to an instruction. Return the full corrected record, not a diff.\n\n${CHAR_JSON_SCHEMA_HINT}`;
}

export function renderTagModifyPrompt() {
    return 'You edit a comma-separated danbooru tag list according to an instruction. Reply with exactly one tag line and nothing else.';
}

export function renderTranslationPrompt() {
    return 'Convert natural-language character facts into one comma-separated danbooru tag line. Reply with that line only.';
}

export function renderPersonaGenPrompt() {
    return `Convert a SillyTavern user persona into exactly one IF Image persona JSON object:
{"name":"string","countTag":"string","booru":"string","natural":"string","aliases":["string"],"dialectHints":{"krea":{"stylePhrase":"string","lighting":"string","camera":"string"},"anima":{"booruTags":"string","artists":"string"},"illus":{"artists":"string","qualityPrefix":"string","negativeTags":"string"}}}`;
}

export function renderChatPlacePrompt({ count, dialect_rules, subject_catalog, character_cards } = {}) {
    const catalog = subject_catalog || character_cards || '(no known subject tokens)';
    return [
        `You are an image placement planner for a roleplay chat. Choose exactly ${count} visually significant moments.`,
        '',
        SUBJECT_TOKEN_CONTRACT,
        '',
        COMPILER_OWNED_CONTRACT,
        '',
        'PLACEMENT RULES:',
        `- Return exactly ${count} items, spread across the conversation; do not cluster adjacent messages.`,
        '- "anchor" is the last 3–8 words copied verbatim from the illustrated message.',
        '- "subjects" is required and lists exact known tokens visibly present in that image.',
        '- "prompt" is only the scene template. Keep each subject token at its semantic action position.',
        '- "negative" must be empty; compiler/profile owns negatives.',
        '- "size" may be WxH.',
        '- Reply with exactly one JSON object and no prose/code fence:',
        `{"images":[{"anchor":"...","subjects":["$ExactToken"],"prompt":"$ExactToken doing ...","negative":"","size":"832x1216"}]}`,
        '',
        'SUBJECT TOKEN CATALOG:',
        catalog,
        '',
        dialect_rules || DIALECT_RULES.anima,
    ].join('\n');
}

export const REWRITE_DIALECT_RULES = {
    krea: 'Keep natural scene prose. Add only concrete context facts; remove contradictions and compiler-owned content.',
    anima: 'Keep a compact hybrid scene. Add supported action/pose/current-clothing/environment tags only.',
    illus: 'Keep concise comma-separated scene tags. Add supported scene facts only; never add quality/appearance/style tags.',
};

export function renderChatRewritePrompt({ count, dialect_rules, rewrite_rules, subject_catalog, character_cards } = {}) {
    const catalog = subject_catalog || character_cards || '(no known subject tokens)';
    return [
        `You revise image prompts: ${count} draft image scenes against their chat excerpts.`,
        '',
        SUBJECT_TOKEN_CONTRACT,
        '',
        COMPILER_OWNED_CONTRACT,
        '',
        'REWRITE RULES:',
        '- Preserve every draft subject token byte-for-byte; never add or remove a subject.',
        '- Return each item with the exact same "subjects" array as its draft.',
        '- Add supported current action, pose, expression, clothing, setting, objects, concrete light and framing.',
        '- Remove contradictions. If already correct, return unchanged.',
        `- Return exactly ${count} items in index order as one JSON object, no prose/code fence:`,
        '{"images":[{"index":0,"subjects":["$ExactToken"],"prompt":"...","negative":"","size":"..."}]}',
        '',
        rewrite_rules || '',
        dialect_rules || DIALECT_RULES.anima,
        '',
        'SUBJECT TOKEN CATALOG:',
        catalog,
    ].join('\n');
}

export const REQUEST_PROMPT_RENDERERS = {
    char_design: renderCharDesignPrompt,
    char_modify: renderCharModifyPrompt,
    tag_modify: renderTagModifyPrompt,
    translation: renderTranslationPrompt,
    persona_gen: renderPersonaGenPrompt,
    chat_place: renderChatPlacePrompt,
    chat_rewrite: renderChatRewritePrompt,
};
