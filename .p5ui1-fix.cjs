// P5-UI-1 fixups — line-anchored, CRLF-tolerant (no verbatim block matching).
const fs = require('fs');
let L = fs.readFileSync('src/ui.js', 'utf8').split('\n');

// Locate the mislaced trio after the "try {" line.
const ti = L.findIndex((l, i) => l.trim() === 'try {' && /normalizeKeyword/.test(L[i + 1] || ''));
if (ti < 0) throw new Error('misplaced try block not found');
const trio = [
    L[ti + 1].replace('rec.keyword', 'target.keyword').replace(/rec\b/, 'target'),
    L[ti + 2].replace(/\brec\.aliases\b/, 'target.aliases'),
    L[ti + 3].replace(/rec\.binding/g, 'target.binding').replace('currentBindingDraft(rec.binding)', 'currentBindingDraft(target.binding)'),
];
L.splice(ti, 4);                       // drop "try {" + trio
// Re-insert: trio first, then try{ + await saveCharacter
const reinsert = [
    trio[0], trio[1], trio[2],
    '        try {',
    '            await saveCharacter(target);',
];
L.splice(ti, 0, ...reinsert);

let s = L.join('\n');

// CSS for identity + bind blocks.
const css = fs.readFileSync('style.css', 'utf8');
if (!css.includes('.if-entity-identity')) {
    const add = [
        '',
        '/* v2 P5-UI-1: identity + binding blocks */',
        '.if-entity-identity {',
        '    border: 1px solid var(--SmartThemeBorderColor);',
        '    border-radius: 8px;',
        '    padding: 8px 10px;',
        '    margin-bottom: 10px;',
        '    background: color-mix(in srgb, var(--SmartThemeBlurTintColor) 60%, transparent);',
        '}',
        '.if-entity-identity label { font-weight: 600; }',
        '.if-entity-bind {',
        '    display: flex; flex-wrap: wrap; gap: 10px; align-items: center;',
        '    margin-bottom: 10px;',
        '}',
        '.if-entity-bind-title { opacity: 0.8; font-size: 0.9em; }',
        '.if-entity-activestate { font-weight: 600; }',
        '',
    ].join('\n');
    fs.writeFileSync('style.css', css + add);
}

fs.writeFileSync('src/ui.js', s);
console.log('FIXUP OK');
