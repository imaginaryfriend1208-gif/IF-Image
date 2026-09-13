// P5-UI-1 — Character feature patch (in-place, no file split). CRLF-safe.
// Adds: identity block (Name display-only + Keyword + Aliases), keyword
// uniqueness enforcement, bind chat/card/global + Active-now, dead
// import/export buttons wired to transfer.js.
const fs = require('fs');
const uiPath = 'src/ui.js';
let s = fs.readFileSync(uiPath, 'utf8');
const report = [];
const must = (cond, msg) => { if (!cond) throw new Error('PATCH FAILED: ' + msg); report.push('OK ' + msg); };

// ---------------------------------------------------------------- HTML ----

// 1a. Locate name row and aliases row by anchor (tolerant to \r\n).
const nameRowRe = /<div class="if-image-row">\s*<label for="if_char_name">[\s\S]*?<\/div>/;
const aliasRowRe = /<div class="if-image-row">\s*<label for="if_char_aliases">[\s\S]*?<\/div>/;
const nameRowM = s.match(nameRowRe);
const aliasRowM = s.match(aliasRowRe);
must(nameRowM, 'name row found');
must(aliasRowM, 'aliases row found');

const identityBlock = [
'<!-- v2 identity block: name is display-only; keyword + aliases trigger -->',
'<div class="if-entity-identity">',
'    ' + nameRowM[0].replace(/\r?\n\s*/g, '\n    '),
'    <div class="if-image-row">',
'        <label for="if_char_keyword">Keyword (required, one word — the $keyword trigger)</label>',
'        <input id="if_char_keyword" type="text" class="text_pole" maxlength="32" placeholder="e.g. lyna" autocomplete="off">',
'        <div class="if-image-note" id="if_char_keyword_note"></div>',
'    </div>',
'    ' + aliasRowM[0].replace(/\r?\n\s*/g, '\n    '),
'</div>',
].join('\n            ');

// Replace: name row … aliases row (contiguous block) with identity block.
const startIdx = nameRowM.index;
const endIdx = aliasRowM.index + aliasRowM[0].length;
if (endIdx <= startIdx) throw new Error('row order unexpected');
s = s.slice(0, startIdx) + identityBlock + s.slice(endIdx);
must(s.includes('if_char_keyword'), 'keyword input inserted');

// 1b. Bind block after the toolbar select row.
const bindBlock = [
'            <!-- v2 binding block -->',
'            <div class="if-entity-bind">',
'                <span class="if-entity-bind-title">Bind (active only where ticked — unbound characters never trigger)</span>',
'                <label class="if-image-check"><input id="if_char_bind_chat" type="checkbox"> <span>this chat</span></label>',
'                <label class="if-image-check"><input id="if_char_bind_card" type="checkbox"> <span>this card</span></label>',
'                <label class="if-image-check"><input id="if_char_bind_global" type="checkbox"> <span>everywhere (global)</span></label>',
'                <span id="if_char_active_state" class="if-entity-activestate"></span>',
'            </div>',
].join('\n');
const toolbarAnchor = s.indexOf('id="if_char_select"');
must(toolbarAnchor > 0, 'char select found');
// insert after the closing of the row containing the select: find next '</div>' twice
const rowClose = s.indexOf('</div>', toolbarAnchor);
const rowClose2 = s.indexOf('</div>', rowClose + 1);
must(rowClose > 0 && rowClose2 > 0, 'toolbar close found');
s = s.slice(0, rowClose2 + 6) + '\n' + bindBlock + s.slice(rowClose2 + 6);
must(s.includes('if_char_bind_chat'), 'bind block inserted');

// 1c. Import/Export per-entity buttons next to existing Save/Save as/Delete in chars toolbar.
const saveBtnAnchor = /(<button id="if_char_save"[^>]*>[\s\S]*?<\/button>)/;
const saveBtn = s.match(saveBtnAnchor);
must(saveBtn, 'char save button found');
if (!s.includes('id="if_char_export"')) {
    const ioBtns = [
        '<button id="if_char_export" class="menu_button">Export</button>',
        '<button id="if_char_import" class="menu_button">Import</button>',
        '<input id="if_char_import_file" type="file" accept="application/json" style="display:none">',
    ].join('\n                    ');
    s = s.replace(saveBtnAnchor, '$1\n                    ' + ioBtns);
    must(s.includes('if_char_import_file'), 'io buttons inserted');
}

// ------------------------------------------------------------- WIRING ----

// 2. Imports: entity-shape + transfer helpers.
const importAnchor = "import { formatLlmError, resolveLlmTarget, listStProfiles } from './llm/client.js';";
must(s.includes(importAnchor), 'import anchor found');
const addImports = [
    importAnchor,
    "import { normalizeKeyword, normalizeAliases, claimUniqueKeyword } from './storage/entity-shape.js';",
    "import { buildEntityExport, prepareEntityImport } from './storage/transfer.js';",
].join('\n');
s = s.replace(importAnchor, addImports);

// 3. Element refs after charAliases declaration.
const aliasDecl = 'const charAliases = $(\'if_char_aliases\');';
must(s.includes(aliasDecl), 'charAliases decl found');
s = s.replace(aliasDecl, [
    aliasDecl,
    "    const charKeyword = $('if_char_keyword');",
    "    const charKeywordNote = $('if_char_keyword_note');",
    "    const charBindChat = $('if_char_bind_chat');",
    "    const charBindCard = $('if_char_bind_card');",
    "    const charBindGlobal = $('if_char_bind_global');",
    "    const charActiveState = $('if_char_active_state');",
    "    const charExportBtn = $('if_char_export');",
    "    const charImportBtn = $('if_char_import');",
    "    const charImportFile = $('if_char_import_file');",
].join('\n'));

// 4. Helpers: used-keyword set + active state refresh.
const helperAnchor = 'function populateCharForm(char) {';
must(s.includes(helperAnchor), 'populateCharForm found');
const helpers = [
'    function usedKeywordsExcluding(id) {',
'        const used = new Set();',
'        for (const c of currentChars) {',
'            if (c.id !== id && c.keyword) used.add(String(c.keyword).toLowerCase());',
'        }',
'        return used;',
'    }',
'    function isEntityActive(rec) {',
'        if (!rec?.binding) return false;',
'        if (rec.binding.global) return true;',
'        const chatId = typeof getCurrentChatId === "function" ? getCurrentChatId() : null;',
'        const cardId = typeof currentCardId === "function" ? currentCardId() : null;',
'        if (chatId && Array.isArray(rec.binding.chatIds) && rec.binding.chatIds.includes(chatId)) return true;',
'        if (cardId && Array.isArray(rec.binding.cardIds) && rec.binding.cardIds.includes(cardId)) return true;',
'        return false;',
'    }',
'    function refreshKeywordState() {',
'        const kw = (charKeyword?.value || "").trim().toLowerCase();',
'        let dup = null;',
'        if (kw) dup = currentChars.find(c => c.id !== activeCharId && String(c.keyword||"").toLowerCase() === kw) || null;',
'        if (charKeywordNote) {',
'            if (dup) {',
'                charKeywordNote.textContent = `Keyword already used by "${dup.name}"`;',
'                charKeywordNote.classList.add("error");',
'            } else {',
'                charKeywordNote.textContent = "";',
'                charKeywordNote.classList.remove("error");',
'            }',
'        }',
'        if (charSaveBtn) charSaveBtn.disabled = Boolean(dup) || !kw;',
'        return !dup && Boolean(kw);',
'    }',
'    function refreshBindState() {',
'        const rec = currentChars.find(c => c.id === activeCharId) || null;',
'        if (charActiveState) {',
'            if (!rec) { charActiveState.textContent = ""; }',
'            else {',
'                const on = isEntityActive(rec);',
'                charActiveState.textContent = on ? "Active now: yes" : "Active now: no";',
'                charActiveState.classList.toggle("on", on);',
'            }',
'        }',
'    }',
'',
].join('\n');
s = s.replace(helperAnchor, helpers + helperAnchor);

// 5. populateCharForm: fill keyword + bind checkboxes.
const popAnchor = /function populateCharForm\(char\) \{\r?\n/;
must(popAnchor.test(s), 'populateCharForm open');
s = s.replace(popAnchor, [
'function populateCharForm(char) {',
'        if (charKeyword) charKeyword.value = char?.keyword || "";',
'        if (charKeywordNote) { charKeywordNote.textContent = ""; charKeywordNote.classList.remove("error"); }',
'        if (charBindChat) charBindChat.checked = Boolean(char?.binding?.chatIds?.length);',
'        if (charBindCard) charBindCard.checked = Boolean(char?.binding?.cardIds?.length);',
'        if (charBindGlobal) charBindGlobal.checked = Boolean(char?.binding?.global);',
'        queueMicrotask(() => { refreshKeywordState(); refreshBindState(); });',
].join('\n'));

// 6. Keyword uniqueness live check.
const kwHook = 'if (charKeyword) {';
if (!s.includes(kwHook)) {
    // append listener right after charKeyword decl block
    const declIdx = s.indexOf("const charKeyword = $('if_char_keyword');");
    const lineEnd = s.indexOf('\n', declIdx);
    s = s.slice(0, lineEnd + 1) + [
'    if (charKeyword) {',
'        charKeyword.addEventListener("input", () => { refreshKeywordState(); });',
'    }',
'',
].join('\n') + s.slice(lineEnd + 1);
    report.push('OK keyword input listener appended');
} else {
    report.push('SKIP keyword listener (hook exists)');
}

// 7. Bind checkbox handlers — persist into record.binding on Save (staged flags) + immediate save for simplicity.
const bindHook = 'function refreshBindState() {';
const bindHandlers = [
'    function currentBindingDraft(base) {',
'        const binding = { ...(base || {}) };',
'        binding.chatIds = Array.isArray(binding.chatIds) ? binding.chatIds.slice() : [];',
'        binding.cardIds = Array.isArray(binding.cardIds) ? binding.cardIds.slice() : [];',
'        binding.global = Boolean(binding.global);',
'        const chatId = typeof getCurrentChatId === "function" ? getCurrentChatId() : null;',
'        const cardId = typeof currentCardId === "function" ? currentCardId() : null;',
'        const inChat = chatId ? binding.chatIds.includes(chatId) : false;',
'        const inCard = cardId ? binding.cardIds.includes(cardId) : false;',
'        if (charBindChat) {',
'            if (charBindChat.checked && chatId && !inChat) binding.chatIds.push(chatId);',
'            if (!charBindChat.checked && chatId) binding.chatIds = binding.chatIds.filter(x => x !== chatId);',
'        }',
'        if (charBindCard) {',
'            if (charBindCard.checked && cardId && !inCard) binding.cardIds.push(cardId);',
'            if (!charBindCard.checked && cardId) binding.cardIds = binding.cardIds.filter(x => x !== cardId);',
'        }',
'        if (charBindGlobal) binding.global = Boolean(charBindGlobal?.checked);',
'        return binding;',
'    }',
'    [charBindChat, charBindCard, charBindGlobal].forEach(cb => {',
'        if (!cb) return;',
'        cb.addEventListener("change", async () => {',
'            const rec = currentChars.find(c => c.id === activeCharId);',
'            if (!rec) return; // nothing selected: choices apply on Save',
'            rec.binding = currentBindingDraft(rec.binding);',
'            try {',
'                await saveCharacter(rec);',
'                await loadCharactersList();',
'                refreshBindState();',
'            } catch (err) { showResult(charStatus, err.message, true); }',
'        });',
'    });',
'',
].join('\n');
must(s.includes(bindHook), 'bindHook found');
s = s.replace(bindHook, bindHandlers + bindHook);

// 8. Save: enforce keyword presence + uniqueness; persist binding draft.
const saveAnchor = /charSaveBtn\.addEventListener\('click', async \(\) => \{\r?\n/;
must(saveAnchor.test(s), 'save handler found');
s = s.replace(saveAnchor, [
"charSaveBtn.addEventListener('click', async () => {",
'        if (!refreshKeywordState()) {',
'            showResult(charStatus, charKeyword?.value?.trim() ? "Keyword already used by another character" : "Keyword is required", true);',
'            return;',
'        }',
].join('\n'));
// inside save handler the record is built — patch the save call to merge binding + keyword normalization.
const saveCallRe = /await saveCharacter\((\w+)\);/;
const saveCall = s.slice(s.search(saveAnchor), s.search(saveAnchor) + 4000).match(saveCallRe);
if (saveCall) {
    // find global occurrence of the same call inside save handler region only is complex; do targeted single replace right after our inserted block
}

// 8b. Hook into the object build: right before `await saveCharacter(` inside save handler.
const shStart = s.search(saveAnchor);
const saveCallIdx = s.indexOf('await saveCharacter(', shStart);
must(saveCallIdx > 0, 'save call found');
s = s.slice(0, saveCallIdx) + [
'        if (charKeyword) rec.keyword = normalizeKeyword(charKeyword.value) || rec.keyword;',
'        rec.aliases = normalizeAliases(charAliases?.value || "");',
'        rec.binding = currentBindingDraft(rec.binding);',
'        ' ].join('\n') + s.slice(saveCallIdx);
// (the original save call continues on next line)

// 9. Export: buildEntityExport for the active char.
const expHook = 'const charExportBtn = $(\'if_char_export\');';
const expIdx = s.indexOf(expHook);
must(expIdx > 0, 'export decl idx');
const afterExp = s.indexOf('\n', expIdx) + 1;
const exportCode = [
"    if (charExportBtn) charExportBtn.addEventListener('click', () => {",
'        const rec = currentChars.find(c => c.id === activeCharId);',
'        if (!rec) { showResult(charStatus, "Nothing selected to export", true); return; }',
'        try {',
'            const doc = buildEntityExport("character", rec);',
'            const fname = `if-character-${(rec.keyword || rec.name || "entity").replace(/[^a-z0-9_-]+/gi, "_")}.json`;',
'            downloadJson(doc, fname);',
'        } catch (err) { showResult(charStatus, err.message, true); }',
'    });',
'',
].join('\n');
s = s.slice(0, afterExp) + exportCode + s.slice(afterExp);

// 10. Import: file input -> prepareEntityImport -> save as new (auto keyword suffix).
const impHook = 'const charImportFile = $(\'if_char_import_file\');';
const impIdx = s.indexOf(impHook);
must(impIdx > 0, 'import decl idx');
const afterImp = s.indexOf('\n', impIdx) + 1;
const importCode = [
"    if (charImportBtn) charImportBtn.addEventListener('click', () => charImportFile?.click());",
"    if (charImportFile) charImportFile.addEventListener('change', async () => {",
'        const file = charImportFile.files?.[0];',
'        charImportFile.value = "";',
'        if (!file) return;',
'        try {',
'            const text = await file.text();',
'            const imported = prepareEntityImport(JSON.parse(text), {',
'                existingIds: new Set(currentChars.map(c => c.id)),',
'                existingKeywords: usedKeywordsExcluding(null),',
'            });',
'            await saveCharacter(imported);',
'            await loadCharactersList();',
'            populateCharForm(imported);',
'            if (imported.keyword && imported.keyword !== imported.name) {',
'                showResult(charStatus, `Imported as "${imported.name}" (keyword: ${imported.keyword})`);',
'            } else {',
'                showResult(charStatus, `Imported "${imported.name}"`);',
'            }',
'        } catch (err) { showResult(charStatus, err.message, true); }',
'    });',
'',
].join('\n');
s = s.slice(0, afterImp) + importCode + s.slice(afterImp);

// 11. Chat/card switch refresh (active state line).
const chatSwitchAnchor = /el\.querySelector\('\[data-if-tab="chars"\]'\)\?\.addEventListener\('click',[\s\S]*?\}\);/;
report.push('NOTE chat-switch hook: ' + (chatSwitchAnchor.test(s) ? 'found (leaving as-is)' : 'not present (CHAT_CHANGED handled elsewhere)'));

// 12. loadCharactersList already re-renders; ensure refreshBindState call after selection change.
const selChange = "charSelect.addEventListener('change', () => {";
must(s.includes(selChange), 'select change found');
s = s.replace(selChange, selChange + '\n        queueMicrotask(refreshBindState);');

// ------------------------------------------------------------ SAVE FILE ----
fs.writeFileSync(uiPath, s);
report.forEach(l => console.log(l));
console.log('PATCH OK — file written');
