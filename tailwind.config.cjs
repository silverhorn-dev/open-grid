// Tailwind wird beim Build vorab kompiliert (npm run build:css), damit die App offline
// und ohne externes CDN funktioniert. Gescannt werden alle Dateien mit Klassennamen.
// `slate` und `brand` kommen aus CSS-Variablen (client/styles.css, client/app/theme.js):
// so wechseln Hell/Dunkel und Akzentfarbe zur Laufzeit, ohne Klassen im Markup zu aendern.
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const fromVariables = name => Object.fromEntries(SHADES.map(shade => [shade, `rgb(var(--${name}-${shade}) / <alpha-value>)`]));

module.exports = {
    content: ['./index.html', './client/**/*.js'],
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                slate: fromVariables('slate'),
                brand: fromVariables('brand'),
                darkbg: 'rgb(var(--slate-900) / <alpha-value>)',
                cardbg: 'rgb(var(--slate-800) / <alpha-value>)'
            }
        }
    }
};
