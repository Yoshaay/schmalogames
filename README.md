# Schmalogames

Electron-Tool für Minigames auf einer Videowall — gebaut für den Live-Einsatz
mit Ü-Wagen. Zwei Fenster: der **Operator** steuert, die **Wall** zeigt den
Cleanfeed (nur das finale Bild, keine Overlays oder Hilfetexte).

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
weiterexistiert). LRC-Dateien in die Setlist laden, die Wall zeigt die Zeilen
im Conveyor-Stil (aktuelle groß, nächste klein). Panel als hochkante Sidebar:

- **Presenter:** Leertaste blättert, Zeilen-Klick oder Ziffer armiert einen
  Sprung ({Name}-Marken aus der LRC), Leertaste löst ihn aus.
- **Auto-Advance:** Beat-Erkennung über wählbaren Audio-Eingang zählt Zeilen
  automatisch weiter (`<N>`-Tags = Beats pro Zeile); Space bleibt als
  Korrektur. Beat-Punkt + BPM im Panel.
- Song-Ende lädt automatisch den nächsten Song der Setlist.

## Hotkeys (gelten in beiden Fenstern)

| Taste | Aktion |
|---|---|
| 1–9 | Aktionen des aktiven Spiels (Groove: Cheers + Burst; Schmalaoke: Sprungmarken) |
| Space / → / ↓ | Schmalaoke: nächste Zeile bzw. Start |
| ← / ↑ | Schmalaoke: Zeile zurück |
| N / Home | Schmalaoke: nächster Song / Song-Neustart |
| T | Tap-Tempo (Schmalogroove) |
| F11 | Wall-Vollbild |

## Ü-Wagen / Keying

Die Hintergrund-Assets haben transparente Flächen; auf dem Wall-Ausgang sind
diese **schwarz** — gedacht zum Stanzen (Luma-Key), dahinter liegt dann das
Livebild (z. B. Publikumscam). Alle Grafikfarben sind key-sicher gewählt
(nichts Fast-Schwarzes im Vordergrund).

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
1920×1080-Canvas). Assets (PNG/FBX) einfach importieren — esbuild bündelt sie.

## Tech-Notizen

- Electron + esbuild + TypeScript, three.js **gepinnt auf 0.128**
  (Prototyp-Look; r128 braucht `skinning: true` auf SkinnedMesh-Materialien).
- Die beiden Fenster reden über einen IPC-Bus (`msg`-Relay im Main-Prozess);
  die Operator-Vorschau ist ein WebRTC-Stream des Wall-Canvas.
- Einstellungen werden pro Spiel in `localStorage` des Wall-Fensters
  persistiert.

## Status / offene Punkte

Funktional komplett fürs Proben. Offen für den Show-Betrieb: automatisches
Vollbild auf dem richtigen Display + Sleep-Blocker, Packaging als App,
Crash-Recovery, Keying-Test an echter Ü-Wagen-Technik.
