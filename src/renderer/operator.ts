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
  btn.textContent = `▶ ${entry.title}`;
  btn.onclick = () => window.bus.send({ type: 'start', gameId: entry.id });
  gamesEl.appendChild(btn);
  if (entry.description) {
    const desc = document.createElement('div');
    desc.className = 'game-desc';
    desc.textContent = entry.description;
    gamesEl.appendChild(desc);
  }
}

$('stop').onclick = () => window.bus.send({ type: 'stop' });
$('fullscreen').onclick = () => window.bus.send({ type: 'wall-fullscreen' });
// Debug-Werkzeug in der Kopfzeile — bewusst kein Hotkey, weit weg von den Show-Buttons
$('syncdebug').onclick = () => window.bus.send({ type: 'action', id: 'syncdebug' });

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
  const faderDefs = (entry.settings ?? []).filter((d) => d.variant === 'fader');
  const sliderDefs = (entry.settings ?? []).filter((d) => d.variant !== 'fader');
  livePanel.hidden = !faderDefs.length;
  for (const def of faderDefs) liveEl.appendChild(buildFader(def));

  for (const def of sliderDefs) {
    const wrap = document.createElement('div');
    wrap.className = 'setting';

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

  const apply = (e: PointerEvent) => {
    const r = track.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (r.bottom - e.clientY) / r.height));
    const value = Math.round((def.min + frac * (def.max - def.min)) / def.step) * def.step;
    setFaderView(root, def, value);
    window.bus.send({ type: 'set', key: def.key, value });
  };
  track.addEventListener('pointerdown', (e) => {
    root.dataset.dragging = '1';
    track.setPointerCapture(e.pointerId);
    apply(e);
  });
  track.addEventListener('pointermove', (e) => {
    if (root.dataset.dragging) apply(e);
  });
  const endDrag = () => {
    delete root.dataset.dragging;
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  return root;
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
}

window.bus.onMessage((raw) => {
  const anyMsg = raw as { type: string; sdp?: string; candidate?: RTCIceCandidateInit; fullscreen?: boolean };
  if (anyMsg.type === 'wall-ready') {
    // Wall-Fenster (neu) gestartet — Vorschau-Verbindung anfordern
    window.bus.send({ type: 'preview-ready' });
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
  if (anyMsg.type === 'wall-fullscreen-state') {
    const btn = $('fullscreen') as HTMLButtonElement;
    btn.textContent = anyMsg.fullscreen ? 'Vollbild verlassen ⛶' : 'Wall-Vollbild ⛶';
    btn.classList.toggle('fullscreen-on', anyMsg.fullscreen === true);
    return;
  }

  const msg = raw as StateMsg;
  if (msg.type !== 'state') return;

  if (msg.gameId !== activeGameId) {
    activeGameId = msg.gameId;
    buildPanels(entryById(activeGameId));
  }

  // Aktives Spiel markieren + ON-AIR-Anzeige
  document.querySelectorAll<HTMLButtonElement>('.game-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.id === activeGameId);
  });
  const onair = $('onair');
  onair.classList.toggle('live', activeGameId !== null);
  $('onair-label').textContent = activeGameId ? 'ON AIR' : 'STANDBY';

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
  if (!action) return;
  window.bus.send({ type: 'action', id: action.id });
  // Button aufblitzen lassen, damit man sieht, was gefeuert hat
  const btn = document.querySelector<HTMLButtonElement>(`.btn-action[data-action-index="${n - 1}"]`);
  if (btn) {
    btn.classList.remove('hit');
    void btn.offsetWidth;
    btn.classList.add('hit');
  }
}

// Falls das Wall-Fenster schon läuft: Vorschau-Verbindung anfordern
window.bus.send({ type: 'preview-ready' });
