import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmtpTransport, emailCodeMessage, parseSmtpConfig } from '../server/email-smtp.js';
import { parseSafetyConfig } from '../server/safety.js';

test('smtp config needs smtp(s) url and sender', () => {
    assert.equal(parseSmtpConfig({}), null);
    assert.equal(parseSmtpConfig({ url: 'smtp://mail.example.org' }), null, 'sender missing');
    assert.equal(parseSmtpConfig({ url: 'http://mail.example.org', from: 'a@b.c' }), null);
    assert.equal(parseSmtpConfig({ url: 'not a url', from: 'a@b.c' }), null);
    assert.deepEqual(parseSmtpConfig({ url: ' smtps://u:p@mail.example.org:465 ', from: 'OpenGrid <no-reply@example.org>' }),
        { url: 'smtps://u:p@mail.example.org:465', from: 'OpenGrid <no-reply@example.org>' });
    assert.equal(parseSafetyConfig({ emailTransport: 'smtp' }).smtp, null);
    assert.equal(parseSafetyConfig({ emailTransport: 'smtp', smtpUrl: 'smtp://m.example.org:587', smtpFrom: 'x@example.org' }).smtp.from, 'x@example.org');
});

test('smtp transport loads nodemailer lazily, once, and sends a bilingual code mail', async () => {
    const sent = [];
    let loads = 0;
    let options = null;
    const fake = {
        createTransport(url, settings) {
            options = { url, settings };
            return { sendMail: async mail => sent.push(mail) };
        }
    };
    const transport = createSmtpTransport({ url: 'smtp://m.example.org:587', from: 'og@example.org' }, {
        loadMailer: async () => { loads += 1; return { default: fake }; }
    });
    assert.equal(loads, 0, 'nothing loaded before the first mail');
    await transport.send({ email: 'alex@example.org', code: '123456' });
    await transport.send({ email: 'kim@example.org', code: '654321' });
    assert.equal(loads, 1);
    assert.equal(options.url, 'smtp://m.example.org:587');
    assert.ok(options.settings.socketTimeout > 0);
    assert.deepEqual(sent.map(mail => [mail.from, mail.to]), [['og@example.org', 'alex@example.org'], ['og@example.org', 'kim@example.org']]);
    assert.match(sent[0].text, /Bestaetigungscode: 123456/);
    assert.match(sent[0].text, /confirmation code: 123456/);
    assert.equal(emailCodeMessage('1').subject, 'OpenGrid: 1');
});

test('smtp transport without nodemailer fails with a clear error and retries later', async () => {
    let attempts = 0;
    const transport = createSmtpTransport({ url: 'smtp://m.example.org', from: 'og@example.org' }, {
        loadMailer: async () => { attempts += 1; throw new Error('Cannot find package'); }
    });
    await assert.rejects(transport.send({ email: 'a@example.org', code: '1' }), /nodemailer is not available/);
    await assert.rejects(transport.send({ email: 'a@example.org', code: '1' }), /nodemailer is not available/);
    assert.equal(attempts, 2);
});
