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

  parseContent(content: string): boolean {
    this.lyricsLines = [];
    this.timestamps = [];
    this.beatCounts = [];
    this.beatTagged = [];
    this.sections = [];
    this.metadata = {};

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
        const [, minutes, seconds, centiseconds, rest] = lyricsMatch;
        const totalMs = (parseInt(minutes) * 60 + parseInt(seconds)) * 1000 + parseInt(centiseconds) * 10;
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

    return this.lyricsLines.length > 0;
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
      warnings.push('Keine Beat-Tags — Auto-Advance läuft auf Default (1 Beat/Zeile)');
    } else if (untaggedCount > 0) {
      warnings.push(`${untaggedCount}/${lineCount} Zeilen ohne Beat-Tag`);
    }

    let level: LrcValidation['level'] = 'ok';
    if (zeroBeatLines.length > 0) level = 'error';
    else if (untaggedCount > 0) level = 'warn';

    return { ok: level === 'ok', level, lineCount, untaggedCount, zeroBeatLines, totalBeats, warnings };
  }
}
