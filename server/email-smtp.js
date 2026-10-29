// ================= E-MAIL-CODES PER SMTP (Board T2) =================
// Versand ueber den Mailserver des Betreibers (EMAIL_TRANSPORT=smtp), mit nodemailer. Das Paket ist
// optional (optionalDependencies) und wird erst beim ersten Versand geladen; ohne SMTP braucht es
// niemand. Der Mailserver erfaehrt nur Adresse und Code, keine Peer-ID.
//
//   SMTP_URL   smtp://user:pass@mail.example.org:587 (STARTTLS) oder smtps://...:465 (TLS)
//   SMTP_FROM  Absender, z. B. "OpenGrid <no-reply@example.org>"
const SMTP_TIMEOUT_MS = 15000;

export function parseSmtpConfig({ url, from } = {}) {
    const rawUrl = String(url ?? '').trim();
    const sender = String(from ?? '').trim();
    if (!rawUrl || !sender) return null;
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }
    if (!['smtp:', 'smtps:'].includes(parsed.protocol) || !parsed.hostname) return null;
    return { url: rawUrl, from: sender };
}

// Zweisprachig: der Router kennt die Sprache des Nutzers nicht.
export function emailCodeMessage(code) {
    return {
        subject: `OpenGrid: ${code}`,
        text: [
            `Dein Bestaetigungscode: ${code}`,
            'Er gilt 15 Minuten. Hast du keinen Code angefordert, ignoriere diese E-Mail.',
            '',
            `Your confirmation code: ${code}`,
            'It is valid for 15 minutes. If you did not request a code, ignore this email.'
        ].join('\n')
    };
}

export function createSmtpTransport(config, { loadMailer = () => import('nodemailer') } = {}) {
    let mailerPromise = null;
    const mailer = () => {
        if (!mailerPromise) {
            mailerPromise = loadMailer()
                .then(module => (module.default ?? module).createTransport(config.url, {
                    connectionTimeout: SMTP_TIMEOUT_MS,
                    greetingTimeout: SMTP_TIMEOUT_MS,
                    socketTimeout: SMTP_TIMEOUT_MS
                }))
                .catch(error => {
                    mailerPromise = null;
                    throw new Error(`nodemailer is not available (npm install nodemailer): ${error.message}`);
                });
        }
        return mailerPromise;
    };
    return {
        async send({ email, code }) {
            const transport = await mailer();
            await transport.sendMail({ from: config.from, to: email, ...emailCodeMessage(code) });
        }
    };
}
