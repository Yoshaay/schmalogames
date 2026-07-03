import { GameEntry } from './core/game';
import { games } from './games/registry';

const $ = (id: string) => document.getElementById(id)!;

let activeGameId: string | null = null;

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
  settingsEl.innerHTML = '';
  actionsEl.innerHTML = '';

  if (!entry) {
    settingsEl.innerHTML = '<div class="hint">Spiel starten, um Einstellungen zu sehen.</div>';
    actionsEl.innerHTML = '<div class="hint">—</div>';
    return;
  }

  for (const def of entry.settings ?? []) {
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
  if (!(entry.settings ?? []).length) {
    settingsEl.innerHTML = '<div class="hint">Dieses Spiel hat keine Einstellungen.</div>';
  }

  for (const action of entry.actions ?? []) {
    const btn = document.createElement('button');
    btn.className = 'btn-action';
    btn.textContent = action.label;
    btn.onclick = () => window.bus.send({ type: 'action', id: action.id });
    actionsEl.appendChild(btn);
  }
  if (!(entry.actions ?? []).length) {
    actionsEl.innerHTML = '<div class="hint">—</div>';
  }
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

// Falls das Wall-Fenster schon läuft: Vorschau-Verbindung anfordern
window.bus.send({ type: 'preview-ready' });
