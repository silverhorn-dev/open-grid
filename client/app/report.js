// ================= MELDEN (Board T25) =================
// Nutzer manuell melden (Chat-Menue): Grund ist Pflicht, bei "Sonstiges" auch eine kurze Beschreibung.
// An den Router gehen nur IDs, Grund und Notiz (nie Chat-Inhalte); nach mehreren Meldungen verschiedener
// Personen blendet der Router den Peer im Grid aus, bis der Betreiber entscheidet (server/reports.js).
// Derselbe Dialog dient fuer GIF-Meldungen (gifs.js) mit eigener Grundliste.
const USER_REPORT_REASONS = ['spam', 'harassment', 'sexual', 'sextortion', 'minor', 'scam', 'hate', 'violence', 'impersonation', 'other'];
const GIF_REPORT_REASONS = ['sexual', 'violence', 'hate', 'spam', 'other'];

// Feste Schluessel: scripts/i18n-keys.mjs findet nur woertliche Aufrufe, keine zusammengesetzten Schluessel.
function reportReasonLabel(reason) {
    return {
        spam: t('report.reason.spam'), harassment: t('report.reason.harassment'), sexual: t('report.reason.sexual'),
        sextortion: t('report.reason.sextortion'),
        minor: t('report.reason.minor'), scam: t('report.reason.scam'), hate: t('report.reason.hate'),
        violence: t('report.reason.violence'), impersonation: t('report.reason.impersonation'), other: t('report.reason.other')
    }[reason] || reason;
}

// Liefert { reason, note } oder null (abgebrochen).
function openReportDialog({ title, intro, reasons, noteRequiredFor = ['other'] }) {
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        const content = openMediaModal(title);
        state.mediaModalCleanup = () => finish(null);
        const form = document.createElement('form');
        form.id = 'report-form';
        form.className = 'space-y-3';
        const text = document.createElement('p');
        text.className = 'text-sm text-slate-400';
        text.textContent = intro;
        const list = document.createElement('div');
        list.className = 'space-y-1';
        list.setAttribute('role', 'radiogroup');
        reasons.forEach(reason => {
            const label = document.createElement('label');
            label.className = 'flex items-center gap-3 rounded-lg border border-slate-800 px-3 py-2 text-sm text-slate-200 cursor-pointer hover:border-slate-600';
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'report-reason';
            input.value = reason;
            const span = document.createElement('span');
            span.textContent = reportReasonLabel(reason);
            label.append(input, span);
            list.appendChild(label);
        });
        const note = document.createElement('textarea');
        note.id = 'report-note';
        note.maxLength = 500;
        note.rows = 3;
        note.placeholder = t('report.notePlaceholder');
        note.className = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-base text-slate-100 focus:outline-hidden focus:border-brand-500';
        const error = document.createElement('p');
        error.id = 'report-error';
        error.className = 'hidden text-xs text-red-300';
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.id = 'report-submit';
        submit.className = 'w-full rounded-full bg-red-600 hover:bg-red-500 px-4 py-2.5 text-sm font-semibold text-white';
        submit.textContent = t('report.send');
        form.append(text, list, note, error, submit);
        form.onsubmit = event => {
            event.preventDefault();
            const reason = form.querySelector('input[name="report-reason"]:checked')?.value;
            const noteText = note.value.trim();
            const problem = !reason ? t('report.pickReason')
                : noteRequiredFor.includes(reason) && noteText.length < 3 ? t('report.describeReason') : '';
            error.textContent = problem;
            error.classList.toggle('hidden', !problem);
            if (problem) return;
            finish({ reason, note: noteText || undefined });
            state.mediaModalCleanup = null;
            closeMediaModal();
        };
        content.appendChild(form);
    });
}

async function reportPeer(peerId) {
    if (!peerId) return false;
    const name = state.cachedProfiles?.[peerId]?.fields?.displayName || state.peers?.find(peer => peer.id === peerId)?.name || '';
    const choice = await openReportDialog({
        title: name ? t('report.userTitleNamed', { name }) : t('report.userTitle'),
        intro: t('report.userIntro'),
        reasons: USER_REPORT_REASONS
    });
    if (!choice) return false;
    const response = await fetch(`${API_BASE}/api/reports`, {
        method: 'POST',
        headers: peerAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ peerId: state.myProfile.id, reportedPeerId: peerId, kind: 'user', reason: choice.reason, note: choice.note })
    }).catch(() => null);
    const ok = Boolean(response?.ok);
    showToast(ok ? t('report.sent') : t('report.failed'), ok ? 'success' : 'error');
    // Wer meldet, will meist auch nichts mehr bekommen: Blockieren anbieten (der normale Ablauf fragt selbst nach).
    if (ok && !isPeerBlocked(peerId) && state.activeChatPeerId === peerId) await toggleActivePeerBlock();
    // Erpressung mit Nacktbildern (Board T37 P5): danach Hilfe und Anlaufstellen zeigen, auch wenn das Melden scheiterte.
    if (choice.reason === 'sextortion') openSextortionHelp();
    return ok;
}

// ----- Hilfe bei Erpressung mit Nacktbildern (Sextortion, Board T37 P5) -----
// Nur Text und Links; nichts wird gesendet. Links oeffnen erst auf Tippen (fremde Seiten, eigener Tab/Browser).
const SEXTORTION_HELP_LINKS = [
    { url: 'https://stopncii.org/', label: () => t('help.sextortion.linkStopNcii') },
    { url: 'https://takeitdown.ncmec.org/', label: () => t('help.sextortion.linkTakeItDown') },
    { url: 'https://hateaid.org/', label: () => t('help.sextortion.linkHateAid') },
    { url: 'https://www.nummergegenkummer.de/', label: () => t('help.sextortion.linkKummer') },
    { url: 'https://www.telefonseelsorge.de/', label: () => t('help.sextortion.linkSeelsorge') }
];

function openSextortionHelp() {
    const content = openMediaModal(t('help.sextortion.title'));
    const box = document.createElement('div');
    box.id = 'sextortion-help';
    box.className = 'space-y-3 text-sm text-slate-300';
    const paragraph = (text, className = '') => {
        const element = document.createElement('p');
        if (className) element.className = className;
        element.textContent = text;
        return element;
    };
    const heading = text => paragraph(text, 'font-semibold text-slate-100 pt-1');
    const list = items => {
        const element = document.createElement('ul');
        element.className = 'list-disc pl-5 space-y-1';
        items.forEach(text => {
            const item = document.createElement('li');
            item.textContent = text;
            element.appendChild(item);
        });
        return element;
    };
    const links = document.createElement('div');
    links.className = 'flex flex-col gap-2';
    SEXTORTION_HELP_LINKS.forEach(({ url, label }) => {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'btn-secondary text-left';
        link.textContent = label();
        links.appendChild(link);
    });
    box.append(
        paragraph(t('help.sextortion.intro'), 'text-slate-200'),
        heading(t('help.sextortion.nowTitle')),
        list([t('help.sextortion.nowPay'), t('help.sextortion.nowStop'), t('help.sextortion.nowEvidence'), t('help.sextortion.nowBlock')]),
        heading(t('help.sextortion.policeTitle')),
        paragraph(t('help.sextortion.police')),
        heading(t('help.sextortion.removeTitle')),
        paragraph(t('help.sextortion.remove')),
        heading(t('help.sextortion.talkTitle')),
        paragraph(t('help.sextortion.talk')),
        links,
        paragraph(t('help.sextortion.notAlone'), 'text-slate-200 pt-1')
    );
    content.appendChild(box);
}

function chatMenuReport() {
    if (typeof closeChatHeaderMenu === 'function') closeChatHeaderMenu();
    return reportPeer(state.activeChatPeerId);
}
