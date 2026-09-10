// Test suite for src/prompt/active-style.js — pure precedence resolution.

import { strict as assert } from 'node:assert';
import { resolveActiveStyle, readChatStyleId, writeChatStyleId, CHAT_STYLE_KEY } from '../src/prompt/active-style.js';

const style1 = { id: 's1', name: 'Krea' };
const style2 = { id: 's2', name: 'Anima' };
const style3 = { id: 's3', name: 'Illus' };
const styles = [style1, style2, style3];

// 1. Marker always wins.
{
    const result = resolveActiveStyle({
        explicitStyles: [style2],
        chatStyleId: 's1',
        defaultStyleId: 's3',
        styles,
    });
    assert.equal(result.source, 'marker');
    assert.deepStrictEqual(result.style, style2);
    assert.equal(result.missingId, undefined);
}

// 2. Chat choice, when marker is absent.
{
    const result = resolveActiveStyle({
        explicitStyles: [],
        chatStyleId: 's3',
        defaultStyleId: 's1',
        styles,
    });
    assert.equal(result.source, 'chat');
    assert.deepStrictEqual(result.style, style3);
}

// 3. Default, when chat has no choice.
{
    const result = resolveActiveStyle({
        explicitStyles: [],
        chatStyleId: '',
        defaultStyleId: 's2',
        styles,
    });
    assert.equal(result.source, 'default');
    assert.deepStrictEqual(result.style, style2);
}

// 4. None, when nothing is configured.
{
    const result = resolveActiveStyle({
        explicitStyles: [],
        chatStyleId: '',
        defaultStyleId: '',
        styles,
    });
    assert.equal(result.source, 'none');
    assert.equal(result.style, null);
    assert.equal(result.missingId, undefined);
}

// 5. Chat style id exists but the style was deleted → missingId.
{
    const result = resolveActiveStyle({
        explicitStyles: [],
        chatStyleId: 's99',
        defaultStyleId: 's1',
        styles,
    });
    assert.equal(result.source, 'none');
    assert.equal(result.style, null);
    assert.equal(result.missingId, 's99');
}

// 6. Default style id exists but the style was deleted → missingId.
{
    const result = resolveActiveStyle({
        explicitStyles: [],
        chatStyleId: '',
        defaultStyleId: 'sDeleted',
        styles,
    });
    assert.equal(result.source, 'none');
    assert.equal(result.style, null);
    assert.equal(result.missingId, 'sDeleted');
}

// 7. Chat choice does NOT fall through to default when deleted.
// The user made a choice for this chat; silently substituting a different
// style would hide that the reference broke.
{
    const result = resolveActiveStyle({
        explicitStyles: [],
        chatStyleId: 'sGone',
        defaultStyleId: 's1',
        styles,
    });
    assert.equal(result.source, 'none');
    assert.equal(result.style, null);
    assert.equal(result.missingId, 'sGone');
}

// 8. readChatStyleId: present.
{
    const ctx = { chatMetadata: { [CHAT_STYLE_KEY]: 's1', other: 42 } };
    assert.equal(readChatStyleId(ctx), 's1');
}

// 9. readChatStyleId: absent.
{
    const ctx = { chatMetadata: { other: 42 } };
    assert.equal(readChatStyleId(ctx), '');
}

// 10. readChatStyleId: not a string.
{
    const ctx = { chatMetadata: { [CHAT_STYLE_KEY]: 123 } };
    assert.equal(readChatStyleId(ctx), '');
}

// 11. readChatStyleId: null context.
{
    assert.equal(readChatStyleId(null), '');
}

// 12. writeChatStyleId: set a value.
{
    const saveCallCount = { n: 0 };
    const ctx = {
        chatMetadata: {},
        saveMetadata() { saveCallCount.n += 1; },
    };
    const ok = writeChatStyleId(ctx, 's2');
    assert.equal(ok, true);
    assert.equal(ctx.chatMetadata[CHAT_STYLE_KEY], 's2');
    assert.equal(saveCallCount.n, 1);
}

// 13. writeChatStyleId: detach (empty string).
{
    const ctx = {
        chatMetadata: { [CHAT_STYLE_KEY]: 's1' },
        saveMetadata() {},
    };
    const ok = writeChatStyleId(ctx, '');
    assert.equal(ok, true);
    assert.equal(ctx.chatMetadata[CHAT_STYLE_KEY], undefined);
}

// 14. writeChatStyleId: no context → false.
{
    const ok = writeChatStyleId(null, 's1');
    assert.equal(ok, false);
}

// 15. writeChatStyleId: no chatMetadata → false.
{
    const ctx = { saveMetadata() {} };
    const ok = writeChatStyleId(ctx, 's1');
    assert.equal(ok, false);
}

// 16. writeChatStyleId: saveMetadata throws → false.
{
    const ctx = {
        chatMetadata: {},
        saveMetadata() { throw new Error('Disk full'); },
    };
    const ok = writeChatStyleId(ctx, 's1');
    assert.equal(ok, false);
}

// 17. Empty styles list: resolves to none.
{
    const result = resolveActiveStyle({
        explicitStyles: [],
        chatStyleId: 's1',
        defaultStyleId: '',
        styles: [],
    });
    assert.equal(result.source, 'none');
    assert.equal(result.missingId, 's1');
}

// 18. Explicit style wins even when the chat and default are also set.
{
    const result = resolveActiveStyle({
        explicitStyles: [style1],
        chatStyleId: 's2',
        defaultStyleId: 's3',
        styles,
    });
    assert.equal(result.source, 'marker');
    assert.deepStrictEqual(result.style, style1);
}

console.log('PASS (18 cases)');
