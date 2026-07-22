import { OperatorPanel, OperatorPanelApi } from '../../core/game';

/** Live-Daten vom Spiel (Schmalogroove.sendTick) */
interface Tick {
  kind: 'tick';
  playing: boolean;
  usingMic: boolean;
  hasTrack: boolean;
  trackName: string;
  pos: number;
  dur: number;
  bpm: number;
  conf: number;
  manual: boolean;
  move: string;
}

const STYLE = `
  .gr-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
  .gr-row button { padding: 8px 12px; font-size: 13px; }
  .gr-row button.armed { color: var(--live); border-color: rgba(231, 29, 115, 0.5); }
  @keyframes gr-taphit { 0% { background: var(--primary); color: #111; } 100% { background: transparent; } }
  .gr-row button.hit { animation: gr-taphit 0.15s ease; }
  .gr-row select {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--ink);
    background: #1d2029;
    border: 1px solid var(--panel-edge);
    border-radius: 4px;
    padding: 8px 10px;
    max-width: 220px;
  }
  .gr-bpm { margin-left: auto; display: flex; align-items: baseline; gap: 10px; }
  .gr-bpm-num { font-family: var(--font-mono); font-size: 34px; font-weight: 700; color: var(--primary); font-variant-numeric: tabular-nums; }
  .gr-bpm-num.searching { color: var(--ink-dim); }
  .gr-bpm-sub { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-dim); }
  .gr-meta { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 6px; font-family: var(--font-mono); font-size: 11px; color: var(--ink-dim); }
  .gr-meta .gr-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gr-wave { position: relative; height: 52px; background: #101218; border: 1px solid var(--panel-edge); border-radius: 4px; cursor: pointer; touch-action: none; }
  .gr-wave canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
`;

export function buildGroovePanel(container: HTMLElement, api: OperatorPanelApi): OperatorPanel {
  if (!document.getElementById('gr-style')) {
    const style = document.createElement('style');
    style.id = 'gr-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  container.innerHTML = `
    <div class="gr-row">
      <button data-id="load">Track laden</button>
      <button data-id="play" disabled>Play</button>
      <button data-id="mic">Mikro</button>
      <select data-id="micdev" title="Audio-Eingang für den Mikro-Modus">
        <option value="default">Standard-Eingang</option>
      </select>
      <button data-id="tap" title="Tap-Tempo — Taste T">Tap</button>
      <button data-id="auto" disabled title="Zurück zur automatischen Erkennung">Auto</button>
      <div class="gr-bpm">
        <span class="gr-bpm-num searching" data-id="bpm">—</span>
        <span class="gr-bpm-sub" data-id="sub">warte auf Beat</span>
      </div>
    </div>
    <div class="gr-meta">
      <span class="gr-name" data-id="name">Kein Track geladen — Audiodatei laden oder Mikro starten.</span>
      <span data-id="time">0:00 / 0:00</span>
    </div>
    <div class="gr-wave" data-id="wave"><canvas></canvas></div>
    <input type="file" accept="audio/*" hidden>
  `;

  const q = (id: string) => container.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
  const btnPlay = q('play') as HTMLButtonElement;
  const btnMic = q('mic') as HTMLButtonElement;
  const btnTap = q('tap') as HTMLButtonElement;
  const btnAuto = q('auto') as HTMLButtonElement;
  const bpmNum = q('bpm');
  const bpmSub = q('sub');
  const nameEl = q('name');
  const timeEl = q('time');
  const waveWrap = q('wave');
  const waveC = waveWrap.querySelector('canvas')!;
  const fileInput = container.querySelector<HTMLInputElement>('input[type=file]')!;

  let last: Tick | null = null;
  let peaks: number[] | null = null;
  let dragging = false;
  let dragFrac = 0;
  /** kurzzeitiger Hinweistext, überdeckt die Track-Zeile */
  let hint: string | null = null;
  let hintUntil = 0;

  /* ---------- Transport ---------- */
  q('load').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    nameEl.textContent = 'Übertrage & dekodiere …';
    const data = await file.arrayBuffer();
    api.send({ cmd: 'load', name: file.name, data });
    fileInput.value = '';
  };
  btnPlay.onclick = () => api.send({ cmd: last?.playing ? 'pause' : 'play' });
  btnMic.onclick = () => api.send({ cmd: 'mic' });
  btnAuto.onclick = () => api.send({ cmd: 'auto' });

  // Audio-Eingang fürs Mikro wählen — Liste kommt aus dem Wall-Fenster
  const micDev = q('micdev') as unknown as HTMLSelectElement;
  micDev.onchange = () => {
    api.send({ cmd: 'micdev', id: micDev.value });
    // Auswahl alleine startet nichts — freundlich dran erinnern
    if (!last?.usingMic) {
      hint = 'Eingang gewählt — „Mikro“ drücken, um ihn zu starten';
      hintUntil = Date.now() + 5000;
    }
  };

  const tap = () => {
    api.send({ cmd: 'tap' });
    btnTap.classList.remove('hit');
    void btnTap.offsetWidth; // Animation neu triggern
    btnTap.classList.add('hit');
  };
  btnTap.onclick = tap;
  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'KeyT' && !e.repeat && (e.target as HTMLElement).tagName !== 'INPUT') tap();
  };
  window.addEventListener('keydown', onKey);

  /* ---------- Waveform + Seek ---------- */
  const waveFrac = (ev: PointerEvent) => {
    const r = waveC.getBoundingClientRect();
    return Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
  };
  waveWrap.addEventListener('pointerdown', (ev) => {
    if (!last?.hasTrack || last.usingMic) return;
    dragging = true;
    dragFrac = waveFrac(ev);
    waveWrap.setPointerCapture(ev.pointerId);
    drawWave();
  });
  waveWrap.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    dragFrac = waveFrac(ev);
    drawWave();
  });
  waveWrap.addEventListener('pointerup', (ev) => {
    if (!dragging) return;
    dragging = false;
    api.send({ cmd: 'seek', frac: waveFrac(ev) }); // erst beim Loslassen wirklich seeken
  });
  waveWrap.addEventListener('pointercancel', () => {
    dragging = false;
  });

  function fmtTime(s: number): string {
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function drawWave() {
    const w = waveC.clientWidth * 2;
    const h = waveC.clientHeight * 2;
    if (!w) return;
    if (waveC.width !== w) {
      waveC.width = w;
      waveC.height = h;
    }
    const c = waveC.getContext('2d')!;
    c.clearRect(0, 0, w, h);
    if (!peaks || !last?.hasTrack) return;
    const frac = dragging ? dragFrac : last.dur > 0 ? last.pos / last.dur : 0;
    const n = peaks.length;
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const bh = Math.max(2, peaks[i] * (h - 10));
      c.fillStyle = i / n < frac ? '#94c01c' : '#3a3f4a'; // gespielt = grün
      c.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw * 0.6), bh);
    }
    c.fillStyle = '#e71d73'; // Playhead
    c.fillRect(w * frac - 1, 0, 3, h);
  }

  /* ---------- Live-Daten vom Spiel ---------- */
  function onTick(t: Tick) {
    last = t;
    btnPlay.disabled = !t.hasTrack || t.usingMic;
    btnPlay.textContent = t.playing && !t.usingMic ? 'Pause' : 'Play';
    btnMic.textContent = t.usingMic ? 'Mikro aus' : 'Mikro';
    btnMic.classList.toggle('armed', t.usingMic);
    btnAuto.disabled = !t.manual;
    btnTap.classList.toggle('armed', t.manual);

    if (t.bpm > 0) {
      bpmNum.textContent = String(Math.round(t.bpm));
      bpmNum.classList.remove('searching');
      bpmSub.textContent = t.manual ? 'manuell' : 'locked · ' + Math.round(t.conf * 100) + '%';
    } else {
      bpmNum.textContent = '—';
      bpmNum.classList.add('searching');
      bpmSub.textContent = t.playing ? 'lerne…' : 'warte auf Beat';
    }

    if (hint && Date.now() < hintUntil) nameEl.textContent = hint;
    else if (t.usingMic) nameEl.textContent = 'Mikrofon live';
    else if (t.hasTrack) nameEl.textContent = t.trackName;
    else nameEl.textContent = 'Kein Track geladen — Audiodatei laden oder Mikro starten.';
    timeEl.textContent = t.hasTrack ? `${fmtTime(dragging ? dragFrac * t.dur : t.pos)} / ${fmtTime(t.dur)}` : '—';

    drawWave();
  }

  // Falls das Spiel schon läuft (Panel neu aufgebaut): Waveform-Daten anfordern
  api.send({ cmd: 'hello' });

  return {
    onEvent(payload: unknown) {
      const msg = payload as { kind?: string };
      if (msg.kind === 'tick') onTick(payload as Tick);
      if (msg.kind === 'peaks') {
        peaks = (payload as { peaks: number[] }).peaks;
        drawWave();
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
      if (msg.kind === 'error') nameEl.textContent = (payload as { text: string }).text;
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
    },
  };
}
