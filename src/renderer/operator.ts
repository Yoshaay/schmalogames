import { GameEntry, OperatorPanel, SettingDef } from './core/game';
import { games } from './games/registry';

const $ = (id: string) => document.getElementById(id)!;

let activeGameId: string | null = null;
// Spielspezifisches Operator-UI (GameEntry.buildOperatorPanel)
let gamePanel: OperatorPanel | null = null;

// ---------- Spiele-Liste ----------
const gamesEl = $('games');
for (const entry of games) {
  const btn = document.createElement('button');
  btn.className = 'game-btn';
  btn.dataset.id = entry.id;
  btn.textContent = entry.title;
  // Beschreibung nur als Tooltip — die Leiste bleibt kompakt
  if (entry.description) btn.title = entry.description;
  btn.onclick = () => window.bus.send({ type: 'start', gameId: entry.id });
  gamesEl.appendChild(btn);
}

// ---------- Sender-Modus: BAYERN 3 (alle Spiele) / BAYERN 1 (nur Schmalaoke) ----------
// Rein eine Operator-Ansichtssache: die Wall kennt keinen Modus. Beim
// Umschalten wird ein Spiel, das es im Zielmodus nicht gibt, gestoppt.
type StationMode = 'b3' | 'b1';
const MODE_GAMES: Record<StationMode, string[]> = {
  b3: games.map((g) => g.id),
  b1: ['schmalaoke'],
};
let mode: StationMode = localStorage.getItem('operator.mode') === 'b1' ? 'b1' : 'b3';

function applyMode(next: StationMode) {
  mode = next;
  localStorage.setItem('operator.mode', mode);
  // Wall färbt den 16:9-Rahmen passend (BAYERN 1 = Blau statt CI-Grün)
  window.bus.send({ type: 'mode', mode });
  document.body.classList.toggle('mode-b1', mode === 'b1');
  document.querySelectorAll<HTMLButtonElement>('#mode-switch button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  document.querySelectorAll<HTMLButtonElement>('.game-btn').forEach((btn) => {
    btn.hidden = !MODE_GAMES[mode].includes(btn.dataset.id!);
  });
  if (activeGameId && !MODE_GAMES[mode].includes(activeGameId)) {
    window.bus.send({ type: 'stop' });
  }
}
document.querySelectorAll<HTMLButtonElement>('#mode-switch button').forEach((btn) => {
  btn.onclick = () => applyMode(btn.dataset.mode as StationMode);
});
applyMode(mode);

$('stop').onclick = () => window.bus.send({ type: 'stop' });
$('fullscreen').onclick = () => window.bus.send({ type: 'wall-fullscreen' });
// Stanzmaske: Wall sendet die Alphamaske des laufenden Spiels statt der Grafik
// (Key-Abgriff für den Ü-Wagen). Zustand kommt über die State-Nachricht zurück.
let maskOn = false;
$('mask').onclick = () => window.bus.send({ type: 'mask', on: !maskOn });
// NDI-Framerate — Wert lebt (persistiert) im Wall-Fenster, State synct zurück
($('ndifps') as HTMLSelectElement).onchange = (e) =>
  window.bus.send({ type: 'ndi-fps', fps: Number((e.target as HTMLSelectElement).value) });

// ---------- Debug-Panel: Netz/NDI/Display-Infos für den Ü-Wagen-Test ----------
// Wird nur bei geöffnetem Panel gepollt (1×/s). Toggle über Button oder ⌘/Strg+D.
let debugTimer: ReturnType<typeof setInterval> | null = null;

function cls(ok: boolean, warn = false): string {
  return ok ? 'good' : warn ? 'warn' : 'bad';
}

function debugRow(k: string, v: string, c = ''): string {
  return `<div class="row"><span class="k">${escapeHtml(k)}</span><span class="v ${c}">${escapeHtml(v)}</span></div>`;
}

/** Adapter-Dropdown: Optionen nur neu bauen, wenn sich die IP-Liste ändert —
 *  das Panel rendert jede Sekunde, das Dropdown darf dabei nicht zuspringen */
let adapterOptionsKey = '';
function syncAdapterSelect(info: DebugInfo) {
  const sel = $('ndi-adapter') as HTMLSelectElement;
  const key = info.ips.map((ip) => `${ip.iface}=${ip.address}`).join(',');
  if (key !== adapterOptionsKey) {
    adapterOptionsKey = key;
    sel.innerHTML = '<option value="">Alle Adapter</option>';
    for (const ip of info.ips) {
      const opt = document.createElement('option');
      opt.value = ip.address;
      opt.textContent = `${ip.iface} · ${ip.address}`;
      sel.appendChild(opt);
    }
    // Gespeicherter Adapter, der gerade nicht existiert: trotzdem anzeigen
    if (info.ndiAdapter.setting && !info.ips.some((ip) => ip.address === info.ndiAdapter.setting)) {
      const opt = document.createElement('option');
      opt.value = info.ndiAdapter.setting;
      opt.textContent = `${info.ndiAdapter.setting} (nicht vorhanden)`;
      sel.appendChild(opt);
    }
  }
  if (document.activeElement !== sel) sel.value = info.ndiAdapter.setting;
  // Hinweis + Neustart-Button, sobald Einstellung und aktiver Wert auseinanderliegen
  $('ndi-adapter-hint').hidden = info.ndiAdapter.setting === info.ndiAdapter.active;
}
($('ndi-adapter') as HTMLSelectElement).onchange = async (e) => {
  await window.debug.setNdiAdapter((e.target as HTMLSelectElement).value);
  void renderDebug();
};
$('ndi-relaunch').onclick = () => window.debug.relaunch();

async function renderDebug() {
  const panel = $('debug-info');
  let info: DebugInfo;
  try {
    info = await window.debug.getInfo();
  } catch (err) {
    panel.innerHTML = `<div class="row"><span class="v bad">${escapeHtml(String(err))}</span></div>`;
    return;
  }
  syncAdapterSelect(info);
  const ndi = info.ndi;
  const fps = Number(($('ndifps') as HTMLSelectElement).value);
  // Erwarteter Quellenname, solange noch kein Sender angelegt ist (NDI nimmt
  // den Hostnamen in Großbuchstaben, ohne .local)
  const expectedSource = `${info.hostname.replace(/\.local$/i, '').toUpperCase()} (Schmalogames)`;
  const src = ndi.sources[0];

  let html = '<h3>NDI-Quelle</h3>';
  html += `<div class="big">${escapeHtml(src?.sourceName ?? expectedSource)}</div>`;
  const statusText =
    ndi.status === 'ok' ? `bereit · ${ndi.version}` : ndi.status === 'fehlt' ? `NICHT verfügbar: ${ndi.version}` : 'wartet auf ersten Frame';
  html += debugRow('Status', statusText, cls(ndi.status === 'ok', ndi.status === 'wartet'));
  if (src) {
    html += debugRow('Empfänger', String(src.connections), cls(src.connections > 0, true));
    html += debugRow('Tally', src.onProgram ? 'ON AIR' : src.onPreview ? 'PREVIEW' : 'keins', src.onProgram ? 'bad' : src.onPreview ? 'warn' : '');
    if (src.error) html += debugRow('Fehler', src.error, 'bad');
  }
  html += debugRow('Rate', `${ndi.sentFps} fps gesendet · ${fps} fps eingestellt`, cls(Math.abs(ndi.sentFps - fps) <= 2, ndi.sentFps > 0));
  if (ndi.droppedFps > 0) html += debugRow('Verworfen', `${ndi.droppedFps} fps (Sender zu langsam)`, 'warn');

  html += '<h3>Netzwerk</h3>';
  html += debugRow('Rechner', info.hostname);
  if (!info.ips.length) html += debugRow('IP', 'keine Verbindung', 'bad');
  const active = info.ndiAdapter.active;
  for (const ip of info.ips) {
    // Aktiver NDI-Adapter grün, die übrigen gedimmt, wenn einer gewählt ist
    const used = !active || ip.address === active;
    html += debugRow(ip.iface, `${ip.address}${used ? ' · NDI' : ''}`, used ? 'good' : '');
  }

  html += '<h3>Displays</h3>';
  for (const d of info.displays) {
    const tag = `${d.size} @ ${d.hz} Hz${d.scale !== 1 ? ` · ${d.scale}×` : ''}`;
    const label = `${d.internal ? 'intern' : d.label}${d.wall ? ' · WALL' : ''}`;
    // Krumme Teiler (z.B. 75 Hz bei 50 fps) juddern — nur zur Info
    const clean = d.hz > 0 && Math.abs((d.hz / fps) - Math.round(d.hz / fps)) < 0.02;
    html += debugRow(label, tag, d.wall ? cls(clean, true) : '');
  }
  html += debugRow('Wall-Vollbild', info.wallFullscreen ? 'ja' : 'nein');

  html += '<h3>App</h3>';
  html += debugRow('Version', `${info.app.version} · ${info.app.packaged ? 'gepackt' : 'dev'}`);
  html += debugRow('Electron', `${info.app.electron} · Node ${info.app.node} · ${info.app.arch}`);
  html += debugRow('System', info.app.platform);
  html += debugRow('Läuft seit', `${Math.floor(info.app.uptime / 60)} min ${info.app.uptime % 60} s`);
  html += '<div class="hint">Werte aktualisieren sich jede Sekunde. NDI-Quelle im Ü-Wagen: Name oben, IP bei Bedarf manuell im NDI Access Manager eintragen.</div>';
  panel.innerHTML = html;
}

function toggleDebug(force?: boolean) {
  const panel = $('debug-panel');
  // hidden ist in neueren DOM-Typen boolean | "until-found" — auf boolean normieren
  const open = force ?? panel.hidden !== false;
  panel.hidden = !open;
  $('debug').classList.toggle('debug-on', open);
  if (debugTimer) clearInterval(debugTimer);
  debugTimer = null;
  if (open) {
    void renderDebug();
    debugTimer = setInterval(() => void renderDebug(), 1000);
  }
}
$('debug').onclick = () => toggleDebug();
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === 'KeyD') {
    e.preventDefault();
    toggleDebug();
  }
});

// ---------- Live-Vorschau (WebRTC vom Wall-Fenster) ----------
let previewPC: RTCPeerConnection | null = null;
let previewPendingIce: RTCIceCandidateInit[] = [];
let previewRemoteSet = false;

async function acceptPreviewOffer(sdp: string) {
  previewPC?.close();
  previewPendingIce = [];
  previewRemoteSet = false;

  const pc = new RTCPeerConnection();
  previewPC = pc;
  pc.ontrack = (e) => {
    ($('preview') as HTMLVideoElement).srcObject = e.streams[0];
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) window.bus.send({ type: 'rtc-ice', candidate: e.candidate.toJSON() });
  };

  await pc.setRemoteDescription({ type: 'offer', sdp });
  previewRemoteSet = true;
  for (const c of previewPendingIce) pc.addIceCandidate(c).catch(() => {});
  previewPendingIce = [];

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  window.bus.send({ type: 'rtc-answer', sdp: answer.sdp });
}

// ---------- Einstellungen / Aktionen ----------
function entryById(id: string | null): GameEntry | null {
  return games.find((g) => g.id === id) ?? null;
}

function buildPanels(entry: GameEntry | null) {
  const settingsEl = $('settings');
  const actionsEl = $('actions');
  const liveEl = $('live');
  const livePanel = $('live-panel') as HTMLElement;
  const gameUiEl = $('game-ui');
  const gamePanelEl = $('game-panel') as HTMLElement;
  settingsEl.innerHTML = '';
  actionsEl.innerHTML = '';
  liveEl.innerHTML = '';
  livePanel.hidden = true;
  gamePanel?.dispose?.();
  gamePanel = null;
  gameUiEl.innerHTML = '';
  gamePanelEl.hidden = true;

  // Panel-Platzierung: Standard = linke Spalte unter der Vorschau,
  // 'sidebar' = eigene hochkante Spalte ganz links (Rundown-Stil)
  const sidebarCol = $('sidebar-col') as HTMLElement;
  const mainEl = document.querySelector('main')!;
  const useSidebar = !!entry?.buildOperatorPanel && entry.panelLayout === 'sidebar';
  if (useSidebar) {
    sidebarCol.appendChild(gamePanelEl);
  } else {
    // zurück an die Standardposition: vor dem Status-Panel
    const statusPanel = $('status').closest('.panel')!;
    statusPanel.parentElement!.insertBefore(gamePanelEl, statusPanel);
  }
  sidebarCol.hidden = !useSidebar;
  mainEl.classList.toggle('with-sidebar', useSidebar);

  // Rechte Spalte komplett ausblenden, wenn sie leer wäre (Spiel ohne
  // Regler und Aktionen, z.B. Schmalaoke) — der Platz geht ans Spiel-Panel.
  // Ohne aktives Spiel bleibt sie sichtbar (zeigt, wo Einstellungen landen).
  const faderDefs = (entry?.settings ?? []).filter((d) => d.variant === 'fader');
  const sliderDefs = (entry?.settings ?? []).filter((d) => d.variant !== 'fader');
  const hasSide = !entry || faderDefs.length > 0 || sliderDefs.length > 0 || (entry.actions ?? []).length > 0;
  const sideCol = document.querySelector<HTMLElement>('.col-side')!;
  sideCol.hidden = !hasSide;
  mainEl.classList.toggle('no-side', !hasSide);

  if (entry?.buildOperatorPanel) {
    gamePanelEl.hidden = false;
    $('game-panel-title').textContent = entry.title;
    gamePanel = entry.buildOperatorPanel(gameUiEl, {
      send: (payload) => window.bus.send({ type: 'game', payload }),
    });
  }

  if (!entry) {
    settingsEl.innerHTML = '<div class="hint">Spiel starten, um Einstellungen zu sehen.</div>';
    actionsEl.innerHTML = '<div class="hint">—</div>';
    return;
  }

  // Live-Fader bekommen ein eigenes Panel, der Rest wird zum normalen Slider
  livePanel.hidden = !faderDefs.length;
  for (const def of faderDefs) liveEl.appendChild(buildFader(def));

  for (const def of sliderDefs) {
    const wrap = document.createElement('div');
    wrap.className = 'setting';

    if (def.variant === 'toggle') {
      // An/Aus-Schalter: Label links, Switch rechts — Wert 0/1 wie ein Regler
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.textContent = def.label;
      const sw = document.createElement('button');
      sw.className = 'toggle';
      sw.dataset.key = def.key;
      sw.setAttribute('role', 'switch');
      setToggleView(sw, def.default > 0);
      sw.onclick = () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        setToggleView(sw, on);
        window.bus.send({ type: 'set', key: def.key, value: on ? 1 : 0 });
      };
      row.append(label, sw);
      wrap.append(row);
      settingsEl.appendChild(wrap);
      continue;
    }

    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.textContent = def.label;
    const val = document.createElement('span');
    val.className = 'val';
    val.dataset.key = def.key;
    row.append(label, val);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(def.min);
    slider.max = String(def.max);
    slider.step = String(def.step);
    slider.value = String(def.default);
    slider.dataset.key = def.key;
    slider.addEventListener('input', () => {
      const value = Number(slider.value);
      val.textContent = formatValue(value, def.unit);
      window.bus.send({ type: 'set', key: def.key, value });
    });
    // Nach dem Ziehen Fokus abgeben, damit State-Updates wieder durchkommen
    slider.addEventListener('change', () => slider.blur());

    val.textContent = formatValue(def.default, def.unit);
    wrap.append(row, slider);
    settingsEl.appendChild(wrap);
  }
  if (!sliderDefs.length) {
    settingsEl.innerHTML = '<div class="hint">Dieses Spiel hat keine Einstellungen.</div>';
  }

  (entry.actions ?? []).forEach((action, i) => {
    const btn = document.createElement('button');
    btn.className = 'btn-action';
    btn.dataset.actionIndex = String(i);
    // Hotkey-Hinweis: Tasten 1–9 feuern die Aktionen in Reihenfolge
    if (i < 9) {
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = String(i + 1);
      btn.appendChild(key);
    }
    btn.appendChild(document.createTextNode(action.label));
    btn.onclick = () => window.bus.send({ type: 'action', id: action.id });
    actionsEl.appendChild(btn);
  });
  if (!(entry.actions ?? []).length) {
    actionsEl.innerHTML = '<div class="hint">—</div>';
  }
}

/** Großer vertikaler Live-Fader (Pult-Optik) für Settings mit variant 'fader' */
function buildFader(def: SettingDef): HTMLElement {
  const root = document.createElement('div');
  root.className = 'fader';
  root.dataset.key = def.key;

  const val = document.createElement('div');
  val.className = 'fader-val';

  const scale = document.createElement('div');
  scale.className = 'fader-scale';
  for (let i = 4; i >= 0; i--) {
    const mark = document.createElement('span');
    mark.textContent = String(Math.round(def.min + ((def.max - def.min) / 4) * i));
    scale.appendChild(mark);
  }

  const track = document.createElement('div');
  track.className = 'fader-track';
  track.innerHTML =
    '<div class="fader-zones zones-hint"></div>' +
    '<div class="fader-zones zones-fill"></div>' +
    '<div class="fader-ticks"></div>' +
    '<div class="fader-grip"></div>';

  const body = document.createElement('div');
  body.className = 'fader-body';
  body.append(scale, track);

  const label = document.createElement('div');
  label.className = 'fader-label';
  label.textContent = def.label;

  root.append(val, body, label);
  setFaderView(root, def, def.default);

  // Pointer-Handler auf dem ganzen Fader-Body, nicht nur auf dem Track:
  // die Griffkappe steht am Anschlag zur Hälfte über den Track hinaus
  // (unten bei 0 %, oben bei 100 %) — dort muss sie trotzdem greifen.
  // Der Wert kommt immer aus der Track-Geometrie, geclampt auf 0..1.
  const apply = (e: PointerEvent) => {
    const r = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (r.bottom - e.clientY) / r.height));
    const value = Math.round((def.min + frac * (def.max - def.min)) / def.step) * def.step;
    setFaderView(root, def, value);
    window.bus.send({ type: 'set', key: def.key, value });
  };
  body.addEventListener('pointerdown', (e) => {
    root.dataset.dragging = '1';
    body.setPointerCapture(e.pointerId);
    apply(e);
  });
  body.addEventListener('pointermove', (e) => {
    if (root.dataset.dragging) apply(e);
  });
  const endDrag = () => {
    delete root.dataset.dragging;
  };
  body.addEventListener('pointerup', endDrag);
  body.addEventListener('pointercancel', endDrag);

  return root;
}

function setToggleView(sw: HTMLButtonElement, on: boolean) {
  sw.setAttribute('aria-checked', on ? 'true' : 'false');
  sw.textContent = on ? 'AN' : 'AUS';
}

function setFaderView(root: HTMLElement, def: SettingDef, value: number) {
  const pct = ((value - def.min) / (def.max - def.min)) * 100;
  root.querySelector<HTMLElement>('.fader-val')!.textContent = formatValue(value, def.unit);
  root.querySelector<HTMLElement>('.zones-fill')!.style.clipPath = `inset(${100 - pct}% 0 0 0)`;
  root.querySelector<HTMLElement>('.fader-grip')!.style.bottom = `${pct}%`;
}

function formatValue(value: number, unit?: string): string {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return unit ? `${text} ${unit}` : text;
}

// ---------- State vom Wall-Fenster ----------
interface StateMsg {
  type: 'state';
  gameId: string | null;
  settings: Record<string, number>;
  status: Record<string, string | number>;
  mask?: boolean;
  ndiFps?: number;
}

window.bus.onMessage((raw) => {
  const anyMsg = raw as {
    type: string;
    sdp?: string;
    candidate?: RTCIceCandidateInit;
    fullscreen?: boolean;
  };
  if (anyMsg.type === 'wall-ready') {
    // Wall-Fenster (neu) gestartet — Vorschau-Verbindung anfordern
    // und den aktuellen Sender-Modus mitgeben (Rahmenfarbe)
    window.bus.send({ type: 'preview-ready' });
    window.bus.send({ type: 'mode', mode });
    return;
  }
  if (anyMsg.type === 'rtc-offer' && anyMsg.sdp) {
    acceptPreviewOffer(anyMsg.sdp);
    return;
  }
  if (anyMsg.type === 'rtc-ice' && anyMsg.candidate) {
    if (previewPC && previewRemoteSet) previewPC.addIceCandidate(anyMsg.candidate).catch(() => {});
    else previewPendingIce.push(anyMsg.candidate);
    return;
  }
  if (anyMsg.type === 'game-event') {
    gamePanel?.onEvent?.((raw as { payload?: unknown }).payload);
    return;
  }
  if (anyMsg.type === 'hotkey') {
    fireHotkey((raw as { key: number }).key);
    return;
  }
  if (anyMsg.type === 'gamekey') {
    gamePanel?.onKey?.((raw as { code: string }).code);
    return;
  }
  if (anyMsg.type === 'ndi-tally') {
    const tally = (raw as { tally: Record<string, { onProgram: boolean; onPreview: boolean; connections: number }> })
      .tally;
    // Eine Quelle — erster (einziger) Eintrag im Tally-Snapshot
    const entry = Object.values(tally)[0];
    const tag = $('tag');
    const state = entry?.onProgram ? 'ON AIR' : entry?.onPreview ? 'PVW' : '';
    tag.textContent = `NDI${state ? ` · ${state}` : ''}${entry?.connections ? '' : ' · offline'}`;
    tag.classList.toggle('onair', entry?.onProgram === true);
    tag.classList.toggle('pvw', !entry?.onProgram && entry?.onPreview === true);
    return;
  }
  if (anyMsg.type === 'wall-fullscreen-state') {
    const btn = $('fullscreen') as HTMLButtonElement;
    btn.textContent = anyMsg.fullscreen ? 'Vollbild verlassen' : 'Wall-Vollbild';
    btn.classList.toggle('fullscreen-on', anyMsg.fullscreen === true);
    return;
  }

  const msg = raw as StateMsg;
  if (msg.type !== 'state') return;

  maskOn = msg.mask === true;
  const maskBtn = $('mask') as HTMLButtonElement;
  maskBtn.textContent = maskOn ? 'Stanzmaske AKTIV' : 'Stanzmaske';
  maskBtn.classList.toggle('mask-on', maskOn);

  const fpsSel = $('ndifps') as HTMLSelectElement;
  if (msg.ndiFps && document.activeElement !== fpsSel) fpsSel.value = String(msg.ndiFps);

  if (msg.gameId !== activeGameId) {
    activeGameId = msg.gameId;
    buildPanels(entryById(activeGameId));
  }

  // Aktives Spiel markieren
  document.querySelectorAll<HTMLButtonElement>('.game-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.id === activeGameId);
  });

  // Reglerwerte übernehmen (außer der Regler wird gerade bedient)
  const entry = entryById(activeGameId);
  for (const def of entry?.settings ?? []) {
    const value = msg.settings[def.key];
    if (value === undefined) continue;
    if (def.variant === 'fader') {
      const fader = document.querySelector<HTMLElement>(`.fader[data-key="${def.key}"]`);
      if (fader && !fader.dataset.dragging) setFaderView(fader, def, value);
      continue;
    }
    if (def.variant === 'toggle') {
      const sw = document.querySelector<HTMLButtonElement>(`.toggle[data-key="${def.key}"]`);
      if (sw) setToggleView(sw, value > 0);
      continue;
    }
    const slider = document.querySelector<HTMLInputElement>(`input[data-key="${def.key}"]`);
    const val = document.querySelector<HTMLElement>(`.val[data-key="${def.key}"]`);
    if (slider && document.activeElement !== slider) slider.value = String(value);
    if (val && document.activeElement !== slider) val.textContent = formatValue(value, def.unit);
  }

  // Status
  const statusEl = $('status');
  const entries = Object.entries(msg.status ?? {});
  if (!entries.length) {
    statusEl.innerHTML = '<div class="status-empty">Kein Spiel aktiv.</div>';
  } else {
    statusEl.innerHTML = entries
      .map(
        ([k, v]) =>
          `<div class="stat"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(String(v))}</div></div>`,
      )
      .join('');
  }
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------- Hotkeys: 1–9 feuern die Aktionen des aktiven Spiels ----------
// Die Tastendrücke fängt der Main-Prozess in BEIDEN Fenstern ab
// (before-input-event) und schickt sie als 'hotkey'-Nachricht hierher.
function fireHotkey(n: number) {
  const action = entryById(activeGameId)?.actions?.[n - 1];
  if (!action) {
    // Keine Aktion auf dieser Ziffer: ans Spiel-Panel durchreichen
    // (Schmalaoke nutzt 1–9 für Sprungmarken)
    gamePanel?.onKey?.(`Digit${n}`);
    return;
  }
  window.bus.send({ type: 'action', id: action.id });
  // Button aufblitzen lassen, damit man sieht, was gefeuert hat
  const btn = document.querySelector<HTMLButtonElement>(`.btn-action[data-action-index="${n - 1}"]`);
  if (btn) {
    btn.classList.remove('hit');
    void btn.offsetWidth;
    btn.classList.add('hit');
  }
}

// Sicherung: ein Datei-Drop irgendwo im Fenster darf NIE die Seite ersetzen
// (Panels wie Schmalaoke behandeln ihre Drop-Zonen selbst)
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Falls das Wall-Fenster schon läuft: Vorschau-Verbindung anfordern
window.bus.send({ type: 'preview-ready' });
