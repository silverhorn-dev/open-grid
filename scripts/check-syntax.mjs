// Syntax-Pruefung aller Server- und Client-Skripte (npm run check). Client-Dateien sind klassische
// Skripte ohne Module; ein Fehler darin stoppt die ganze App beim Start.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const files = [
    ...readdirSync('server').filter(name => name.endsWith('.js')).map(name => join('server', name)),
    ...readdirSync(join('client', 'app')).filter(name => name.endsWith('.js')).map(name => join('client', 'app', name)),
    join('client', 'sw.js'),
    join('client', 'admin.js')
];
let failed = 0;
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
        failed += 1;
        process.stderr.write(`${file}\n${result.stderr}\n`);
    }
}
if (failed) {
    console.error(`${failed} file(s) with syntax errors`);
    process.exit(1);
}
console.log(`Syntax OK (${files.length} files)`);
