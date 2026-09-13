// IF Image - Drawer UI with 7 tabs: Settings (connections + checkpoint
// profiles + Test Generate), Generation, Characters, Persona & Style, LLM,
// Gallery, Advanced (Log + Replace Rules + 3-Dialect Preview).
// Template literals mounted into #extensions_settings2 by index.js.

import { NAI_MODELS } from './backends/nai.js';
import { resolveCheckpoint } from './backends/a1111.js';
import { getActiveProfile, mergeParams, suggestCheckpointProfile, normalizeCheckpointProfile, SIZE_PRESETS, matchSizePreset } from './backends/checkpoint-profiles.js';
import { PROFILES, PROFILE_KEYS } from './profiles.js';
import { getAllCharacters, saveCharacter, removeCharacter, createDefaultCharacter, emptyBooruDetail, applyCharMigrations } from './storage/chars.js';
import { getAllPersonas, savePersona, removePersona, getAllStyles, saveStyle, removeStyle, createDefaultPersona, createDefaultStyle, applyPersonaNameImport, getReplaceRules, saveReplaceRules } from './storage/presets.js';
import { getOutfitsForCharacter, getAllOutfits, saveOutfit, removeOutfit, createDefaultOutfit } from './storage/outfits.js';
import { buildExport, validateImport, planMerge } from './storage/transfer.js';
import { listImages, countImages, deleteImageRecord, getStorageStats, pruneImages } from './storage/images.js';
import { parseTriggers } from './prompt/triggers.js';
import { resolveActiveStyle, readChatStyleId, writeChatStyleId } from './prompt/active-style.js';
import { buildTriggerContext } from './prompt/binding.js';
import { undoPlacements } from './llm/inject.js';
import { buildApiProfileExport, importApiProfiles } from './llm/profiles.js';
import { formatLlmError, resolveLlmTarget, listStProfiles } from './llm/client.js';
import { mountConnectionTab, connectionTabMarkup } from './ui/connection-tab.js';
import { makeHelpers } from './ui/shared.js';
import { isValidLora, collectLoraGroups, parseLoraLines, renderLoraToken } from './prompt/ordering.js';
import { renderDefaultSystemPrompt } from './llm/prompts.js';
import { assemblePrompt, resolveProfileKey } from './prompt/render.js';
import { cleanupEnvelope } from './prompt/cleanup.js';
import { applyReplaceRules, parseCompactRule } from './prompt/replace.js';

// Single source of truth for the displayed version. Keep in sync with
// manifest.json (which cannot be imported from browser ESM without JSON
// import attributes — unsupported on older Chromium, would hard-fail the
// whole extension).
export const EXTENSION_VERSION = '0.3.0';

/**
 * @param {object} args
 * @param {object} args.settings extension_settings.IF_Image (live reference)
 * @param {() => void} args.save saveSettingsDebounced wrapper
 * @param {NaiClient} args.nai
 * @param {ComfyProxyClient} args.comfy legacy proxy client (connection 'legacy_proxy')
 * @param {A1111Client} args.a1111 AUTOMATIC1111-compatible API client (connection 'a1111')
 * @param {Array} [args.genLog] - B7: ring buffer of pipeline/LLM events
 * @param {() => object} [args.getQueue] - B7: live queue instance for task list
 * @param {(record: object) => Promise<string>} [args.regenerateImage] - C10:
 *   re-enqueue a gallery record through the existing queue/executor (seed -1)
 *   and save the result as a new record.
 * @param {() => string} [args.getCurrentChatId] - C10: current chat id, for
 *   the Gallery tab's "current chat" filter.
 * @param {(opts?: { signal?: AbortSignal }) => Promise<{ persona: object }>}
 *   [args.importPersonaNameFromSt] - read only the active host persona name.
 * @param {() => (void|Promise<void>)} [args.refreshRoster] - refresh the
 *   runtime roster after the UI has persisted an imported/synced record.
 */
export function renderDrawer({ settings, save, imageBackend, llmClient, genLog, getQueue, regenerateImage, getCurrentChatId, planChatImages, applyPlacements, getChatContext, eventSource, event_types, importPersonaNameFromSt, refreshRoster }) {
    const html = `
    <div class="if-image-settings">
        <div class="if-image-title">
            <h2>IF Image</h2>
            <span>v${EXTENSION_VERSION}</span>
        </div>

        <div class="if-image-tabs">
            <button class="if-image-tab menu_button active" data-if-tab="connection">Connection</button>
            <button class="if-image-tab menu_button" data-if-tab="main">Generation</button>
            <button class="if-image-tab menu_button" data-if-tab="chars">Characters</button>
            <button class="if-image-tab menu_button" data-if-tab="presets">Persona & Style</button>
            <button class="if-image-tab menu_button" data-if-tab="gallery">Gallery</button>
            <button class="if-image-tab menu_button" data-if-tab="advanced">Advanced</button>
        </div>

        <!-- ============ GENERATION TAB (formerly Main) ============ -->
        <div class="if-image-panel" data-if-panel="main" style="display:none;">
            <h3>Generation</h3>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_main_enabled"> Extension enabled
                </label>
            </div>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_main_gen_enabled"> Marker detection enabled
                </label>
            </div>
            <div class="if-image-row">
                <label for="if_main_start">Start tag</label>
                <input id="if_main_start" type="text" class="text_pole textarea_compact" value="image###">
            </div>
            <div class="if-image-row">
                <label for="if_main_end">End tag</label>
                <input id="if_main_end" type="text" class="text_pole textarea_compact" value="###">
            </div>
            <div class="if-image-note">Changing the tags affects marker detection in existing messages. Tags are matched literally (regex special characters are escaped).</div>
            <div class="if-image-row">
                <label for="if_main_backend">Default backend</label>
                <select id="if_main_backend" class="text_pole">
                    <option value="comfy">SD (A1111-compatible / Comfy proxy)</option>
                    <option value="nai">NovelAI</option>
                </select>
            </div>
            <div class="if-image-row">
                <label for="if_main_profile">Fallback prompt style</label>
                <select id="if_main_profile" class="text_pole">
                    ${PROFILE_KEYS.map(k => `<option value="${k}">${PROFILES[k].label}</option>`).join('')}
                </select>
            </div>
            <div class="if-image-note">Used when the active checkpoint has no saved profile. The checkpoint itself is selected in Settings → Stable Diffusion.</div>
            <div class="if-image-row">
                <label for="if_main_mode">Mode</label>
                <select id="if_main_mode" class="text_pole">
                    <option value="direct">Direct (marker → image)</option>
                    <option value="assist">Assist (LLM rewrite)</option>
                    <option value="full">Full (LLM replies)</option>
                </select>
            </div>
            <div class="if-image-note">Direct compiles markers locally. Assist rewrites hand-typed markers through the LLM. Full also scans LLM chat replies for &lt;ifimage&gt; blocks.</div>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_main_dryrun"> Dry-run (log envelope, no generation)
                </label>
            </div>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_main_order"> Enforce prompt order (LoRA &rarr; style &rarr; prompt)
                </label>
            </div>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_main_keeplora"> Keep LoRA where written (don't move to the front)
                </label>
            </div>
            <div class="if-image-note">LoRAs lead the final prompt, then style fragments, then the scene. The scene's own wording and character placement are never reordered.</div>
            <div class="if-image-row">
                <label for="if_main_llmsize">LLM size hint</label>
                <select id="if_main_llmsize" class="text_pole">
                    <option value="auto">Auto (LLM &lt;size&gt; wins)</option>
                    <option value="ignore">Ignore (discard LLM size)</option>
                    <option value="force">Force (always use LLM size)</option>
                </select>
            </div>
            <div class="if-image-note">How an Assist/Full-mode LLM &lt;size&gt; hint interacts with sizes from markers and profiles. Auto and Force behave identically today.</div>

            <hr class="if-image-sep"/>
            <h3>Active Profile</h3>
            <div class="if-image-note">Generation uses the checkpoint profile marked active in Settings → Stable Diffusion — one set of params for everything. Marker JSON triggers and LLM hints still override individual values per image.</div>
            <div id="if_main_active_profile" class="if-image-active-summary">No active profile.</div>

            <hr class="if-image-sep"/>
            <h3>Style</h3>
            <div class="if-image-note">The style supplies prompt hints and its LoRA. A <code>{{style: Name}}</code> written into a marker still wins over the choice here.</div>
            <div class="if-image-row">
                <label for="if_main_style">Style for this chat</label>
                <select id="if_main_style" class="text_pole">
                    <option value="">-- none --</option>
                </select>
            </div>
            <div class="if-image-row">
                <label for="if_main_style_default">Default for new chats</label>
                <select id="if_main_style_default" class="text_pole">
                    <option value="">-- none --</option>
                </select>
            </div>
            <div class="if-image-row">
                <button id="if_main_style_setdefault" class="menu_button" type="button">Use this chat's style as the default</button>
            </div>
            <div id="if_main_style_status" class="if-image-active-summary">No style active.</div>

            <hr class="if-image-sep"/>
            <h3>Chat Image Placement (LLM)</h3>
            <div class="if-image-note">Let the LLM plan image placements across the current chat. It reads the conversation, picks N visually significant moments, and injects image markers at those positions — the pipeline then generates images automatically.</div>
            <div class="if-image-row">
                <label for="if_plan_mode">Placement mode</label>
                <select id="if_plan_mode" class="text_pole">
                    <option value="together">Together — plan all significant moments at once</option>
                    <option value="separate">Separate — scan and place scenes chronologically</option>
                </select>
            </div>
            <div class="if-image-note">Together submits the selected conversation as one plan and queues all markers together. Separate asks for message-by-message chronological scenes and inserts markers in timeline order.</div>
            <div class="if-image-row">
                <label for="if_plan_count">Number of images</label>
                <input id="if_plan_count" type="number" min="1" max="6" value="3" class="text_pole" style="width:60px;">
            </div>
            <div class="if-image-row">
                <label for="if_plan_context">Recent messages to read (0 = entire chat)</label>
                <input id="if_plan_context" type="number" min="0" max="200" value="40" class="text_pole">
            </div>
            <div class="if-image-row if-image-choice-list">
                <label class="if-image-check"><input type="checkbox" id="if_plan_include_character" checked><span>Include character messages</span></label>
                <label class="if-image-check"><input type="checkbox" id="if_plan_include_user" checked><span>Include user/persona messages</span></label>
                <label class="if-image-check"><input type="checkbox" id="if_plan_include_first"><span>Include the character card's first message</span></label>
                <label class="if-image-check"><input type="checkbox" id="if_plan_include_card"><span>Include character-card description, personality, and scenario</span></label>
                <label class="if-image-check"><input type="checkbox" id="if_plan_include_injections"><span>Include active extension prompt injections</span></label>
                <label class="if-image-check"><input type="checkbox" id="if_plan_charonly" checked><span>Place images after character messages only</span></label>
            </div>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_plan_rewrite" checked> Rewrite prompts against the chat (one extra LLM call)
                </label>
            </div>
            <div class="if-image-note">With rewrite on, a second pass edits each planned prompt to match the messages around it — adding what the scene describes and dropping character-card details the scene contradicts.</div>
            <div class="if-image-row">
                <button id="if_plan_run" class="menu_button" style="flex:1;">Plan & place images</button>
                <button id="if_plan_undo" class="menu_button" title="Undo last placement">Undo</button>
            </div>
            <div class="if-image-result" id="if_plan_result"></div>
            <details class="if-image-advanced">
                <summary>Advanced · Test Generate</summary>
                <div id="if_testgen_mount">
                    <div class="if-image-row">
                        <label for="if_active_profile">Checkpoint profile (active — used for all generation)</label>
                        <select id="if_active_profile" class="text_pole">
                            <option value="">-- no saved profiles yet --</option>
                        </select>
                    </div>
                    <div class="if-image-row">
                        <button id="if_cp_editor_toggle" class="menu_button" style="display:none;">Create / edit profile…</button>
                    </div>
                    <div class="if-image-note" id="if_cp_status"></div>
                    <div class="if-image-row">
                        <label for="if_cp_name">Profile name</label>
                        <input id="if_cp_name" type="text" class="text_pole" placeholder="defaults to the checkpoint title">
                    </div>
                        </div>
                        <div class="if-image-row">
                            <label for="if_cp_profile">Prompt style</label>
                            <select id="if_cp_profile" class="text_pole">
                                ${PROFILE_KEYS.map(k => `<option value="${k}">${PROFILES[k].label}</option>`).join('')}
                            </select>
                        </div>
                        <div class="if-image-row">
                            <label for="if_cp_size">Size</label>
                            <select id="if_cp_size" class="text_pole">
                                ${SIZE_PRESETS.map(p => `<option value="${p.key}">${p.label}</option>`).join('')}
                                <option value="custom">Custom…</option>
                            </select>
                        </div>
                        <div class="if-image-grid">
                            <div class="if-image-row">
                                <label for="if_cp_width">Width</label>
                                <input id="if_cp_width" type="number" min="256" max="2048" step="64" class="text_pole">
                            </div>
                            <div class="if-image-row">
                                <label for="if_cp_height">Height</label>
                                <input id="if_cp_height" type="number" min="256" max="2048" step="64" class="text_pole">
                            </div>
                            <div class="if-image-row">
                                <label for="if_cp_steps">Steps</label>
                                <input id="if_cp_steps" type="number" min="1" max="150" class="text_pole">
                            </div>
                            <div class="if-image-row">
                                <label for="if_cp_cfg">CFG</label>
                                <input id="if_cp_cfg" type="number" min="0" max="30" step="0.5" class="text_pole">
                            </div>
                            <div class="if-image-row">
                                <label for="if_cp_sampler">Sampler</label>
                                <select id="if_cp_sampler" class="text_pole"></select>
                            </div>
                            <div class="if-image-row">
                                <label for="if_cp_scheduler">Scheduler</label>
                                <select id="if_cp_scheduler" class="text_pole"></select>
                            </div>
                        </div>
                        <div class="if-image-row">
                            <div style="display:flex; gap:6px;">
                                <button id="if_cp_save" class="menu_button">Save profile</button>
                                <button id="if_cp_delete" class="menu_button if-image-btn-danger" style="display:none;">Delete profile</button>
                            </div>
                        </div>
                        <div class="if-image-note">A saved profile ties this checkpoint to a prompt style and generation params. Chat markers using the checkpoint pick them up automatically (marker JSON and LLM hints still override). Without a saved profile the default profile and its Generation Params apply.</div>
                    </div>
                    <div id="if_a1111_cp_list" class="if-image-cp-list"></div>
                </div>
                </div>
    
                <hr class="if-image-sep"/>
                <h3>Test Generate</h3>
                <div class="if-image-note" id="if_test_using">Uses the active profile above (or the fallback prompt style when none is saved).</div>
                <div class="if-image-note" id="if_test_triggers" style="display:none;"></div>
                <div class="if-image-row">
                    <label for="if_test_prompt">Prompt</label>
                    <textarea id="if_test_prompt" class="text_pole textarea_compact" rows="3"></textarea>
                </div>
                <div class="if-image-row">
                    <label for="if_test_seed">Seed (-1 random)</label>
                    <input id="if_test_seed" type="number" min="-1" class="text_pole" style="max-width:160px;">
                </div>
                <div class="if-image-row">
                    <div style="display:flex; gap:6px;">
                        <button id="if_test_generate" class="menu_button">Generate</button>
                        <button id="if_test_cancel" class="menu_button" style="display:none;">Cancel</button>
                    </div>
                </div>
                <div class="if-image-result" id="if_test_error" style="display:none;"></div>
                <div class="if-image-output" id="if_test_output" style="display:none;">
                    <img id="if_test_image" alt="Generated image"/>
                    <div class="if-image-caption" id="if_test_caption"></div>
                    <div class="if-image-actions">
                        <a id="if_test_download" class="menu_button" download="if-image.png">Download</a>
                        <span id="if_test_elapsed"></span>
                    </div>
                </div>
            </div>
    
                </div>
            </details>
        </div>


        <!-- ============ ADVANCED TAB: log section ============ -->
        <div class="if-image-panel" data-if-panel="advanced" style="display:none;">
            <h3>Notifications</h3>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_notifications"> Notify when prompts are filtered and images are generated
                </label>
            </div>
            <div class="if-image-note">Turn this off to suppress IF Image progress toasts.</div>

            <hr class="if-image-sep"/>
            <h3>Generation Log</h3>
            <div class="if-image-row">
                <label for="if_log_limit">Log limit</label>
                <input id="if_log_limit" type="number" min="1" max="500" class="text_pole">
            </div>
            <div class="if-image-row">
                <button id="if_log_refresh" class="menu_button">Refresh</button>
                <button id="if_log_clear" class="menu_button">Clear</button>
            </div>
            <div id="if_log_entries" class="if-image-log"></div>

            <hr class="if-image-sep"/>

            <h3>Live Tasks</h3>
            <div class="if-image-row">
                <button id="if_log_tasks_refresh" class="menu_button">Refresh tasks</button>
            </div>
            <div id="if_log_tasks" class="if-image-log"></div>
        </div>

        <!-- ============ CONNECTION TAB ============ -->
        <div class="if-image-panel" data-if-panel="connection">
            <div id="if_connection_mount"></div>
        </div>


        <!-- ============ CHARACTERS TAB ============ -->
        <div class="if-image-panel" data-if-panel="chars" style="display:none;">
            <div class="if-image-heading-row">
                <h3>Character Presets</h3>
                <!-- D14: ST-style small icon buttons (same pattern as the
                     host's preset import/export controls). -->
                <div class="if-image-icon-actions">
                    <div id="if_preset_import" class="margin0 menu_button_icon menu_button" title="Import preset" tabindex="0" role="button">
                        <i class="fa-fw fa-solid fa-file-import"></i>
                    </div>
                    <div id="if_preset_export" class="margin0 menu_button_icon menu_button" title="Export preset" tabindex="0" role="button">
                        <i class="fa-fw fa-solid fa-file-export"></i>
                    </div>
                    <select id="if_preset_import_mode" class="text_pole" title="Conflict handling for records that already exist (matched by id or name)">
                        <option value="keep-mine" selected>Conflicts: keep mine</option>
                        <option value="overwrite">Conflicts: overwrite</option>
                    </select>
                </div>
                <input id="if_preset_import_file" type="file" accept=".json,application/json" style="display:none;">
            </div>
            <div id="if_preset_status" class="if-image-result"></div>
            <div class="if-image-row">
                <label for="if_char_select">Select Character</label>
                <div style="display:flex; gap:6px;">
                    <select id="if_char_select" class="text_pole" style="flex:1;">
                        <option value="">-- New Character --</option>
                    </select>
                    <button id="if_char_new" class="menu_button">+ New</button>
                </div>
            </div>
            <div class="if-image-row">
                <label for="if_char_name">Name (display only — not a trigger)</label>
                <input id="if_char_name" type="text" class="text_pole" placeholder="e.g. Lyna">
            </div>
            <div class="if-image-row">
                <label for="if_char_aliases">Aliases (comma separated)</label>
                <input id="if_char_aliases" type="text" class="text_pole" placeholder="e.g. lyna, dark elf">
            </div>
            <div class="if-image-row">
                <label for="if_char_count">Count Tag</label>
                <input id="if_char_count" type="text" class="text_pole" value="1girl">
            </div>
            <div class="if-image-row">
                <label for="if_char_booru">Booru Tags (Illus/Anima)</label>
                <textarea id="if_char_booru" class="text_pole textarea_compact" rows="2" placeholder="silver hair, purple eyes, elf ears"></textarea>
            </div>
            <div class="if-image-row">
                <label for="if_char_natural">Natural Description (Krea)</label>
                <textarea id="if_char_natural" class="text_pole textarea_compact" rows="2" placeholder="a young elf woman with long silver hair and glowing purple eyes"></textarea>
            </div>
            <div class="if-image-row">
                <label for="if_char_facts">Neutral Facts (Core traits)</label>
                <textarea id="if_char_facts" class="text_pole textarea_compact" rows="2" placeholder="Age 24, archer, wears leather tunic"></textarea>
            </div>
            <div class="if-image-row">
                <label for="if_char_views_back">View: Back (flat fallback, used when the matrix cell below is empty)</label>
                <input id="if_char_views_back" type="text" class="text_pole" placeholder="e.g. long hair over back, viewed from behind">
            </div>
            <div class="if-image-row">
                <label for="if_char_nsfw_extra">NSFW Extra (flat fallback)</label>
                <textarea id="if_char_nsfw_extra" class="text_pole textarea_compact" rows="2"></textarea>
            </div>
            <div class="if-image-row">
                <label for="if_char_negative">Character Negative</label>
                <textarea id="if_char_negative" class="text_pole textarea_compact" rows="2" placeholder="tags to always exclude for this character"></textarea>
            </div>
            <div class="if-image-row">
                <label for="if_char_lora">LoRA (A1111 format, optional)</label>
                <input id="if_char_lora" type="text" class="text_pole" placeholder="&lt;lora:WinxclubKrea2pack:1&gt;">
            </div>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_char_lock_seed"> Lock seed
                </label>
                <input id="if_char_lock_seed_value" type="number" class="text_pole" style="max-width:140px;" placeholder="-1">
            </div>

            <hr class="if-image-sep"/>
            <h4>Booru Detail Matrix</h4>
            <div class="if-image-note">Per region/rating/view detail tags. An empty cell falls back to the flat fields above (back/nsfw) or is simply omitted (front/lower have no legacy equivalent).</div>
            <table class="if-image-matrix" id="if_char_matrix">
                <thead><tr><th>Region</th><th>SFW front</th><th>SFW back</th><th>NSFW front</th><th>NSFW back</th></tr></thead>
                <tbody>
                    ${['face', 'upper', 'lower'].map(region => `
                    <tr data-region="${region}">
                        <td>${region}</td>
                        <td><input type="text" class="text_pole" data-cell="sfw.front"></td>
                        <td><input type="text" class="text_pole" data-cell="sfw.back"></td>
                        <td><input type="text" class="text_pole" data-cell="nsfw.front"></td>
                        <td><input type="text" class="text_pole" data-cell="nsfw.back"></td>
                    </tr>`).join('')}
                </tbody>
            </table>

            <hr class="if-image-sep"/>
            <h4>Outfits</h4>
            <div class="if-image-note">Outfits with no character assigned ("Common") are usable by every character via the same trigger token.</div>
            <div id="if_char_outfits_list" class="if-image-log"></div>
            <div class="if-image-row">
                <input id="if_char_outfit_name" type="text" class="text_pole" placeholder="Outfit name (trigger: $Name:outfitName)">
            </div>
            <div class="if-image-row">
                <input id="if_char_outfit_tags" type="text" class="text_pole" placeholder="tags appended when this outfit is triggered">
            </div>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_char_outfit_common"> Common (usable by any character)
                </label>
                <button id="if_char_outfit_add" class="menu_button">+ Add / Update Outfit</button>
            </div>

            <div style="display:flex; gap:6px; margin-top:4px;">
                <button id="if_char_save" class="menu_button" style="flex:1;">Save Character</button>
                <button id="if_char_del" class="menu_button if-image-btn-danger">Delete</button>
            </div>
            <div id="if_char_status" class="if-image-result"></div>
        </div>

        <!-- ============ PERSONA & STYLES TAB ============ -->
        <div class="if-image-panel" data-if-panel="presets" style="display:none;">
            <h3>User Persona ($me)</h3>
            <div class="if-image-row">
                <label for="if_per_select">Select Persona</label>
                <div style="display:flex; gap:6px;">
                    <select id="if_per_select" class="text_pole" style="flex:1;">
                        <option value="">-- New Persona --</option>
                    </select>
                    <button id="if_per_new" class="menu_button">+ New</button>
                    <button id="if_per_sync" class="menu_button">Sync from SillyTavern</button>
                    <button id="if_per_del" class="menu_button if-image-btn-danger">Delete</button>
                </div>
            </div>
            <div class="if-image-row">
                <label for="if_per_name">Name (display only — not a trigger)</label>
                <input id="if_per_name" type="text" class="text_pole" value="Default User">
            </div>
            <div class="if-image-row">
                <label for="if_per_aliases">Aliases (comma separated — auto-trigger when these appear in scene text)</label>
                <input id="if_per_aliases" type="text" class="text_pole" placeholder="e.g. user, narrator, self">
            </div>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="checkbox" id="if_per_default"> Default persona ($me resolves to this one)
                </label>
            </div>
            <div class="if-image-row">
                <label for="if_per_pov">Default POV Mode</label>
                <select id="if_per_pov" class="text_pole">
                    <option value="auto">Auto (Context)</option>
                    <option value="hidden">Hidden (Solo girl looking at viewer)</option>
                    <option value="hands">Hands (POV hands in frame)</option>
                    <option value="full">Full (Visible in scene)</option>
                    <option value="third_person">Third Person (No POV)</option>
                </select>
            </div>
            <div class="if-image-row">
                <label for="if_per_booru">Persona Booru Tags</label>
                <input id="if_per_booru" type="text" class="text_pole" placeholder="1boy, black hair, casual clothes">
            </div>
            <div class="if-image-row">
                <label for="if_per_natural">Persona Natural (Krea)</label>
                <input id="if_per_natural" type="text" class="text_pole" placeholder="a young man in casual attire">
            </div>
            <div class="if-image-row">
                <label for="if_per_facts">Persona Facts</label>
                <input id="if_per_facts" type="text" class="text_pole" placeholder="core traits, dialect-free text">
            </div>
            <div class="if-image-row">
                <label for="if_per_avoid">Avoid Tags (comma separated, stripped by cleanup)</label>
                <input id="if_per_avoid" type="text" class="text_pole" placeholder="e.g. beard, glasses">
            </div>
            <div class="if-image-row">
                <label for="if_per_lora">LoRA (A1111 format, optional)</label>
                <input id="if_per_lora" type="text" class="text_pole" placeholder="&lt;lora:MyPersonaLora:1&gt;">
            </div>

            <hr class="if-image-sep"/>
            <h4>Persona Dialect Hints (per-dialect style overrides)</h4>
            <div class="if-image-note">Style fragments merged into the prompt when this persona is rendered in 'full' mode. Leave empty to inherit base booru/natural tags only.</div>
            <div class="if-image-row">
                <label for="if_per_krea_style">Krea: Style Phrase</label>
                <input id="if_per_krea_style" type="text" class="text_pole" placeholder="e.g. cinematic, moody lighting">
            </div>
            <div class="if-image-row">
                <label for="if_per_krea_light">Krea: Lighting</label>
                <input id="if_per_krea_light" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_per_krea_cam">Krea: Camera</label>
                <input id="if_per_krea_cam" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_per_anima_tags">Anima: Booru Tags</label>
                <input id="if_per_anima_tags" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_per_anima_artists">Anima: Artists</label>
                <input id="if_per_anima_artists" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_per_illus_artists">Illustrious: Artists / Tags</label>
                <input id="if_per_illus_artists" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_per_illus_quality">Illustrious: Quality Prefix</label>
                <input id="if_per_illus_quality" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_per_illus_neg">Illustrious: Negative Tags</label>
                <input id="if_per_illus_neg" type="text" class="text_pole">
            </div>

            <div class="if-image-row">
                <button id="if_per_save" class="menu_button">Save Persona</button>
            </div>

            <hr class="if-image-sep"/>

            <h3>Style Preset</h3>
            <div class="if-image-row">
                <label for="if_style_select">Select Style</label>
                <div style="display:flex; gap:6px;">
                    <select id="if_style_select" class="text_pole" style="flex:1;">
                        <option value="">-- New Style --</option>
                    </select>
                    <button id="if_style_new" class="menu_button">+ New</button>
                    <button id="if_style_del" class="menu_button if-image-btn-danger">Delete</button>
                </div>
            </div>
            <div class="if-image-row">
                <label for="if_style_name">Style Name ({{style: Name}})</label>
                <input id="if_style_name" type="text" class="text_pole" placeholder="e.g. Cyberpunk">
            </div>
            <div class="if-image-row">
                <label for="if_style_lora">LoRA (A1111 format, optional)</label>
                <input id="if_style_lora" type="text" class="text_pole" placeholder="&lt;lora:WinxclubKrea2pack:1&gt;">
            </div>
            <div class="if-image-note">Style LoRAs lead the final prompt, ahead of character LoRAs.</div>
            <div class="if-image-row">
                <label for="if_style_krea">Krea: Style Phrase</label>
                <input id="if_style_krea" type="text" class="text_pole" placeholder="cyberpunk aesthetic, neon lighting, 35mm film">
            </div>
            <div class="if-image-row">
                <label for="if_style_krea_light">Krea: Lighting</label>
                <input id="if_style_krea_light" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_style_krea_cam">Krea: Camera</label>
                <input id="if_style_krea_cam" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_style_anima_tags">Anima: Booru Tags</label>
                <input id="if_style_anima_tags" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_style_anima_artists">Anima: Artists</label>
                <input id="if_style_anima_artists" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_style_illus">Illustrious: Artists / Tags</label>
                <input id="if_style_illus" type="text" class="text_pole" placeholder="retro anime, 1990s (style), neon city">
            </div>
            <div class="if-image-row">
                <label for="if_style_illus_quality">Illustrious: Quality Prefix</label>
                <input id="if_style_illus_quality" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <label for="if_style_illus_neg">Illustrious: Negative Tags</label>
                <input id="if_style_illus_neg" type="text" class="text_pole">
            </div>
            <div class="if-image-row">
                <button id="if_style_save" class="menu_button">Save Style</button>
            </div>
            <div id="if_presets_status" class="if-image-result"></div>
        </div>

        <!-- ============ ADVANCED TAB: replace-rules section ============ -->
        <div class="if-image-panel" data-if-panel="advanced" style="display:none;">
            <h3>Replace Rules</h3>
            <div class="if-image-note">Trigger on a tag, then prefix/suffix/replace/delete it. Multi-trigger: "a|b". Condition: "@if dialect==illus", "@if nsfw", "@if !nsfw" (safe evaluator — no code execution). Pipeline order: compile &rarr; non-final rules &rarr; cleanup &rarr; final rules.</div>
            <div id="if_replace_list" class="if-image-log"></div>

            <div class="if-image-row">
                <label for="if_replace_trigger">Trigger (a|b for multiple)</label>
                <input id="if_replace_trigger" type="text" class="text_pole" placeholder="e.g. bad hands|bad fingers">
            </div>
            <div class="if-image-row">
                <label for="if_replace_mode">Mode</label>
                <select id="if_replace_mode" class="text_pole">
                    <option value="replace">replace</option>
                    <option value="prefix-head">prefix-head</option>
                    <option value="prefix-tail">prefix-tail</option>
                    <option value="suffix-head">suffix-head</option>
                    <option value="suffix-tail">suffix-tail</option>
                    <option value="delete">delete</option>
                    <option value="final">final (runs after cleanup)</option>
                </select>
            </div>
            <div class="if-image-row">
                <label for="if_replace_replacement">Replacement</label>
                <input id="if_replace_replacement" type="text" class="text_pole" placeholder="new tag text (ignored for delete)">
            </div>
            <div class="if-image-row">
                <label for="if_replace_condition">Condition (optional)</label>
                <input id="if_replace_condition" type="text" class="text_pole" placeholder="@if dialect==illus">
            </div>
            <div class="if-image-row">
                <button id="if_replace_add" class="menu_button">+ Add Rule</button>
            </div>

            <div class="if-image-row">
                <label for="if_replace_compact">Quick add (compact syntax: "a|b=replacement", mode=replace)</label>
                <input id="if_replace_compact" type="text" class="text_pole" placeholder="bad hands|bad fingers=good hands">
            </div>
            <div class="if-image-row">
                <button id="if_replace_compact_add" class="menu_button">+ Add from compact line</button>
            </div>

            <hr class="if-image-sep"/>
            <h3>Dry-run Preview</h3>
            <div class="if-image-note">Runs the current Test Generate prompt (Settings tab) through compile() including these rules.</div>
            <div class="if-image-row">
                <button id="if_replace_preview" class="menu_button">Preview against Test Gen prompt</button>
            </div>
            <div id="if_replace_preview_out" class="if-image-result"></div>
        </div>

        <!-- ============ GALLERY TAB ============ -->
        <div class="if-image-panel" data-if-panel="gallery" style="display:none;">
            <h3>Gallery <span id="if_gallery_stats" class="if-image-hint"></span></h3>
            <div class="if-image-row">
                <label class="if-image-check">
                    <input type="radio" name="if_gallery_scope" id="if_gallery_scope_chat" value="chat" checked> Current chat
                </label>
                <label class="if-image-check">
                    <input type="radio" name="if_gallery_scope" id="if_gallery_scope_all" value="all"> All chats
                </label>
            </div>
            <div class="if-image-row" style="gap:6px; flex-wrap:wrap;">
                <button id="if_gallery_prune_old" class="menu_button">Delete older than</button>
                <input id="if_gallery_prune_days" type="number" class="text_pole textarea_compact" min="1" step="1" value="30" style="width:64px;"> days
                <button id="if_gallery_prune_chat" class="menu_button if-image-btn-danger">Delete all in this chat</button>
            </div>
            <div class="if-image-row" style="gap:6px; flex-wrap:wrap;" title="0 disables each knob. Applied on load (TTL/size) and on new saves (JPEG).">
                <label>TTL days <input id="if_cache_ttl" type="number" class="text_pole textarea_compact" min="0" step="1" style="width:64px;"></label>
                <label>Max MB <input id="if_cache_maxmb" type="number" class="text_pole textarea_compact" min="0" step="1" style="width:64px;"></label>
                <label>JPEG quality <input id="if_cache_jpegq" type="number" class="text_pole textarea_compact" min="0" max="100" step="1" style="width:64px;"></label>
            </div>
            <div class="if-image-gallery-grid" id="if_gallery_grid"></div>
            <div class="if-image-row" style="justify-content:center; gap:8px;">
                <button id="if_gallery_prev" class="menu_button">&larr; Prev</button>
                <span id="if_gallery_page_label"></span>
                <button id="if_gallery_next" class="menu_button">Next &rarr;</button>
            </div>

            <hr class="if-image-sep"/>
            <div id="if_gallery_detail" style="display:none;">
                <h4>Image Detail</h4>
                <img id="if_gallery_detail_img" style="max-width:100%; max-height:50vh; display:block; border-radius:8px;" alt="Selected generated image"/>
                <div class="if-image-preview-field" id="if_gallery_detail_meta"></div>
                <div class="if-image-row" style="gap:6px;">
                    <a id="if_gallery_detail_download" class="menu_button" download="if-image.png">Download</a>
                    <button id="if_gallery_detail_regen" class="menu_button">Regenerate</button>
                    <button id="if_gallery_detail_delete" class="menu_button if-image-btn-danger">Delete</button>
                    <button id="if_gallery_detail_close" class="menu_button">Close</button>
                </div>
                <div class="if-image-row">
                    <label for="if_gallery_lock_char">Lock seed to character</label>
                    <div style="display:flex; gap:6px;">
                        <select id="if_gallery_lock_char" class="text_pole" style="flex:1;">
                            <option value="">-- select character --</option>
                        </select>
                        <button id="if_gallery_lock_apply" class="menu_button">Lock</button>
                    </div>
                </div>
                <div id="if_gallery_detail_status" class="if-image-result"></div>
            </div>
        </div>

        <!-- ============ ADVANCED TAB: 3-dialect preview section ============ -->
        <div class="if-image-panel" data-if-panel="advanced" style="display:none;">
            <h3>Test-Render (Offline Compiler)</h3>

            <h4>Character Picker (C9)</h4>
            <div class="if-image-note">Pick characters/persona and modifier toggles, then "Insert Tokens" to prepend the matching trigger syntax to the input below.</div>
            <div id="if_render_picker" class="if-image-log"></div>
            <div class="if-image-row">
                <button id="if_render_insert" class="menu_button">Insert Selected as Tokens</button>
                <button id="if_render_clear" class="menu_button">Clear Input</button>
            </div>

            <div class="if-image-row">
                <label for="if_render_input">Input with triggers ($Name, $me, {{style:}}, {{dialect:}})</label>
                <textarea id="if_render_input" class="text_pole textarea_compact" rows="2" placeholder="e.g. $Lyna:back sitting at a bar, neon lights, {{style: Cyberpunk}}"></textarea>
            </div>
            <div class="if-image-row">
                <button id="if_render_btn" class="menu_button">Compile Preview</button>
            </div>

            <div id="if_render_results" style="display:flex; flex-direction:column; gap:8px; margin-top:6px;">
                <div class="if-image-preview-block" data-if-dialect="krea">
                    <strong style="color:#7aa2f7;">1. Krea 2 (Prose):</strong>
                    <div class="if-image-preview-field if-render-prompt" data-dialect="krea"><span class="k">prompt:</span> (Click Compile)</div>
                    <div class="if-image-preview-field if-render-negative" data-dialect="krea"><span class="k">negative:</span></div>
                    <div class="if-image-preview-field if-render-params" data-dialect="krea"><span class="k">params:</span></div>
                </div>
                <div class="if-image-preview-block" data-if-dialect="anima">
                    <strong style="color:#bb9af7;">2. rdbt Anima (Hybrid):</strong>
                    <div class="if-image-preview-field if-render-prompt" data-dialect="anima"><span class="k">prompt:</span> (Click Compile)</div>
                    <div class="if-image-preview-field if-render-negative" data-dialect="anima"><span class="k">negative:</span></div>
                    <div class="if-image-preview-field if-render-params" data-dialect="anima"><span class="k">params:</span></div>
                </div>
                <div class="if-image-preview-block" data-if-dialect="illus">
                    <strong style="color:#7dcfff;">3. Illustrious (Booru):</strong>
                    <div class="if-image-preview-field if-render-prompt" data-dialect="illus"><span class="k">prompt:</span> (Click Compile)</div>
                    <div class="if-image-preview-field if-render-negative" data-dialect="illus"><span class="k">negative:</span></div>
                    <div class="if-image-preview-field if-render-params" data-dialect="illus"><span class="k">params:</span></div>
                </div>
            </div>
        </div>
    </div>`;

    const root = document.createElement('div');
    root.innerHTML = html;
    const el = root.firstElementChild;

    // Element helpers
    const $ = id => el.querySelector('#' + id);

    // Log/prompt/name text is user- or LLM-controlled: always escape before
    // interpolating into innerHTML.
    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ================= Tabs Switching =================
    el.querySelectorAll('.if-image-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            el.querySelectorAll('.if-image-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Several sections share data-if-panel="advanced"; all of them
            // toggle together, so the Advanced tab shows every section.
            el.querySelectorAll('.if-image-panel').forEach(p => {
                p.style.display = p.dataset.ifPanel === btn.dataset.ifTab ? '' : 'none';
            });
        });
    });

    // Settings sub-tabs: one connection per sub-tab (SD | NovelAI).
    el.querySelectorAll('.if-image-subtab').forEach(btn => {
        btn.addEventListener('click', () => {
            el.querySelectorAll('.if-image-subtab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            el.querySelectorAll('[data-if-settings]').forEach(p => {
                p.style.display = p.dataset.ifSettings === btn.dataset.ifSubtab ? '' : 'none';
            });
        });
    });

    // ================= Main Tab Wiring =================
    const mainEnabled = $('if_main_enabled');
    const mainGenEnabled = $('if_main_gen_enabled');
    const mainStart = $('if_main_start');
    const mainEnd = $('if_main_end');
    const mainBackend = $('if_main_backend');
    const mainProfile = $('if_main_profile');
    const mainMode = $('if_main_mode');

    const notifications = $('if_notifications');
    if (notifications) {
        notifications.checked = settings.notifications !== false;
        notifications.addEventListener('change', () => {
            settings.notifications = notifications.checked;
            save();
        });
    }

    mainEnabled.checked = settings.enabled !== false;
    mainGenEnabled.checked = settings.generation.enabled !== false;
    mainStart.value = settings.generation.startTag || 'image###';
    mainEnd.value = settings.generation.endTag || '###';
    mainBackend.value = settings.generation.backend || 'comfy';
    mainProfile.value = settings.generation.profile || 'anima';
    mainMode.value = settings.generation.mode || 'direct';

    mainEnabled.addEventListener('change', () => { settings.enabled = mainEnabled.checked; save(); });
    mainGenEnabled.addEventListener('change', () => { settings.generation.enabled = mainGenEnabled.checked; save(); });
    mainStart.addEventListener('change', () => {
        const value = mainStart.value.trim();
        if (!value) {
            mainStart.value = settings.generation.startTag || 'image###';
            mainStart.setCustomValidity('Start tag cannot be empty.');
            mainStart.reportValidity();
            return;
        }
        mainStart.setCustomValidity('');
        settings.generation.startTag = value;
        save();
    });
    mainEnd.addEventListener('change', () => {
        const value = mainEnd.value.trim();
        if (!value) {
            mainEnd.value = settings.generation.endTag || '###';
            mainEnd.setCustomValidity('End tag cannot be empty.');
            mainEnd.reportValidity();
            return;
        }
        mainEnd.setCustomValidity('');
        settings.generation.endTag = value;
        save();
    });
    mainBackend.addEventListener('change', () => { settings.generation.backend = mainBackend.value; save(); syncTestGenVisibility(); });
    mainProfile.addEventListener('change', () => { settings.generation.profile = mainProfile.value; save(); syncTestGenVisibility(); });
    mainMode.addEventListener('change', () => { settings.generation.mode = mainMode.value; save(); });

    // ================= Chat Placement Wiring =================
    const planMode = $('if_plan_mode');
    const planCount = $('if_plan_count');
    const planCharOnly = $('if_plan_charonly');
    const planContext = $('if_plan_context');
    const planIncludeCharacter = $('if_plan_include_character');
    const planIncludeUser = $('if_plan_include_user');
    const planIncludeFirst = $('if_plan_include_first');
    const planIncludeCard = $('if_plan_include_card');
    const planIncludeInjections = $('if_plan_include_injections');
    const planRewrite = $('if_plan_rewrite');
    const planRun = $('if_plan_run');
    const planUndo = $('if_plan_undo');
    const planResult = $('if_plan_result');
    const chatPlace = settings.llm?.chatPlace ?? {};
    let planAbort = null;
    let lastPlacementSnapshots = []; // [{ messageId, prevMes }] for undo

    if (planMode) {
        planMode.value = chatPlace.planningMode === 'separate' ? 'separate' : 'together';
        planMode.addEventListener('change', () => { chatPlace.planningMode = planMode.value; save(); });
    }
    if (planCount) {
        planCount.value = chatPlace.count ?? 3;
        planCount.addEventListener('change', () => {
            const n = Math.min(6, Math.max(1, parseInt(planCount.value, 10) || 3));
            planCount.value = n;
            chatPlace.count = n;
            save();
        });
    }
    if (planContext) {
        planContext.value = chatPlace.maxChatWindow ?? 40;
        planContext.addEventListener('change', () => {
            chatPlace.maxChatWindow = Math.min(200, Math.max(0, parseInt(planContext.value, 10) || 0));
            planContext.value = chatPlace.maxChatWindow;
            save();
        });
    }
    for (const [control, key, fallback] of [
        [planIncludeCharacter, 'includeCharacterMessages', true],
        [planIncludeUser, 'includeUserMessages', true],
        [planIncludeFirst, 'includeFirstMessage', false],
        [planIncludeCard, 'includeCharacterCard', false],
        [planIncludeInjections, 'includeExtensionPrompts', false],
    ]) {
        if (!control) continue;
        control.checked = chatPlace[key] ?? fallback;
        control.addEventListener('change', () => { chatPlace[key] = control.checked; save(); });
    }
    if (planCharOnly) {
        planCharOnly.checked = chatPlace.onlyCharacter !== false;
        planCharOnly.addEventListener('change', () => {
            chatPlace.onlyCharacter = planCharOnly.checked;
            save();
        });
    }
    if (planRewrite) {
        planRewrite.checked = chatPlace.rewrite !== false;
        planRewrite.addEventListener('change', () => {
            chatPlace.rewrite = planRewrite.checked;
            save();
        });
    }
    if (planRun) {
        planRun.addEventListener('click', async () => {
            // V2: single LLM target from Connection tab (P3 resolveLlmTarget).
            let llmOk = false;
            try { resolveLlmTarget(settings); llmOk = true; } catch { /* no target yet */ }
            const hasProfile = llmOk;
            let hostContext = null;
            try { hostContext = getChatContext?.() ?? null; } catch { /* host context unavailable */ }
            const hasGenerateRaw = typeof hostContext?.generateRaw === 'function';
            if (!hasProfile && !hasGenerateRaw) {
                planResult.textContent = 'LLM not configured. Go to LLM tab and create an API profile (method: ST generateRaw / Connection Manager / Direct fetch), or ensure SillyTavern main API is connected.';
                return;
            }
            if (typeof planChatImages !== 'function') {
                planResult.textContent = 'Plan function not available.';
                return;
            }
            const count = parseInt(planCount?.value, 10) || 3;
            planRun.disabled = true;
            planRun.textContent = 'Planning…';
            planResult.textContent = `Asking LLM to plan ${count} image placements…`;
            planAbort?.abort();
            planAbort = new AbortController();
            try {
                const {
                    placements, method, elapsedMs,
                    rewritten, rewriteChanged, rewriteElapsedMs, rewriteError,
                } = await planChatImages(count, { signal: planAbort.signal });
                if (!placements.length) {
                    planResult.textContent = `LLM returned no valid placements (${method}, ${(elapsedMs / 1000).toFixed(1)}s). Check LLM settings or try again.`;
                    return;
                }
                // Snapshot current message text before injection (for undo)
                const ctx = getChatContext?.() ?? null;
                const chat = ctx?.chat ?? [];
                lastPlacementSnapshots = placements
                    .filter(p => chat[p.messageId])
                    .map(p => ({ messageId: p.messageId, prevMes: chat[p.messageId].mes }));
                // applyPlacements now returns { placed, rendered }; older
                // builds returned a bare count, so accept both shapes.
                const applied = typeof applyPlacements === 'function' ? applyPlacements(placements) : 0;
                const legacyShape = typeof applied === 'number';
                const touched = legacyShape ? applied : (applied?.placed ?? 0);
                const rendered = legacyShape ? null : (applied?.rendered ?? null);
                // Real ids, not the requested ones: a placement can be dropped
                // for a missing message, a duplicate position, or an empty
                // prompt, and pointing the user at a message that never got a
                // marker is its own kind of lie.
                const touchedIds = Array.isArray(applied?.touchedIds) ? [...applied.touchedIds] : [];
                const savedOk = legacyShape ? null : (applied?.saved ?? null);
                const emptyCount = Array.isArray(applied?.skippedEmpty) ? applied.skippedEmpty.length : 0;
                const shadowedCount = Array.isArray(applied?.shadowed) ? applied.shadowed.length : 0;
                const skipped = placements.length - touched - emptyCount;
                // "Injected", not "Placed": this counts markers written into
                // the chat, NOT images produced. Generation happens after this
                // and reports itself through the per-marker chip in the message.
                // Dry-run never reaches a backend, so promising generation
                // would be the same false success this banner exists to avoid.
                const dryRun = settings.generation?.dryRun === true;
                const outcome = touched === 0
                    ? 'nothing to generate'
                    : (dryRun ? 'dry-run is ON, so no image will be generated' : 'generating…');
                let msg = `Injected ${touched} marker${touched !== 1 ? 's' : ''} (${method}, ${(elapsedMs / 1000).toFixed(1)}s) — ${outcome}`;
                // Say WHERE. The planner picks moments anywhere in its chat
                // window, so the marker is often far above the latest message
                // and the user sees only this banner.
                const where = touchedIds.slice().sort((a, b) => a - b);
                if (where.length) msg += ` — at message${where.length !== 1 ? 's' : ''} #${where.join(', #')}`;
                if (rendered !== null && touched > rendered) {
                    const lost = touched - rendered;
                    msg += ` — WARNING: ${lost} message${lost !== 1 ? 's' : ''} could not be re-rendered, so ${lost !== 1 ? 'those markers are' : 'that marker is'} invisible to detection. Reload the chat.`;
                }
                // A failed save means the markers disappear on the next load.
                if (savedOk === false) msg += ' — WARNING: the chat could not be saved, so these markers will be lost on reload.';
                if (shadowedCount > 0) {
                    msg += ` — WARNING: ${shadowedCount} message${shadowedCount !== 1 ? 's have' : ' has'} translated/display text, so the marker is not drawn and will never be detected.`;
                }
                if (emptyCount > 0) msg += ` — ${emptyCount} skipped (the LLM returned an empty prompt)`;
                if (skipped > 0) msg += ` — ${skipped} skipped (duplicate position)`;
                // Report the rewrite pass honestly: silence would read as
                // success even when the second call failed.
                if (rewriteError) {
                    msg += ` — rewrite pass FAILED (${rewriteError}); the planned prompts were used unchanged`;
                } else if (rewritten) {
                    msg += ` — rewrite pass changed ${rewriteChanged ?? 0} prompt${rewriteChanged === 1 ? '' : 's'} (+${((rewriteElapsedMs ?? 0) / 1000).toFixed(1)}s)`;
                }
                planResult.textContent = msg;
            } catch (err) {
                if (err?.code === 'ABORTED' || err?.name === 'AbortError') return;
                planResult.textContent = formatLlmError(err, 'Plan & Place');
            } finally {
                planRun.disabled = false;
                planRun.textContent = 'Plan & place images';
            }
        });
    }
    if (planUndo) {
        planUndo.addEventListener('click', () => {
            if (!lastPlacementSnapshots.length) {
                planResult.textContent = 'Nothing to undo.';
                return;
            }
            const ctx = getChatContext?.() ?? null;
            const msgUpdated = event_types?.MESSAGE_UPDATED;
            const { restored, rendered: undoRendered, saved: undoSaved } = undoPlacements(lastPlacementSnapshots, {
                chat: ctx?.chat ?? [],
                saveChat: () => ctx?.saveChat?.(),
                updateMessageBlock: ctx?.updateMessageBlock
                    ? (id, message) => ctx.updateMessageBlock(id, message)
                    : undefined,
                emit: msgUpdated ? (id) => eventSource?.emit?.(msgUpdated, id) : undefined,
            });
            const count = restored.length;
            let undoMsg = `Undone ${count} placement${count !== 1 ? 's' : ''}.`;
            // Worse than a failed placement: .mes no longer has the marker but
            // the stale text is still on screen, so the undo looks complete.
            if (count > undoRendered) {
                const stale = count - undoRendered;
                undoMsg += ` WARNING: ${stale} message${stale !== 1 ? 's' : ''} could not be re-rendered — the marker text may still be visible. Reload the chat.`;
            }
            if (undoSaved === false) undoMsg += ' WARNING: the chat could not be saved, so the undo may not survive a reload.';
            planResult.textContent = undoMsg;
            lastPlacementSnapshots = [];
        });
    }

    // ================= Test Generate Wiring (Generation tab, Advanced details) =================
    // The old Test Gen tab's own backend/profile/checkpoint/size controls are
    // gone: a test generation uses exactly what marker generation would use —
    // the default backend, the active checkpoint (profile) and mergeParams.
    // Only the prompt and the seed are test-specific.
    const testPrompt = $('if_test_prompt');
    const testSeed = $('if_test_seed');
    const testUsing = $('if_test_using');
    const generateBtn = $('if_test_generate');
    const cancelBtn = $('if_test_cancel');
    const errorBox = $('if_test_error');
    const outputBox = $('if_test_output');
    const imageEl = $('if_test_image');
    const captionEl = $('if_test_caption');
    const downloadEl = $('if_test_download');
    const elapsedEl = $('if_test_elapsed');

    testPrompt.value = settings.test.prompt;
    testSeed.value = settings.test.seed;

    function currentSdConnection() {
        // V2: the Connection tab decides the backend kind (comfy|nai).
        return settings.connection?.imageBackend === 'nai' ? 'nai' : 'comfy';
    }

    /** Active discovered checkpoint for the comfy connection. */
    function activeCheckpointOptions() {
        return {
            models: imageBackend.getDiscoveredModels?.() ?? [],
            stored: settings.connection?.comfy?.model ?? '',
        };
    }

    /**
     * What a generation would use RIGHT NOW: backend kind, prompt profile
     * (active checkpoint profile beats the fallback style) and merged params.
     * Mirrors compile() in index.js minus marker/LLM overrides.
     */
    function effectiveTestSetup() {
        if (settings.connection?.imageBackend === 'nai') {
            const profileKey = settings.generation.profile || 'anima';
            return { backend: 'nai', profileKey, params: mergeParams({ profileKey, settings }) };
        }
        const conn = currentSdConnection();
        if (conn === 'comfy') {
            // D14: the ACTIVE saved profile decides checkpoint + style +
            // params; without one, the raw checkpoint selection + fallback
            // style apply. Mirrors compile() in index.js.
            const active = getActiveProfile(settings);
            const title = active?.entry.checkpoint || settings.connection?.comfy?.model || '';
            const profileKey = active?.entry.profile || settings.generation.profile || 'anima';
            return {
                backend: 'comfy', conn, profileKey, checkpointTitle: title,
                activeName: active?.entry.name || '', hasActive: !!active,
                params: mergeParams({ profileKey, checkpointTitle: title || undefined, profileId: active?.id, settings }),
            };
        }
        const profileKey = settings.generation.profile || 'anima';
        return { backend: 'comfy', conn, profileKey, params: mergeParams({ profileKey, settings }) };
    }

    // The "uses X" note under the Test Generate heading; re-rendered whenever
    // the connection, checkpoint, or a saved profile changes.
    const testTriggers = $('if_test_triggers');
    let triggerUpdateTimer = null;

    async function syncTestGenVisibility() {
        syncMainActiveProfile();
        if (!testUsing) return;
        const setup = effectiveTestSetup();
        const style = PROFILES[setup.profileKey]?.label ?? setup.profileKey;
        const p = setup.params;
        if (setup.backend === 'nai') {
            testUsing.textContent = `Uses NovelAI · ${style} · ${p.width}×${p.height} · ${p.steps} steps · cfg ${p.cfg}.`;
        } else if (setup.conn === 'a1111') {
            const label = setup.activeName || setup.checkpointTitle;
            testUsing.textContent = setup.checkpointTitle
                ? `Uses ${label}${setup.hasActive ? '' : ' (no active profile — fallback style)'} · ${style} · ${p.width}×${p.height} · ${p.steps} steps · cfg ${p.cfg}.`
                : 'No checkpoint selected — pick or save a checkpoint profile above first.';
        } else {
            const model = settings.connection?.comfy?.model || '';
            testUsing.textContent = model
                ? `Uses Comfy proxy · ${model} · ${style} · ${p.width}×${p.height} · ${p.steps} steps · cfg ${p.cfg}.`
                : 'No proxy model selected — click Refresh Models and pick one above first.';
        }

        // Parse the test prompt to show active triggers
        await updateTriggerSummary();
    }

    async function updateTriggerSummary() {
        if (!testTriggers) return;
        const text = testPrompt.value.trim();
        if (!text) { testTriggers.style.display = 'none'; return; }
        try {
            const [characters, styles, personas, outfits] = await Promise.all([
                getAllCharacters(), getAllStyles(), getAllPersonas(), getAllOutfits(),
            ]);
            const ctx = freshChatCtx();
            const triggerContext = buildTriggerContext({
                characters, personas, styles, outfits,
                cardId: ctx?.characters?.[ctx?.characterId]?.avatar ?? null,
                chatId: ctx?.getCurrentChatId?.() ?? getCurrentChatId?.() ?? null,
            });
            const parsed = parseTriggers(text, triggerContext);
            const parts = [];
            for (const item of parsed.characters) {
                if (item.isPersona) {
                    const label = item.persona?.name || 'Persona';
                    const mods = item.modifiers?.length ? ` (${item.modifiers.join('|')})` : '';
                    parts.push(`$me → ${label}${mods}`);
                } else if (item.char) {
                    const mods = item.modifiers?.length ? ` (${item.modifiers.join('|')})` : '';
                    parts.push(`$${item.char.name}${mods}`);
                }
            }
            for (const s of parsed.styles) {
                parts.push(`{{style: ${s.name}}}`);
            }
            if (parsed.dialectOverride) parts.push(`{{dialect: ${parsed.dialectOverride}}}`);
            if (parts.length) {
                testTriggers.textContent = `Active triggers: ${parts.join(' · ')}`;
                testTriggers.style.display = '';
            } else {
                testTriggers.style.display = 'none';
            }
        } catch { testTriggers.style.display = 'none'; }
    }
    syncTestGenVisibility();

    testPrompt.addEventListener('input', () => {
        settings.test.prompt = testPrompt.value;
        save();
        if (triggerUpdateTimer) clearTimeout(triggerUpdateTimer);
        triggerUpdateTimer = setTimeout(updateTriggerSummary, 300);
    });
    testSeed.addEventListener('input', () => {
        settings.test.seed = Number.isFinite(Number(testSeed.value)) ? Number(testSeed.value) : -1;
        save();
    });

    // Object URL hygiene: revoke the previous URL before showing a new one.
    let currentObjectUrl = null;
    function showImage(dataUrl) {
        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = null;
        }
        if (dataUrl.startsWith('blob:')) currentObjectUrl = dataUrl;
        imageEl.src = dataUrl;
        downloadEl.href = dataUrl;
        outputBox.style.display = '';
    }
    function disposeImage() {
        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = null;
        }
        imageEl.removeAttribute('src');
    }

    // Cancellation: aborts the browser request only. The server job (if any)
    // is NOT cancelled — /sdapi/v1/interrupt is never called because a hosted
    // instance may be shared with other users.
    let generateController = null;
    cancelBtn.addEventListener('click', () => {
        if (generateController) generateController.abort();
    });

    generateBtn.addEventListener('click', async () => {
        if (generateController) return; // already running
        errorBox.style.display = 'none';
        outputBox.style.display = 'none';
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating...';
        cancelBtn.style.display = '';
        generateController = new AbortController();
        const startedAt = performance.now();
        try {
            const setup = effectiveTestSetup();
            const profile = PROFILES[setup.profileKey] ?? PROFILES.anima;
            const negative = profile.negativeDisabled ? '' : profile.negative;
            const p = setup.params;
            const seed = settings.test.seed;
            if (setup.backend === 'nai') {
                const blob = await imageBackend.generate({
                    kind: 'nai',
                    model: settings.connection?.nai?.model,                    prompt: settings.test.prompt,
                    negative,
                    width: p.width,
                    height: p.height,
                    steps: p.steps,
                    scale: p.cfg,
                    seed,
                    signal: generateController.signal,
                });
                showImage(URL.createObjectURL(blob));
                captionEl.textContent = `NovelAI · ${p.width}x${p.height} · steps ${p.steps}`;
            } else {
                const { models, stored } = activeCheckpointOptions();
                // The checkpoint must be a discovered model from the ACTIVE
                // source; dialect/profile names are never sent as a model.
                const checkpoint = resolveCheckpoint(models, stored);
                if (!checkpoint) {
                    throw new Error(`No valid checkpoint for the "${'AUTOMATIC1111-compatible API (ComfyCloud)'}" connection. Click Refresh Models above and select a checkpoint (profile ≠ model: family names like anima/krea2/illustrious are not checkpoints).`);
                }
                if (setup.conn === 'comfy') {
                    const result = await imageBackend.generate({
                        kind: 'comfy',
                        model: checkpoint,
                        prompt: settings.test.prompt,
                        negative_prompt: negative,
                        seed,
                        width: p.width,
                        height: p.height,
                        steps: p.steps,
                        cfg_scale: p.cfg,
                        sampler: p.sampler,
                        scheduler: p.scheduler,
                        signal: generateController.signal,
                    });
                    showImage(result.dataUrl);
                    captionEl.textContent = `ComfyCloud · ${checkpoint} · ${p.width}x${p.height}`;
                }
            }
            elapsedEl.textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
        } catch (err) {
            if (err?.name === 'AbortError' || err?.code === 'A1111_ABORTED') {
                errorBox.textContent = 'Generation cancelled. Only the browser request was aborted — the server (if it received the job) may still be processing it.';
            } else {
                errorBox.textContent = err.message;
            }
            errorBox.style.display = '';
            disposeImage();
        } finally {
            generateController = null;
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate';
            cancelBtn.style.display = 'none';
        }
    });

    // ================= Characters Tab Wiring =================
    const charSelect = $('if_char_select');
    const charNewBtn = $('if_char_new');
    const charName = $('if_char_name');
    const charAliases = $('if_char_aliases');
    const charCount = $('if_char_count');
    const charBooru = $('if_char_booru');
    const charNatural = $('if_char_natural');
    const charFacts = $('if_char_facts');
    const charViewsBack = $('if_char_views_back');
    const charNsfwExtra = $('if_char_nsfw_extra');
    const charNegative = $('if_char_negative');
    const charLora = $('if_char_lora');
    const charLockSeed = $('if_char_lock_seed');
    const charLockSeedValue = $('if_char_lock_seed_value');
    const charMatrix = $('if_char_matrix');
    const charOutfitsList = $('if_char_outfits_list');
    const charOutfitName = $('if_char_outfit_name');
    const charOutfitTags = $('if_char_outfit_tags');
    const charOutfitCommon = $('if_char_outfit_common');
    const charOutfitAdd = $('if_char_outfit_add');
    const charSaveBtn = $('if_char_save');
    const charDelBtn = $('if_char_del');
    const charStatus = $('if_char_status');

    let currentChars = [];
    let activeCharId = null;
    let currentOutfits = []; // outfits for the active character (own + common)
    let activeOutfitId = null;

    async function loadCharactersList() {
        try {
            currentChars = await getAllCharacters();
            charSelect.innerHTML = '<option value="">-- New Character --</option>' +
                currentChars.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
            if (activeCharId) charSelect.value = activeCharId;
        } catch (e) {
            console.warn('[IF Image] Load characters failed:', e);
        }
    }
    loadCharactersList();

    // ---- Roster sync (per-user server storage) -----------------------------
    // ---- D7: preset export/import -----------------------------------------
    const presetExportBtn = $('if_preset_export');
    const presetImportBtn = $('if_preset_import');
    const presetImportMode = $('if_preset_import_mode');
    const presetImportFile = $('if_preset_import_file');
    const presetStatus = $('if_preset_status');

    if (presetExportBtn) presetExportBtn.addEventListener('click', async () => {
        try {
            const [characters, outfits, styles, personas, replaceRules] = await Promise.all([
                getAllCharacters(), getAllOutfits(), getAllStyles(), getAllPersonas(), getReplaceRules(),
            ]);
            const doc = buildExport({
                characters, outfits, styles, personas, replaceRules,
                checkpointProfiles: settings.backends?.a1111?.checkpointProfiles ?? {},
            });
            const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `if-image-preset-${new Date().toISOString().slice(0, 10)}.ifimage.json`;
            a.click();
            // Revoked after the click has handed the URL to the download.
            setTimeout(() => URL.revokeObjectURL(url), 0);
            showResult(presetStatus, `Exported ${characters.length} characters, ${outfits.length} outfits, ${styles.length} styles, ${personas.length} personas, ${replaceRules.length} rules.`, false);
        } catch (e) {
            showResult(presetStatus, `Export failed: ${e.message}`, true);
        }
    });

    if (presetImportBtn) presetImportBtn.addEventListener('click', () => presetImportFile?.click());
    if (presetImportFile) presetImportFile.addEventListener('change', async () => {
        const file = presetImportFile.files?.[0];
        presetImportFile.value = ''; // re-selecting the same file re-fires change
        if (!file) return;
        try {
            const json = JSON.parse(await file.text());
            const { ok, errors } = validateImport(json);
            if (!ok) {
                showResult(presetStatus, `Invalid preset: ${errors.slice(0, 3).join(' ')}`, true);
                return;
            }
            const [characters, outfits, styles, personas, replaceRules] = await Promise.all([
                getAllCharacters(), getAllOutfits(), getAllStyles(), getAllPersonas(), getReplaceRules(),
            ]);
            const mode = presetImportMode?.value === 'overwrite' ? 'overwrite' : 'keep-mine';
            const plan = planMerge(
                { characters, outfits, styles, personas, replaceRules, checkpointProfiles: settings.backends?.a1111?.checkpointProfiles ?? {} },
                json, mode,
            );
            // Persist: characters run through CHAR_MIGRATORS before storing.
            for (const c of [...plan.characters.add, ...plan.characters.overwrite]) await saveCharacter(applyCharMigrations(c));
            for (const o of [...plan.outfits.add, ...plan.outfits.overwrite]) await saveOutfit(o);
            for (const s of [...plan.styles.add, ...plan.styles.overwrite]) await saveStyle(s);
            for (const p of [...plan.personas.add, ...plan.personas.overwrite]) await savePersona(p);
            if (plan.replaceRules.add.length || plan.replaceRules.overwrite.length) {
                const byTrigger = new Map(replaceRules.map(r => [String(r.trigger).trim().toLowerCase(), r]));
                for (const rule of [...plan.replaceRules.add, ...plan.replaceRules.overwrite]) {
                    byTrigger.set(String(rule.trigger).trim().toLowerCase(), rule);
                }
                await saveReplaceRules(Array.from(byTrigger.values()));
            }
            if (plan.checkpointProfiles.add.length || plan.checkpointProfiles.overwrite.length) {
                const target = ((settings.connection?.comfy?.modelProfiles ??= {}));
                for (const { title, entry } of [...plan.checkpointProfiles.add, ...plan.checkpointProfiles.overwrite]) {
                    target[title] = entry;
                }
                save();
            }
            const added = Object.values(plan).reduce((n, p) => n + p.add.length, 0);
            const overwritten = Object.values(plan).reduce((n, p) => n + p.overwrite.length, 0);
            const skipped = Object.values(plan).reduce((n, p) => n + p.skip.length, 0);
            showResult(presetStatus, `Import done: ${added} added, ${overwritten} overwritten, ${skipped} skipped (${mode}).`, false);
            await loadCharactersList();
        } catch (e) {
            showResult(presetStatus, `Import failed: ${e.message}`, true);
        }
    });

    function matrixCells() {
        return Array.from(charMatrix.querySelectorAll('tr[data-region]')).flatMap(row => {
            const region = row.dataset.region;
            return Array.from(row.querySelectorAll('input[data-cell]')).map(input => ({ region, path: input.dataset.cell, input }));
        });
    }

    function populateMatrix(detail) {
        const source = detail || emptyBooruDetail();
        for (const { region, path, input } of matrixCells()) {
            const [rating, view] = path.split('.');
            input.value = source[region]?.[rating]?.[view] ?? '';
        }
    }

    function readMatrix() {
        const detail = emptyBooruDetail();
        for (const { region, path, input } of matrixCells()) {
            const [rating, view] = path.split('.');
            detail[region][rating][view] = input.value.trim();
        }
        return detail;
    }

    async function loadOutfitsForActiveChar() {
        activeOutfitId = null;
        if (!activeCharId) { currentOutfits = []; renderOutfitsList(); return; }
        try {
            currentOutfits = await getOutfitsForCharacter(activeCharId);
        } catch (e) {
            console.warn('[IF Image] Load outfits failed:', e);
            currentOutfits = [];
        }
        renderOutfitsList();
    }

    function renderOutfitsList() {
        if (!currentOutfits.length) { charOutfitsList.textContent = 'No outfits yet.'; return; }
        charOutfitsList.innerHTML = currentOutfits.map(o => `
            <div class="if-image-log-entry" data-outfit-id="${escapeHtml(o.id)}">
                <span class="if-image-log-type">${o.charId ? 'own' : 'common'}</span>
                ${escapeHtml(o.name)}: ${escapeHtml(o.tags)}
                <button class="ifimg-outfit-edit menu_button" data-outfit-id="${escapeHtml(o.id)}">Edit</button>
                <button class="ifimg-outfit-del menu_button if-image-btn-danger" data-outfit-id="${escapeHtml(o.id)}" >Delete</button>
            </div>`).join('');
        charOutfitsList.querySelectorAll('.ifimg-outfit-edit').forEach(btn => {
            btn.addEventListener('click', () => {
                const outfit = currentOutfits.find(o => o.id === btn.dataset.outfitId);
                if (!outfit) return;
                activeOutfitId = outfit.id;
                charOutfitName.value = outfit.name;
                charOutfitTags.value = outfit.tags;
                charOutfitCommon.checked = !outfit.charId;
            });
        });
        charOutfitsList.querySelectorAll('.ifimg-outfit-del').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await removeOutfit(btn.dataset.outfitId);
                    await loadOutfitsForActiveChar();
                    showResult(charStatus, 'Outfit deleted.', false);
                } catch (e) {
                    showResult(charStatus, e.message, true);
                }
            });
        });
    }

    charOutfitAdd.addEventListener('click', async () => {
        if (!activeCharId) {
            showResult(charStatus, 'Save the character before adding outfits.', true);
            return;
        }
        const name = charOutfitName.value.trim();
        if (!name) { showResult(charStatus, 'Outfit name is required.', true); return; }
        const outfit = activeOutfitId
            ? currentOutfits.find(o => o.id === activeOutfitId) || createDefaultOutfit(name)
            : createDefaultOutfit(name);
        outfit.name = name;
        outfit.tags = charOutfitTags.value.trim();
        outfit.charId = charOutfitCommon.checked ? null : activeCharId;
        try {
            await saveOutfit(outfit);
            activeOutfitId = null;
            charOutfitName.value = '';
            charOutfitTags.value = '';
            charOutfitCommon.checked = false;
            await loadOutfitsForActiveChar();
            showResult(charStatus, `Outfit "${name}" saved.`, false);
        } catch (e) {
            showResult(charStatus, e.message, true);
        }
    });

    function populateCharForm(char) {
        if (!char) {
            activeCharId = null;
            charName.value = '';
            charAliases.value = '';
            charCount.value = '1girl';
            charBooru.value = '';
            charNatural.value = '';
            charFacts.value = '';
            charViewsBack.value = '';
            charNsfwExtra.value = '';
            charNegative.value = '';
            if (charLora) charLora.value = '';
            charLockSeed.checked = false;
            charLockSeedValue.value = '-1';
            populateMatrix(null);
            loadOutfitsForActiveChar();
            return;
        }
        activeCharId = char.id;
        charName.value = char.name || '';
        charAliases.value = (char.aliases || []).join(', ');
        charCount.value = char.countTag || '1girl';
        charBooru.value = char.booru || '';
        charNatural.value = char.natural || '';
        charFacts.value = char.facts || '';
        charViewsBack.value = char.views?.back || '';
        charNsfwExtra.value = char.nsfwExtra || '';
        charNegative.value = char.negative || '';
        if (charLora) charLora.value = char.lora || '';
        charLockSeed.checked = Number.isInteger(char.lock?.seed) && char.lock.seed >= 0;
        charLockSeedValue.value = String(char.lock?.seed ?? -1);
        populateMatrix(char.booruDetail);
        loadOutfitsForActiveChar();
    }

    charSelect.addEventListener('change', () => {
        const found = currentChars.find(c => c.id === charSelect.value);
        populateCharForm(found);
    });

    charNewBtn.addEventListener('click', () => {
        charSelect.value = '';
        populateCharForm(null);
    });

    charSaveBtn.addEventListener('click', async () => {
        const name = charName.value.trim();
        if (!name) {
            showResult(charStatus, 'Character name cannot be empty', true);
            return;
        }
        let target = currentChars.find(c => c.id === activeCharId);
        if (!target) {
            target = createDefaultCharacter(name);
        }
        target.name = name;
        target.aliases = charAliases.value.split(',').map(s => s.trim()).filter(Boolean);
        target.countTag = charCount.value.trim() || '1girl';
        target.booru = charBooru.value.trim();
        target.natural = charNatural.value.trim();
        target.facts = charFacts.value.trim();
        target.views = { ...(target.views || {}), back: charViewsBack.value.trim() };
        target.nsfwExtra = charNsfwExtra.value.trim();
        target.negative = charNegative.value.trim();
        if (charLora) {
            const loraValue = charLora.value.trim();
            // A malformed LoRA would be dropped silently at compile time, so
            // refuse the save instead of storing something that never loads.
            if (loraValue && !isValidLora(loraValue)) {
                showResult(charStatus, 'LoRA must be a single A1111 token, e.g. <lora:MyLora:1>', true);
                return;
            }
            target.lora = loraValue;
        }
        const seedValue = Number(charLockSeedValue.value);
        target.lock = { seed: charLockSeed.checked && Number.isFinite(seedValue) ? seedValue : -1, params: target.lock?.params ?? null };
        target.booruDetail = readMatrix();

        try {
            await saveCharacter(target);
            activeCharId = target.id;
            await loadCharactersList();
            await loadOutfitsForActiveChar();
            showResult(charStatus, `Character "${name}" saved!`, false);
        } catch (err) {
            showResult(charStatus, err.message, true);
        }
    });

    charDelBtn.addEventListener('click', async () => {
        if (!activeCharId) return;
        try {
            await removeCharacter(activeCharId);
            activeCharId = null;
            populateCharForm(null);
            await loadCharactersList();
            showResult(charStatus, 'Character deleted.', false);
        } catch (err) {
            showResult(charStatus, err.message, true);
        }
    });

    // ================= Persona & Style Wiring =================
    const perSelect = $('if_per_select');
    const perNewBtn = $('if_per_new');
    const perSyncBtn = $('if_per_sync');
    const perDelBtn = $('if_per_del');
    const perName = $('if_per_name');
    const perAliases = $('if_per_aliases');
    const perDefault = $('if_per_default');
    const perPov = $('if_per_pov');
    const perBooru = $('if_per_booru');
    const perNatural = $('if_per_natural');
    const perFacts = $('if_per_facts');
    const perAvoid = $('if_per_avoid');
    const perLora = $('if_per_lora');
    const perKreaStyle = $('if_per_krea_style');
    const perKreaLight = $('if_per_krea_light');
    const perKreaCam = $('if_per_krea_cam');
    const perAnimaTags = $('if_per_anima_tags');
    const perAnimaArtists = $('if_per_anima_artists');
    const perIllusArtists = $('if_per_illus_artists');
    const perIllusQuality = $('if_per_illus_quality');
    const perIllusNeg = $('if_per_illus_neg');
    const perSaveBtn = $('if_per_save');

    const styleSelect = $('if_style_select');
    const styleNewBtn = $('if_style_new');
    const styleDelBtn = $('if_style_del');
    const styleName = $('if_style_name');
    const styleLora = $('if_style_lora');
    const styleLoraPosition = $('if_style_lora_position');
    const styleKrea = $('if_style_krea');
    const styleKreaLight = $('if_style_krea_light');
    const styleKreaCam = $('if_style_krea_cam');
    const styleAnimaTags = $('if_style_anima_tags');
    const styleAnimaArtists = $('if_style_anima_artists');
    const styleIllus = $('if_style_illus');
    const styleIllusQuality = $('if_style_illus_quality');
    const styleIllusNeg = $('if_style_illus_neg');
    const styleSaveBtn = $('if_style_save');
    const presetsStatus = $('if_presets_status');

    let currentPersonas = [];
    let currentStyles = [];
    let activePersonaId = null;
    let activeStyleId = null;

    function populatePersonaForm(p) {
        activePersonaId = p?.id ?? null;
        perName.value = p?.name ?? 'Default User';
        perAliases.value = (p?.aliases || []).join(', ');
        perDefault.checked = Boolean(p?.isDefault);
        perPov.value = p?.povMode ?? 'auto';
        perBooru.value = p?.booru ?? '';
        perNatural.value = p?.natural ?? '';
        perFacts.value = p?.facts ?? '';
        perAvoid.value = (p?.avoidTags || []).join(', ');
        if (perLora) perLora.value = p?.lora ?? '';
        const h = p?.dialectHints;
        perKreaStyle.value = h?.krea?.stylePhrase ?? '';
        perKreaLight.value = h?.krea?.lighting ?? '';
        perKreaCam.value = h?.krea?.camera ?? '';
        perAnimaTags.value = h?.anima?.booruTags ?? '';
        perAnimaArtists.value = h?.anima?.artists ?? '';
        perIllusArtists.value = h?.illus?.artists ?? '';
        perIllusQuality.value = h?.illus?.qualityPrefix ?? '';
        perIllusNeg.value = h?.illus?.negativeTags ?? '';
    }

    function populateStyleForm(s) {
        activeStyleId = s?.id ?? null;
        styleName.value = s?.name ?? '';
        if (styleLora) styleLora.value = s?.lora ?? '';
        styleKrea.value = s?.dialectHints?.krea?.stylePhrase ?? '';
        styleKreaLight.value = s?.dialectHints?.krea?.lighting ?? '';
        styleKreaCam.value = s?.dialectHints?.krea?.camera ?? '';
        styleAnimaTags.value = s?.dialectHints?.anima?.booruTags ?? '';
        styleAnimaArtists.value = s?.dialectHints?.anima?.artists ?? '';
        styleIllus.value = s?.dialectHints?.illus?.artists ?? '';
        styleIllusQuality.value = s?.dialectHints?.illus?.qualityPrefix ?? '';
        styleIllusNeg.value = s?.dialectHints?.illus?.negativeTags ?? '';
    }

    function refreshPersonaSelect() {
        perSelect.innerHTML = '<option value="">-- New Persona --</option>' +
            currentPersonas.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.isDefault ? ' (default)' : ''}</option>`).join('');
        if (activePersonaId) perSelect.value = activePersonaId;
    }

    function refreshStyleSelect() {
        styleSelect.innerHTML = '<option value="">-- New Style --</option>' +
            currentStyles.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
        if (activeStyleId) styleSelect.value = activeStyleId;
    }

    async function loadPresets() {
        try {
            currentPersonas = await getAllPersonas();
            currentStyles = await getAllStyles();
            refreshPersonaSelect();
            refreshStyleSelect();
            const activePersona = currentPersonas.find(p => p.id === activePersonaId)
                ?? currentPersonas.find(p => p.isDefault)
                ?? currentPersonas[0]
                ?? null;
            populatePersonaForm(activePersona);
            refreshPersonaSelect();
            const activeStyle = currentStyles.find(s => s.id === activeStyleId) ?? null;
            populateStyleForm(activeStyle);
            // Refresh the Generation tab style UI whenever the roster changes.
            if (typeof refreshMainStyle === 'function') refreshMainStyle();
        } catch (e) {
            console.warn('[IF Image] Presets load error:', e);
        }
    }
    loadPresets();

    // Import only the host persona display name.
    if (perSyncBtn) perSyncBtn.addEventListener('click', async () => {
        if (typeof importPersonaNameFromSt !== 'function') {
            showResult(presetsStatus, 'Persona name import is not available.', true);
            return;
        }
        const originalText = perSyncBtn.textContent;
        perSyncBtn.disabled = true;
        perSyncBtn.textContent = 'Importing...';
        const controller = new AbortController();
        try {
            const result = await importPersonaNameFromSt();
            if (typeof result?.name !== 'string' || !result.name.trim()) {
                throw new Error('SillyTavern returned no persona name.');
            }
            const target = currentPersonas.find(persona => persona.id === activePersonaId)
                ?? currentPersonas.find(persona => persona.isDefault)
                ?? currentPersonas[0]
                ?? createDefaultPersona(result.name);
            applyPersonaNameImport(target, result);
            await savePersona(target);
            activePersonaId = target.id;
            await loadPresets();
            await refreshRoster?.();
            perSelect.value = target.id;
            const message = `Imported persona name: ${target.name}`;
            showResult(presetsStatus, message, false);
            if (typeof toastr !== 'undefined') toastr.success(message, 'IF Image');
        } catch (err) {
            const message = formatLlmError(err, 'Persona name import');
            showResult(presetsStatus, message, true);
            if (typeof toastr !== 'undefined') toastr.error(message, 'IF Image');
        } finally {
            perSyncBtn.disabled = false;
            perSyncBtn.textContent = originalText;
        }
    });

    perSelect.addEventListener('change', () => {
        populatePersonaForm(currentPersonas.find(p => p.id === perSelect.value) ?? null);
    });
    perNewBtn.addEventListener('click', () => {
        perSelect.value = '';
        populatePersonaForm(null);
    });
    perDelBtn.addEventListener('click', async () => {
        if (!activePersonaId) return;
        try {
            await removePersona(activePersonaId);
            activePersonaId = null;
            await loadPresets();
            showResult(presetsStatus, 'Persona deleted.', false);
        } catch (e) {
            showResult(presetsStatus, e.message, true);
        }
    });

    perSaveBtn.addEventListener('click', async () => {
        const name = perName.value.trim();
        if (!name) { showResult(presetsStatus, 'Persona name is required', true); return; }
        try {
            const existing = currentPersonas.find(p => p.id === activePersonaId);
            const p = existing || createDefaultPersona(name);
            p.name = name;
            p.aliases = perAliases.value.split(',').map(s => s.trim()).filter(Boolean);
            p.povMode = perPov.value;
            p.booru = perBooru.value.trim();
            p.natural = perNatural.value.trim();
            p.facts = perFacts.value.trim();
            p.avoidTags = perAvoid.value.split(',').map(s => s.trim()).filter(Boolean);
            if (perLora) {
                const loraValue = perLora.value.trim();
                if (loraValue && !isValidLora(loraValue)) {
                    showResult(presetsStatus, 'LoRA must be a single A1111 token, e.g. <lora:MyLora:1>', true);
                    return;
                }
                p.lora = loraValue;
            }
            p.isDefault = perDefault.checked;
            p.dialectHints = p.dialectHints || {};
            p.dialectHints.krea = p.dialectHints.krea || {};
            p.dialectHints.krea.stylePhrase = perKreaStyle.value.trim();
            p.dialectHints.krea.lighting = perKreaLight.value.trim();
            p.dialectHints.krea.camera = perKreaCam.value.trim();
            p.dialectHints.anima = p.dialectHints.anima || {};
            p.dialectHints.anima.booruTags = perAnimaTags.value.trim();
            p.dialectHints.anima.artists = perAnimaArtists.value.trim();
            p.dialectHints.illus = p.dialectHints.illus || {};
            p.dialectHints.illus.artists = perIllusArtists.value.trim();
            p.dialectHints.illus.qualityPrefix = perIllusQuality.value.trim();
            p.dialectHints.illus.negativeTags = perIllusNeg.value.trim();
            await savePersona(p);
            // Only one persona may be default at a time.
            if (p.isDefault) {
                for (const other of currentPersonas) {
                    if (other.id !== p.id && other.isDefault) {
                        other.isDefault = false;
                        await savePersona(other);
                    }
                }
            }
            activePersonaId = p.id;
            await loadPresets();
            showResult(presetsStatus, 'Persona saved!', false);
        } catch (e) {
            showResult(presetsStatus, e.message, true);
        }
    });

    styleSelect.addEventListener('change', () => {
        populateStyleForm(currentStyles.find(s => s.id === styleSelect.value) ?? null);
    });
    styleNewBtn.addEventListener('click', () => {
        styleSelect.value = '';
        populateStyleForm(null);
    });
    styleDelBtn.addEventListener('click', async () => {
        if (!activeStyleId) return;
        try {
            await removeStyle(activeStyleId);
            activeStyleId = null;
            await loadPresets();
            showResult(presetsStatus, 'Style deleted.', false);
        } catch (e) {
            showResult(presetsStatus, e.message, true);
        }
    });

    styleSaveBtn.addEventListener('click', async () => {
        const name = styleName.value.trim();
        if (!name) {
            showResult(presetsStatus, 'Style name is required', true);
            return;
        }
        try {
            const existing = currentStyles.find(s => s.id === activeStyleId);
            const s = existing || createDefaultStyle(name);
            s.name = name;
            if (styleLora) {
                const loraValue = styleLora.value.trim();
                if (loraValue && !isValidLora(loraValue)) {
                    showResult(presetsStatus, 'LoRA must be a single A1111 token, e.g. <lora:MyLora:1>', true);
                    return;
                }
                s.lora = loraValue;
            }
            s.dialectHints.krea.stylePhrase = styleKrea.value.trim();
            s.dialectHints.krea.lighting = styleKreaLight.value.trim();
            s.dialectHints.krea.camera = styleKreaCam.value.trim();
            s.dialectHints.anima.booruTags = styleAnimaTags.value.trim();
            s.dialectHints.anima.artists = styleAnimaArtists.value.trim();
            s.dialectHints.illus.artists = styleIllus.value.trim();
            s.dialectHints.illus.qualityPrefix = styleIllusQuality.value.trim();
            s.dialectHints.illus.negativeTags = styleIllusNeg.value.trim();
            await saveStyle(s);
            activeStyleId = s.id;
            await loadPresets();
            showResult(presetsStatus, `Style "${name}" saved!`, false);
        } catch (e) {
            showResult(presetsStatus, e.message, true);
        }
    });


    // ================= Replace Rules Wiring =================
    const replaceList = $('if_replace_list');
    const replaceTrigger = $('if_replace_trigger');
    const replaceMode = $('if_replace_mode');
    const replaceReplacement = $('if_replace_replacement');
    const replaceCondition = $('if_replace_condition');
    const replaceAdd = $('if_replace_add');
    const replaceCompact = $('if_replace_compact');
    const replaceCompactAdd = $('if_replace_compact_add');
    const replacePreviewBtn = $('if_replace_preview');
    const replacePreviewOut = $('if_replace_preview_out');

    let currentRules = [];

    async function loadReplaceRules() {
        try {
            currentRules = await getReplaceRules();
        } catch (e) {
            console.warn('[IF Image] Load replace rules failed:', e);
            currentRules = [];
        }
        renderReplaceList();
    }

    function renderReplaceList() {
        if (!currentRules.length) { replaceList.textContent = 'No rules yet.'; return; }
        replaceList.innerHTML = currentRules.map((r, i) => `
            <div class="if-image-log-entry">
                <span class="if-image-log-type">${escapeHtml(r.mode)}</span>
                "${escapeHtml(r.trigger)}" &rarr; "${escapeHtml(r.replacement ?? '')}"
                ${r.condition ? ` [${escapeHtml(r.condition)}]` : ''}
                <button class="ifimg-rule-del menu_button if-image-btn-danger" data-idx="${i}" >Delete</button>
            </div>`).join('');
        replaceList.querySelectorAll('.ifimg-rule-del').forEach(btn => {
            btn.addEventListener('click', async () => {
                currentRules.splice(Number(btn.dataset.idx), 1);
                await saveReplaceRules(currentRules);
                renderReplaceList();
            });
        });
    }
    loadReplaceRules();

    replaceAdd.addEventListener('click', async () => {
        const trigger = replaceTrigger.value.trim();
        if (!trigger) return;
        currentRules.push({
            trigger,
            mode: replaceMode.value,
            replacement: replaceReplacement.value.trim(),
            condition: replaceCondition.value.trim() || undefined,
        });
        await saveReplaceRules(currentRules);
        replaceTrigger.value = '';
        replaceReplacement.value = '';
        replaceCondition.value = '';
        renderReplaceList();
    });

    replaceCompactAdd.addEventListener('click', async () => {
        const rule = parseCompactRule(replaceCompact.value);
        if (!rule) return;
        currentRules.push(rule);
        await saveReplaceRules(currentRules);
        replaceCompact.value = '';
        renderReplaceList();
    });

    replacePreviewBtn.addEventListener('click', () => {
        try {
            const text = testPrompt.value.trim();
            if (!text) { replacePreviewOut.textContent = 'The Test Generate prompt (Settings tab) is empty.'; return; }
            // Same prompt style the Test Generate section would use.
            const profileKey = effectiveTestSetup().profileKey;
            const profile = PROFILES[profileKey] ?? PROFILES.anima;
            // Parameter-only parsing: no entity roster is intentionally needed here.
            const parsed = parseTriggers(text, {});
            const assembled = assemblePrompt(parsed, profile.dialect, profile);
            const ctx = { dialect: profile.dialect, nsfw: false, back: false, full: false };
            let envelope = applyReplaceRules(assembled, currentRules, 'pre', ctx);
            envelope = cleanupEnvelope(envelope, profile.dialect, { avoidTags: [], rating: 'nsfw' });
            envelope = applyReplaceRules(envelope, currentRules, 'final', ctx);
            replacePreviewOut.innerHTML = `<div><span class="k">before:</span> ${escapeHtml(assembled.prompt)}</div><div><span class="k">after:</span> ${escapeHtml(envelope.prompt)}</div>`;
            replacePreviewOut.classList.remove('error');
        } catch (e) {
            showResult(replacePreviewOut, e.message, true);
        }
    });

    // ================= Gallery Tab Wiring (C10) =================
    const galleryGrid = $('if_gallery_grid');
    const galleryPrevBtn = $('if_gallery_prev');
    const galleryNextBtn = $('if_gallery_next');
    const galleryPageLabel = $('if_gallery_page_label');
    const galleryDetail = $('if_gallery_detail');
    const galleryDetailImg = $('if_gallery_detail_img');
    const galleryDetailMeta = $('if_gallery_detail_meta');
    const galleryDetailDownload = $('if_gallery_detail_download');
    const galleryDetailRegen = $('if_gallery_detail_regen');
    const galleryLockChar = $('if_gallery_lock_char');
    const galleryLockApply = $('if_gallery_lock_apply');
    const galleryDetailDelete = $('if_gallery_detail_delete');
    const galleryDetailClose = $('if_gallery_detail_close');
    const galleryDetailStatus = $('if_gallery_detail_status');

    const GALLERY_PAGE_SIZE = 24;
    let galleryPage = 0;
    let galleryTotal = 0;
    let galleryItems = [];
    // Object URLs are created here for display only (listImages() itself
    // never attaches one) and revoked on every reload/page change so a
    // closed gallery tab never leaks blob URLs.
    let galleryUrls = new Map(); // record id -> object URL
    let galleryDetailId = null;

    function galleryScope() {
        return $('if_gallery_scope_all')?.checked ? 'all' : 'chat';
    }

    function revokeGalleryUrls() {
        for (const url of galleryUrls.values()) URL.revokeObjectURL(url);
        galleryUrls.clear();
    }

    function closeGalleryDetail() {
        galleryDetailId = null;
        galleryDetail.style.display = 'none';
    }

    async function loadGalleryPage() {
        revokeGalleryUrls();
        closeGalleryDetail();
        const scope = galleryScope();
        const chatId = scope === 'chat' && typeof getCurrentChatId === 'function' ? getCurrentChatId() : undefined;
        try {
            const [items, total] = await Promise.all([
                listImages({ chatId, offset: galleryPage * GALLERY_PAGE_SIZE, limit: GALLERY_PAGE_SIZE }),
                countImages({ chatId }),
            ]);
            galleryItems = items;
            galleryTotal = total;
            renderGalleryGrid();
        } catch (e) {
            galleryGrid.textContent = '';
            console.warn('[IF Image] Gallery load failed:', e);
        }
        refreshGalleryStats(chatId);
    }

    // D6: "N images · X MB" header (blob records only, scope-aware).
    const galleryStats = $('if_gallery_stats');
    async function refreshGalleryStats(chatId) {
        if (!galleryStats) return;
        try {
            const { count, bytes } = await getStorageStats({ chatId });
            galleryStats.textContent = `${count} image${count === 1 ? '' : 's'} · ${(bytes / 1048576).toFixed(1)} MB`;
        } catch (e) {
            galleryStats.textContent = '';
            console.warn('[IF Image] Gallery stats failed:', e);
        }
    }

    function renderGalleryGrid() {
        for (const record of galleryItems) {
            galleryUrls.set(record.id, URL.createObjectURL(record.blob));
        }
        // Blob URLs are browser-generated (opaque, no user-controlled
        // characters) and safe to interpolate directly; every other field
        // still goes through escapeHtml via data-record-id lookups below.
        galleryGrid.innerHTML = galleryItems.map(record => `
            <div class="if-image-gallery-thumb" data-record-id="${escapeHtml(record.id)}">
                <img src="${galleryUrls.get(record.id)}" alt="Generated image">
            </div>`).join('');
        galleryGrid.querySelectorAll('[data-record-id]').forEach(node => {
            node.addEventListener('click', () => {
                const record = galleryItems.find(r => r.id === node.dataset.recordId);
                if (record) openGalleryDetail(record);
            });
        });
        const totalPages = Math.max(1, Math.ceil(galleryTotal / GALLERY_PAGE_SIZE));
        galleryPageLabel.textContent = `Page ${galleryPage + 1} / ${totalPages} (${galleryTotal} image${galleryTotal === 1 ? '' : 's'})`;
        galleryPrevBtn.disabled = galleryPage <= 0;
        galleryNextBtn.disabled = (galleryPage + 1) * GALLERY_PAGE_SIZE >= galleryTotal;
        if (!galleryItems.length) galleryGrid.textContent = 'No images yet.';
    }

    function openGalleryDetail(record) {
        galleryDetailId = record.id;
        const url = galleryUrls.get(record.id);
        galleryDetailImg.src = url;
        galleryDetailDownload.href = url;
        const when = record.timestamp ? new Date(record.timestamp).toLocaleString() : '(unknown time)';
        galleryDetailMeta.innerHTML = [
            `<span class="k">when:</span> ${escapeHtml(when)}`,
            `<span class="k">backend:</span> ${escapeHtml(record.backend || '(unknown)')}`,
            `<span class="k">profile:</span> ${escapeHtml(record.profileKey || '(unknown)')}`,
            `<span class="k">size:</span> ${record.width || '?'}x${record.height || '?'} · seed ${record.seed ?? '?'}`,
            `<span class="k">prompt:</span> ${escapeHtml(record.prompt || '')}`,
        ].join('<br>');
        showResult(galleryDetailStatus, '', false);
        // D2: Lock needs a concrete non-random seed to be meaningful.
        const hasSeed = Number.isInteger(record.seed) && record.seed >= 0;
        galleryLockApply.disabled = !hasSeed;
        populateGalleryLockSelect();
        galleryDetail.style.display = '';
    }

    // D2: roster select for "Lock seed to character". Loaded on each detail
    // open so it reflects characters added since the drawer mounted.
    async function populateGalleryLockSelect() {
        try {
            const chars = await getAllCharacters();
            galleryLockChar.innerHTML = '<option value="">-- select character --</option>' +
                chars.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
        } catch (e) {
            console.warn('[IF Image] Lock-seed roster load failed:', e);
        }
    }

    galleryLockApply.addEventListener('click', async () => {
        if (!galleryDetailId || !galleryLockChar.value) return;
        const record = galleryItems.find(r => r.id === galleryDetailId);
        if (!record || !Number.isInteger(record.seed) || record.seed < 0) return;
        try {
            const chars = await getAllCharacters();
            const target = chars.find(c => c.id === galleryLockChar.value);
            if (!target) { showResult(galleryDetailStatus, 'Character not found.', true); return; }
            target.lock = { seed: record.seed, params: target.lock?.params ?? null };
            await saveCharacter(target);
            showResult(galleryDetailStatus, `Locked seed ${record.seed} to ${target.name}.`, false);
            // Refresh the character editor if that character is open there.
            if (activeCharId === target.id) {
                await loadCharactersList();
                charLockSeed.checked = true;
                charLockSeedValue.value = String(record.seed);
            }
        } catch (e) {
            showResult(galleryDetailStatus, e.message, true);
        }
    });

    galleryPrevBtn.addEventListener('click', () => {
        if (galleryPage <= 0) return;
        galleryPage -= 1;
        loadGalleryPage();
    });
    galleryNextBtn.addEventListener('click', () => {
        if ((galleryPage + 1) * GALLERY_PAGE_SIZE >= galleryTotal) return;
        galleryPage += 1;
        loadGalleryPage();
    });
    el.querySelectorAll('input[name="if_gallery_scope"]').forEach(radio => {
        radio.addEventListener('change', () => {
            galleryPage = 0;
            loadGalleryPage();
        });
    });
    galleryDetailClose.addEventListener('click', closeGalleryDetail);

    // ---- D6: cache management (prune buttons + settings inputs) ----------
    const pruneOldBtn = $('if_gallery_prune_old');
    const pruneDaysEl = $('if_gallery_prune_days');
    const pruneChatBtn = $('if_gallery_prune_chat');
    if (pruneOldBtn) pruneOldBtn.addEventListener('click', async () => {
        const days = Number(pruneDaysEl?.value);
        if (!Number.isFinite(days) || days < 1) return;
        if (!confirm(`Delete images older than ${days} day(s)? Each marker keeps its newest image.`)) return;
        try {
            const { deleted, bytesFreed } = await pruneImages({ olderThanMs: days * 86400000 });
            showResult(galleryDetailStatus, `Deleted ${deleted} image(s), freed ${(bytesFreed / 1048576).toFixed(1)} MB.`, false);
            galleryPage = 0;
            await loadGalleryPage();
        } catch (e) {
            showResult(galleryDetailStatus, e.message, true);
        }
    });
    if (pruneChatBtn) pruneChatBtn.addEventListener('click', async () => {
        const chatId = typeof getCurrentChatId === 'function' ? getCurrentChatId() : undefined;
        if (!chatId) { showResult(galleryDetailStatus, 'No active chat.', true); return; }
        if (!confirm('Delete ALL images in this chat? Each marker keeps its newest image.')) return;
        try {
            // olderThanMs: everything qualifies; the newest-per-slot rule
            // still protects each marker's latest image.
            const { deleted, bytesFreed } = await pruneImages({ chatId, olderThanMs: 1 });
            showResult(galleryDetailStatus, `Deleted ${deleted} image(s), freed ${(bytesFreed / 1048576).toFixed(1)} MB.`, false);
            galleryPage = 0;
            await loadGalleryPage();
        } catch (e) {
            showResult(galleryDetailStatus, e.message, true);
        }
    });
    // Cache settings (migrator v7 defaults 0/0/0 = all off).
    const cacheDefaults = () => (settings.cache ??= { ttlDays: 0, maxMB: 0, jpegQuality: 0 });
    const cacheInput = (id, key, max) => {
        const input = $(id);
        if (!input) return;
        input.value = String(cacheDefaults()[key] ?? 0);
        input.addEventListener('change', () => {
            let n = Math.max(0, Math.round(Number(input.value) || 0));
            if (max !== undefined) n = Math.min(max, n);
            input.value = String(n);
            cacheDefaults()[key] = n;
            save();
        });
    };
    cacheInput('if_cache_ttl', 'ttlDays');
    cacheInput('if_cache_maxmb', 'maxMB');
    cacheInput('if_cache_jpegq', 'jpegQuality', 100);

    galleryDetailDelete.addEventListener('click', async () => {
        if (!galleryDetailId) return;
        try {
            await deleteImageRecord(galleryDetailId);
            showResult(galleryDetailStatus, 'Deleted.', false);
            await loadGalleryPage();
        } catch (e) {
            showResult(galleryDetailStatus, e.message, true);
        }
    });

    galleryDetailRegen.addEventListener('click', async () => {
        if (!galleryDetailId) return;
        const record = galleryItems.find(r => r.id === galleryDetailId);
        if (!record) return;
        if (typeof regenerateImage !== 'function') {
            showResult(galleryDetailStatus, 'Regenerate is unavailable in this context.', true);
            return;
        }
        galleryDetailRegen.disabled = true;
        showResult(galleryDetailStatus, 'Regenerating...', false);
        try {
            await regenerateImage(record);
            showResult(galleryDetailStatus, 'Regenerated — a new image was added to the gallery.', false);
            galleryPage = 0;
            await loadGalleryPage();
        } catch (e) {
            showResult(galleryDetailStatus, e.message, true);
        } finally {
            galleryDetailRegen.disabled = false;
        }
    });

    // Loaded lazily on first activation, not on drawer mount, so opening the
    // extensions panel never triggers an IndexedDB round-trip for a tab the
    // user hasn't looked at.
    let galleryLoaded = false;
    el.querySelector('[data-if-tab="gallery"]')?.addEventListener('click', () => {
        if (galleryLoaded) return;
        galleryLoaded = true;
        loadGalleryPage();
    });

    // ================= 3-Dialect Preview: Character Picker (C9) =================
    const renderPicker = $('if_render_picker');
    const renderInsertBtn = $('if_render_insert');
    const renderClearBtn = $('if_render_clear');

    let pickerRoster = [];
    let pickerOutfits = [];
    let pickerHasPersona = false;

    function pickerRowHtml(id, label, outfits) {
        const outfitOptions = outfits.length
            ? outfits.map(o => `<option value="${escapeHtml(o.name)}">${escapeHtml(o.name)}${o.charId ? '' : ' (common)'}</option>`).join('')
            : '';
        return `
            <div class="if-image-log-entry" data-picker-id="${escapeHtml(id)}">
                <label class="if-image-check"><input type="checkbox" class="if-picker-select"> ${escapeHtml(label)}</label>
                <label class="if-image-check"><input type="checkbox" class="if-picker-back"> back</label>
                <label class="if-image-check"><input type="checkbox" class="if-picker-full"> full</label>
                <label class="if-image-check"><input type="checkbox" class="if-picker-nsfw"> nsfw</label>
                ${outfits.length ? `<select class="if-picker-outfit text_pole"><option value="">-- outfit: none --</option>${outfitOptions}</select>` : ''}
            </div>`;
    }

    async function loadCharPicker() {
        try {
            pickerRoster = await getAllCharacters();
            const allOutfits = await (async () => {
                try {
                    const per = await Promise.all(pickerRoster.map(c => getOutfitsForCharacter(c.id)));
                    return per;
                } catch { return pickerRoster.map(() => []); }
            })();
            pickerOutfits = allOutfits;
            const personas = await getAllPersonas();
            pickerHasPersona = personas.length > 0;
        } catch (e) {
            console.warn('[IF Image] Character picker load failed:', e);
            pickerRoster = [];
            pickerOutfits = [];
            pickerHasPersona = false;
        }
        renderCharPicker();
    }

    function renderCharPicker() {
        if (!renderPicker) return;
        const rows = pickerRoster.map((c, i) => pickerRowHtml(c.id, c.name, pickerOutfits[i] || []));
        if (pickerHasPersona) rows.push(pickerRowHtml('__persona__', '$me (Persona)', []));
        renderPicker.innerHTML = rows.length ? rows.join('') : 'No characters yet — add some in the Characters tab.';
    }

    function pickerTokens() {
        if (!renderPicker) return [];
        const tokens = [];
        renderPicker.querySelectorAll('[data-picker-id]').forEach(row => {
            if (!row.querySelector('.if-picker-select')?.checked) return;
            const mods = [];
            if (row.querySelector('.if-picker-back')?.checked) mods.push('back');
            if (row.querySelector('.if-picker-full')?.checked) mods.push('full');
            if (row.querySelector('.if-picker-nsfw')?.checked) mods.push('nsfw');
            const outfit = row.querySelector('.if-picker-outfit')?.value;
            if (outfit) mods.push(outfit);
            const id = row.dataset.pickerId;
            if (id === '__persona__') {
                tokens.push(mods.length ? `$me:${mods.join('|')}` : '$me');
                return;
            }
            const char = pickerRoster.find(c => c.id === id);
            if (!char) return;
            tokens.push(mods.length ? `$${char.name}:${mods.join('|')}` : `$${char.name}`);
        });
        return tokens;
    }

    if (renderInsertBtn) renderInsertBtn.addEventListener('click', () => {
        const tokens = pickerTokens();
        if (!tokens.length) return;
        const current = renderInput.value.trim();
        renderInput.value = current ? `${tokens.join(' ')} ${current}` : tokens.join(' ');
    });
    if (renderClearBtn) renderClearBtn.addEventListener('click', () => { renderInput.value = ''; });

    loadCharPicker();

    // ================= 3-Dialect Preview Wiring =================
    const renderInput = $('if_render_input');
    const renderBtn = $('if_render_btn');

    function renderPreviewBlock(dialect, output, active) {
        const block = el.querySelector(`[data-if-dialect="${dialect}"]`);
        if (!block) return;
        block.classList.toggle('active', active);
        const promptEl = block.querySelector('.if-render-prompt');
        const negEl = block.querySelector('.if-render-negative');
        const paramsEl = block.querySelector('.if-render-params');
        // R4: prompt/negative are user-typed trigger text — escape them.
        if (promptEl) promptEl.innerHTML = `<span class="k">prompt:</span> ${escapeHtml(output.prompt || '(empty)')}`;
        if (negEl) negEl.innerHTML = `<span class="k">negative:</span> ${escapeHtml(output.negative || '(none)')}`;
        if (paramsEl) paramsEl.innerHTML = `<span class="k">params:</span> W=${escapeHtml(output.params.width)} H=${escapeHtml(output.params.height)} steps=${escapeHtml(output.params.steps)} cfg=${escapeHtml(output.params.cfg)}`;
    }

    renderBtn.addEventListener('click', async () => {
        const text = renderInput.value.trim();
        if (!text) return;
        try {
            const [characters, styles, personas, outfits] = await Promise.all([
                getAllCharacters(), getAllStyles(), getAllPersonas(), getAllOutfits(),
            ]);
            const ctx = freshChatCtx();
            const triggerContext = buildTriggerContext({
                characters, personas, styles, outfits,
                cardId: ctx?.characters?.[ctx?.characterId]?.avatar ?? null,
                chatId: ctx?.getCurrentChatId?.() ?? getCurrentChatId?.() ?? null,
            });
            const parsed = parseTriggers(text, triggerContext);

            const dialects = [
                { key: 'krea', profileKey: 'krea2' },
                { key: 'anima', profileKey: 'anima' },
                { key: 'illus', profileKey: 'illustrious' },
            ];
            // The pipeline's dialectOverride wins over the configured default
            // profile; mark the dialect it resolves to as active.
            const configured = settings.generation.profile || 'anima';
            const { profileKey: resolvedKey } = resolveProfileKey(parsed.dialectOverride, configured);
            const activeDialect = PROFILES[resolvedKey]?.dialect ?? 'anima';
            for (const d of dialects) {
                const output = assemblePrompt(parsed, d.key, PROFILES[d.profileKey]);
                renderPreviewBlock(d.key, output, d.key === activeDialect);
            }
        } catch (err) {
            const kreaBlock = el.querySelector('[data-if-dialect="krea"]');
            if (kreaBlock) {
                const promptEl = kreaBlock.querySelector('.if-render-prompt');
                if (promptEl) promptEl.innerHTML = `<span class="k">error:</span> ${escapeHtml(err.message)}`;
            }
        }
    });

    // ================= Main Tab: dry-run toggle =================
    const dryRunEl = $('if_main_dryrun');
    if (dryRunEl) {
        dryRunEl.checked = settings.generation?.dryRun === true;
        dryRunEl.addEventListener('change', () => { settings.generation.dryRun = dryRunEl.checked; save(); });
    }

    // ============ Main Tab: final prompt ordering (LoRA -> style) ============
    const orderEl = $('if_main_order');
    const keepLoraEl = $('if_main_keeplora');
    function syncKeepLoraEnabled() {
        // Keeping LoRA in place is meaningless when ordering is off — the
        // whole prompt is already left as written.
        if (keepLoraEl) keepLoraEl.disabled = orderEl ? !orderEl.checked : false;
    }
    if (orderEl) {
        if (!settings.generation.promptOrder) settings.generation.promptOrder = {};
        orderEl.checked = settings.generation.promptOrder.enabled !== false;
        orderEl.addEventListener('change', () => {
            settings.generation.promptOrder.enabled = orderEl.checked;
            syncKeepLoraEnabled();
            save();
        });
    }
    if (keepLoraEl) {
        if (!settings.generation.promptOrder) settings.generation.promptOrder = {};
        keepLoraEl.checked = settings.generation.promptOrder.keepLoraPosition === true;
        keepLoraEl.addEventListener('change', () => {
            settings.generation.promptOrder.keepLoraPosition = keepLoraEl.checked;
            save();
        });
    }
    syncKeepLoraEnabled();

    // ================= Main Tab: D3 LLM size hint policy =================
    const llmSizeEl = $('if_main_llmsize');
    if (llmSizeEl) {
        llmSizeEl.value = ['auto', 'ignore', 'force'].includes(settings.generation?.llmSize)
            ? settings.generation.llmSize : 'auto';
        llmSizeEl.addEventListener('change', () => { settings.generation.llmSize = llmSizeEl.value; save(); });
    }

    // ============ Main Tab: Active Profile summary (D14) ============
    // Read-only mirror of what generation would use right now (same
    // resolution as effectiveTestSetup / compile()). The old per-profile
    // Generation Params matrix is gone — ONE active profile drives all
    // params; generation.params stays in settings as a legacy data layer.
    function syncMainActiveProfile() {
        // Looked up per call (hoisted declaration; syncTestGenVisibility
        // calls this before this section of setup code has executed).
        const mainActiveProfile = $('if_main_active_profile');
        if (!mainActiveProfile) return;
        const setup = effectiveTestSetup();
        const style = PROFILES[setup.profileKey]?.label ?? setup.profileKey;
        const p = setup.params;
        const paramsText = `${style} · ${p.width}×${p.height} · ${p.steps} steps · cfg ${p.cfg}`;
        if (setup.backend === 'nai') {
            mainActiveProfile.textContent = `NovelAI · ${paramsText}`;
        } else if (setup.conn === 'a1111') {
            mainActiveProfile.textContent = setup.hasActive
                ? `${setup.activeName} · ${setup.checkpointTitle} · ${paramsText}`
                : (setup.checkpointTitle
                    ? `No active profile — using checkpoint ${setup.checkpointTitle} · ${paramsText}`
                    : 'No active profile — save one in Settings → Stable Diffusion.');
        } else {
            const model = settings.connection?.comfy?.model || '';
            mainActiveProfile.textContent = model
                ? `Comfy proxy · ${model} · ${paramsText}`
                : 'No proxy model selected — pick one in Settings → Stable Diffusion.';
        }
    }
    syncMainActiveProfile();

    // ============ Generation Tab: active style for this chat ============
    // A style used to apply only when a marker literally contained
    // {{style: Name}} — which the default LLM instructions forbid emitting,
    // so nothing ever applied a style. Here the user attaches one to the
    // chat; index.js compile() resolves it with the same precedence.
    const mainStyleSelect = $('if_main_style');
    const mainStyleDefault = $('if_main_style_default');
    const mainStyleSetDefault = $('if_main_style_setdefault');
    const mainStyleStatus = $('if_main_style_status');

    /** The chat metadata object, freshly obtained (never cached across chat changes). */
    function freshChatCtx() {
        return getChatContext?.() ?? null;
    }

    function refreshMainStyleSelects() {
        const options = currentStyles
            .map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
            .join('');
        const none = '<option value="">-- none --</option>';
        if (mainStyleSelect) {
            mainStyleSelect.innerHTML = none + options;
            mainStyleSelect.value = readChatStyleId(freshChatCtx());
        }
        if (mainStyleDefault) {
            mainStyleDefault.innerHTML = none + options;
            mainStyleDefault.value = settings.generation?.defaultStyleId ?? '';
        }
    }

    /**
     * Read-only mirror of what the next image in THIS chat will actually use.
     * Async because the roster lives in IndexedDB; a stale call is harmless
     * since it only writes text.
     */
    async function syncMainStyleStatus() {
        if (!mainStyleStatus) return;
        const chatStyleId = readChatStyleId(freshChatCtx());
        const active = resolveActiveStyle({
            chatStyleId,
            defaultStyleId: settings.generation?.defaultStyleId,
            styles: currentStyles,
        });

        if (active.missingId) {
            mainStyleStatus.textContent = 'The style saved for this chat no longer exists. Pick another one above.';
            return;
        }
        if (!active.style) {
            mainStyleStatus.textContent = 'No style active for this chat — generations use no style hints or style LoRA.';
            return;
        }

        const origin = ({ chat: 'this chat', 'chat-bind': 'chat binding', 'card-bind': 'card binding', default: 'the default for new chats' })[active.source] || active.source;
        const lines = [`Style: ${active.style.name} (from ${origin})`];

        if (active.style.lora) lines.push(`LoRA: ${active.style.lora}`);

        try {
            const [characters, personas, outfits] = await Promise.all([
                getAllCharacters(), getAllPersonas(), getAllOutfits(),
            ]);
            const ctx = freshChatCtx();
            const cardId = ctx?.characters?.[ctx?.characterId]?.avatar ?? null;
            const chatId = ctx?.getCurrentChatId?.() ?? getCurrentChatId?.() ?? null;
            const active = buildTriggerContext({ characters, personas, outfits, cardId, chatId });
            const bound = characters.length - active.roster.length;
            lines.push(`Characters available here: ${active.roster.length}${bound > 0 ? ` (${bound} bound elsewhere)` : ''}`);
            if (active.defaultPersona) lines.push(`Persona: ${active.defaultPersona.name}`);
            if (outfits.length) lines.push(`Outfits: ${outfits.length}`);
        } catch (err) {
            lines.push('Roster unavailable — open the Characters tab to reload it.');
        }

        // The LoRAs that will lead the final prompt, in order.
        const groups = collectLoraGroups({ styles: [active.style] });
        const loras = [...groups.style, ...groups.character];
        lines.push(loras.length
            ? `LoRA (${active.style.loraPosition || 'prompt_start'}): ${loras.join(', ')}`
            : 'No LoRA from this style.');

        mainStyleStatus.textContent = lines.join('\n');
    }

    function refreshMainStyle() {
        refreshMainStyleSelects();
        syncMainStyleStatus();
    }

    if (mainStyleSelect) {
        mainStyleSelect.addEventListener('change', () => {
            const ok = writeChatStyleId(freshChatCtx(), mainStyleSelect.value);
            if (!ok) {
                toastr?.warning?.('No chat open — the style was not saved.');
            }
            syncMainStyleStatus();
        });
    }
    if (mainStyleDefault) {
        mainStyleDefault.addEventListener('change', () => {
            settings.generation.defaultStyleId = mainStyleDefault.value;
            save();
            syncMainStyleStatus();
        });
    }
    if (mainStyleSetDefault) {
        mainStyleSetDefault.addEventListener('click', () => {
            const chatStyleId = mainStyleSelect?.value ?? '';
            if (!chatStyleId) {
                toastr?.warning?.('Pick a style for this chat first.');
                return;
            }
            settings.generation.defaultStyleId = chatStyleId;
            save();
            if (mainStyleDefault) mainStyleDefault.value = chatStyleId;
            syncMainStyleStatus();
        });
    }
    refreshMainStyle();

    // CHAT_CHANGED fires AFTER chat_metadata has been reassigned, so this is
    // the moment the new chat's style becomes readable.
    if (eventSource && event_types?.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => refreshMainStyle());
    }

    // ================= Log Tab Wiring =================
    const logLimit = $('if_log_limit');
    const logRefresh = $('if_log_refresh');
    const logClear = $('if_log_clear');
    const logEntries = $('if_log_entries');
    const logTasksRefresh = $('if_log_tasks_refresh');
    const logTasks = $('if_log_tasks');

    if (logLimit) {
        logLimit.value = settings.generation?.logLimit ?? 50;
        logLimit.addEventListener('change', () => {
            settings.generation.logLimit = Math.max(1, Number(logLimit.value) || 50);
            save();
        });
    }


    function renderLogEntries() {
        if (!logEntries) return;
        const log = genLog ?? [];
        if (!log.length) { logEntries.textContent = 'No entries yet.'; return; }
        logEntries.innerHTML = log.slice().reverse().map(e => {
            const time = new Date(e.timestamp).toLocaleTimeString();
            const body = e.content ?? e.prompt ?? '';
            const detail = body ? `: ${escapeHtml(String(body).slice(0, 120))}` : '';
            const method = e.method ? ` [${escapeHtml(e.method)}]` : '';
            const error = e.error ? ` ⚠ ${escapeHtml(String(e.error).slice(0, 100))}` : '';
            return `<div class="if-image-log-entry"><span class="if-image-log-time">${time}</span> <span class="if-image-log-type">${escapeHtml(e.type)}</span>${method}${detail}${error}</div>`;
        }).join('');
    }

    if (logRefresh) logRefresh.addEventListener('click', renderLogEntries);
    if (logClear) logClear.addEventListener('click', () => {
        if (genLog) genLog.length = 0;
        renderLogEntries();
    });

    function renderTaskList() {
        if (!logTasks || !getQueue) return;
        const queue = getQueue();
        if (!queue || typeof queue.listTasks !== 'function') {
            logTasks.textContent = 'Queue unavailable.';
            return;
        }
        const tasks = queue.listTasks();
        if (!tasks.length) { logTasks.textContent = 'No tasks.'; return; }
        logTasks.innerHTML = tasks.map(t => {
            const promptText = typeof t.prompt === 'object' && t.prompt?.prompt
                ? String(t.prompt.prompt).slice(0, 80)
                : String(t.prompt ?? '').slice(0, 80);
            return `<div class="if-image-log-entry">
                <span class="if-image-log-type">${escapeHtml(t.status)}</span> ${escapeHtml(t.id)}: ${escapeHtml(promptText)}
                ${t.status === 'running' || t.status === 'queued' ? `<button class="ifimg-retry menu_button" data-task-id="${escapeHtml(t.id)}">Cancel</button>` : ''}
            </div>`;
        }).join('');
        // Wire cancel buttons
        logTasks.querySelectorAll('[data-task-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.taskId;
                queue.cancelTask(id);
                renderTaskList();
            });
        });
    }
    if (logTasksRefresh) logTasksRefresh.addEventListener('click', renderTaskList);

    return el;
}

// ---------------------------------------------------------------------------
// D4: edit-before-generate dialog. Exported as a factory so index.js can wire
// it into the marker pipeline (deps.openEditDialog) with the ST popup and the
// LLM tag-modify callback injected — ui.js never imports the engine itself.
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {() => object|null} deps.getContext - ST getContext (feature-detected:
 *   callGenericPopup + POPUP_TYPE.CONFIRM when present, else a self-built
 *   overlay so offline/degraded environments still work).
 * @param {(promptText: string, instruction: string, opts: {signal?: AbortSignal}) => Promise<{tags: string}>} [deps.modifyTags]
 *   AI assist hook (index.js wires engine.modifyTags). Optional: without it
 *   the assist row is hidden.
 * @param {(kind: string, message: string) => void} deps.notify
 * @param {object} deps.profiles - PROFILES map (for negativeDisabled).
 * @returns {(current: {prompt, negative, params, profileKey}) => Promise<object|null>}
 *   resolves to an envelope override { prompt, negative, params } or null on cancel.
 */
export function createEditDialog({ getContext, modifyTags, notify, profiles }) {
    return async function openEditDialog({ prompt = '', negative = '', params = {}, profileKey } = {}) {
        const doc = document;
        const form = doc.createElement('div');
        form.className = 'ifimg-edit-dialog';

        const field = (labelText, node) => {
            const wrap = doc.createElement('label');
            wrap.className = 'ifimg-edit-field';
            const span = doc.createElement('span');
            span.textContent = labelText;
            wrap.appendChild(span);
            wrap.appendChild(node);
            form.appendChild(wrap);
            return node;
        };
        const promptEl = doc.createElement('textarea');
        promptEl.rows = 5;
        promptEl.value = String(prompt);
        field('Prompt', promptEl);

        // AI assist: rewrites the prompt textarea via the LLM; NEVER generates.
        let abortAssist = null;
        if (typeof modifyTags === 'function') {
            const row = doc.createElement('div');
            row.className = 'ifimg-edit-assist';
            const instrEl = doc.createElement('input');
            instrEl.type = 'text';
            instrEl.placeholder = 'AI assist instruction (e.g. "make it night time")';
            const assistBtn = doc.createElement('button');
            assistBtn.type = 'button';
            assistBtn.className = 'menu_button';
            assistBtn.textContent = 'AI assist';
            assistBtn.addEventListener('click', async () => {
                const instruction = instrEl.value.trim();
                if (!instruction) { notify('warning', 'Enter an assist instruction first.'); return; }
                assistBtn.disabled = true;
                abortAssist = new AbortController();
                try {
                    // engine.modifyTags keeps only the FIRST line of the reply,
                    // so the current prompt is collapsed to one line first.
                    const oneLine = promptEl.value.replace(/\s*\n+\s*/g, ', ').trim();
                    const result = await modifyTags(oneLine, instruction, { signal: abortAssist.signal });
                    if (result?.tags) promptEl.value = result.tags;
                } catch (err) {
                    if (err?.name !== 'AbortError') notify('error', `AI assist failed: ${err?.message ?? err}`);
                } finally {
                    abortAssist = null;
                    assistBtn.disabled = false;
                }
            });
            row.appendChild(instrEl);
            row.appendChild(assistBtn);
            form.appendChild(row);
        }

        const negativeEl = doc.createElement('textarea');
        negativeEl.rows = 2;
        negativeEl.value = String(negative);
        const negField = field('Negative', negativeEl);
        if (profiles?.[profileKey]?.negativeDisabled) negField.parentNode.style.display = 'none';

        const numRow = doc.createElement('div');
        numRow.className = 'ifimg-edit-params';
        form.appendChild(numRow);
        const num = (labelText, value, step = 1) => {
            const wrap = doc.createElement('label');
            wrap.className = 'ifimg-edit-field ifimg-edit-num';
            const span = doc.createElement('span');
            span.textContent = labelText;
            const input = doc.createElement('input');
            input.type = 'number';
            input.step = String(step);
            input.value = value === undefined || value === null ? '' : String(value);
            wrap.appendChild(span);
            wrap.appendChild(input);
            numRow.appendChild(wrap);
            return input;
        };
        const widthEl = num('Width', params.width, 64);
        const heightEl = num('Height', params.height, 64);
        const stepsEl = num('Steps', params.steps);
        const cfgEl = num('CFG', params.cfg, 0.5);
        const seedEl = num('Seed', params.seed ?? -1);

        const collect = () => ({
            prompt: promptEl.value,
            negative: negativeEl.value,
            params: {
                width: widthEl.value === '' ? undefined : Number(widthEl.value),
                height: heightEl.value === '' ? undefined : Number(heightEl.value),
                steps: stepsEl.value === '' ? undefined : Number(stepsEl.value),
                cfg: cfgEl.value === '' ? undefined : Number(cfgEl.value),
                seed: seedEl.value === '' ? undefined : Number(seedEl.value),
            },
        });

        // ST popup path: CONFIRM gives OK/Cancel; the OK button is relabeled
        // "Generate" via popupOptions where supported.
        let ctx = null;
        try { ctx = getContext?.(); } catch { ctx = null; }
        const popup = ctx?.callGenericPopup;
        const confirmType = ctx?.POPUP_TYPE?.CONFIRM ?? 2;
        if (typeof popup === 'function') {
            try {
                const result = await popup(form, confirmType, '', { okButton: 'Generate', cancelButton: 'Cancel' });
                abortAssist?.abort();
                return result ? collect() : null;
            } catch (err) {
                console.warn('[IF Image] callGenericPopup failed; using fallback dialog:', err?.message ?? err);
            }
        }

        // Fallback: self-built modal overlay (no ST).
        return new Promise((resolve) => {
            const overlay = doc.createElement('div');
            overlay.className = 'ifimg-lightbox'; // reuse backdrop styling
            const inner = doc.createElement('div');
            inner.className = 'ifimg-lightbox-inner ifimg-edit-inner';
            inner.addEventListener('click', (e) => e.stopPropagation());
            inner.appendChild(form);
            const buttons = doc.createElement('div');
            buttons.className = 'ifimg-lb-actions';
            const done = (value) => {
                abortAssist?.abort();
                overlay.remove();
                doc.removeEventListener('keydown', onKey);
                resolve(value);
            };
            const mkBtn = (label, handler) => {
                const b = doc.createElement('button');
                b.type = 'button';
                b.className = 'menu_button';
                b.textContent = label;
                b.addEventListener('click', handler);
                buttons.appendChild(b);
            };
            mkBtn('Generate', () => done(collect()));
            mkBtn('Cancel', () => done(null));
            inner.appendChild(buttons);
            overlay.appendChild(inner);
            const onKey = (e) => { if (e.key === 'Escape') done(null); };
            overlay.addEventListener('click', () => done(null));
            doc.addEventListener('keydown', onKey);
            (doc.body || doc).appendChild(overlay);
        });
    };
}
