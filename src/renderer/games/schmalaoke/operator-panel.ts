import { OperatorPanel, OperatorPanelApi } from '../../core/game';
import { LRCParser } from './lrc-parser';

/**
 * Rundown + Presenter-Ansicht — portiert aus SchmalKaraoke_ALPHA
 * (src/rundown). Playlist-Verwaltung lebt hier im Panel; das Spiel im
 * Wall-Fenster bekommt beim Laden den LRC-Inhalt geschickt und meldet
 * seinen Presenter-State zurück.
 */

interface Song {
  name: string;
  content: string;
  title: string;
  artist: string;
  lines: string[];
  sections: Array<string | null>;
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
}

const STYLE = `
  /* Aufgeräumt wie das Original-Rundown: links die Setlist mit klaren,
     vollbreiten Buttons darunter, rechts der Presenter mit den Lyrics.
     Unten EINE Statuszeile statt verstreuter Hinweistexte. */
  .ka-root { display: flex; flex-direction: column; gap: 10px; height: 100%; }
  .ka-cols { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 16px; }
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
  .ka-song .warn { font-size: 11px; }
  /* Sortier-/Lösch-Buttons erst bei Hover — der Name bekommt die Breite
     (Umsortieren geht ohnehin auch per Drag & Drop) */
  .ka-song .ops { display: none; gap: 2px; }
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
  .ka-lyric .sec {
    font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.1em;
    color: var(--blue); margin-right: 8px; text-transform: uppercase;
  }
  .ka-meta { font-family: var(--font-mono); font-size: 11px; color: var(--ink-dim); }
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
          <div class="ka-head">Setlist</div>
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
          <div class="ka-head" title="Beats zählen die Zeilen weiter — braucht &lt;N&gt;-Tags in der LRC">Auto-Advance · Beat-Sync</div>
          <button data-id="auto" class="ka-btn-wide" title="Taste A schaltet um"><span class="ka-beat" data-id="beatdot"></span><span data-id="autolabel">Auto-Advance</span></button>
          <div class="ka-row">
            <select data-id="micdev" title="Audio-Eingang für die Beat-Erkennung">
              <option value="default">Standard-Eingang</option>
            </select>
            <input type="number" data-id="bpminput" min="40" max="240" placeholder="BPM"
              title="BPM fest eintippen (40–240, Enter setzt) — läuft ohne Mikro. Feld leeren oder Reset: zurück zur Erkennung">
            <span class="ka-meta" data-id="bpm">—</span>
            <button data-id="bpmreset" title="BPM zurücksetzen — Erkennung lockt neu ein">Reset</button>
          </div>
          <input type="file" accept=".lrc" multiple hidden>
          <input type="file" accept=".json" data-id="setlistfile" hidden>
        </div>
        <div class="ka-col">
          <div class="ka-head" title="Klick oder Ziffer armiert — Leertaste löst den Sprung aus">Sprungmarken</div>
          <div class="ka-markers" data-id="markers"></div>
          <div class="ka-lyrics" data-id="lyrics"></div>
        </div>
      </div>
      <div class="ka-status">
        <span data-id="meta">Kein Song geladen.</span>
        <span class="ka-keys"><kbd>Leertaste</kbd> weiter · <kbd>←</kbd> zurück · <kbd>R</kbd> Neustart · <kbd>1–9</kbd> Sprungmarke · <kbd>N</kbd> nächster Song</span>
      </div>
    </div>
  `;

  const q = (id: string) => container.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  const songsEl = q('songs');
  const lyricsEl = q('lyrics');
  const metaEl = q('meta');
  const fileInput = container.querySelector<HTMLInputElement>('input[type=file]')!;

  const songs: Song[] = [];
  let activeIndex = -1;
  let presenter: PresenterState | null = null;

  /** Song aus LRC-Inhalt bauen (Parse, Metadaten, Validierung) */
  function songFromContent(name: string, content: string, status: Song['status'] = 'planned'): Song {
    const p = new LRCParser();
    const ok = p.parseContent(content);
    return {
      name,
      content,
      title: p.metadata.ti || name.replace(/\.lrc$/i, ''),
      artist: p.metadata.ar || '',
      lines: ok ? [...p.lyricsLines] : [],
      sections: ok ? [...p.sections] : [],
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
      songs.push(songFromContent(file.name, await file.text()));
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
      songs: songs.map((s) => ({ name: s.name, content: s.content })),
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
        songs?: Array<{ name?: string; content?: string; filepath?: string }>;
      };
      if (data?.type !== 'schmalaoke-setlist' || !Array.isArray(data.songs)) throw new Error('kein Setlist-Format');
      if (!data.songs.every((s) => typeof s?.content === 'string')) {
        // v1 aus der Standalone-App referenziert nur Dateipfade — hier kein fs-Zugriff
        metaEl.textContent = 'Setlist aus der Standalone-App (nur Dateipfade) — bitte die LRC-Dateien direkt reinziehen.';
        return;
      }
      songs.length = 0;
      for (const s of data.songs) songs.push(songFromContent(String(s.name ?? 'Song.lrc'), s.content!));
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

  /* ---------- Drag & Drop: Songs umsortieren ---------- */
  let dragFrom = -1;

  function moveSongTo(from: number, insertAt: number) {
    // insertAt = Einfügeposition in der Liste VOR dem Entfernen
    const to = insertAt > from ? insertAt - 1 : insertAt;
    if (from === to) return;
    const [song] = songs.splice(from, 1);
    songs.splice(to, 0, song);
    if (activeIndex === from) activeIndex = to;
    else if (from < activeIndex && to >= activeIndex) activeIndex--;
    else if (from > activeIndex && to <= activeIndex) activeIndex++;
    renderSongs();
  }

  function loadSong(index: number) {
    const song = songs[index];
    if (!song || !song.lines.length) return;
    // vorherigen loaded-Song zurücksetzen (falls nicht schon gespielt)
    songs.forEach((s, i) => {
      if (i !== index && s.status === 'loaded') s.status = 'planned';
    });
    activeIndex = index;
    song.status = 'loaded';
    api.send({ cmd: 'song', name: song.name, content: song.content });
    renderSongs();
    renderMarkers();
    renderLyrics();
  }

  q('next').onclick = () => {
    if (activeIndex < songs.length - 1) {
      if (activeIndex >= 0) songs[activeIndex].status = 'finished';
      loadSong(activeIndex + 1);
    } else {
      api.send({ cmd: 'nextsong' });
    }
  };

  function renderSongs() {
    songsEl.innerHTML = '';
    if (!songs.length) {
      songsEl.innerHTML =
        '<div class="ka-empty"><b>Keine Songs in der Setlist</b>LRC-Dateien hierhin ziehen oder „+ Songs hinzufügen“</div>';
      return;
    }
    songs.forEach((song, i) => {
      const row = document.createElement('div');
      row.className = 'ka-song' + (i === activeIndex ? ' active' : '');

      // Umsortieren per Drag & Drop
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        dragFrom = i;
        row.classList.add('dragging');
        e.dataTransfer?.setData('text/plain', String(i));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => {
        dragFrom = -1;
        songsEl.querySelectorAll('.ka-song').forEach((r) => r.classList.remove('dragging', 'drop-above', 'drop-below'));
      });
      row.addEventListener('dragover', (e) => {
        if (dragFrom < 0) return; // Datei-Drags behandelt der Container
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const rect = row.getBoundingClientRect();
        const below = e.clientY > rect.top + rect.height / 2;
        row.classList.toggle('drop-above', !below);
        row.classList.toggle('drop-below', below);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
      row.addEventListener('drop', (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        e.stopPropagation(); // nicht als Datei-Drop im Container behandeln
        const rect = row.getBoundingClientRect();
        const below = e.clientY > rect.top + rect.height / 2;
        moveSongTo(dragFrom, below ? i + 1 : i);
        dragFrom = -1;
      });
      const dot = document.createElement('span');
      dot.className = `dot dot-${song.status}`;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = song.artist ? `${song.artist} – ${song.title}` : song.title;
      name.title = song.validation.warnings.join('\n') || song.name;
      row.append(dot, name);
      if (song.validation.level !== 'ok') {
        const warn = document.createElement('span');
        warn.className = 'warn';
        warn.textContent = song.validation.level === 'error' ? '🛑' : '⚠️';
        warn.title = song.validation.warnings.join('\n');
        row.appendChild(warn);
      }
      const ops = document.createElement('span');
      ops.className = 'ops';
      for (const [label, fn] of [
        ['↑', () => moveSong(i, -1)],
        ['↓', () => moveSong(i, 1)],
        ['✕', () => removeSong(i)],
      ] as Array<[string, () => void]>) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.onclick = (e) => {
          e.stopPropagation();
          fn();
        };
        ops.appendChild(btn);
      }
      row.appendChild(ops);
      row.onclick = () => loadSong(i);
      songsEl.appendChild(row);
    });
  }

  function moveSong(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= songs.length) return;
    [songs[i], songs[j]] = [songs[j], songs[i]];
    if (activeIndex === i) activeIndex = j;
    else if (activeIndex === j) activeIndex = i;
    renderSongs();
  }

  function removeSong(i: number) {
    songs.splice(i, 1);
    if (activeIndex === i) {
      activeIndex = -1;
      api.send({ cmd: 'reset' });
      presenter = null;
      renderMarkers();
      renderLyrics();
      metaEl.textContent = 'Kein Song geladen.';
    } else if (activeIndex > i) {
      activeIndex--;
    }
    renderSongs();
  }

  q('restart').onclick = () => api.send({ cmd: 'restart' });

  /* ---------- Auto-Advance ---------- */
  let autoOn = false;
  let beatDotTimer = -1;
  const autoBtn = q('auto') as HTMLButtonElement;
  const beatDot = q('beatdot');
  const bpmEl = q('bpm');
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

  q('bpmreset').onclick = () => {
    api.send({ cmd: 'bpmreset' });
    bpmInput.value = '';
    bpmEl.textContent = autoOn ? 'wartet auf 2× Leertaste' : '—';
    beatDot.classList.remove('on', 'warn');
  };

  function renderAuto() {
    q('autolabel').textContent = autoOn ? 'Auto-Advance: AN (A)' : 'Auto-Advance (A)';
    autoBtn.classList.toggle('armed', autoOn);
    if (!autoOn) {
      bpmEl.textContent = '—';
      beatDot.classList.remove('on', 'warn');
    } else {
      bpmEl.textContent = 'wartet auf 2× Leertaste';
    }
  }

  /** Sprungmarken ({Name}-Tags) als Chips — Klick/Ziffer armiert */
  function renderMarkers() {
    const markersEl = q('markers');
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
      el.appendChild(document.createTextNode(line || '···'));
      // Bewusst KEIN Klick auf Zeilen: das sah aus wie "ausgewählt", sprang
      // aber nicht — Sprünge laufen nur über die Marken-Chips / Ziffern
      lyricsEl.appendChild(el);
    });
  }

  /** Statuszeile unten: nur Zustand — Titel steht in Setlist & Status-Panel */
  function updateMeta() {
    if (!presenter || activeIndex < 0) return;
    const parts: string[] = [];
    if (presenter.ended) parts.push('Song beendet');
    else if (!presenter.started) parts.push('Bereit — Leertaste startet');
    else if (presenter.remaining >= 0) {
      const cls = presenter.remaining <= 5 ? 'rest-crit' : presenter.remaining <= 10 ? 'rest-warn' : '';
      parts.push(`<span class="${cls}">${presenter.remaining} Zeilen übrig</span>`);
    }
    if (presenter.pendingJump >= 0) parts.push(`<span class="rest-crit">Sprung armiert → Zeile ${presenter.pendingJump + 1} (Leertaste)</span>`);
    metaEl.innerHTML = parts.join(' · ');
  }

  /* ---------- Tastensteuerung (wie im Original-Player) ---------- */

  const KEY_MAP: Record<string, 'space' | 'prev' | 'nextsong' | 'restart' | 'auto'> = {
    Space: 'space',
    ArrowRight: 'space',
    ArrowDown: 'space',
    ArrowLeft: 'prev',
    ArrowUp: 'prev',
    KeyN: 'nextsong',
    // R = Neustart (MacBook-tauglich); Home bleibt für externe Tastaturen
    KeyR: 'restart',
    Home: 'restart',
    // A = Auto-Advance an/aus
    KeyA: 'auto',
  };

  function handleCode(code: string) {
    const digit = code.match(/^Digit([1-9])$/);
    if (digit) {
      armMarkerByDigit(Number(digit[1]));
      return;
    }
    const cmd = KEY_MAP[code];
    if (!cmd) return;
    if (cmd === 'nextsong') q('next').click();
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
        if (activeIndex >= 0 && presenter.started && songs[activeIndex].status !== 'playing') {
          songs[activeIndex].status = 'playing';
        }
        renderSongs();
        renderMarkers();
        renderLyrics();
        updateMeta();
        // aktive Zeile in Sicht halten
        lyricsEl.querySelector('.ka-lyric.current')?.scrollIntoView({ block: 'nearest' });
      }
      if (msg.kind === 'beat') {
        const { bpm, locked, manual, armed, spaces } = payload as {
          bpm: number;
          locked: boolean;
          manual?: boolean;
          armed?: boolean;
          spaces?: number;
        };
        const bpmTxt = bpm > 0 ? `${Math.round(bpm)} BPM${manual ? ' fix' : ''}` : '';
        const left = 2 - (spaces ?? 0);
        bpmEl.textContent = !armed
          ? `${bpmTxt ? bpmTxt + ' · ' : ''}wartet auf ${left}× Leertaste`
          : locked
            ? `${bpmTxt} · Auto fährt`
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
        // Auto-Next wie im Original
        if (activeIndex < songs.length - 1) loadSong(activeIndex + 1);
      }
      if (msg.kind === 'error') {
        metaEl.textContent = (payload as { text: string }).text;
      }
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
    },
  };
}
