// Fuehrt E2E-Dateien nacheinander aus (im Playwright-Container von scripts/e2e.sh), zeigt ihre Ausgabe wie bisher
// und schreibt eine JUnit-Datei fuer Jenkins (`junit`-Schritt): ein Testfall je Datei, bei Fehlern mit dem Ende der
// Ausgabe. Laeuft nach einem Fehler weiter, damit alle roten Tests sichtbar sind; Exit-Code 1, wenn einer scheitert.
//   node e2e-runner.cjs <junit.xml> <variante> <datei.e2e.cjs>...
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');

const [output, variant, ...files] = process.argv.slice(2);
const OUTPUT_LIMIT = 20000;

const escapeXml = value => String(value).replace(/[<>&"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[char]));
const cdata = value => `<![CDATA[${String(value).replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;

function run(file) {
    return new Promise(resolve => {
        const startedAt = Date.now();
        let log = '';
        const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
        const collect = stream => chunk => {
            stream.write(chunk);
            log = (log + chunk.toString()).slice(-OUTPUT_LIMIT);
        };
        child.stdout.on('data', collect(process.stdout));
        child.stderr.on('data', collect(process.stderr));
        child.on('close', code => resolve({ file, code: code ?? 1, seconds: (Date.now() - startedAt) / 1000, log }));
    });
}

(async () => {
    const results = [];
    for (const file of files) results.push(await run(file));
    const failures = results.filter(result => result.code !== 0);
    const total = results.reduce((sum, result) => sum + result.seconds, 0);
    const cases = results.map(result => {
        const name = escapeXml(result.file.replace(/\.e2e\.cjs$/, ''));
        const out = result.log.trim() ? `<system-out>${cdata(result.log)}</system-out>` : '';
        const failure = result.code !== 0 ? `<failure message="exit code ${result.code}">${cdata(result.log)}</failure>` : '';
        return `    <testcase classname="e2e.${escapeXml(variant)}" name="${name}" time="${result.seconds.toFixed(1)}">${failure}${out}</testcase>`;
    });
    writeFileSync(output, `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="e2e-${escapeXml(variant)}" tests="${results.length}" failures="${failures.length}" time="${total.toFixed(1)}">
${cases.join('\n')}
  </testsuite>
</testsuites>
`);
    if (failures.length) console.error(`E2E failed (${variant}): ${failures.map(result => result.file).join(', ')}`);
    process.exit(failures.length ? 1 : 0);
})();
