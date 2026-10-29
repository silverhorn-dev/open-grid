import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Das Image enthaelt nur, was der Dockerfile kopiert. Liest der Server beim Start eine Datei aus dem
// Projekt-Wurzelordner, muss sie dort stehen (sonst startet der Container nicht, z. B. admin.html).
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('every project file the server reads is copied into the image', () => {
    const dockerfile = read('Dockerfile');
    const finalStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    // Quellen und Ziele aller COPY-Zeilen (auch aus der Build-Stufe), als Namen relativ zu /app.
    const copied = finalStage.split('\n').filter(line => line.startsWith('COPY '))
        .flatMap(line => line.replace(/^COPY\s+(--\S+\s+)*/, '').split(/\s+/))
        .map(path => path.replace(/^(\.\/|\/app\/)/, '').replace(/\/$/, ''));
    const serverSources = ['server/app.js', 'server/info-site.js', 'server/nudity-model.js'].map(read).join('\n');
    const rootFiles = [...serverSources.matchAll(/read(?:File|dir)\(join\(projectDirectory, '([^'/]+)'/g)].map(match => match[1]);
    assert.ok(rootFiles.includes('admin.html') && rootFiles.includes('index.html'), `found ${rootFiles}`);
    for (const file of new Set(rootFiles)) {
        assert.ok(copied.includes(file), `${file} is read by the server but not copied in the Dockerfile`);
    }
});
