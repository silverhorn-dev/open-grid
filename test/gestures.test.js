import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

const source = readFileSync(new URL('../client/app/gestures.js', import.meta.url), 'utf8');

function fakeElement({ classes = [], id = '' } = {}) {
    const classList = new Set(classes);
    const element = {
        id,
        style: {},
        children: [],
        classList: {
            contains: name => classList.has(name),
            add: name => classList.add(name),
            remove: name => classList.delete(name),
            toggle: (name, force) => (force ?? !classList.has(name)) ? classList.add(name) : classList.delete(name)
        },
        querySelector: () => null,
        appendChild: child => element.children.push(child)
    };
    return element;
}

function setup({ isMine = false } = {}) {
    const row = fakeElement({ id: 'chat-message-m1' });
    const wrap = fakeElement({ classes: ['chat-bubble-wrap', ...(isMine ? ['is-mine'] : [])] });
    row.querySelector = selector => (selector === '.chat-bubble-wrap' ? wrap : null);
    row.setPointerCapture = () => {};
    // Das Wischen startet irgendwo in der Zeile (Blase oder Leerraum daneben).
    const target = { closest: selector => (selector === '[id^="chat-message-"]' ? row : null) };
    const calls = { reply: [], react: [], actions: 0 };
    const timers = [];
    const context = {
        window: { matchMedia: () => ({ matches: false }) },
        navigator: {},
        document: { createElement: () => fakeElement() },
        requestAnimationFrame: () => 1,
        setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
        clearTimeout: handle => { if (timers[handle - 1]) timers[handle - 1].cleared = true; },
        startReply: id => calls.reply.push(id),
        reactToMessage: (id, emoji) => calls.react.push([id, emoji]),
        openMessageMenu: () => { calls.actions += 1; },
        Date,
        Math
    };
    vm.runInNewContext(source, Object.assign(context, I18N_STUBS));
    const pointer = (x, y) => ({ pointerType: 'touch', pointerId: 1, clientX: x, clientY: y, target });
    const runTimers = () => timers.filter(timer => !timer.cleared).forEach(timer => timer.callback());
    return { context, calls, pointer, runTimers, wrap };
}

test('a horizontal swipe past the threshold starts a reply, a short one does not', () => {
    const { context, calls, pointer } = setup();
    context.handleMessagePointerDown(pointer(100, 100));
    context.handleMessagePointerMove(pointer(140, 102));
    context.finishMessageGesture(pointer(140, 102), false);
    assert.deepEqual(calls.reply, []);

    context.handleMessagePointerDown(pointer(100, 100));
    context.handleMessagePointerMove(pointer(200, 103));
    context.finishMessageGesture(pointer(200, 103), false);
    assert.deepEqual([...calls.reply], ['m1']);
});

test('own messages only reply when swiped to the left', () => {
    const { context, calls, pointer } = setup({ isMine: true });
    context.handleMessagePointerDown(pointer(200, 100));
    context.handleMessagePointerMove(pointer(300, 100));
    context.finishMessageGesture(pointer(300, 100), false);
    assert.deepEqual(calls.reply, []);

    context.handleMessagePointerDown(pointer(200, 100));
    context.handleMessagePointerMove(pointer(100, 100));
    context.finishMessageGesture(pointer(100, 100), false);
    assert.deepEqual([...calls.reply], ['m1']);
});

test('vertical movement locks the gesture to scrolling', () => {
    const { context, calls, pointer, runTimers } = setup();
    context.handleMessagePointerDown(pointer(100, 100));
    context.handleMessagePointerMove(pointer(104, 140));
    context.handleMessagePointerMove(pointer(200, 140));
    runTimers();
    context.finishMessageGesture(pointer(200, 140), false);
    assert.deepEqual(calls.reply, []);
    assert.equal(calls.actions, 0, 'scrolling cancels the long press');
});

test('long press opens the actions, a cancelled swipe does nothing', () => {
    const { context, calls, pointer, runTimers } = setup();
    context.handleMessagePointerDown(pointer(100, 100));
    runTimers();
    context.finishMessageGesture(pointer(100, 100), false);
    assert.equal(calls.actions, 1);
    assert.deepEqual(calls.react, [], 'a long press is no tap');

    const second = setup();
    second.context.handleMessagePointerDown(second.pointer(100, 100));
    second.context.handleMessagePointerMove(second.pointer(200, 100));
    second.context.finishMessageGesture(second.pointer(200, 100), true);
    assert.deepEqual(second.calls.reply, []);
});

test('double tap reacts with a heart', () => {
    const { context, calls, pointer } = setup();
    for (let tap = 0; tap < 2; tap++) {
        context.handleMessagePointerDown(pointer(100, 100));
        context.finishMessageGesture(pointer(100, 100), false);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(calls.react)), [['m1', '❤️']]);
});

test('pull up at the end of a chat runs the configured action', () => {
    const calls = [];
    const { context } = setup();
    Object.assign(context, {
        neighbourChat: () => 'next-peer',
        visibleChatPeerIds: () => ['a', 'b'],
        switchToChat: async peerId => calls.push(`switch:${peerId}`),
        openSnapUploadModal: async () => calls.push('snap'),
        openAlbumPicker: () => calls.push('album'),
        openChatSwitcherSheet: () => calls.push('switcher'),
        logBackgroundError: () => () => {}
    });
    context.state = { activeChatPeerId: 'a' };
    context.window.location = { reload: () => calls.push('reload') };
    for (const action of ['reload', 'next', 'switcher', 'snap', 'album', 'unknown']) {
        context.state.pullUpAction = action;
        context.runPullUpAction();
    }
    assert.deepEqual(calls, ['reload', 'switch:next-peer', 'switcher', 'snap', 'album', 'reload']);

    // Am Ende der Liste geht es von vorn weiter.
    calls.length = 0;
    context.neighbourChat = () => null;
    context.state.pullUpAction = 'next';
    context.runPullUpAction();
    assert.deepEqual(calls, ['switch:b']);
});
