// ================= GEMEINSAME UI-BAUSTEINE =================
// Leere Zustaende und Ladeanzeigen ueberall im gleichen Muster: Symbol im Kreis, kurzer Titel,
// optional ein Satz Erklaerung und ein Knopf. Texte kommen bereits uebersetzt (t()).
function createEmptyState({ icon = 'fa-circle-info', title = '', text = '', action = null, spin = false, compact = false } = {}) {
    const box = document.createElement('div');
    box.className = `empty-state${compact ? ' empty-state-compact' : ''}`;
    const symbol = document.createElement('span');
    symbol.className = 'empty-state-icon';
    symbol.setAttribute('aria-hidden', 'true');
    const glyph = document.createElement('i');
    glyph.className = `fa-solid ${icon}${spin ? ' fa-spin' : ''}`;
    symbol.appendChild(glyph);
    box.appendChild(symbol);
    if (title) {
        const heading = document.createElement('div');
        heading.className = 'empty-state-title';
        heading.textContent = title;
        box.appendChild(heading);
    }
    if (text) {
        const body = document.createElement('div');
        body.className = 'empty-state-text';
        body.textContent = text;
        box.appendChild(body);
    }
    if (action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-secondary mt-1';
        if (action.icon) {
            const actionIcon = document.createElement('i');
            actionIcon.className = `fa-solid ${action.icon}`;
            button.appendChild(actionIcon);
        }
        button.appendChild(document.createTextNode(action.label));
        button.onclick = event => {
            event.stopPropagation();
            action.onClick();
        };
        box.appendChild(button);
    }
    return box;
}

// Inhalt eines Containers durch einen leeren Zustand ersetzen.
function showEmptyState(container, options) {
    if (!container) return null;
    const box = createEmptyState(options);
    container.replaceChildren(box);
    return box;
}
