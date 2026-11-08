
Projekte werden automatisch im Browser-Speicher (IndexedDB) des Geräts gesichert; mehrere Projekte lassen sich parallel anlegen, umbenennen und löschen.

Weitere Layouts: Eintrag im Objekt `LAYOUTS` in `app.js` ergänzen (Beschreibung der Felder steht dort im Kommentar).

## Video-EQ (`video.html`)

Lädt ein Video, kopiert die Videospur unverändert (keine Neukodierung) und bearbeitet nur den Ton mit einem 6-Band-Equalizer (60 Hz bis 14 kHz, ±12 dB) plus Pegel. Ton wird als AAC 256 kbit/s neu kodiert, wenn das Gerät das kann, sonst unkomprimiert (PCM) im MOV-Container. Container: MOV bleibt MOV, sonst MP4. Bibliothek: `vendor/mediabunny.min.mjs` (MPL-2.0).

## Bewegte Collage (`./?m=motion`)

Gleiche Collage-Funktion, zusätzlich mit Videos und Livebildern (Livebilder vorher in Fotos per „Als Video sichern“ umwandeln; Videos bis 4 s gelten zunächst als Livebild, umschaltbar). Länge: einfach (längstes Livebild, sonst 3 s) oder doppelt. Livebilder laufen einmal durch, bei „Doppelt“ vorwärts und zurück; Videos laufen ab wählbarem Startpunkt durch. Export als MP4 (H.264, 30 fps, ohne Ton), Bild für Bild gerendert. Eigene Projektliste.

Navigation zwischen den drei Funktionen über die Leiste unten.
