/**
 * LRC-Parser — portiert aus SchmalKaraoke_ALPHA (src/shared/lrc-parser.js).
 * Parsed LRC-Inhalte (Lyrics mit Zeitstempel, <N>-Beat-Tags, {Name}-Sprungpunkte).
 * Dateizugriff passiert außerhalb (File-Input im Operator-Panel).
 */

export interface LrcValidation {
  ok: boolean;
  level: 'ok' | 'warn' | 'error';
  lineCount: number;
  untaggedCount: number;
  zeroBeatLines: number[];
  totalBeats: number;
  warnings: string[];
}

/** Zeilen ab dieser Zeichenzahl werden beim Parsen an der Wortgrenze
 *  nahe der Mitte geteilt (ggf. mehrfach), damit sie auf der Wall in
 *  voller Schriftgröße stehen statt geschrumpft zu werden. Gemessen mit
 *  TheSans 700/56px: ~24–27 px pro Zeichen, das pinke Band (BAYERN 3)
 *  erlaubt 870 px → ab ~36 Zeichen wird sichtbar skaliert. Beat-Tags
 *  werden auf die Hälften verteilt, Sprungmarken bleiben an der ersten. */
export const MAX_LINE_CHARS = 36;

export class LRCParser {
  lyricsLines: string[] = [];
  timestamps: number[] = [];
  /** Beats pro Zeile (aus <N> Tag, Default 1) */
  beatCounts: number[] = [];
  /** true wenn Zeile einen expliziten <N>-Tag hatte */
  beatTagged: boolean[] = [];
  /** Sprungpunkt-Name pro Zeile (aus {Name} Tag) oder null */
  sections: Array<string | null> = [];
  metadata: Record<string, string> = {};
  /** Referenztempo aus dem [bpm:N]-Tag: die BPM, auf die die <N>-Tags
   *  gebaut wurden. 0 = kein (gültiger) Tag. Dient dem Abgleich mit der
   *  Erkennung — liegt die weit daneben, kann Auto-Advance nicht passen. */
  refBpm = 0;

  parseContent(content: string): boolean {
    this.lyricsLines = [];
    this.timestamps = [];
    this.beatCounts = [];
    this.beatTagged = [];
    this.sections = [];
    this.metadata = {};
    this.refBpm = 0;

    const lines = content.trim().split('\n');

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      // Metadata-Tags (z.B. [ar:Artist], [ti:Title])
      const metadataMatch = line.match(/^\[([a-z]+):(.+)\]$/);
      if (metadataMatch) {
        this.metadata[metadataMatch[1]] = metadataMatch[2].trim();
        continue;
      }

      // Lyrics mit Zeitstempel (z.B. [01:23.45]<4>Text oder [01:23.45]Text)
      const lyricsMatch = line.match(/^\[(\d+):(\d+)\.(\d+)\](.*)$/);
      if (lyricsMatch) {
        const [, minutes, seconds, frac, rest] = lyricsMatch;
        // Nachkommateil nach Stellenzahl skalieren: .4 = 400 ms, .45 = 450 ms, .456 = 456 ms
        const fracMs = Math.round(parseInt(frac, 10) * Math.pow(10, 3 - frac.length));
        const totalMs = (parseInt(minutes) * 60 + parseInt(seconds)) * 1000 + fracMs;
        this.timestamps.push(totalMs);

        // Führende Tags abknabbern — in beliebiger Reihenfolge:
        //   <N>     = Beat-Anzahl für Auto-Advance
        //   {Name}  = Sprungpunkt/Section (z.B. {Chorus})
        let text = rest;
        let beat = 1;
        let beatTagged = false;
        let section: string | null = null;
        let m: RegExpMatchArray | null;
        for (;;) {
          if ((m = text.match(/^<(\d+)>\s*/))) {
            beat = parseInt(m[1], 10);
            beatTagged = true;
            text = text.slice(m[0].length);
          } else if ((m = text.match(/^\{([^}]*)\}\s*/))) {
            const name = m[1].trim();
            if (name) section = name;
            text = text.slice(m[0].length);
          } else {
            break;
          }
        }

        this.beatCounts.push(beat);
        this.beatTagged.push(beatTagged);
        this.sections.push(section);
        this.lyricsLines.push(text.trim());
      }
    }

    // [bpm: 162] — Platzhalter wie "XXX" ergeben NaN und zählen als "kein Tag"
    const bpm = Math.round(Number(this.metadata.bpm));
    if (Number.isFinite(bpm) && bpm >= 40 && bpm <= 240) this.refBpm = bpm;

    this.splitLongLines();

    return this.lyricsLines.length > 0;
  }

  /** Anzahl der Originalzeilen, die beim Parsen geteilt wurden */
  splitCount = 0;

  /** Überlange Zeilen an der Wortgrenze nahe der Mitte teilen — rekursiv,
   *  bis jede Hälfte unter MAX_LINE_CHARS liegt. Alle parallelen Arrays
   *  (Zeit, Beats, Tag-Flag, Sprungmarke) wachsen mit, damit Indizes in
   *  Rundown, Sprungmarken und Zeilenzähler weiter zusammenpassen. */
  private splitLongLines() {
    const lines: string[] = [];
    const times: number[] = [];
    const beats: number[] = [];
    const tagged: boolean[] = [];
    const sections: Array<string | null> = [];
    this.splitCount = 0;

    for (let i = 0; i < this.lyricsLines.length; i++) {
      const parts = splitLine(this.lyricsLines[i]);
      if (parts.length > 1) this.splitCount++;
      // Beats gleichmäßig verteilen, Rest von vorn — nie 0 (wäre ein Fehler)
      const total = this.beatCounts[i];
      const base = Math.floor(total / parts.length);
      let rest = total - base * parts.length;
      // Zeitstempel: Hälften gleichmäßig bis zur nächsten Zeile verteilen
      const t0 = this.timestamps[i];
      const t1 = i + 1 < this.timestamps.length ? this.timestamps[i + 1] : t0 + 4000;
      parts.forEach((text, k) => {
        lines.push(text);
        times.push(Math.round(t0 + ((t1 - t0) * k) / parts.length));
        beats.push(Math.max(1, base + (rest-- > 0 ? 1 : 0)));
        tagged.push(this.beatTagged[i]);
        sections.push(k === 0 ? this.sections[i] : null);
      });
    }

    this.lyricsLines = lines;
    this.timestamps = times;
    this.beatCounts = beats;
    this.beatTagged = tagged;
    this.sections = sections;
  }

  /** Sprungpunkte als kompakte Liste */
  getMarkers(): Array<{ index: number; name: string }> {
    const markers: Array<{ index: number; name: string }> = [];
    this.sections.forEach((name, i) => {
      if (name) markers.push({ index: i, name });
    });
    return markers;
  }

  /** Prüft die geparsten Lyrics auf Probleme für den Auto-Advance */
  validate(): LrcValidation {
    const lineCount = this.lyricsLines.length;
    const warnings: string[] = [];

    if (lineCount === 0) {
      return { ok: false, level: 'error', lineCount: 0, untaggedCount: 0, zeroBeatLines: [], totalBeats: 0, warnings: ['Keine Lyrics gefunden'] };
    }

    let untaggedCount = 0;
    const zeroBeatLines: number[] = [];
    let totalBeats = 0;

    for (let i = 0; i < lineCount; i++) {
      if (!this.beatTagged[i]) untaggedCount++;
      const beats = this.beatCounts[i];
      totalBeats += beats;
      if (this.beatTagged[i] && beats === 0) zeroBeatLines.push(i + 1);
    }

    // <0>-Tags sind ein harter Fehler: Zeile würde im Auto-Modus sofort übersprungen
    if (zeroBeatLines.length > 0) {
      const list = zeroBeatLines.slice(0, 5).join(', ');
      const more = zeroBeatLines.length > 5 ? ` (+${zeroBeatLines.length - 5})` : '';
      warnings.push(`${zeroBeatLines.length}× <0>-Beat (Zeile ${list}${more})`);
    }

    if (untaggedCount === lineCount) {
      warnings.push('Keine Beat-Tags — Auto-Advance bleibt bei diesem Song AUS (nur manuell)');
    } else if (untaggedCount > 0) {
      warnings.push(`${untaggedCount}/${lineCount} Zeilen ohne Beat-Tag (laufen auf Default 1 Beat)`);
    }
    // Ohne [bpm:]-Tag fehlt der Abgleich mit der Erkennung (nur Hinweis)
    if (untaggedCount < lineCount && this.refBpm === 0) {
      warnings.push('Kein [bpm:]-Tag — Referenztempo für den Abgleich mit der Erkennung fehlt');
    }

    if (this.splitCount > 0) {
      warnings.push(`${this.splitCount} lange Zeile${this.splitCount > 1 ? 'n' : ''} automatisch geteilt (ab ${MAX_LINE_CHARS} Zeichen)`);
    }

    let level: LrcValidation['level'] = 'ok';
    if (zeroBeatLines.length > 0) level = 'error';
    else if (untaggedCount > 0 || (untaggedCount < lineCount && this.refBpm === 0)) level = 'warn';

    return { ok: level === 'ok', level, lineCount, untaggedCount, zeroBeatLines, totalBeats, warnings };
  }
}

/** Eine Zeile so lange an der Wortgrenze teilen, bis alle Teile kurz genug
 *  sind. Bevorzugt wird eine Lücke hinter Komma/Satzzeichen, sofern beide
 *  Hälften damit unter die Grenze kommen (der Bruch wirkt dort natürlich);
 *  sonst die Lücke, die die Hälften am gleichmäßigsten macht. Ohne
 *  Leerzeichen bleibt die Zeile, wie sie ist (wird dann skaliert). */
export function splitLine(text: string, maxChars = MAX_LINE_CHARS): string[] {
  if (text.length <= maxChars) return [text];
  let best = -1;
  let bestScore = Infinity;
  for (let i = 1; i < text.length - 1; i++) {
    if (text[i] !== ' ') continue;
    const left = text.slice(0, i).trimEnd();
    const right = text.slice(i + 1).trimStart();
    if (!left || !right) continue;
    let score = Math.abs(left.length - right.length);
    const fits = left.length <= maxChars && right.length <= maxChars;
    if (fits && /[,;:!?.–—-]$/.test(left)) score -= 1000;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return [text];
  const left = text.slice(0, best).trimEnd();
  const right = text.slice(best + 1).trimStart();
  return [...splitLine(left, maxChars), ...splitLine(right, maxChars)];
}
