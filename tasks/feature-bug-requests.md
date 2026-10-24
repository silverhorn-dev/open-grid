Requirement Task / Feature Specifications
1. Offline-Status Visualisierung

    Anforderung: Offline-Nachrichten-Banner sollen nicht mehr als Banner dargestellt werden, sondern ausschließlich über ein dezentes Status-Icon visualisiert werden.

    Details: Das Icon soll klar signalisieren, dass man offline ist.

2. Konfigurierbare Schlüssel-TTL & Key-Uploads

    Anforderung: Die Time-To-Live (TTL) für Album-Schlüssel sowie die Parameter für hochgeladene Schlüssel sollen vom Nutzer manuell konfiguriert werden können.

    Details:

        Einstellungsoption für die Gültigkeitsdauer (TTL) von Album-Schlüsseln implementieren.

        Konfigurationsmöglichkeiten für die Anzahl/Verwaltung der hochgeladenen Schlüssel (Key Uploads) bereitstellen.

3. Anpassung des Nachrichteneingabefeldes

    Anforderung: Das Text-Eingabefeld für Nachrichten soll mehrzeilig/mehrstöckig wachsen, dabei aber nur bis 4 5 zeilen und dann scrollbar werden, der text darin sollte automatisch umgebrochen werden.

4. Abfrage von Fremd-Profilbildern

    Anforderung: Die Funktion profildaten auch von anderen grid-teilnehmern abzufragen anstatt nur vom source profil sollte auch um das profil, album erweitert werden.
5. 
5. Layout-Fix für Desktop (Chatbox & Sticky Banner)

    Anforderung: Das Chat-Layout auf Desktop-Bildschirmen ist aktuell zu lang gestreckt und soll begrenzt werden.

    Details:

        Maximalhöhe/Kapselung: Die Haupt-Chatbox auf eine maximale Höhe (max-height / constrained Box) begrenzen.

        Scroll-Verhalten: Nur der Nachrichtenbereich innerhalb der Box soll scrollbar sein (overflow-y: auto).

        Sticky Contact Banner: Das Kontaktbanner am oberen Rand des Chats muss fixiert bleiben (position: sticky), damit es beim Scrollen der Nachrichten sichtbar bleibt.
6. im freund bzw chat modus sind flammen vergebbar? Wurde ein freund / chat geaddet funktioniert das wie die flammen heiß aber auf gar keinen fall so! Sondern folgen, daran wird auch eine spätere funktion für den status und so geknüpft, da man sich auch schreiben können soll ohne einander zu folgen bzw geadded zu haben, aber halt dann den status und das profil nicht so sieht.