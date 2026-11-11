import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Der Router nimmt nur DELETE_CHAT und BLOCK an (server/app.js); kleingeschrieben gab es 400 (Sperren nach Umzug/Koppeln).
test('every chat control the client stores uses an action the router accepts', () => {
    const files = ['client/app', 'client'].flatMap(dir => readdirSync(new URL(`../${dir}`, import.meta.url))
        .filter(name => name.endsWith('.js')).map(name => `${dir}/${name}`));
    const used = files.flatMap(file => [...readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
        .matchAll(/storeChatControl\([^,]+,\s*'([^']+)'\)/g)].map(match => [file, match[1]]));
    assert.ok(used.length >= 3);
    for (const [file, action] of used) assert.ok(['DELETE_CHAT', 'BLOCK'].includes(action), `${file}: ${action}`);
});
