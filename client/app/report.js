// ================= MELDEN (Board T25) =================
// Nutzer manuell melden (Chat-Menue): Grund ist Pflicht, bei "Sonstiges" auch eine kurze Beschreibung.
// An den Router gehen nur IDs, Grund und Notiz (nie Chat-Inhalte); nach mehreren Meldungen verschiedener
// Personen blendet der Router den Peer im Grid aus, bis der Betreiber entscheidet (server/reports.js).
// Derselbe Dialog dient fuer GIF-Meldungen (gifs.js) mit eigener Grundliste.
const USER_REPORT_REASONS = ['spam', 'harassment', 'sexual', 'minor', 'scam', 'hate', 'violence', 'impersonation', 'other'];
const GIF_REPORT_REASONS = ['sexual', 'violence', 'hate', 'spam', 'other'];

// Feste Schluessel: scripts/i18n-keys.mjs findet nur woertliche Aufrufe, keine zusammengesetzten Schluessel.
function reportReasonLabel(reason) {
    return {
        spam: t('report.reason.spam'), harassment: t('report.reason.harassment'), sexual: t('report.reason.sexual'),
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
    return ok;
}

function chatMenuReport() {
    if (typeof closeChatHeaderMenu === 'function') closeChatHeaderMenu();
    return reportPeer(state.activeChatPeerId);
}
