# BAYERN 1 Mitsingkonzert (November 2026)

Dritter Sender-Modus **MITSINGKONZERT** neben BAYERN 3 / BAYERN 1. Der
Festival-Stand ist als Git-Tag `festival-2026` gesichert; die beiden
Festival-Modi verhalten sich unverändert.

## Wall
- Nur Schmalaoke. Ausgabe = quadratisches Nutzbild **1536×1536**
  (ein Drittel der 4608×1536-Leinwand), komplett Alpha, kein Rahmen.
  NDI-Quelle bleibt „Schmalogames“.
- Steht die endgültige Auflösung fest: `MK_W` / `MK_H` in
  `src/renderer/core/game.ts` anpassen. Die Layout-Werte in `schmalaoke.ts`
  (`MK_SLOTS`, `MK_REF_SIZE`, …) sind auf 1536 abgestimmt und müssen bei
  einem anderen Seitenverhältnis neu eingemessen werden.
- Layout: aktuelle Zeile groß (Weiß, bis zu zwei Reihen), darunter die
  nächsten zwei Zeilen kleiner und gedimmt. Beim Weiterschalten rutscht
  alles einen Platz nach oben.
- Trenner: Hat eine Vorschauzeile eine `{Sprungmarke}`, steht deren Name
  als „── REFRAIN ──“ in BAYERN-1-Blau darüber. Kommt automatisch aus den
  vorhandenen Sprungmarken, keine extra Pflege.
- Lange Zeilen: Geteilt wird erst ab 56 Zeichen (Festival: 36), weil die
  Wall selbst auf zwei Reihen umbricht.
- Notfall-Durchsage: statischer Text auf rotem Block, mittig (kein Laufband).

## Regie (eine Person, MacBook)
- Ausgeblendet: Spiele-Leiste, Statuspanel, Auto-Advance/Beat-Sync
  (wird beim Umschalten ausgeschaltet).
- Rundown groß und umbrechend, die aktuelle Zeile bleibt im oberen Drittel.
- Rechts: quadratische Vorschau, darunter Sprungmarken als große Buttons.
- **N** (nächster Song) und **R** (Neustart) müssen innerhalb von 1,5 s
  zweimal gedrückt werden; die Statuszeile zeigt den Hinweis.

## Offen
- Endgültige Wall-Auflösung / Zuspielweg (NDI mit Alpha?) mit der Technik
  klären.
- Farben und Größen nach erstem Test auf der echten Wall nachziehen.
