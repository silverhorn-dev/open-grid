import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const clientDirectory = new URL('../client/', import.meta.url).pathname;

function clientSources() {
    const files = [];
    const walk = directory => readdirSync(directory, { withFileTypes: true }).forEach(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.js') && entry.name !== 'sw.js') files.push(path);
    });
    walk(clientDirectory);
    return files.map(file => readFileSync(file, 'utf8')).join('\n');
}

// Regression: ein nicht deklariertes state-Feld (matchState) liess den Start mit
// "Cannot read properties of undefined" abbrechen, sobald es vor seiner Zuweisung gelesen wurde.
test('every state field used by the client is declared in config.js', () => {
    const config = readFileSync(join(clientDirectory, 'app', 'config.js'), 'utf8');
    const block = config.slice(config.indexOf('const state = {'));
    const declared = new Set([...block.slice(0, block.indexOf('\n};')).matchAll(/^ {4}([A-Za-z_]\w*):/gm)].map(match => match[1]));
    // history.state.from ist kein Feld des App-States.
    const used = new Set([...clientSources().matchAll(/(?<!history\.)\bstate\.([A-Za-z_]\w*)/g)].map(match => match[1]));
    const missing = [...used].filter(field => !declared.has(field));
    assert.deepEqual(missing, []);
});
