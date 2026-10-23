// ================= DEKLARATIVE AKTIONEN (statt Inline-Handlern) =================
// Das Markup nutzt keine onclick/onchange-Attribute mehr, damit die CSP ohne 'unsafe-inline'
// auskommt. Stattdessen:
//   data-click="fn"   data-change="fn"   data-input="fn"   data-enter="fn" (Enter-Taste)
//   data-args='[...]' JSON-Argumente; Platzhalter: "$value", "$checked", "$number" (Number(value)),
//                     "$el" (das Element), "$src", "$event"
// Aufgerufen werden nur globale Funktionen (Funktionsdeklarationen der App-Skripte).
const ACTION_PLACEHOLDERS = {
    $value: (element) => element.value,
    $checked: (element) => element.checked,
    $number: (element) => Number(element.value),
    $el: (element) => element,
    $src: (element) => element.src,
    $event: (_element, event) => event
};

function resolveActionArgs(element, event) {
    if (!element.dataset.args) return [];
    try {
        const args = JSON.parse(element.dataset.args);
        return Array.isArray(args)
            ? args.map(arg => (typeof arg === 'string' && ACTION_PLACEHOLDERS[arg] ? ACTION_PLACEHOLDERS[arg](element, event) : arg))
            : [];
    } catch {
        return [];
    }
}

function runAction(element, name, event) {
    const action = window[name];
    if (typeof action !== 'function') {
        logDebug(`Unbekannte Aktion "${name}".`);
        return;
    }
    try {
        const result = action(...resolveActionArgs(element, event));
        if (result && typeof result.catch === 'function') result.catch(logBackgroundError(name));
    } catch (error) {
        logDebug(`Aktion "${name}" fehlgeschlagen: ${error?.message || error}`);
    }
}

function delegateAction(eventType, attribute) {
    document.addEventListener(eventType, event => {
        const element = event.target.closest?.(`[data-${attribute}]`);
        if (!element) return;
        if (attribute === 'enter' && event.key !== 'Enter') return;
        runAction(element, element.dataset[attribute], event);
    });
}

delegateAction('click', 'click');
delegateAction('change', 'change');
delegateAction('input', 'input');
delegateAction('keydown', 'enter');
// Kein Kontextmenue (z. B. Secure-Snap-Viewer).
document.addEventListener('contextmenu', event => {
    if (event.target.closest?.('[data-no-context-menu]')) event.preventDefault();
});

// ----- Zusammengesetzte Aktionen aus dem Markup -----
function openSettingsFromMenu() {
    switchTab('keys');
    closeMenu();
}

function openCloudFromMenu() {
    switchTab('cloud');
    closeMenu();
}

function unregisterFromMenu() {
    closeMenu();
    return gracefulUnregister();
}

function openInviteCard() {
    switchTab('keys');
    document.getElementById('invite-card')?.scrollIntoView({ behavior: 'smooth' });
}

function openActiveChatProfile() {
    if (state.activeChatPeerId) openProfileModal(state.activeChatPeerId);
}

function chatMenuMedia() {
    closeChatHeaderMenu();
    openChatMediaOverview();
}

function chatMenuProfile() {
    closeChatHeaderMenu();
    openActiveChatProfile();
}

function chatMenuDeleteChat() {
    closeChatHeaderMenu();
    return deleteActiveChat();
}

function chatMenuToggleBlock() {
    closeChatHeaderMenu();
    return toggleActivePeerBlock();
}
