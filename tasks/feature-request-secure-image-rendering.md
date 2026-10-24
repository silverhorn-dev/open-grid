Überblick

Um Bilddaten vor dem Speichern oder Abfotografieren zu schützen, können die Rohdaten verschleiert (z. B. Farbkanäle vertauscht oder Pixel permutiert) und erst unmittelbar vor dem Rendern im Browser durch einen Shader oder die Canvas-API korrigiert dargestellt werden.
Implementierungsschritte
1. Vorbereitung der Bilddaten

Das Bild wird serverseitig oder vor dem Laden so transformiert, dass es für das menschliche Auge unsinnig oder stark verrauscht aussieht.
2. Initialisierung des Canvas-Elements

Im Frontend wird ein canvas Element erstellt.
HTML

<canvas id="renderCanvas"></canvas>

3. Echtzeit-Decodierung beim Rendern

Mit der Canvas-API oder WebGL werden die Pixeldaten im requestAnimationFrame-Loop ausgelesen und an die korrekte Position gebracht. Über WebGL-Shader kann die Transformation GPU-beschleunigt und für Screenshots noch schwerer abgreifbar gemacht werden.
Sicherheitsmodell

Dies stellt keinen absoluten Kopierschutz dar, da der finale Frame im Speicher des Browsers liegt, erschwert jedoch das einfache Speichern der Bilddatei massiv, da nur verschlüsselte Daten über das Netzwerk geladen und im DOM abgelegt werden.