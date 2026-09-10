/**
 * LRC-Parser — portiert aus SchmalKaraoke_ALPHA (src/shared/lrc-parser.js).
 * Parsed LRC-Inhalte (Lyrics mit Zeitstempel, <N>-Beat-Tags, {Name}-Sprungpunkte,
 * //-Operator-Kommentare). Dateizugriff passiert außerhalb (File-Input im
 * Operator-Panel).
 *
 * Kommentare: alles hinter " //" auf einer Textzeile ist eine Notiz für den
 * Operator (Rundown), die NIE auf der Wall erscheint. Eine Zeile, die mit
 * "//" beginnt, hängt sich als Notiz an die nächste Textzeile.
 *   [01:15.81]<64> // Instrumental, 16 Takte
 *   // Achtung: Tempo zieht an
 *   [01:37.34]<8>{Verse2}Ja, Rosi hat ein Telefon
 *
 * Formatierung im Text: <b>fett</b>, <i>kursiv</i>, <u>unterstrichen</u>
 * (schachtelbar, Groß-/Kleinschreibung egal). Die Tags bleiben in
 * lyricsLines stehen; Wall und Rundown zerlegen sie mit parseMarkup().
 * Zeilenlänge und Teilung rechnen mit dem reinen Text (plainText()).
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
  /** Operator-Notiz pro Zeile (aus // Kommentar) oder null — nur fürs Rundown */
  comments: Array<string | null> = [];
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
    this.comments = [];
    this.metadata = {};
    this.refBpm = 0;

    const lines = content.trim().split('\n');
    // Kommentarzeilen (// …) sammeln sich, bis die nächste Textzeile kommt
    const pending: string[] = [];

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      if (line.startsWith('//')) {
        const note = line.slice(2).trim();
        if (note) pending.push(note);
        continue;
      }

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

        // Inline-Kommentar abtrennen: " // Notiz" am Zeilenende (oder die
        // ganze Restzeile, wenn sie mit // beginnt — z.B. leere Pausenzeile)
        const cm = text.match(/(?:^|\s)\/\/\s*(.*)$/);
        if (cm) {
          const note = cm[1].trim();
          if (note) pending.push(note);
          text = text.slice(0, cm.index);
        }

        this.beatCounts.push(beat);
        this.beatTagged.push(beatTagged);
        this.sections.push(section);
        this.comments.push(pending.length ? pending.join(' · ') : null);
        pending.length = 0;
        this.lyricsLines.push(text.trim());
      }
    }

    // Kommentar nach der letzten Textzeile: an die letzte Zeile hängen
    if (pending.length && this.comments.length) {
      const last = this.comments.length - 1;
      this.comments[last] = [this.comments[last], ...pending].filter(Boolean).join(' · ');
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
   *  (Zeit, Beats, Tag-Flag, Sprungmarke, Kommentar) wachsen mit, damit
   *  Indizes in Rundown, Sprungmarken und Zeilenzähler weiter zusammenpassen. */
  private splitLongLines() {
    const lines: string[] = [];
    const times: number[] = [];
    const beats: number[] = [];
    const tagged: boolean[] = [];
    const sections: Array<string | null> = [];
    const comments: Array<string | null> = [];
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
        comments.push(k === 0 ? this.comments[i] : null);
      });
    }

    this.lyricsLines = lines;
    this.timestamps = times;
    this.beatCounts = beats;
    this.beatTagged = tagged;
    this.sections = sections;
    this.comments = comments;
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

/* ---------- Formatierungs-Tags <b> <i> <u> ---------- */

/** Ein Textstück mit einheitlichem Stil */
export interface Segment {
  text: string;
  b: boolean;
  i: boolean;
  u: boolean;
}

const TAG_RE = /<(\/?)([biu])>/gi;

/** Reiner Text ohne Formatierungs-Tags (für Längen, Suche, Vorschau) */
export function plainText(text: string): string {
  return text.replace(TAG_RE, '');
}

/** Text in Stil-Segmente zerlegen. Unbekannte spitze Klammern bleiben
 *  Text; nicht geschlossene Tags gelten bis zum Zeilenende. */
export function parseMarkup(text: string): Segment[] {
  const segs: Segment[] = [];
  const depth = { b: 0, i: 0, u: 0 };
  let last = 0;
  const push = (t: string) => {
    if (t) segs.push({ text: t, b: depth.b > 0, i: depth.i > 0, u: depth.u > 0 });
  };
  for (const m of text.matchAll(TAG_RE)) {
    push(text.slice(last, m.index));
    last = m.index! + m[0].length;
    const key = m[2].toLowerCase() as keyof typeof depth;
    depth[key] = Math.max(0, depth[key] + (m[1] ? -1 : 1));
  }
  push(text.slice(last));
  return segs;
}

/** Segmente zurück in Tag-Schreibweise (gleiche Nachbarn verschmolzen) */
export function serializeMarkup(segs: Segment[]): string {
  const merged: Segment[] = [];
  let prev: Segment | null = null;
  for (const s of segs) {
    if (!s.text) continue;
    if (prev && prev.b === s.b && prev.i === s.i && prev.u === s.u) {
      prev.text += s.text;
      continue;
    }
    prev = { ...s };
    merged.push(prev);
  }
  return merged.map(wrap).join('');
}

function wrap(s: Segment): string {
  let t = s.text;
  if (s.u) t = `<u>${t}</u>`;
  if (s.i) t = `<i>${t}</i>`;
  if (s.b) t = `<b>${t}</b>`;
  return t;
}

/** Segmente an einer Position im REINEN Text teilen; das Zeichen an der
 *  Position (das Leerzeichen der Wortgrenze) fällt weg. */
function splitSegments(segs: Segment[], at: number): [Segment[], Segment[]] {
  const left: Segment[] = [];
  const right: Segment[] = [];
  let pos = 0;
  for (const s of segs) {
    const end = pos + s.text.length;
    if (end <= at) left.push({ ...s });
    else if (pos > at) right.push({ ...s });
    else {
      left.push({ ...s, text: s.text.slice(0, at - pos) });
      right.push({ ...s, text: s.text.slice(at - pos + 1) });
    }
    pos = end;
  }
  return [trimSegs(left, 'end'), trimSegs(right, 'start')];
}

function trimSegs(segs: Segment[], side: 'start' | 'end'): Segment[] {
  const out = segs.filter((s) => s.text);
  while (out.length) {
    const idx = side === 'start' ? 0 : out.length - 1;
    const t = side === 'start' ? out[idx].text.trimStart() : out[idx].text.trimEnd();
    if (t) {
      out[idx] = { ...out[idx], text: t };
      break;
    }
    out.splice(idx, 1);
  }
  return out;
}

/** Eine Zeile so lange an der Wortgrenze teilen, bis alle Teile kurz genug
 *  sind. Bevorzugt wird eine Lücke hinter Komma/Satzzeichen, sofern beide
 *  Hälften damit unter die Grenze kommen (der Bruch wirkt dort natürlich);
 *  sonst die Lücke, die die Hälften am gleichmäßigsten macht. Ohne
 *  Leerzeichen bleibt die Zeile, wie sie ist (wird dann skaliert).
 *  Formatierungs-Tags zählen nicht zur Länge und werden beim Teilen sauber
 *  geschlossen/wieder geöffnet. */
export function splitLine(text: string, maxChars = MAX_LINE_CHARS): string[] {
  const plain = plainText(text);
  if (plain.length <= maxChars) return [text];
  let best = -1;
  let bestScore = Infinity;
  for (let i = 1; i < plain.length - 1; i++) {
    if (plain[i] !== ' ') continue;
    const left = plain.slice(0, i).trimEnd();
    const right = plain.slice(i + 1).trimStart();
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
  const [l, r] = splitSegments(parseMarkup(text), best);
  return [...splitLine(serializeMarkup(l), maxChars), ...splitLine(serializeMarkup(r), maxChars)];
}
