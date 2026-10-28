import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

// Verlauf in Seiten (chat-tools.js): durchgehend nur die letzten Nachrichten, oder ein Tag nach dem anderen.
function loadChatTools() {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) {
            const classes = new Set(['hidden']);
            elements.set(id, {
                id, textContent: '', disabled: false,
                classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) }
            });
        }
        return elements.get(id);
    };
    const context = {
        state: { chatRenderLimit: 150, chatDayMode: false, chatDay: null, chatDays: [], chats: {}, activeChatPeerId: 'peer' },
        document: { getElementById: element, addEventListener: () => {}, documentElement: { lang: 'de' } },
        window: { addEventListener: () => {} },
        Date, Math, Number, String, Set, Object, Array
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/chat-tools.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    return { context, element };
}

const day = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

test('long chats render only the latest page, older ones on demand', () => {
    const { context } = loadChatTools();
    const messages = Array.from({ length: 400 }, (_, index) => ({ id: `m${index}`, createdAt: index }));
    const first = context.chatHistoryWindow(messages, false);
    assert.equal(first.messages.length, 150);
    assert.equal(first.messages[0].id, 'm250');
    assert.equal(first.older, 250);
    context.state.chatRenderLimit += context.CHAT_RENDER_PAGE ?? 150;
    assert.equal(context.chatHistoryWindow(messages, false).older, 100);
});

test('chat by day shows one day, arrows walk the days with messages, search sees everything', () => {
    const { context, element } = loadChatTools();
    context.state.chatDayMode = true;
    const messages = [
        { id: 'a', createdAt: day(2026, 10, 20) },
        { id: 'b', createdAt: day(2026, 10, 20, 18) },
        { id: 'c', createdAt: day(2026, 10, 25) },
        { id: 'd', createdAt: day(2026, 10, 27) }
    ];
    let page = context.chatHistoryWindow(messages, false);
    assert.deepEqual(page.messages.map(message => message.id), ['d'], 'starts on the newest day');
    assert.equal(element('chat-day-bar').classList.contains('hidden'), false);
    assert.equal(element('chat-day-next').disabled, true);
    context.renderChatHistory = () => {};
    context.stepChatDay(-1);
    page = context.chatHistoryWindow(messages, false);
    assert.deepEqual(page.messages.map(message => message.id), ['c']);
    context.stepChatDay(-1);
    assert.deepEqual(context.chatHistoryWindow(messages, false).messages.map(message => message.id), ['a', 'b'], 'days without messages are skipped');
    assert.equal(element('chat-day-prev').disabled, true);
    const searching = context.chatHistoryWindow(messages, true);
    assert.equal(searching.messages.length, 4, 'search covers all days');
    assert.equal(element('chat-day-bar').classList.contains('hidden'), true);
});
