// Tailwind wird beim Build vorab kompiliert (npm run build:css), damit die App offline
// und ohne externes CDN funktioniert. Gescannt werden alle Dateien mit Klassennamen.
module.exports = {
    content: ['./index.html', './client/**/*.js'],
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                brand: {
                    50: '#fff1f2', 100: '#ffe4e6', 400: '#fb7185', 500: '#f43f5e',
                    600: '#e11d48', 700: '#be123c', 900: '#881337'
                },
                darkbg: '#0f172a',
                cardbg: '#1e293b'
            }
        }
    }
};
