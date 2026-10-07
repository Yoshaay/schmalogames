import { OperatorPanel, OperatorPanelApi, StationMode } from '../../core/game';
import { makeGapResizable } from '../../core/gap-resize';
import { LRCParser, MAX_LINE_CHARS, MK_MAX_LINE_CHARS, parseMarkup, plainText } from './lrc-parser';

/**
 * Rundown + Presenter-Ansicht — portiert aus SchmalKaraoke_ALPHA
 * (src/rundown). Playlist-Verwaltung lebt hier im Panel; das Spiel im
 * Wall-Fenster bekommt beim Laden den LRC-Inhalt geschickt und meldet
 * seinen Presenter-State zurück.
 */

interface Song {
  name: string;
  content: string;
  /** Eigener Anzeigename aus dem Rundown (Umbenennen) — überstimmt den aus
   *  der LRC gelesenen Titel, ändert aber nichts an der Datei */
  label?: string;
  /** Teilungsgrenze beim Parsen — geht mit an die Wall (gleiche Zeilen) */
  maxChars: number;
  /** Ordner-Key: Versionen desselben Songs teilen ihn (aus dem Dateinamen
   *  ohne Versions-Kürzel); 'f:…' = händischer Ordner, 's:…' = aus einem
   *  Ordner herausgezogen */
  group: string;
  /** Dateiname ohne Versions-Kürzel und .lrc — Name des Ordners */
  base: string;
  /** Versions-Kürzel aus dem Dateinamen ('V2', 'V4.1'; '' = Original) */
  version: string;
  /** In seinem Ordner gewählte Version (N/B laden diese) */
  pick?: boolean;
  title: string;
  artist: string;
  lines: string[];
  sections: Array<string | null>;
  /** Operator-Notizen (// Kommentare aus der LRC), nie auf der Wall */
  comments: Array<string | null>;
  /** Referenztempo aus [bpm:]-Tag (0 = keins) */
  refBpm: number;
  validation: { level: 'ok' | 'warn' | 'error'; warnings: string[] };
  status: 'planned' | 'loaded' | 'playing' | 'finished';
}

interface PresenterState {
  kind: 'presenter';
  currentLine: number;
  pendingJump: number;
  started: boolean;
  ended: boolean;
  remaining: number;
  total: number;
  title: string;
  artist: string;
  autoMode: boolean;
  autoArmed: boolean;
  autoSpaces: number;
  refBpm: number;
  /** Notfall-Durchsage auf der Wall ('' = keine) */
  notice: string;
  /** Schwarz: Lyrics auf der Wall ausgeblendet (Taste S) */
  blank?: boolean;
}

const STYLE = `
  /* Aufgeräumt wie das Original-Rundown: links die Setlist mit klaren,
     vollbreiten Buttons darunter, rechts der Presenter mit den Lyrics.
     Unten EINE Statuszeile statt verstreuter Hinweistexte. */
  .ka-root { display: flex; flex-direction: column; gap: 10px; height: 100%; }
  /* Setlist-Breite ziehbar (--ka-left, gap-resize) */
  .ka-cols { flex: 1; min-height: 0; display: grid; grid-template-columns: var(--ka-left, minmax(0, 2fr)) minmax(0, 3fr); gap: 16px; }
  .ka-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
  .ka-markers { display: flex; flex-wrap: wrap; gap: 6px; max-height: 96px; overflow-y: auto; flex-shrink: 0; }
  .ka-marker {
    font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.06em;
    padding: 5px 10px; border: 1px solid var(--panel-edge); border-radius: 4px;
    cursor: pointer; color: var(--blue); background: #14161d; user-select: none;
  }
  .ka-marker:hover { border-color: var(--blue); }
  .ka-marker.armed { color: #ffffff; background: rgba(231, 29, 115, 0.25); border-color: var(--live); }
  .ka-marker .key {
    display: inline-block; min-width: 14px; margin-right: 6px; text-align: center;
    font-size: 10px; color: var(--ink-dim); border: 1px solid var(--panel-edge);
    border-radius: 3px; padding: 0 3px;
  }
  .ka-marker.armed .key { color: #ffffff; border-color: rgba(231, 29, 115, 0.6); }
  .ka-head {
    font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.18em;
    text-transform: uppercase; color: var(--ink-dim); margin-top: 6px;
  }
  .ka-col > .ka-head:first-child { margin-top: 0; }

  /* Eine klare Primäraktion (gefüllt), alles andere ruhig und vollbreit —
     Größe/Form kommt aus dem globalen Button-Grundformat (operator.html) */
  .ka-btn-primary {
    width: 100%; font-weight: 700;
    background: var(--primary); border-color: var(--primary-deep); color: #101403;
  }
  .ka-btn-primary:hover { background: var(--primary-bright); border-color: var(--primary); }
  .ka-btn-wide { width: 100%; }
  .ka-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .ka-root button.armed { color: var(--live); border-color: rgba(231, 29, 115, 0.5); }
  .ka-row { display: flex; gap: 6px; align-items: center; }
  .ka-list, .ka-lyrics {
    background: #101218; border: 1px solid var(--panel-edge); border-radius: 4px;
    overflow-y: auto;
  }
  .ka-list { flex: 1; min-height: 90px; }
  .ka-lyrics { flex: 1; min-height: 160px; }
  .ka-song {
    display: flex; align-items: center; gap: 8px; padding: 7px 10px;
    border-bottom: 1px solid #1a1d26; cursor: pointer; font-size: 13px;
  }
  .ka-song:hover { background: #171a22; }
  .ka-song.active { background: rgba(var(--primary-rgb), 0.1); }
  .ka-song.dragging { opacity: 0.4; }
  .ka-song.drop-above { box-shadow: inset 0 2px 0 var(--primary); }
  .ka-song.drop-below { box-shadow: inset 0 -2px 0 var(--primary); }
  .ka-list.dropping { border-color: var(--primary); background: rgba(var(--primary-rgb), 0.06); }
  .ka-song .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .dot-planned { background: #3a3e4c; }
  .dot-loaded { background: #f9b233; }
  .dot-playing { background: var(--primary-bright); }
  .dot-finished { background: #2699d6; }
  .ka-song .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Leiste über der Setlist (+ Ordner) */
  .ka-listbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .ka-listbar .ka-head { margin-top: 0; }
  .ka-root button.ka-mini { height: 24px; padding: 0 9px; font-size: 11px; }
  /* Ordner: Kopf mit Pfeil, gewählter Version und Anzahl; Versionen eingerückt */
  /* Ordner-Kopf: eigene Fläche, Ordner-Symbol, großer Pfeil — klar
     unterscheidbar von normalen Song-Zeilen */
  .ka-song.ka-folder { background: #1a1d26; border-bottom-color: #262a35; padding-left: 6px; }
  .ka-song.ka-folder:hover { background: #20242f; }
  .ka-song.ka-folder.open { border-bottom-color: transparent; }
  .ka-folder .chev {
    width: 22px; height: 22px; flex-shrink: 0; display: grid; place-items: center;
    border-radius: 4px; color: var(--ink); transition: transform 0.15s;
  }
  .ka-folder .chev svg { width: 14px; height: 14px; }
  .ka-folder.open .chev { transform: rotate(90deg); }
  .ka-folder:hover .chev { background: rgba(255, 255, 255, 0.07); }
  .ka-folder .ficon { width: 18px; height: 18px; flex-shrink: 0; color: var(--primary); }
  .ka-folder .name { font-weight: 700; }
  .ka-vtag {
    flex-shrink: 0; font-family: var(--font-mono); font-size: 10px; color: var(--primary);
    border: 1px solid rgba(var(--primary-rgb), 0.4); border-radius: 3px; padding: 0 5px;
  }
  .ka-vcount { flex-shrink: 0; font-family: var(--font-mono); font-size: 10px; color: var(--ink-dim); }
  /* Versionen: eingerückt mit Führungslinie in Ordnerfarbe */
  .ka-version { padding-left: 40px; background: #0d0f14; position: relative; }
  .ka-version::before {
    content: ''; position: absolute; left: 16px; top: 0; bottom: 0; width: 2px;
    background: rgba(var(--primary-rgb), 0.25);
  }
  /* Gewählte Version: Name in Akzentfarbe + Balken links */
  .ka-version.picked { box-shadow: inset 3px 0 0 var(--primary); }
  .ka-version.picked .name { color: var(--primary); font-weight: 600; }
  .ka-vinfo {
    flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--font-mono); font-size: 10px; color: var(--ink-dim);
  }
  .ka-version .name { flex: 0 0 auto; max-width: 60%; }
  .ka-vtag { max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ka-empty-folder { color: var(--ink-dim); border-style: dashed; }
  .ka-song.drop-into { box-shadow: inset 0 0 0 2px var(--primary); background: rgba(var(--primary-rgb), 0.08); }
  /* Eigener Name: kursiv, damit man sieht, dass er nicht aus der LRC kommt */
  .ka-song .name.custom { font-style: italic; }
  .ka-song input.ka-rename {
    min-width: 0; font: inherit; color: var(--ink); background: #1d2029;
    border: 1px solid var(--primary); border-radius: 3px; padding: 2px 6px; outline: none;
  }
  .ka-song .warn { font-size: 11px; }
  /* Umbenennen-/Lösch-Buttons erst bei Hover — der Name bekommt die
     Breite (Umsortieren läuft nur per Drag & Drop). Absolut über dem
     rechten Zeilenende, damit die Zeile beim Hover NICHT höher wird. */
  .ka-song { position: relative; }
  .ka-song .ops {
    display: none; gap: 2px; position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    padding-left: 12px; background: linear-gradient(to right, transparent, #171a22 12px);
  }
  .ka-song.active .ops { background: linear-gradient(to right, transparent, #18202a 12px); }
  .ka-song:hover .ops { display: flex; }
  /* Bewusste Ausnahme vom Grundformat: Mini-Controls IN den Listenzeilen */
  .ka-song .ops button { height: 22px; padding: 0 7px; font-size: 11px; }
  .ka-lyric {
    padding: 4px 10px; font-size: 12px; color: var(--ink-dim);
    border-left: 3px solid transparent;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .ka-lyric.current { color: #ffffff; border-left-color: var(--primary); background: rgba(var(--primary-rgb), 0.08); }
  .ka-lyric.armed { color: var(--live); border-left-color: var(--live); }
  /* Schwarz: aktuelle Zeile durchgestrichen-blass, Rand in Warnfarbe */
  .ka-lyrics.blank .ka-lyric.current { color: var(--ink-dim); border-left-color: var(--live); background: rgba(231, 29, 115, 0.08); }
  .ka-root button.ka-blank.live {
    color: #ffffff; background: var(--live); border-color: var(--live); font-weight: 700;
  }
  .ka-lyric b { color: #ffffff; }
  .ka-lyric .sec {
    font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.1em;
    color: var(--blue); margin-right: 8px; text-transform: uppercase;
  }
  /* Operator-Notiz (// Kommentar in der LRC): eigene Zeile unter dem Text,
     gelb wie ein Klebezettel — steht nur hier, nie auf der Wall */
  .ka-lyric .note {
    display: block; font-family: var(--font-mono); font-size: 10px;
    color: #f2c94c; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .ka-lyric .note::before { content: '// '; opacity: 0.6; }
  .ka-meta { font-family: var(--font-mono); font-size: 11px; color: var(--ink-dim); }
  .ka-meta.mismatch { color: var(--live); font-weight: 700; }
  .ka-root button.ka-ref {
    font-family: var(--font-mono); font-size: 11px; padding: 3px 7px; letter-spacing: 0.04em;
    color: var(--blue); border-color: rgba(38, 153, 214, 0.4);
  }
  .ka-row select {
    flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 11px; color: var(--ink);
    background: #1d2029; border: 1px solid var(--panel-edge); border-radius: 4px;
    height: 34px; padding: 0 8px;
  }
  .ka-row input[type='number'] {
    flex: 0 0 auto; width: 64px; font-family: var(--font-mono); font-size: 11px; color: var(--ink);
    background: #1d2029; border: 1px solid var(--panel-edge); border-radius: 4px;
    height: 34px; padding: 0 8px;
  }
  .ka-row input[type='number']:focus { border-color: var(--blue); outline: none; }
  .ka-beat {
    width: 12px; height: 12px; border-radius: 50%; background: #3a3e4c;
    display: inline-block; vertical-align: -1px; transition: background 0.05s;
  }
  .ka-btn-wide .ka-beat { margin-right: 8px; }
  /* Ampel: grün = gelockt (Auto fährt), gelb = lauscht (manuell fahren) */
  .ka-beat.on { background: var(--primary); box-shadow: 0 0 10px rgba(var(--primary-rgb), 0.8); }
  .ka-beat.warn { background: #f9b233; box-shadow: 0 0 10px rgba(249, 178, 51, 0.8); }

  /* Notfall-Durchsage: Live-Zustand in Magenta (Warnfarbe), Textfeld nur
     im aktivierten Modus sichtbar */
  .ka-root button.ka-notice.live {
    color: #ffffff; background: var(--live); border-color: var(--live); font-weight: 700;
  }
  .ka-notice-box { display: flex; flex-direction: column; gap: 6px; }
  .ka-notice-box textarea {
    width: 100%; box-sizing: border-box; min-height: 88px; resize: vertical;
    font-family: var(--font-body); font-size: 13px; line-height: 1.35; color: var(--ink);
    background: #1d2029; border: 1px solid rgba(231, 29, 115, 0.5); border-radius: 4px;
    padding: 8px 10px;
  }
  .ka-notice-box textarea:focus { border-color: var(--live); outline: none; }
  .ka-notice-box .ka-notice-hint { font-family: var(--font-mono); font-size: 10px; color: var(--ink-dim); }
  .ka-status .notice-live { color: var(--live); font-weight: 700; }

  /* ---------- Mitsingkonzert (.ka-mk) ----------
     Schmale Setlist links, Rundown groß und umbrechend in der Mitte,
     Sprungmarken als große Buttons in #preview-extra unter der Vorschau. */
  .ka-mk .ka-auto { display: none; }
  .ka-mk .ka-cols { grid-template-columns: var(--ka-left, 220px) minmax(0, 1fr); }
  .ka-mk .ka-lyrics { padding: 4px 0 40vh; }
  .ka-mk .ka-lyric {
    font-size: 16px; line-height: 1.3; padding: 6px 14px;
    white-space: normal; border-left-width: 4px;
  }
  .ka-mk .ka-lyric.current { font-size: 21px; font-weight: 700; }
  .ka-mk .ka-lyric .sec { display: block; font-size: 10px; margin: 4px 0 2px; }
  .ka-mk .ka-lyric .note { font-size: 12px; white-space: normal; }
  #preview-extra .ka-markerbox { display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1; }
  #preview-extra .ka-markers {
    flex-direction: column; flex-wrap: nowrap; gap: 6px; max-height: none; flex: 1; min-height: 0;
  }
  #preview-extra .ka-marker {
    font-family: var(--font-body); font-size: 15px; font-weight: 600; letter-spacing: 0;
    padding: 10px 12px; display: flex; align-items: center; flex-shrink: 0;
  }
  #preview-extra .ka-marker .key { font-family: var(--font-mono); font-size: 12px; min-width: 20px; margin-right: 10px; padding: 1px 4px; }

  /* Leere Setlist: Drop-Hinweis mittig, wie im Original */
  .ka-empty {
    height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 6px; padding: 16px; text-align: center; color: var(--ink-dim); font-size: 12px;
  }
  .ka-empty b { color: var(--ink); font-size: 13px; font-weight: 600; }

  /* Statuszeile unten: Zustand links, Tastatur-Hinweise rechts */
  .ka-status {
    border-top: 1px solid var(--panel-edge); padding-top: 8px;
    display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
    font-family: var(--font-mono); font-size: 11px; color: var(--ink-dim);
  }
  .ka-status .rest-warn { color: #f9b233; }
  .ka-status .rest-crit { color: var(--live); }
  .ka-keys { white-space: nowrap; flex-shrink: 0; }
  .ka-keys kbd {
    font-family: var(--font-mono); font-size: 10px; border: 1px solid var(--panel-edge);
    border-radius: 3px; padding: 1px 5px;
  }
`;

export function buildSchmalaokePanel(container: HTMLElement, api: OperatorPanelApi): OperatorPanel {
  if (!document.getElementById('ka-style')) {
    const style = document.createElement('style');
    style.id = 'ka-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  container.innerHTML = `
    <div class="ka-root">
      <div class="ka-cols">
        <div class="ka-col">
          <div class="ka-listbar">
            <span class="ka-head">Setlist</span>
            <button data-id="addfolder" class="ka-mini" title="Leeren Ordner anlegen — Songs per Drag &amp; Drop hineinziehen (Mitte eines Ordners = hinein)">+ Ordner</button>
          </div>
          <div class="ka-list" data-id="songs"></div>
          <button data-id="add" class="ka-btn-primary">+ Songs hinzufügen</button>
          <div class="ka-grid2">
            <button data-id="save" title="Setlist als JSON-Datei sichern">Speichern</button>
            <button data-id="loadlist" title="Setlist aus JSON-Datei laden — ersetzt die aktuelle Liste">Laden</button>
          </div>
          <div class="ka-head">Wiedergabe</div>
          <div class="ka-grid2">
            <button data-id="restart" title="Song von vorn — Taste R">Neustart</button>
            <button data-id="next" title="Taste N">Nächster Song</button>
          </div>
          <button data-id="blank" class="ka-btn-wide ka-blank" title="Lyrics auf der Wall aus-/einblenden (z.B. Solo) — Taste S. Leertaste blendet ein und schaltet weiter">Schwarz (S)</button>
          <div class="ka-head" title="Freier Text (Suchmeldung, Warnung) statt der Lyrics — an derselben Stelle wie die Untertitel">Notfall-Durchsage</div>
          <button data-id="notice" class="ka-btn-wide ka-notice" title="Modus an/aus — AUS nimmt die Durchsage sofort von der Wall">Notfall-Durchsage</button>
          <div class="ka-notice-box" data-id="noticebox" hidden>
            <textarea data-id="noticetext" rows="4" spellcheck="false"
              placeholder="Text der Durchsage … (fährt als Laufband in einer Zeile durch, Absätze werden mit +++ verbunden)"></textarea>
            <button data-id="noticesend" class="ka-btn-wide" title="Text live auf die Wall schicken (⌘⏎ im Textfeld)">Fertig — live schicken</button>
            <span class="ka-notice-hint" data-id="noticehint">Text eintippen, dann „Fertig“ — erst dann geht er raus.</span>
          </div>
          <div class="ka-auto">
          <div class="ka-head" title="Beats zählen die Zeilen weiter — braucht &lt;N&gt;-Tags in der LRC">Auto-Advance · Beat-Sync</div>
          <button data-id="auto" class="ka-btn-wide" title="Taste A schaltet um"><span class="ka-beat" data-id="beatdot"></span><span data-id="autolabel">Auto-Advance</span></button>
          <div class="ka-row">
            <select data-id="micdev" title="Audio-Eingang für die Beat-Erkennung">
              <option value="default">Standard-Eingang</option>
            </select>
            <input type="number" data-id="bpminput" min="40" max="240" placeholder="BPM"
              title="BPM fest eintippen (40–240, Enter setzt) — läuft ohne Mikro. Feld leeren oder Reset: zurück zur Erkennung">
            <button data-id="refbpm" class="ka-ref" hidden
              title="Referenztempo aus dem [bpm:]-Tag der LRC — darauf sind die &lt;N&gt;-Takte gebaut. Klick übernimmt den Wert als festen BPM"></button>
            <span class="ka-meta" data-id="bpm">—</span>
            <button data-id="bpmreset" title="BPM zurücksetzen — Erkennung lockt neu ein">Reset</button>
          </div>
          </div>
          <input type="file" accept=".lrc" multiple hidden>
          <input type="file" accept=".json" data-id="setlistfile" hidden>
        </div>
        <div class="ka-col">
          <div class="ka-markerbox" data-id="markerbox">
            <div class="ka-head" title="Klick oder Ziffer armiert — Leertaste löst den Sprung aus">Sprungmarken</div>
            <div class="ka-markers" data-id="markers"></div>
          </div>
          <div class="ka-lyrics" data-id="lyrics"></div>
        </div>
      </div>
      <div class="ka-status">
        <span data-id="meta">Kein Song geladen.</span>
        <span class="ka-keys" data-id="keys"></span>
      </div>
    </div>
  `;

  const q = (id: string) => container.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  const rootEl = container.querySelector<HTMLElement>('.ka-root')!;
  const songsEl = q('songs');
  const lyricsEl = q('lyrics');
  // Sprungmarken wandern im Mitsingkonzert unter die Vorschau (außerhalb
  // des Containers) — deshalb fest referenziert statt per q()
  const markerBox = q('markerbox');
  const markersEl = q('markers');
  const markerHome = markerBox.parentElement!;
  const keysEl = q('keys');

  // Grenze Setlist ↔ Rundown ziehbar, Breite je Modus gemerkt
  const colsEl = container.querySelector<HTMLElement>('.ka-cols')!;
  const leftResize = makeGapResizable({
    container: colsEl,
    left: () => colsEl.firstElementChild as HTMLElement,
    apply: (px) => rootEl.style.setProperty('--ka-left', px === null ? null : `${px}px`),
    storageKey: () => `schmalaoke.leftW.${mk ? 'mk' : 'fest'}`,
    min: 160,
    max: () => colsEl.clientWidth - 280,
  });
  const metaEl = q('meta');
  const fileInput = container.querySelector<HTMLInputElement>('input[type=file]')!;

  const songs: Song[] = [];
  let activeIndex = -1;
  let presenter: PresenterState | null = null;

  /** Teilungsgrenze für den aktuellen Sender-Modus */
  const modeMaxChars = () => (localStorage.getItem('operator.mode') === 'mk' ? MK_MAX_LINE_CHARS : MAX_LINE_CHARS);

  /** Song aus LRC-Inhalt bauen (Parse, Metadaten, Validierung) */
  function songFromContent(name: string, content: string, status: Song['status'] = 'planned'): Song {
    const p = new LRCParser();
    // Mitsingkonzert bricht auf der Wall selbst um → später teilen
    const maxChars = modeMaxChars();
    const ok = p.parseContent(content, maxChars);
    return {
      name,
      content,
      maxChars,
      ...fromFileName(name),
      title: p.metadata.ti || name.replace(/\.lrc$/i, ''),
      artist: p.metadata.ar || '',
      lines: ok ? [...p.lyricsLines] : [],
      sections: ok ? [...p.sections] : [],
      comments: ok ? [...p.comments] : [],
      refBpm: ok ? p.refBpm : 0,
      validation: ok ? p.validate() : { level: 'error', warnings: ['Keine Lyrics gefunden'] },
      status,
    };
  }

  // Keine stille Persistenz: das Panel startet leer. Setlists werden
  // ausschließlich explizit als JSON gesichert (💾) und geladen (📂).
  localStorage.removeItem('schmalaoke.setlist'); // Altlast früherer Versionen

  /* ---------- Playlist ---------- */

  async function addFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      if (!/\.lrc$/i.test(file.name)) continue;
      insertSong(songFromContent(file.name, await file.text()));
    }
    renderSongs();
  }

  q('add').onclick = () => fileInput.click();
  fileInput.onchange = () => {
    void addFiles(fileInput.files ?? []);
    fileInput.value = '';
  };

  /* ---------- Setlist als JSON sichern/laden (LRC-Inhalte eingebettet) ---------- */

  const setlistInput = container.querySelector<HTMLInputElement>('[data-id="setlistfile"]')!;

  q('save').onclick = () => {
    if (!songs.length) {
      metaEl.textContent = 'Setlist ist leer — nichts zu sichern.';
      return;
    }
    const data = {
      type: 'schmalaoke-setlist',
      version: 2,
      songs: songs.map((s) => ({
        name: s.name,
        content: s.content,
        group: s.group,
        ...(s.pick ? { pick: true } : {}),
        ...(s.label ? { label: s.label } : {}),
      })),
      folders: Object.fromEntries(groupNames),
      emptyFolders,
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'schmalaoke-setlist.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };

  q('loadlist').onclick = () => setlistInput.click();
  setlistInput.onchange = async () => {
    const file = setlistInput.files?.[0];
    setlistInput.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as {
        type?: string;
        songs?: Array<{ name?: string; content?: string; filepath?: string; label?: string; group?: string; pick?: boolean }>;
        folders?: Record<string, string>;
        emptyFolders?: string[];
      };
      if (data?.type !== 'schmalaoke-setlist' || !Array.isArray(data.songs)) throw new Error('kein Setlist-Format');
      if (!data.songs.every((s) => typeof s?.content === 'string')) {
        // v1 aus der Standalone-App referenziert nur Dateipfade — hier kein fs-Zugriff
        metaEl.textContent = 'Setlist aus der Standalone-App (nur Dateipfade) — bitte die LRC-Dateien direkt reinziehen.';
        return;
      }
      songs.length = 0;
      groupNames.clear();
      openGroups.clear();
      emptyFolders.length = 0;
      for (const s of data.songs) {
        const song = songFromContent(String(s.name ?? 'Song.lrc'), s.content!);
        if (typeof s.label === 'string' && s.label.trim()) song.label = s.label.trim();
        // Gespeicherte Ordner-Zuordnung (inkl. händischer Ordner) hat Vorrang
        if (typeof s.group === 'string' && s.group) song.group = s.group;
        song.pick = s.pick === true;
        songs.push(song);
      }
      for (const [g, n] of Object.entries(data.folders ?? {})) if (typeof n === 'string') groupNames.set(g, n);
      for (const g of data.emptyFolders ?? []) if (typeof g === 'string' && groupNames.has(g)) emptyFolders.push(g);
      activeIndex = -1;
      presenter = null;
      api.send({ cmd: 'reset' });
      renderSongs();
      renderMarkers();
      renderLyrics();
      metaEl.textContent = `Setlist geladen: ${songs.length} Song${songs.length === 1 ? '' : 's'}.`;
    } catch {
      metaEl.textContent = 'Keine gültige Setlist-Datei (.json).';
    }
  };

  /* ---------- Drag & Drop: Dateien aus dem Finder in die Liste ---------- */
  songsEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      songsEl.classList.add('dropping');
    }
  });
  songsEl.addEventListener('dragleave', () => songsEl.classList.remove('dropping'));
  songsEl.addEventListener('drop', (e) => {
    songsEl.classList.remove('dropping');
    if (e.dataTransfer?.files.length) {
      e.preventDefault();
      void addFiles(e.dataTransfer.files);
    }
  });

  /* ---------- Ordner: Versionen eines Songs ----------
     Die Liste bleibt flach; Versionen desselben Songs (gleicher group-Key
     aus dem Dateinamen) liegen direkt hintereinander und bilden einen
     Ordner („Run“). Pro Ordner ist genau eine Version gewählt (pick) — N/B
     springen von Ordner zu Ordner und laden die gewählte Version. Ein
     Ordner mit nur einer Version wird als normale Zeile gezeigt. */
  /** Aufgeklappte Ordner (group-Keys); neue Ordner starten zugeklappt */
  const openGroups = new Set<string>();
  /** Eigene Ordnernamen (Umbenennen bzw. händisch angelegte Ordner) */
  const groupNames = new Map<string, string>();
  /** Händisch angelegte, noch leere Ordner — stehen unten in der Liste,
   *  bis der erste Song hineingezogen wird */
  const emptyFolders: string[] = [];
  /** Händische Ordner (+ Ordner) sind auch mit nur einem Song ein Ordner */
  const isManual = (group: string) => group.startsWith('f:');
  const uid = () => Math.random().toString(36).slice(2, 9);
  const folderName = (group: string, fallback: string) => groupNames.get(group) ?? fallback;

  function runOf(i: number): { start: number; end: number } {
    let start = i;
    let end = i;
    while (start > 0 && songs[start - 1].group === songs[i].group) start--;
    while (end < songs.length - 1 && songs[end + 1].group === songs[i].group) end++;
    return { start, end };
  }

  /** Gewählte Version eines Ordners (Index) */
  function pickedOf(i: number): number {
    const r = runOf(i);
    for (let k = r.start; k <= r.end; k++) if (songs[k].pick) return k;
    return r.start;
  }

  /** Genau eine gewählte Version pro Ordner (sonst die erste) */
  function normalizePicks() {
    for (let i = 0; i < songs.length; ) {
      const r = runOf(i);
      let seen = false;
      for (let k = r.start; k <= r.end; k++) {
        if (songs[k].pick && !seen) seen = true;
        else songs[k].pick = false;
      }
      if (!seen) songs[r.start].pick = true;
      i = r.end + 1;
    }
  }

  /** Neuen Song einsortieren: in einen vorhandenen Ordner nach Version
   *  (Original, V2, V3 … V10), sonst ans Ende */
  function insertSong(song: Song) {
    const at = songs.findIndex((s) => s.group === song.group);
    let pos = songs.length;
    if (at >= 0) {
      const r = runOf(at);
      pos = r.end + 1;
      for (let k = r.start; k <= r.end; k++) {
        if (compareVersions(song.version, songs[k].version) < 0) {
          pos = k;
          break;
        }
      }
    }
    songs.splice(pos, 0, song);
    if (activeIndex >= pos) activeIndex++;
    if (renaming >= pos) renaming++;
  }

  /* ---------- Drag & Drop: Songs umsortieren ----------
     Quelle: ganzer Ordner (Kopf) bzw. einzelner Song, oder eine Version.
     Ziel: obere/untere Zeilenhälfte = davor/dahinter (ganze Ordner rasten
     an Ordnergrenzen ein), Mitte eines Ordner-Kopfs = hinein. Eine
     Version, die außerhalb eines Ordners landet, wird zum einzelnen Song. */
  interface DragSrc {
    start: number;
    count: number;
    /** true = einzelner Song/Version (darf in Ordner hinein/heraus) */
    item: boolean;
  }
  interface DropPlan {
    insertAt: number;
    /** neuer group-Key der verschobenen Songs (undefined = bleibt) */
    group?: string;
    /** Zeile, an der der Drop-Hinweis erscheint */
    mark: 'above' | 'below' | 'into';
  }
  let drag: DragSrc | null = null;

  /** Steckt Index i in einem (sichtbaren) Ordner? */
  const inFolder = (i: number) => {
    const r = runOf(i);
    return r.end > r.start || isManual(songs[i].group);
  };

  /** Bereich [start, start+count) vor die Einfügeposition insertAt
   *  (Index VOR dem Entfernen) verschieben, ggf. Ordner wechseln */
  function moveRange(start: number, count: number, insertAt: number, group?: string) {
    const moved = songs.splice(start, count);
    if (group !== undefined) for (const m of moved) m.group = group;
    let to = insertAt > start ? insertAt - count : insertAt;
    if (insertAt > start && insertAt < start + count) to = start; // auf sich selbst
    to = Math.max(0, Math.min(to, songs.length));
    songs.splice(to, 0, ...moved);
    const remap = (i: number) => {
      if (i < 0) return i;
      if (i >= start && i < start + count) return to + (i - start);
      let k = i > start ? i - count : i;
      if (k >= to) k += count;
      return k;
    };
    activeIndex = remap(activeIndex);
    renderSongs();
  }

  /** Was passiert beim Loslassen über Zeile i (kind = Zeilentyp)? */
  function planDrop(i: number, kind: 'song' | 'folder' | 'version', zone: 'top' | 'mid' | 'bottom'): DropPlan | null {
    if (!drag) return null;
    const src = drag;
    const r = runOf(i);
    // Eine Version, die einen Ordner verlässt, bekommt einen eigenen Key
    const leaving = src.item && inFolder(src.start) ? `s:${uid()}` : undefined;
    if (kind === 'folder') {
      const g = songs[r.start].group;
      if (zone === 'mid' && src.item && songs[src.start].group !== g) return { insertAt: r.end + 1, group: g, mark: 'into' };
      if (zone === 'top') return { insertAt: r.start, group: leaving, mark: 'above' };
      return { insertAt: r.end + 1, group: leaving, mark: 'below' };
    }
    if (kind === 'version') {
      const g = songs[i].group;
      if (!src.item) return zone === 'top' && i === r.start ? { insertAt: r.start, mark: 'above' } : { insertAt: r.end + 1, mark: 'below' };
      return zone === 'top' ? { insertAt: i, group: g, mark: 'above' } : { insertAt: i + 1, group: g, mark: 'below' };
    }
    return zone === 'top' ? { insertAt: i, group: leaving, mark: 'above' } : { insertAt: i + 1, group: leaving, mark: 'below' };
  }

  function loadSong(index: number) {
    // Song wurde in einem anderen Modus eingelesen (z.B. Setlist vor dem
    // Umschalten aufs Mitsingkonzert geladen) → frisch parsen, damit die
    // Zeilen zur Wall-Darstellung passen
    if (songs[index] && songs[index].maxChars !== modeMaxChars()) {
      const old = songs[index];
      songs[index] = songFromContent(old.name, old.content, old.status);
      songs[index].label = old.label;
      songs[index].pick = old.pick;
      songs[index].group = old.group;
    }
    const song = songs[index];
    if (!song || !song.lines.length) return;
    // Laden = diese Version im Ordner wählen
    const r = runOf(index);
    for (let k = r.start; k <= r.end; k++) songs[k].pick = k === index;
    // vorherigen loaded-Song zurücksetzen (falls nicht schon gespielt)
    songs.forEach((s, i) => {
      if (i !== index && s.status === 'loaded') s.status = 'planned';
    });
    activeIndex = index;
    setlistEnd = false;
    lastSongHint = false;
    song.status = 'loaded';
    api.send({ cmd: 'song', name: song.name, content: song.content, maxChars: song.maxChars });
    renderSongs();
    renderMarkers();
    renderLyrics();
  }

  /** Nächster Ordner/Song (Taste N, Auto-Next): gewählte Version laden.
   *  false = es gibt keinen weiteren. */
  function nextSong(): boolean {
    const from = activeIndex >= 0 ? runOf(activeIndex).end + 1 : 0;
    if (from >= songs.length) return false;
    loadSong(pickedOf(from));
    return true;
  }

  /** Hinter dem letzten Ordner gibt es nichts mehr: Statuszeile sagt es
   *  deutlich, statt dass die Wall still leer bleibt */
  let setlistEnd = false;
  /** Kurzer Hinweis „letzter Song“ nach N am Listenende (Mitsingkonzert) */
  let lastSongHint = false;
  let lastSongTimer = -1;

  q('next').onclick = () => {
    // Mitsingkonzert: am letzten Song tut N NICHTS — ein Druck zu viel
    // soll live nicht die Wall leer machen. Der Song läuft weiter.
    if (mk && activeIndex >= 0 && runOf(activeIndex).end >= songs.length - 1) {
      lastSongHint = true;
      updateMeta();
      clearTimeout(lastSongTimer);
      lastSongTimer = window.setTimeout(() => {
        lastSongHint = false;
        updateMeta();
      }, 3000);
      return;
    }
    if (activeIndex >= 0) songs[activeIndex].status = 'finished';
    if (!nextSong()) {
      setlistEnd = true;
      api.send({ cmd: 'nextsong' });
    }
    renderSongs();
    updateMeta();
  };

  /** Voriger Song (Taste B): lädt die gewählte Version des Ordners davor —
   *  sie startet wie jeder geladene Song erst mit der Leertaste. Der
   *  verlassene Song gilt wieder als geplant, außer er war durchgespielt. */
  function prevSong() {
    if (activeIndex < 0) return;
    const r = runOf(activeIndex);
    if (r.start <= 0) return;
    const cur = songs[activeIndex];
    if (cur.status !== 'finished') cur.status = 'planned';
    loadSong(pickedOf(r.start - 1));
  }

  /** Anzeigename: eigener Name, sonst „Interpret – Titel“ aus der LRC
   *  (plus Version, damit gleiche [ti:]-Tags unterscheidbar bleiben) */
  const autoName = (song: Song) => {
    // Viele LRCs haben den Interpreten schon im [ti:] — dann nicht doppeln
    const hasArtist = song.artist && !song.title.toLowerCase().includes(song.artist.toLowerCase());
    return (hasArtist ? `${song.artist} – ${song.title}` : song.title) + (song.version ? ` · ${song.version}` : '');
  };
  const displayName = (song: Song) => song.label || autoName(song);
  /** Steckt der Song in „seinem“ Ordner (gleicher Dateiname-Stamm)? Sonst
   *  (händischer Ordner) hilft das Versions-Kürzel allein nicht weiter */
  const ownFolder = (song: Song) => song.group === fromFileName(song.name).group;
  /** Name einer Version im aufgeklappten Ordner */
  const versionAuto = (song: Song) => (ownFolder(song) ? song.version || 'Original' : autoName(song));
  const versionName = (song: Song) => song.label || versionAuto(song);
  /** Kurzinfo einer Version: Zeilen + Sprungmarken (zeigt, was drin ist) */
  const versionInfo = (song: Song) => {
    const marks = song.sections.filter((x): x is string => !!x);
    const list = marks.slice(0, 4).join(', ') + (marks.length > 4 ? ` +${marks.length - 4}` : '');
    return `${song.lines.length} Zeilen${list ? ` · ${list}` : ''}`;
  };

  /* ---------- Umbenennen ----------
     ✎ in der Zeile oder Rechtsklick → Name wird zum Eingabefeld. Enter
     übernimmt, Esc bricht ab, leeres Feld = zurück zum Namen aus der LRC.
     Solange getippt wird, baut renderSongs die Liste NICHT neu (Presenter-
     Updates kommen laufend und würden das Feld sonst wegwerfen). */
  let renaming = -1;

  function startRename(i: number) {
    renaming = i;
    renderSongs(true);
  }

  function finishRename(i: number, value: string | null) {
    if (renaming !== i) return;
    renaming = -1;
    if (value !== null && songs[i]) {
      const v = value.trim();
      const r = runOf(i);
      const auto = r.end > r.start || isManual(songs[i].group) ? versionAuto(songs[i]) : autoName(songs[i]);
      songs[i].label = v && v !== auto ? v : undefined;
    }
    renderSongs();
  }

  /** Ordner umbenennen (Kopf): eigener Name statt des Dateinamens */
  let renamingGroup: string | null = null;

  function startRenameGroup(group: string) {
    renamingGroup = group;
    renderSongs(true);
  }

  function finishRenameGroup(group: string, value: string | null) {
    if (renamingGroup !== group) return;
    renamingGroup = null;
    if (value !== null) {
      const v = value.trim();
      if (v) groupNames.set(group, v);
      else if (!isManual(group)) groupNames.delete(group);
    }
    renderSongs();
  }

  /** Name im Ordner-Kopf (bzw. Eingabefeld beim Umbenennen) */
  function folderNameEl(group: string, fallback: string): HTMLElement {
    const text = folderName(group, fallback);
    if (renamingGroup === group) {
      const input = document.createElement('input');
      input.className = 'name ka-rename';
      input.value = text;
      input.placeholder = fallback;
      input.onclick = (e) => e.stopPropagation();
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finishRenameGroup(group, input.value);
        else if (e.key === 'Escape') finishRenameGroup(group, null);
      };
      input.onblur = () => finishRenameGroup(group, input.value);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
      return input;
    }
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = text;
    if (groupNames.has(group) && !isManual(group)) name.classList.add('custom');
    return name;
  }

  /** Namensfeld einer Zeile: Text oder (beim Umbenennen) Eingabefeld */
  function nameEl(i: number, text: string, auto: string, tooltip: string, row: HTMLElement): HTMLElement {
    const song = songs[i];
    if (i === renaming) {
      const input = document.createElement('input');
      input.className = 'name ka-rename';
      input.value = text;
      input.placeholder = auto;
      input.title = 'Enter übernimmt · Esc bricht ab · leer = Name aus der LRC';
      input.onclick = (e) => e.stopPropagation();
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finishRename(i, input.value);
        else if (e.key === 'Escape') finishRename(i, null);
      };
      input.onblur = () => finishRename(i, input.value);
      row.draggable = false;
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
      return input;
    }
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = text;
    name.title = tooltip;
    if (song.label) name.classList.add('custom');
    return name;
  }

  function opsEl(items: Array<[string, string, () => void]>): HTMLElement {
    const ops = document.createElement('span');
    ops.className = 'ops';
    for (const [label, tip, fn] of items) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.title = tip;
      btn.onclick = (e) => {
        e.stopPropagation();
        fn();
      };
      ops.appendChild(btn);
    }
    return ops;
  }

  function warnEl(song: Song): HTMLElement | null {
    if (song.validation.level === 'ok') return null;
    // Mitsingkonzert läuft von Hand — Beat-Tag-Hinweise wären nur Rauschen
    if (mk && song.validation.level === 'warn') return null;
    const warn = document.createElement('span');
    warn.className = 'warn';
    warn.textContent = song.validation.level === 'error' ? '🛑' : '⚠️';
    warn.title = song.validation.warnings.join('\n');
    return warn;
  }

  const zoneOf = (row: HTMLElement, e: DragEvent): 'top' | 'mid' | 'bottom' => {
    const rect = row.getBoundingClientRect();
    const f = (e.clientY - rect.top) / rect.height;
    return f < 0.3 ? 'top' : f > 0.7 ? 'bottom' : 'mid';
  };
  const clearMarks = () =>
    songsEl.querySelectorAll('.ka-song').forEach((r) => r.classList.remove('drop-above', 'drop-below', 'drop-into'));

  /** Drag-Quelle + Drop-Ziel an eine Zeile hängen */
  function wireDrag(row: HTMLElement, i: number, kind: 'song' | 'folder' | 'version', source: DragSrc) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      drag = source;
      row.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', String(i));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      drag = null;
      songsEl.querySelectorAll('.ka-song').forEach((r) => r.classList.remove('dragging'));
      clearMarks();
    });
    row.addEventListener('dragover', (e) => {
      if (!drag) return; // Datei-Drags behandelt der Container
      const plan = planDrop(i, kind, zoneOf(row, e));
      row.classList.remove('drop-above', 'drop-below', 'drop-into');
      if (!plan) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      row.classList.add(`drop-${plan.mark}`);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below', 'drop-into'));
    row.addEventListener('drop', (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation(); // nicht als Datei-Drop im Container behandeln
      const plan = planDrop(i, kind, zoneOf(row, e));
      const src = drag;
      drag = null;
      clearMarks();
      if (!plan) return;
      if (plan.group !== undefined) openGroups.add(plan.group);
      moveRange(src.start, src.count, plan.insertAt, plan.group);
    });
  }

  const SVG_CHEV = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg>';
  const SVG_FOLDER = '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h4l1.6 1.8h7.4A1.5 1.5 0 0 1 18 7.3v7.2a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14.5z"/></svg>';
  /** Aufklapp-Pfeil (dreht sich per CSS, wenn der Ordner offen ist) */
  function chevEl(): HTMLElement {
    const chev = document.createElement('span');
    chev.className = 'chev';
    chev.innerHTML = SVG_CHEV;
    return chev;
  }
  function folderIcon(): HTMLElement {
    const icon = document.createElement('span');
    icon.className = 'ficon';
    icon.innerHTML = SVG_FOLDER;
    return icon;
  }

  /** Leerer händischer Ordner: Ablagefläche, Songs landen ans Listenende */
  function emptyFolderRow(group: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ka-song ka-folder ka-empty-folder';
    const chev = chevEl();
    const hint = document.createElement('span');
    hint.className = 'ka-vinfo';
    hint.textContent = 'leer — Songs hierher ziehen';
    row.append(chev, folderIcon(), folderNameEl(group, 'Neuer Ordner'), hint);
    row.appendChild(
      opsEl([
        ['✎', 'Ordner umbenennen (Rechtsklick)', () => startRenameGroup(group)],
        ['✕', 'Leeren Ordner entfernen', () => {
          emptyFolders.splice(emptyFolders.indexOf(group), 1);
          groupNames.delete(group);
          renderSongs();
        }],
      ]),
    );
    row.oncontextmenu = (e) => {
      e.preventDefault();
      startRenameGroup(group);
    };
    row.addEventListener('dragover', (e) => {
      if (!drag) return;
      e.preventDefault();
      row.classList.add('drop-into');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-into'));
    row.addEventListener('drop', (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      const src = drag;
      drag = null;
      clearMarks();
      emptyFolders.splice(emptyFolders.indexOf(group), 1);
      openGroups.add(group);
      moveRange(src.start, src.count, songs.length, group);
    });
    return row;
  }

  /** Normale Zeile (Song mit einer Version) */
  function songRow(i: number): HTMLElement {
    const song = songs[i];
    const row = document.createElement('div');
    row.className = 'ka-song' + (i === activeIndex ? ' active' : '');
    wireDrag(row, i, 'song', { start: i, count: 1, item: true });
    const dot = document.createElement('span');
    dot.className = `dot dot-${song.status}`;
    const tip = [song.label ? `Eigener Name · LRC: ${autoName(song)}` : '', `Datei: ${song.name}`, ...song.validation.warnings]
      .filter(Boolean)
      .join('\n');
    row.append(dot, nameEl(i, displayName(song), autoName(song), tip, row));
    const warn = warnEl(song);
    if (warn) row.appendChild(warn);
    row.appendChild(
      opsEl([
        ['✎', 'Umbenennen (Rechtsklick)', () => startRename(i)],
        ['✕', 'Aus der Setlist entfernen', () => removeRange(i, 1)],
      ]),
    );
    row.onclick = () => loadSong(i);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      startRename(i);
    };
    return row;
  }

  /** Ordner-Kopf: Klick klappt auf/zu, zeigt die gewählte Version */
  function folderRow(start: number, end: number): HTMLElement {
    const song = songs[start];
    const picked = pickedOf(start);
    const open = openGroups.has(song.group);
    const holdsActive = activeIndex >= start && activeIndex <= end;
    const row = document.createElement('div');
    row.className = 'ka-song ka-folder' + (holdsActive ? ' active' : '') + (open ? ' open' : '');
    wireDrag(row, start, 'folder', { start, count: end - start + 1, item: false });
    const chev = chevEl();
    const dot = document.createElement('span');
    dot.className = `dot dot-${songs[picked].status}`;
    const name = folderNameEl(song.group, isManual(song.group) ? 'Ordner' : song.base);
    name.title = `${end - start + 1} Versionen · gewählt: ${versionName(songs[picked])}\nKlick klappt auf/zu · Rechtsklick benennt um`;
    const tag = document.createElement('span');
    tag.className = 'ka-vtag';
    tag.textContent = versionName(songs[picked]);
    tag.title = 'Gewählte Version — N/B laden diese';
    const count = document.createElement('span');
    count.className = 'ka-vcount';
    const n = end - start + 1;
    count.textContent = isManual(song.group) ? `${n} Song${n === 1 ? '' : 's'}` : `${n} Vers.`;
    row.append(chev, folderIcon(), dot, name, tag, count);
    row.appendChild(
      opsEl([
        ['✎', 'Ordner umbenennen (Rechtsklick)', () => startRenameGroup(song.group)],
        ['✕', 'Ordner mit allen Versionen aus der Setlist entfernen', () => removeRange(start, end - start + 1)],
      ]),
    );
    row.oncontextmenu = (e) => {
      e.preventDefault();
      startRenameGroup(song.group);
    };
    row.onclick = () => {
      if (open) openGroups.delete(song.group);
      else openGroups.add(song.group);
      renderSongs();
    };
    return row;
  }

  /** Version im aufgeklappten Ordner: Klick wählt sie und lädt sie */
  function versionRow(i: number): HTMLElement {
    const song = songs[i];
    const row = document.createElement('div');
    row.className = 'ka-song ka-version' + (i === activeIndex ? ' active' : '') + (song.pick ? ' picked' : '');
    wireDrag(row, i, 'version', { start: i, count: 1, item: true });
    const dot = document.createElement('span');
    dot.className = `dot dot-${song.status}`;
    const tip = [song.label ? `Eigener Name · Version: ${song.version || 'Original'}` : '', `Datei: ${song.name}`, ...song.validation.warnings]
      .filter(Boolean)
      .join('\n');
    const info = document.createElement('span');
    info.className = 'ka-vinfo';
    info.textContent = versionInfo(song);
    row.append(dot, nameEl(i, versionName(song), versionAuto(song), tip, row), info);
    if (song.pick) row.title = 'Gewählte Version — N/B laden diese';
    const warn = warnEl(song);
    if (warn) row.appendChild(warn);
    row.appendChild(
      opsEl([
        ['✎', 'Umbenennen (Rechtsklick)', () => startRename(i)],
        ['✕', 'Version aus der Setlist entfernen', () => removeRange(i, 1)],
      ]),
    );
    row.onclick = () => loadSong(i);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      startRename(i);
    };
    return row;
  }

  function renderSongs(force = false) {
    if ((renaming >= 0 || renamingGroup !== null) && !force) return;
    songsEl.innerHTML = '';
    if (!songs.length && !emptyFolders.length) {
      songsEl.innerHTML =
        '<div class="ka-empty"><b>Keine Songs in der Setlist</b>LRC-Dateien hierhin ziehen oder „+ Songs hinzufügen“</div>';
      return;
    }
    normalizePicks();
    for (let i = 0; i < songs.length; ) {
      const r = runOf(i);
      if (r.end === r.start && !isManual(songs[i].group)) {
        songsEl.appendChild(songRow(i));
      } else {
        songsEl.appendChild(folderRow(r.start, r.end));
        if (openGroups.has(songs[i].group)) {
          for (let k = r.start; k <= r.end; k++) songsEl.appendChild(versionRow(k));
        }
      }
      i = r.end + 1;
    }
    for (const g of emptyFolders) songsEl.appendChild(emptyFolderRow(g));
  }

  /** + Ordner: leeren Ordner anlegen und gleich benennen */
  q('addfolder').onclick = () => {
    const g = `f:${uid()}`;
    groupNames.set(g, 'Neuer Ordner');
    emptyFolders.push(g);
    startRenameGroup(g);
  };

  function removeRange(start: number, count: number) {
    songs.splice(start, count);
    if (activeIndex >= start && activeIndex < start + count) {
      activeIndex = -1;
      api.send({ cmd: 'reset' });
      presenter = null;
      renderMarkers();
      renderLyrics();
      metaEl.textContent = 'Kein Song geladen.';
    } else if (activeIndex >= start + count) {
      activeIndex -= count;
    }
    renderSongs();
  }

  q('restart').onclick = () => api.send({ cmd: 'restart' });
  const blankBtn = q('blank') as HTMLButtonElement;
  blankBtn.onclick = () => api.send({ cmd: 'blank' });

  /** Schwarz-Zustand am Button und im Rundown zeigen */
  function renderBlank() {
    const on = !!presenter?.blank;
    blankBtn.classList.toggle('live', on);
    blankBtn.textContent = on ? 'SCHWARZ — einblenden (S)' : 'Schwarz (S)';
    lyricsEl.classList.toggle('blank', on);
  }

  /* ---------- Notfall-Durchsage ---------- */
  // Modus AN = Textfeld sichtbar, noch nichts auf der Wall. „Fertig“ schickt
  // den Text live (und ersetzt eine laufende Durchsage). Modus AUS nimmt
  // die Durchsage von der Wall — die Lyrics laufen an der Stelle weiter,
  // an der sie standen. Der Entwurf bleibt über Spielwechsel erhalten.
  const NOTICE_DRAFT_KEY = 'schmalaoke.noticeDraft';
  const noticeBtn = q('notice') as HTMLButtonElement;
  const noticeBox = q('noticebox');
  const noticeText = container.querySelector<HTMLTextAreaElement>('[data-id="noticetext"]')!;
  const noticeSend = q('noticesend') as HTMLButtonElement;
  const noticeHint = q('noticehint');
  let noticeMode = false;
  /** Text, der gerade auf der Wall steht ('' = keine Durchsage) */
  let noticeLive = '';
  noticeText.value = localStorage.getItem(NOTICE_DRAFT_KEY) ?? '';

  function renderNotice() {
    noticeBox.hidden = !noticeMode;
    noticeBtn.classList.toggle('live', !!noticeLive);
    noticeBtn.classList.toggle('armed', noticeMode && !noticeLive);
    noticeBtn.textContent = noticeLive
      ? 'Notfall-Durchsage: LIVE — ausschalten'
      : noticeMode
        ? 'Notfall-Durchsage: bereit — abbrechen'
        : 'Notfall-Durchsage';
    const dirty = noticeText.value.trim() !== noticeLive;
    noticeSend.textContent = noticeLive ? (dirty ? 'Fertig — Text aktualisieren' : 'Fertig — live') : 'Fertig — live schicken';
    noticeSend.classList.toggle('ka-btn-primary', noticeMode && dirty && !!noticeText.value.trim());
    noticeHint.textContent = noticeLive
      ? dirty
        ? 'Geänderter Text ist noch NICHT auf der Wall — „Fertig“ schickt ihn.'
        : 'Steht live auf der Wall, Lyrics sind ausgeblendet.'
      : 'Text eintippen, dann „Fertig“ — erst dann geht er raus.';
    updateMeta();
  }

  noticeBtn.onclick = () => {
    if (noticeMode) {
      noticeMode = false;
      if (noticeLive) {
        noticeLive = '';
        api.send({ cmd: 'notice', text: '' });
      }
    } else {
      noticeMode = true;
      noticeText.focus();
    }
    renderNotice();
  };
  noticeSend.onclick = () => {
    const text = noticeText.value.trim();
    if (!text) {
      noticeHint.textContent = 'Kein Text — nichts geschickt.';
      noticeText.focus();
      return;
    }
    noticeLive = text;
    api.send({ cmd: 'notice', text });
    renderNotice();
    noticeText.blur();
  };
  noticeText.addEventListener('input', () => {
    localStorage.setItem(NOTICE_DRAFT_KEY, noticeText.value);
    renderNotice();
  });
  noticeText.addEventListener('keydown', (e) => {
    // ⌘⏎ / Ctrl⏎ = Fertig, Esc = Feld verlassen (Tasten gehen dann wieder ans Spiel)
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      noticeSend.click();
    } else if (e.key === 'Escape') {
      noticeText.blur();
    }
    e.stopPropagation();
  });

  /* ---------- Auto-Advance ---------- */
  let autoOn = false;
  let beatDotTimer = -1;
  const autoBtn = q('auto') as HTMLButtonElement;
  const beatDot = q('beatdot');
  const bpmEl = q('bpm');
  const refBtn = q('refbpm') as HTMLButtonElement;
  /** Referenz-BPM des aktiven Songs (aus [bpm:]-Tag) */
  const refBpm = () => songs[activeIndex]?.refBpm ?? 0;
  const micDev = container.querySelector<HTMLSelectElement>('[data-id="micdev"]')!;

  autoBtn.onclick = () => {
    autoOn = !autoOn;
    api.send({ cmd: 'auto', enabled: autoOn });
    renderAuto();
  };
  micDev.onchange = () => api.send({ cmd: 'micdev', id: micDev.value });

  /* Fester BPM-Wert: eintippen + Enter (oder Feld verlassen) setzt das
     Beat-Grid ohne Mikrofon. Feld leeren = zurück zur Erkennung. */
  const bpmInput = container.querySelector<HTMLInputElement>('[data-id="bpminput"]')!;
  const sendBpm = () => {
    if (bpmInput.value.trim() === '') {
      api.send({ cmd: 'bpmset', value: 0 });
      bpmEl.textContent = autoOn ? 'wartet auf 2× Leertaste' : '—';
      return;
    }
    const v = Math.round(Number(bpmInput.value));
    if (!Number.isFinite(v)) {
      bpmInput.value = '';
      return;
    }
    const clamped = Math.min(240, Math.max(40, v));
    bpmInput.value = String(clamped);
    api.send({ cmd: 'bpmset', value: clamped });
  };
  bpmInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendBpm();
      bpmInput.blur();
    }
  });
  bpmInput.addEventListener('change', sendBpm);

  // Referenztempo-Chip: zeigt den [bpm:]-Tag, Klick setzt ihn als festen Wert
  refBtn.onclick = () => {
    const ref = refBpm();
    if (!ref) return;
    bpmInput.value = String(ref);
    sendBpm();
  };
  function renderRefBpm() {
    const ref = refBpm();
    refBtn.hidden = !ref;
    refBtn.textContent = ref ? `Song ${ref} BPM` : '';
  }

  q('bpmreset').onclick = () => {
    api.send({ cmd: 'bpmreset' });
    bpmInput.value = '';
    bpmEl.textContent = autoOn ? 'wartet auf 2× Leertaste' : '—';
    beatDot.classList.remove('on', 'warn');
  };

  function renderAuto() {
    q('autolabel').textContent = autoOn ? 'Auto-Advance: AN (A)' : 'Auto-Advance (A)';
    autoBtn.classList.toggle('armed', autoOn);
    bpmEl.classList.remove('mismatch');
    if (!autoOn) {
      bpmEl.textContent = '—';
      beatDot.classList.remove('on', 'warn');
    } else {
      bpmEl.textContent = 'wartet auf 2× Leertaste';
    }
  }

  /** Sprungmarken ({Name}-Tags) als Chips — Klick/Ziffer armiert */
  function renderMarkers() {
    markersEl.innerHTML = '';
    const song = songs[activeIndex];
    if (!song) {
      markersEl.innerHTML = '<span class="ka-meta">—</span>';
      return;
    }
    const markers: Array<{ index: number; name: string }> = [];
    song.sections.forEach((name, i) => {
      if (name) markers.push({ index: i, name });
    });
    if (!markers.length) {
      markersEl.innerHTML = '<span class="ka-meta">Keine {Sprungmarken} in dieser LRC.</span>';
      return;
    }
    markers.forEach((m, i) => {
      const chip = document.createElement('span');
      chip.className = 'ka-marker' + (presenter?.pendingJump === m.index ? ' armed' : '');
      if (i < 9) {
        const key = document.createElement('span');
        key.className = 'key';
        key.textContent = String(i + 1);
        chip.appendChild(key);
      }
      chip.appendChild(document.createTextNode(m.name));
      chip.title = `Zeile ${m.index + 1} — armieren, Leertaste springt`;
      chip.onclick = () => api.send({ cmd: 'jump', index: m.index });
      markersEl.appendChild(chip);
    });
  }

  /** Ziffern-Hotkey → N-te Sprungmarke armieren (wie im Original) */
  function armMarkerByDigit(n: number) {
    const song = songs[activeIndex];
    if (!song) return;
    const markerLines: number[] = [];
    song.sections.forEach((name, i) => {
      if (name) markerLines.push(i);
    });
    const line = markerLines[n - 1];
    if (line !== undefined) api.send({ cmd: 'jump', index: line });
  }

  function renderLyrics() {
    lyricsEl.innerHTML = '';
    const song = songs[activeIndex];
    if (!song) return;
    song.lines.forEach((line, i) => {
      const el = document.createElement('div');
      el.className = 'ka-lyric';
      if (presenter?.started && presenter.currentLine === i) el.classList.add('current');
      if (presenter?.pendingJump === i) el.classList.add('armed');
      if (song.sections[i]) {
        const sec = document.createElement('span');
        sec.className = 'sec';
        sec.textContent = `{${song.sections[i]}}`;
        el.appendChild(sec);
      }
      if (!plainText(line)) el.appendChild(document.createTextNode('···'));
      // Formatierungs-Tags wie auf der Wall: <b> <i> <u> als Elemente
      for (const seg of parseMarkup(line)) {
        let node: Node = document.createTextNode(seg.text);
        for (const tag of [seg.u && 'u', seg.i && 'i', seg.b && 'b']) {
          if (!tag) continue;
          const wrap = document.createElement(tag);
          wrap.appendChild(node);
          node = wrap;
        }
        el.appendChild(node);
      }
      if (song.comments[i]) {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = song.comments[i]!;
        note.title = song.comments[i]!;
        el.appendChild(note);
      }
      // Bewusst KEIN Klick auf Zeilen: das sah aus wie "ausgewählt", sprang
      // aber nicht — Sprünge laufen nur über die Marken-Chips / Ziffern
      lyricsEl.appendChild(el);
    });
  }

  /** Statuszeile unten: nur Zustand — Titel steht in Setlist & Status-Panel */
  function updateMeta() {
    const parts: string[] = [];
    if (noticeLive) parts.push('<span class="notice-live">NOTFALL-DURCHSAGE LIVE</span>');
    if (presenter?.blank) parts.push('<span class="notice-live">SCHWARZ — Leertaste blendet ein</span>');
    if (!presenter || activeIndex < 0) {
      if (noticeLive) metaEl.innerHTML = parts.join(' · ');
      return;
    }
    if (lastSongHint) parts.push('<span class="rest-crit">LETZTER SONG — kein nächster in der Setlist</span>');
    if (presenter.ended && setlistEnd) parts.push('<span class="rest-crit">ENDE DER SETLIST — kein weiterer Song · B = voriger, oder Song/Version anklicken</span>');
    else if (presenter.ended) parts.push('Song beendet');
    else if (!presenter.started) parts.push('Bereit — Leertaste startet');
    else if (presenter.remaining >= 0) {
      const cls = presenter.remaining <= 5 ? 'rest-crit' : presenter.remaining <= 10 ? 'rest-warn' : '';
      parts.push(`<span class="${cls}">${presenter.remaining} Zeilen übrig</span>`);
    }
    if (presenter.pendingJump >= 0) parts.push(`<span class="rest-crit">Sprung armiert → Zeile ${presenter.pendingJump + 1} (Leertaste)</span>`);
    if (guardKey) parts.push(`<span class="rest-crit">${GUARDED[guardKey].key} nochmal drücken = ${GUARDED[guardKey].label}</span>`);
    metaEl.innerHTML = parts.join(' · ');
  }

  /* ---------- Tastensteuerung (wie im Original-Player) ---------- */

  const KEY_MAP: Record<string, 'space' | 'prev' | 'nextsong' | 'prevsong' | 'restart' | 'auto' | 'blank'> = {
    Space: 'space',
    ArrowRight: 'space',
    ArrowDown: 'space',
    ArrowLeft: 'prev',
    ArrowUp: 'prev',
    KeyN: 'nextsong',
    KeyB: 'prevsong',
    KeyS: 'blank',
    // R = Neustart (MacBook-tauglich); Home bleibt für externe Tastaturen
    KeyR: 'restart',
    Home: 'restart',
    // A = Auto-Advance an/aus
    KeyA: 'auto',
  };

  /* ---------- Mitsingkonzert ---------- */
  // Eigenes Layout für eine Person am MacBook: Beat-Sync weg (alles von
  // Hand), Sprungmarken als große Buttons unter der Vorschau, Rundown
  // groß und mitlaufend. N und R brauchen einen zweiten Druck — ein
  // versehentliches N mitten im Song wäre live fatal.
  let mk = false;
  /** Doppeldruck-Sicherung: Taste, die gerade auf Bestätigung wartet */
  let guardKey: Guarded | null = null;
  let guardTimer = -1;
  const GUARD_MS = 1500;
  /** Tasten mit Doppeldruck-Sicherung im Mitsingkonzert */
  const GUARDED = {
    nextsong: { key: 'N', label: 'nächster Song' },
    prevsong: { key: 'B', label: 'voriger Song' },
    restart: { key: 'R', label: 'Neustart' },
  };
  type Guarded = keyof typeof GUARDED;

  function applyMode(mode: StationMode) {
    mk = mode === 'mk';
    rootEl.classList.toggle('ka-mk', mk);
    const extra = document.getElementById('preview-extra');
    if (mk && extra) {
      extra.appendChild(markerBox);
      extra.hidden = false;
    } else if (markerBox.parentElement !== markerHome) {
      markerHome.insertBefore(markerBox, lyricsEl);
      if (extra) extra.hidden = true;
    }
    // Auto-Advance ist im Mitsingkonzert nicht bedienbar → sicher aus
    if (mk && autoOn) autoBtn.click();
    noticeText.placeholder = mk
      ? 'Text der Durchsage … (läuft unten am Bildrand als Laufband durch, Absätze werden mit +++ verbunden)'
      : 'Text der Durchsage … (fährt als Laufband in einer Zeile durch, Absätze werden mit +++ verbunden)';
    clearGuard();
    renderKeys();
    renderSongs(); // Warn-Symbole hängen am Modus
    leftResize.restore();
    scrollToCurrent(false);
  }

  function renderKeys() {
    keysEl.innerHTML = mk
      ? '<kbd>Leertaste</kbd> weiter · <kbd>←</kbd> zurück · <kbd>S</kbd> Schwarz · <kbd>1–9</kbd> Sprungmarke · <kbd>R</kbd><kbd>R</kbd> Neustart · <kbd>B</kbd><kbd>B</kbd> voriger / <kbd>N</kbd><kbd>N</kbd> nächster Song'
      : '<kbd>Leertaste</kbd> weiter · <kbd>←</kbd> zurück · <kbd>S</kbd> Schwarz · <kbd>R</kbd> Neustart · <kbd>1–9</kbd> Sprungmarke · <kbd>B</kbd> voriger / <kbd>N</kbd> nächster Song';
  }

  function clearGuard() {
    guardKey = null;
    clearTimeout(guardTimer);
    updateMeta();
  }

  /** true = Befehl ausführen; false = erst mal nur scharf geschaltet */
  function guardPassed(cmd: Guarded): boolean {
    if (!mk) return true;
    if (guardKey === cmd) {
      clearGuard();
      return true;
    }
    guardKey = cmd;
    clearTimeout(guardTimer);
    guardTimer = window.setTimeout(clearGuard, GUARD_MS);
    updateMeta();
    return false;
  }

  /** Aktuelle Zeile im Rundown ins obere Drittel holen — so steht sie
   *  immer an derselben Stelle und man sieht viel vom Kommenden */
  function scrollToCurrent(smooth = true) {
    const el = lyricsEl.querySelector<HTMLElement>('.ka-lyric.current');
    if (!el) return;
    if (!mk) {
      el.scrollIntoView({ block: 'nearest' });
      return;
    }
    const top = el.offsetTop - lyricsEl.offsetTop - lyricsEl.clientHeight * 0.25;
    lyricsEl.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }

  function handleCode(code: string) {
    const digit = code.match(/^Digit([1-9])$/);
    if (digit) {
      armMarkerByDigit(Number(digit[1]));
      return;
    }
    const cmd = KEY_MAP[code];
    if (!cmd) return;
    if (cmd === 'auto' && mk) return;
    if (cmd in GUARDED) {
      if (!guardPassed(cmd as Guarded)) return;
    } else if (guardKey) {
      clearGuard();
    }
    if (cmd === 'nextsong') q('next').click();
    else if (cmd === 'prevsong') prevSong();
    else if (cmd === 'auto') autoBtn.click();
    else api.send({ cmd });
  }

  // Lokal (Operator fokussiert) — kennt Eingabefelder und Buttons
  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!KEY_MAP[e.code]) return;
    e.preventDefault();
    // Space darf keinen fokussierten Button auslösen
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    handleCode(e.code);
  };
  window.addEventListener('keydown', onKey);

  renderSongs();
  renderMarkers();
  renderNotice();
  renderKeys();
  // Eingangsliste + aktuellen Stand anfordern (Panel evtl. neu aufgebaut)
  api.send({ cmd: 'hello' });

  return {
    // Tasten aus dem WALL-Fenster (Main-Prozess relayt sie hierher)
    onKey(code: string) {
      handleCode(code);
    },
    onEvent(payload: unknown) {
      const msg = payload as { kind?: string };
      if (msg.kind === 'presenter') {
        presenter = payload as PresenterState;
        if (autoOn !== presenter.autoMode) {
          autoOn = presenter.autoMode;
          renderAuto();
        }
        // Durchsage-Zustand kommt vom Spiel (Panel evtl. neu aufgebaut)
        const liveNotice = presenter.notice ?? '';
        if (liveNotice !== noticeLive) {
          noticeLive = liveNotice;
          if (noticeLive) {
            noticeMode = true;
            if (!noticeText.value.trim()) noticeText.value = noticeLive;
          }
          renderNotice();
        }
        if (activeIndex >= 0 && presenter.started && songs[activeIndex].status !== 'playing') {
          songs[activeIndex].status = 'playing';
        }
        renderSongs();
        renderMarkers();
        renderLyrics();
        renderRefBpm();
        renderBlank();
        updateMeta();
        // aktive Zeile in Sicht halten
        scrollToCurrent();
      }
      if (msg.kind === 'beat') {
        const { bpm, locked, lockedFor, manual, armed, spaces, ref } = payload as {
          bpm: number;
          locked: boolean;
          lockedFor?: number;
          manual?: boolean;
          armed?: boolean;
          spaces?: number;
          ref?: number;
        };
        const bpmTxt = bpm > 0 ? `${Math.round(bpm)} BPM${manual ? ' fix' : ''}` : '';
        const left = 2 - (spaces ?? 0);
        // Abgleich mit dem [bpm:]-Tag: >8 % daneben (typisch halb/doppelt)
        // → die Takte können nicht stimmen, deutlich warnen
        const mismatch = !!ref && bpm > 0 && Math.abs(bpm / ref - 1) > 0.08;
        bpmEl.classList.toggle('mismatch', mismatch);
        bpmEl.textContent = mismatch
          ? `${bpmTxt} ≠ Song ${ref} — passt NICHT`
          : !armed
            ? `${bpmTxt ? bpmTxt + ' · ' : ''}wartet auf ${left}× Leertaste`
            : locked
              ? `${bpmTxt} · Auto fährt${lockedFor ? ` · gelockt seit ${Math.round(lockedFor)} s` : ''}`
              : bpm > 0
                ? `${bpmTxt} · lockt ein …`
                : 'lauscht …';
        beatDot.classList.remove('on', 'warn');
        beatDot.classList.add(locked ? 'on' : 'warn');
        clearTimeout(beatDotTimer);
        beatDotTimer = window.setTimeout(() => beatDot.classList.remove('on', 'warn'), 120);
      }
      if (msg.kind === 'inputs') {
        const { devices, selected } = payload as { devices: Array<{ id: string; label: string }>; selected: string };
        micDev.innerHTML = '';
        const def = document.createElement('option');
        def.value = 'default';
        def.textContent = 'Standard-Eingang';
        micDev.appendChild(def);
        for (const d of devices) {
          const opt = document.createElement('option');
          opt.value = d.id;
          opt.textContent = d.label;
          micDev.appendChild(opt);
        }
        micDev.value = selected;
        if (micDev.selectedIndex < 0) micDev.value = 'default';
      }
      if (msg.kind === 'song-ended') {
        if (activeIndex >= 0) songs[activeIndex].status = 'finished';
        renderSongs();
        // Auto-Next wie im Original — nächster Ordner, gewählte Version
        if (!nextSong()) setlistEnd = true;
        updateMeta();
      }
      if (msg.kind === 'error') {
        metaEl.textContent = (payload as { text: string }).text;
      }
    },
    onModeChange(mode: StationMode) {
      applyMode(mode);
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      clearTimeout(guardTimer);
      clearTimeout(lastSongTimer);
      leftResize.dispose();
      // Sprungmarken lagen evtl. unter der Vorschau → mit wegräumen
      markerBox.remove();
      const extra = document.getElementById('preview-extra');
      if (extra) extra.hidden = true;
    },
  };
}

/** Versions-Kürzel im Dateinamen: „Titel V2 - Interpret.lrc“,
 *  „Titel V4.1- Interpret.lrc“ — das Kürzel steht direkt vor dem Bindestrich */
const VERSION_RE = /\s+V(\d+(?:\.\d+)*)(?=\s*-\s*)/i;

/** Ordner-Daten aus dem Dateinamen: Basisname (ohne Kürzel), Key, Version */
function fromFileName(file: string): { group: string; base: string; version: string } {
  const stem = file.replace(/\.lrc$/i, '').trim();
  const m = stem.match(VERSION_RE);
  const version = m ? `V${m[1]}` : '';
  const base = (m ? stem.replace(VERSION_RE, '') : stem).replace(/\s*-\s*/, ' - ').trim();
  return { group: base.toLowerCase().replace(/\s+/g, ' '), base, version };
}

/** Reihenfolge im Ordner: Original, V2, V3 … V10 (numerisch, V4 < V4.1 < V5) */
function compareVersions(a: string, b: string): number {
  const num = (v: string) => (v ? v.slice(1).split('.').map(Number) : [-1]);
  const x = num(a);
  const y = num(b);
  for (let k = 0; k < Math.max(x.length, y.length); k++) {
    const d = (x[k] ?? -1) - (y[k] ?? -1);
    if (d) return d;
  }
  return 0;
}
