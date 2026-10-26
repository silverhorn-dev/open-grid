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

// Changelog (CHANGELOG.md im Repo): einfaches Markdown (Ueberschriften, Listen) als DOM, ohne innerHTML.
function openChangelogFromMenu() {
    replaceModal(closeMenu, showChangelog);
}

async function showChangelog() {
    const content = openMediaModal(t('Changelog'));
    content.textContent = t('Wird geladen...');
    try {
        const response = await fetch('/changelog.md', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        content.replaceChildren(renderChangelog(await response.text()));
    } catch (error) {
        content.textContent = t('Changelog nicht verfuegbar ({message}).', { message: error.message });
    }
}

function renderChangelog(markdown) {
    const root = document.createElement('div');
    root.className = 'space-y-2 text-sm text-slate-300';
    let list = null;
    const appendInline = (element, text) => {
        // `code` als Monospace, sonst reiner Text.
        text.split(/(`[^`]+`)/).forEach(part => {
            if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
                const code = document.createElement('code');
                code.className = 'px-1 rounded bg-slate-800 text-[12px]';
                code.textContent = part.slice(1, -1);
                element.appendChild(code);
            } else if (part) {
                element.appendChild(document.createTextNode(part));
            }
        });
    };
    markdown.split(/\r?\n/).forEach(line => {
        const heading = line.match(/^(#{1,3})\s+(.*)$/);
        const item = line.match(/^\s*[-*]\s+(.*)$/);
        if (item) {
            if (!list) {
                list = document.createElement('ul');
                list.className = 'list-disc pl-5 space-y-1';
                root.appendChild(list);
            }
            const entry = document.createElement('li');
            appendInline(entry, item[1]);
            list.appendChild(entry);
            return;
        }
        list = null;
        if (heading) {
            const level = heading[1].length;
            if (level === 1) return;
            const element = document.createElement(level === 2 ? 'h3' : 'h4');
            element.className = level === 2 ? 'pt-3 text-sm font-bold text-slate-100' : 'pt-1 text-xs font-bold uppercase tracking-wider text-brand-400';
            appendInline(element, heading[2]);
            root.appendChild(element);
        } else if (line.trim()) {
            const paragraph = document.createElement('p');
            paragraph.className = 'text-xs text-slate-500';
            appendInline(paragraph, line.trim());
            root.appendChild(paragraph);
        }
    });
    return root;
}

function openProfileFromMenu() {
    switchTab('editprofile');
    closeMenu();
}

function openModeFromMenu() {
    switchTab('keys');
    switchSettingsTab('general');
    closeMenu();
}

function openInviteFromMenu() {
    openInviteCard();
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
    switchSettingsTab('general');
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
