// ================= MARKDOWN (App-Changelog, Info-Seite) =================
// Kleine, sichere Untermenge: Ueberschriften (#-###), Absaetze, Listen (- / 1.), Zitate (>), Tabellen
// (| a | b |), Trennlinie (---), **fett**, *kursiv*, `Code`, [Link](ziel). Aufbau als DOM, nie ueber
// innerHTML; Links nur relativ, http(s) oder ueber options.resolveLink (z. B. "page:faq").

// Text -> Bloecke (rein, ohne DOM; testbar).
function parseMarkdown(text) {
    const blocks = [];
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [];
    let list = null;
    const flushParagraph = () => {
        if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
        paragraph = [];
    };
    const flushList = () => {
        if (list) blocks.push(list);
        list = null;
    };
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const trimmed = line.trim();
        if (!trimmed) {
            flushParagraph();
            flushList();
            continue;
        }
        const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            flushParagraph();
            flushList();
            blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
            continue;
        }
        if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
            flushParagraph();
            flushList();
            blocks.push({ type: 'rule' });
            continue;
        }
        if (trimmed.startsWith('>')) {
            flushParagraph();
            flushList();
            const quote = [trimmed.replace(/^>\s?/, '')];
            while (index + 1 < lines.length && lines[index + 1].trim().startsWith('>')) {
                quote.push(lines[++index].trim().replace(/^>\s?/, ''));
            }
            blocks.push({ type: 'quote', text: quote.join(' ') });
            continue;
        }
        if (trimmed.startsWith('|') && index + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[index + 1].trim())) {
            flushParagraph();
            flushList();
            const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
            const table = { type: 'table', header: cells(trimmed), rows: [] };
            index++;
            while (index + 1 < lines.length && lines[index + 1].trim().startsWith('|')) table.rows.push(cells(lines[++index]));
            blocks.push(table);
            continue;
        }
        const item = trimmed.match(/^([-*+]|\d+[.)])\s+(.*)$/);
        if (item) {
            flushParagraph();
            const ordered = /\d/.test(item[1]);
            if (!list || list.ordered !== ordered) {
                flushList();
                list = { type: 'list', ordered, items: [] };
            }
            list.items.push(item[2]);
            continue;
        }
        if (list && /^\s{2,}/.test(line)) {
            list.items[list.items.length - 1] += ` ${trimmed}`;
            continue;
        }
        flushList();
        paragraph.push(trimmed);
    }
    flushParagraph();
    flushList();
    return blocks;
}

// Zeile -> Inline-Teile: { type: 'text'|'strong'|'em'|'code'|'link', text, href, children }.
function parseInline(text) {
    const parts = [];
    const pattern = /`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text))) {
        if (match.index > last) parts.push({ type: 'text', text: text.slice(last, match.index) });
        if (match[1] !== undefined) parts.push({ type: 'code', text: match[1] });
        else if (match[2] !== undefined) parts.push({ type: 'strong', children: parseInline(match[2]) });
        else if (match[3] !== undefined) parts.push({ type: 'em', children: parseInline(match[3]) });
        else parts.push({ type: 'link', href: match[5], children: parseInline(match[4]) });
        last = pattern.lastIndex;
    }
    if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
    return parts;
}

function isSafeHref(href) {
    return /^(https?:\/\/|\/(?!\/)|#|mailto:)/i.test(href);
}

function appendInline(element, text, options) {
    appendInlineParts(element, parseInline(text), options);
}

function appendInlineParts(element, parts, options) {
    for (const part of parts) {
        if (part.type === 'text') {
            element.appendChild(document.createTextNode(part.text));
        } else if (part.type === 'code') {
            const code = document.createElement('code');
            code.className = 'md-code';
            code.textContent = part.text;
            element.appendChild(code);
        } else if (part.type === 'strong' || part.type === 'em') {
            const wrapper = document.createElement(part.type);
            appendInlineParts(wrapper, part.children, options);
            element.appendChild(wrapper);
        } else {
            const resolved = options.resolveLink ? options.resolveLink(part.href) : part.href;
            if (!resolved || !isSafeHref(resolved)) {
                appendInlineParts(element, part.children, options);
                continue;
            }
            const link = document.createElement('a');
            link.href = resolved;
            link.className = 'md-link';
            if (/^https?:\/\//i.test(resolved) && !resolved.startsWith(window.location.origin)) {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
            appendInlineParts(link, part.children, options);
            element.appendChild(link);
        }
    }
}

// Bloecke -> DOM. options.resolveLink(href) darf Links umschreiben oder verwerfen (null).
function renderMarkdown(text, options = {}) {
    const root = document.createElement('div');
    root.className = 'md';
    for (const block of parseMarkdown(text)) {
        let element;
        if (block.type === 'heading') {
            element = document.createElement(`h${Math.min(4, block.level)}`);
            appendInline(element, block.text, options);
        } else if (block.type === 'paragraph') {
            element = document.createElement('p');
            appendInline(element, block.text, options);
        } else if (block.type === 'quote') {
            element = document.createElement('blockquote');
            appendInline(element, block.text, options);
        } else if (block.type === 'rule') {
            element = document.createElement('hr');
        } else if (block.type === 'list') {
            element = document.createElement(block.ordered ? 'ol' : 'ul');
            block.items.forEach(item => {
                const entry = document.createElement('li');
                appendInline(entry, item, options);
                element.appendChild(entry);
            });
        } else if (block.type === 'table') {
            element = document.createElement('div');
            element.className = 'md-table';
            const table = document.createElement('table');
            const head = document.createElement('tr');
            block.header.forEach(cell => {
                const th = document.createElement('th');
                appendInline(th, cell, options);
                head.appendChild(th);
            });
            const thead = document.createElement('thead');
            thead.appendChild(head);
            const tbody = document.createElement('tbody');
            block.rows.forEach(row => {
                const tr = document.createElement('tr');
                row.forEach(cell => {
                    const td = document.createElement('td');
                    appendInline(td, cell, options);
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            table.append(thead, tbody);
            element.appendChild(table);
        }
        if (element) root.appendChild(element);
    }
    return root;
}
