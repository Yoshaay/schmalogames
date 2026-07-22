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
}

const STYLE = `
  /* Hochkant-Layout (Sidebar links, wie das Original-Rundown): alles untereinander */
  .ka-cols { display: flex; flex-direction: column; gap: 16px; }
  .ka-col { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
  .ka-markers { display: flex; flex-wrap: wrap; gap: 6px; }
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
    text-transform: uppercase; color: var(--ink-dim);
  }
  .ka-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .ka-row button { padding: 7px 10px; font-size: 12px; }
  .ka-row button.primary { color: var(--primary); border-color: rgba(148, 192, 28, 0.4); font-weight: 600; }
  .ka-list, .ka-lyrics {
    background: #101218; border: 1px solid var(--panel-edge); border-radius: 4px;
    overflow-y: auto;
  }
  .ka-list { max-height: 24vh; min-height: 90px; }
  .ka-lyrics { max-height: 38vh; min-height: 160px; }
  .ka-song {
    display: flex; align-items: center; gap: 8px; padding: 7px 10px;
    border-bottom: 1px solid #1a1d26; cursor: pointer; font-size: 13px;
  }
  .ka-song:hover { background: #171a22; }
  .ka-song.active { background: rgba(148, 192, 28, 0.1); }
  .ka-song .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .dot-planned { background: #3a3e4c; }
  .dot-loaded { background: #f9b233; }
  .dot-playing { background: #9be600; }
  .dot-finished { background: #2699d6; }
  .ka-song .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ka-song .warn { font-size: 11px; }
  .ka-song .ops { display: flex; gap: 2px; }
  .ka-song .ops button { padding: 2px 7px; font-size: 11px; }
  .ka-lyric {
    padding: 4px 10px; font-size: 12px; color: var(--ink-dim);
    border-left: 3px solid transparent; cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .ka-lyric:hover { background: #171a22; }
  .ka-lyric.current { color: #ffffff; border-left-color: var(--primary); background: rgba(148, 192, 28, 0.08); }
  .ka-lyric.armed { color: var(--live); border-left-color: var(--live); }
  .ka-lyric .sec {
    font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.1em;
    color: var(--blue); margin-right: 8px; text-transform: uppercase;
  }
  .ka-meta { font-family: var(--font-mono); font-size: 11px; color: var(--ink-dim); }
  .ka-meta .rest-warn { color: #f9b233; }
  .ka-meta .rest-crit { color: var(--live); }
  .ka-row select {
    font-family: var(--font-mono); font-size: 11px; color: var(--ink);
    background: #1d2029; border: 1px solid var(--panel-edge); border-radius: 4px;
    padding: 7px 8px; max-width: 190px;
  }
  .ka-row button.armed { color: var(--live); border-color: rgba(231, 29, 115, 0.5); }
  .ka-beat {
    width: 12px; height: 12px; border-radius: 50%; background: #3a3e4c;
    display: inline-block; align-self: center; transition: background 0.05s;
  }
  .ka-beat.on { background: var(--primary); box-shadow: 0 0 10px rgba(148, 192, 28, 0.8); }
`;

export function buildSchmalaokePanel(container: HTMLElement, api: OperatorPanelApi): OperatorPanel {
  if (!document.getElementById('ka-style')) {
    const style = document.createElement('style');
    style.id = 'ka-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  container.innerHTML = `
    <div class="ka-cols">
      <div class="ka-col">
        <div class="ka-head">Setlist</div>
        <div class="ka-row">
          <button data-id="add" class="primary">+ LRC-Dateien</button>
          <button data-id="next" title="Taste N">Nächster Song ⏭</button>
        </div>
        <div class="ka-list" data-id="songs"></div>
        <input type="file" accept=".lrc" multiple hidden>
      </div>
      <div class="ka-col">
        <div class="ka-head">Presenter</div>
        <div class="ka-meta" data-id="meta">Kein Song geladen.</div>
        <div class="ka-row">
          <button data-id="space" class="primary" title="Leertaste">▶ Start / Weiter</button>
          <button data-id="prev" title="Pfeil links">⏴ Zurück</button>
          <button data-id="restart" title="Home">↺ Neustart</button>
        </div>
        <div class="ka-head">Auto-Advance <span style="text-transform:none;letter-spacing:0">— Beats zählen Zeilen weiter (&lt;N&gt;-Tags)</span></div>
        <div class="ka-row">
          <button data-id="auto">Auto: AUS</button>
          <select data-id="micdev" title="Audio-Eingang für die Beat-Erkennung">
            <option value="default">Standard-Eingang</option>
          </select>
          <span class="ka-beat" data-id="beatdot"></span>
          <span class="ka-meta" data-id="bpm" style="align-self:center">—</span>
        </div>
        <div class="ka-head">Sprungmarken <span style="text-transform:none;letter-spacing:0">— Klick oder Ziffer armiert, Leertaste springt</span></div>
        <div class="ka-markers" data-id="markers"></div>
        <div class="ka-lyrics" data-id="lyrics"></div>
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

  /* ---------- Playlist ---------- */

  q('add').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    for (const file of Array.from(fileInput.files ?? [])) {
      const content = await file.text();
      const p = new LRCParser();
      const ok = p.parseContent(content);
      songs.push({
        name: file.name,
        content,
        title: p.metadata.ti || file.name.replace(/\.lrc$/i, ''),
        artist: p.metadata.ar || '',
        lines: ok ? [...p.lyricsLines] : [],
        sections: ok ? [...p.sections] : [],
        validation: ok ? p.validate() : { level: 'error', warnings: ['Keine Lyrics gefunden'] },
        status: 'planned',
      });
    }
    fileInput.value = '';
    renderSongs();
  };

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
      songsEl.innerHTML = '<div class="ka-lyric">Noch keine Songs — „+ LRC-Dateien“.</div>';
      return;
    }
    songs.forEach((song, i) => {
      const row = document.createElement('div');
      row.className = 'ka-song' + (i === activeIndex ? ' active' : '');
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

  /* ---------- Presenter ---------- */

  q('space').onclick = () => api.send({ cmd: 'space' });
  q('prev').onclick = () => api.send({ cmd: 'prev' });
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

  function renderAuto() {
    autoBtn.textContent = autoOn ? 'Auto: AN' : 'Auto: AUS';
    autoBtn.classList.toggle('armed', autoOn);
    if (!autoOn) {
      bpmEl.textContent = '—';
      beatDot.classList.remove('on');
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
      el.title = 'Klick: Sprung armieren — Leertaste löst aus';
      el.onclick = () => api.send({ cmd: 'jump', index: i });
      lyricsEl.appendChild(el);
    });
  }

  function updateMeta() {
    if (!presenter || activeIndex < 0) return;
    const parts: string[] = [];
    parts.push(presenter.artist ? `${presenter.artist} – ${presenter.title}` : presenter.title);
    if (presenter.started && !presenter.ended && presenter.remaining >= 0) {
      const cls = presenter.remaining <= 5 ? 'rest-crit' : presenter.remaining <= 10 ? 'rest-warn' : '';
      parts.push(`<span class="${cls}">${presenter.remaining} Zeilen übrig</span>`);
    }
    if (presenter.ended) parts.push('Song beendet');
    if (presenter.pendingJump >= 0) parts.push(`<span class="rest-crit">Sprung armiert → Zeile ${presenter.pendingJump + 1} (Space)</span>`);
    metaEl.innerHTML = parts.join(' · ');
  }

  /* ---------- Tastensteuerung (wie im Original-Player) ---------- */

  const KEY_MAP: Record<string, 'space' | 'prev' | 'nextsong' | 'restart'> = {
    Space: 'space',
    ArrowRight: 'space',
    ArrowDown: 'space',
    ArrowLeft: 'prev',
    ArrowUp: 'prev',
    KeyN: 'nextsong',
    Home: 'restart',
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
        if (activeIndex >= 0 && presenter.started) songs[activeIndex].status = 'playing';
        renderSongs();
        renderMarkers();
        renderLyrics();
        updateMeta();
        // aktive Zeile in Sicht halten
        lyricsEl.querySelector('.ka-lyric.current')?.scrollIntoView({ block: 'nearest' });
      }
      if (msg.kind === 'beat') {
        const { bpm } = payload as { bpm: number };
        bpmEl.textContent = bpm > 0 ? `${Math.round(bpm)} BPM` : 'lauscht …';
        beatDot.classList.add('on');
        clearTimeout(beatDotTimer);
        beatDotTimer = window.setTimeout(() => beatDot.classList.remove('on'), 120);
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
