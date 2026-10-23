import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function loadTheme(storage = {}, prefersLight = false) {
    const classes = new Set(['dark']);
    const properties = new Map();
    const context = {
        window: {
            localStorage: {
                getItem: key => storage[key] ?? null,
                setItem: (key, value) => { storage[key] = value; },
                removeItem: key => { delete storage[key]; }
            },
            matchMedia: () => ({ matches: prefersLight, addEventListener: () => {} })
        },
        document: {
            documentElement: {
                classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) },
                style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) }
            },
            querySelector: () => null,
            querySelectorAll: () => [],
            getElementById: () => null
        },
        JSON,
        Math,
        Number,
        Object
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/theme.js', import.meta.url), 'utf8'), context);
    return { context, classes, properties, storage };
}

test('applies the stored theme and follows the system setting', () => {
    assert.ok(loadTheme({ 'opengrid-theme': 'light' }).classes.has('theme-light'));
    assert.ok(!loadTheme({ 'opengrid-theme': 'dark' }, true).classes.has('theme-light'));
    assert.ok(loadTheme({}, true).classes.has('theme-light'), 'system + light preference');
    assert.ok(loadTheme({}, false).classes.has('dark'));
});

test('builds a full accent palette from hue and saturation', () => {
    const { context, properties, storage } = loadTheme({ 'opengrid-accent': JSON.stringify({ hue: 220, saturation: 85 }) });
    assert.equal(properties.size, 11, 'shades 50-950');
    assert.match(properties.get('--brand-500'), /^\d{1,3} \d{1,3} \d{1,3}$/);
    const [red, , blue] = properties.get('--brand-500').split(' ').map(Number);
    assert.ok(blue > red, 'hue 220 is blue');
    assert.deepEqual([...context.hslToRgb(0, 100, 50)], [255, 0, 0]);

    context.setAccent(null);
    assert.equal(properties.size, 0, 'reset falls back to the CSS defaults');
    assert.equal(storage['opengrid-accent'], undefined);
});

test('tailwind palettes come from CSS variables', () => {
    const config = readFileSync(new URL('../tailwind.config.cjs', import.meta.url), 'utf8');
    assert.match(config, /fromVariables\('slate'\)/);
    assert.match(config, /fromVariables\('brand'\)/);
    const styles = readFileSync(new URL('../client/styles.css', import.meta.url), 'utf8');
    assert.match(styles, /:root\.theme-light \{/);
    assert.doesNotMatch(styles.replace(/:root[^{]*\{[^}]*\}/g, ''), /#0f172a|#1e293b|#334155/, 'no hard-coded slate colors outside the variables');
});
