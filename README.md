# Schmalogames

Electron-Tool für Minigames auf einer Videowall — gebaut für den Live-Einsatz
mit Ü-Wagen. Zwei Fenster: der **Operator** steuert, die **Wall** zeigt den
Cleanfeed (nur das finale Bild, keine Overlays oder Hilfetexte). Ausgespielt
wird per **NDI** als eine Quelle („Schmalogames“) — ein volles FHD-16:9-Signal
mit echtem Alpha im Nutzbild, das beide Videowalls gemeinsam bespielt; das
Wall-Fenster dient als HDMI-Fallback.

## Sender-Modus: BAYERN 3 / BAYERN 1

Umschalter im Operator-Header (Wahl wird gemerkt):

- **BAYERN 3** (Standard): alle drei Spiele, Akzent in CI-Grün `#94c01c`.
- **BAYERN 1**: nur Schmalaoke (läuft beim Umschalten ein anderes Spiel,
  wird es gestoppt), Akzent und 16:9-Rahmen in BAYERN-1-Blau `#00a0d5`.
  Schmalaoke zeigt dann kein Hintergrund-Asset (reines Alpha, dahinter
  liegt das Livebild) und zentriert die Lyrics im unteren Bilddrittel.

## Schnellstart

```bash
npm install
npm start        # baut und startet beide Fenster
npm run dev      # dasselbe mit offenen DevTools
```

- **F11** schaltet die Wall in den Vollbildmodus (auch per Button im Operator).
- Das Wall-Fenster auf den Videowall-Ausgang ziehen, Vollbild an — fertig.

### Schriften

Die BR-Hausschrift **TheSans** liegt lizenzbedingt **nicht** im Repo. Den
Ordner `fonts/` mit den OTFs (`TheSansC5s-5_Plain`, `-6_SemiBold`, `-7_Bold`,
`-8_ExtraBold`) ins Projektverzeichnis legen, dann bündelt der Build sie
automatisch. Ohne den Ordner läuft alles mit Fallback-Font.

## Die Spiele

### Applausometer

Pegel-Meter im Design-Layout. Der Operator fährt den Pegel über einen großen
vertikalen **Live-Fader**; ein Humanizer (Flattern, Spitzen, An-/Abschwellen)
lässt ihn wie echten Applaus wirken. Über der einstellbaren Ziellinie:
Konfetti, der Fader springt automatisch auf null zurück.

### Schmalogroove

Beat-Dancer: Eine toon-gerenderte 3D-Tänzerin (weiße Outline, Just-Dance-Look)
tanzt im Takt der Musik.

- **Audio rein:** Track laden (MP3 & Co., läuft geloopt) **oder** Live-Signal
  über einen wählbaren Audio-Eingang (Dropdown neben „Mikro“ — Auswahl
  startet nichts, erst der Mikro-Button!).
- **Beat-Erkennung:** Spectral-Flux → Autokorrelation → PLL. Übersteuerbar
  per **Tap-Tempo** (Button oder Taste T).
- **Sync einpegeln:** Button „🔧 Sync-Debug“ in der Kopfzeile blendet auf der
  Wall einen Beat-Blitz + Metronom-Punkt ein. Sync-Offset-Regler schieben,
  bis der Punkt oben exakt auf dem hörbaren Beat trifft.
- **Auszeichnungen:** Vier togglebare Banner (Dreieck-Welle im CI, Konfetti),
  dazu ein Speedburst über der Publikumscam-Fläche.
- **Moves:** 15 prozedurale Moves, Wechsel alle 8 Beats. Alternativ steckt
  eine komplette Mocap-Pipeline im Code (Mixamo-Clips werden zur Laufzeit auf
  das Modell retargetet, BPM-Messung per Hüft-Autokorrelation) — Umschalter:
  `USE_MOCAP_CLIPS` in `schmalogroove.ts`.

### Schmalaoke

Karaoke-Lyrics-Player (Port der Standalone-App SchmalKaraoke, die als Backup
weiterexistiert). LRC-Dateien in die Setlist laden, die Wall zeigt immer
**eine** Zeile im Conveyor-Stil: In BAYERN 3 läuft sie durch das pinke Band
des Hintergrund-Assets (Clip-Maske), in BAYERN 1 ohne Asset zentriert im
unteren Drittel. Panel als hochkante Sidebar:

- **Presenter:** Leertaste blättert; Marken-Chip-Klick oder Ziffer armiert
  einen Sprung ({Name}-Marken aus der LRC), Leertaste löst ihn aus. Die
  Textzeilen selbst sind nur Anzeige, nicht klickbar.
- **Auto-Advance:** Beat-Erkennung über wählbaren Audio-Eingang zählt Zeilen
  automatisch weiter (`<N>`-Tags = Beats pro Zeile; ein `[bpm:162]`-Tag im
  Kopf der LRC nennt das Tempo, auf das die Takte gebaut sind — das Panel
  zeigt es als Chip, Klick übernimmt es als festen Wert, und liegt die
  Erkennung mehr als 8 % daneben, warnt die BPM-Anzeige in Magenta „passt
  NICHT“); Space bleibt als
  Korrektur. Auto fährt nie von selbst los: nach Einschalten, BPM-Änderung
  oder Songwechsel braucht es **zwei Leertasten** (Songstart + bestätigter
  Einsatz auf dem Beat), erst dann zählt es; bei festem BPM wird das Grid
  auf diesen zweiten Druck ausgerichtet. Beat-Punkt + BPM im Panel. Alternativ **BPM fest eintippen**
  (40–240, Enter setzt) — das Grid läuft dann von der Uhr, ganz ohne Mikro;
  Feld leeren oder Reset schaltet zurück auf Erkennung.
- Song-Ende lädt automatisch den nächsten Song der Setlist.
- Setlist speichern/laden als JSON (LRC-Inhalte eingebettet). Die
  Songtexte selbst (`PopUp26 LRC/`) liegen aus Urheberrechtsgründen nicht
  im Repo.

## LRC Tapper (Beat-Tags eintappen)

`tools/lrc-tapper.html` — eigenständiges Mini-Tool, direkt im Browser öffnen
(kein Server nötig). LRC laden, BPM setzen (wird aus dem `[bpm:]`-Tag
vorbelegt), optional die Song-Datei dazu, dann mit **Leertaste** jede Zeile
bei ihrem Einsatz tappen; nach der letzten Zeile ein Abschluss-Tap fürs
Ende. Die Tap-Abstände werden aufs Beat-Raster gerundet (kumulativ, damit
sich Rundungsfehler nicht aufaddieren) und als `<N>`-Tags in die LRC
geschrieben — vorhandene `<N>`/`<xxx>`-Platzhalter werden ersetzt, das
`[bpm:]`-Tag gesetzt. Tabelle zeigt pro Zeile Beats und Abweichung (gelb
über ¼ Beat, rot bei 0 Beats → wird auf 1 gesetzt). Backspace nimmt den
letzten Tap zurück, R startet neu, P spielt/pausiert das Audio, Metronom
zum Einzählen zuschaltbar. Ergebnis herunterladen oder in die
Zwischenablage kopieren.

## Hotkeys (gelten in beiden Fenstern)

| Taste | Aktion |
|---|---|
| 1–9 | Aktionen des aktiven Spiels (Groove: Cheers + Burst; Schmalaoke: Sprungmarken) |
| Space / → / ↓ | Schmalaoke: nächste Zeile bzw. Start |
| ← / ↑ | Schmalaoke: Zeile zurück |
| N | Schmalaoke: nächster Song |
| R (oder Home) | Schmalaoke: Song-Neustart |
| A | Schmalaoke: Auto-Advance an/aus |
| T | Tap-Tempo (Schmalogroove) |
| F11 | Wall-Vollbild |

## Signalformat / Ü-Wagen

Der NDI-Stream ist ein komponiertes FHD-16:9-Bild (1920×1080):
außen die Rahmenfarbe des Sender-Modus (Grün bzw. Blau — Backstage-Monitore
zeigen den vollen Frame randlos), darin die 675×1080-Zone, mittig das
640×1024-**Nutzbild** mit echtem Alphakanal. Der Ü-Wagen croppt sich das
Nutzbild auf die großen Walls und legt das Livebild hinter die Transparenz
(Fill+Key in einem Stream). NDI-Framerate im Operator-Header wählbar.
Als Fallback gibt es den Toggle **Stanzmaske** (Luma-Matte statt Nutzbild);
auf dem HDMI-Wall-Fenster wirkt Transparenz schwarz. Alle Grafikfarben sind
key-sicher gewählt (nichts Fast-Schwarzes im Vordergrund).

## Neues Spiel anlegen

Jedes Spiel ist ein „Slot“: Ordner unter `src/renderer/games/<name>/` mit
einer `index.ts`, die ein `GameEntry` exportiert, plus Eintrag in
`registry.ts`. Deklarativ im Manifest:

- `settings`: Slider (`variant: 'fader'` = großer Live-Fader,
  `transient: true` = wird nicht gespeichert)
- `actions`: Buttons im Operator (bekommen automatisch Hotkeys 1–9)
- `buildOperatorPanel()`: optionales eigenes Operator-UI
  (Kanal zum Spiel: `api.send()` ↔ `Game.onMessage()` / `ctx.sendToOperator()`;
  Tasten aus der Wall kommen über `OperatorPanel.onKey()` an)
- `panelLayout: 'sidebar'`: Panel als hochkante Spalte links neben der
  Vorschau (Rundown-Stil) statt unter ihr

Das Spiel selbst implementiert `Game` (`init/update/render` auf einen
virtuellen 1200×1920-Canvas, 10:16 Hochformat — der Host skaliert ihn ins
640×1024-Nutzbild). Optional: `setStationMode()` für Layout-Anpassungen im
BAYERN-1-Modus.
Assets (PNG/FBX) einfach importieren — esbuild bündelt sie.

## Tech-Notizen

- Electron + esbuild + TypeScript, three.js **gepinnt auf 0.128**
  (Prototyp-Look; r128 braucht `skinning: true` auf SkinnedMesh-Materialien).
- Die beiden Fenster reden über einen IPC-Bus (`msg`-Relay im Main-Prozess);
  die Operator-Vorschau streamt das Wall-Composite per WebRTC.
- NDI-Ausgabe über das Binding `grandi` (NDI-6-SDK, bringt die libndi mit —
  kein Setup am Show-Rechner nötig); Senden läuft im Main-Prozess.
- Einstellungen werden pro Spiel in `localStorage` des Wall-Fensters
  persistiert.

## Status / offene Punkte

Funktional komplett fürs Proben. Offen für den Show-Betrieb: automatisches
Vollbild auf dem richtigen Display + Sleep-Blocker, Packaging als App,
Crash-Recovery, Keying-Test an echter Ü-Wagen-Technik.
