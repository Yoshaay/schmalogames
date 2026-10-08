/**
 * Show-Schublade im Operator (F auf/zu, Esc zu): globale Kommentare
 * („TANZGOTT“, Freitext …, core/cheer.ts) und Effekte (Konfetti, …,
 * core/fx.ts), die der Host über jedes laufende Spiel legt.
 * Kommentar-Liste ist bearbeitbar und wird gespeichert, die Tasten ⇧1–⇧9
 * sind pro Kommentar frei belegbar; ⇧0 blendet aus, derselbe Kommentar
 * nochmal = vorzeitig aus.
 * Effekte auf ⇧Q/⇧W/⇧E. Alle Hotkeys gehen auch bei zugeklappter Schublade.
 */

const $ = (id: string) => document.getElementById(id)!;

/** Startliste = die bisherigen Auszeichnungen aus dem Tanzspiel */
const DEFAULT_LIST = ['TANZGOTT', 'GROOVE-LEGENDE', 'TANZMASCHINE', 'DISCO-FIEBER'];
const LIST_KEY = 'cheers.list';
const DUR_KEY = 'cheers.duration';

/** Ein Kommentar mit frei belegbarer Taste (1–9 = ⇧1–⇧9, null = keine) */
interface Cheer {
  text: string;
  key: number | null;
}

function loadList(): Cheer[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LIST_KEY) ?? 'null');
    if (Array.isArray(raw)) {
      const used = new Set<number>();
      return raw.flatMap((e, i): Cheer[] => {
        // altes Format (reine Strings): Taste = Listenplatz
        const item = typeof e === 'string' ? { text: e, key: i < 9 ? i + 1 : null } : e;
        if (typeof item?.text !== 'string') return [];
        let key = Number.isInteger(item.key) && item.key >= 1 && item.key <= 9 ? (item.key as number) : null;
        if (key !== null && used.has(key)) key = null;
        if (key !== null) used.add(key);
        return [{ text: item.text, key }];
      });
    }
  } catch {}
  return DEFAULT_LIST.map((text, i) => ({ text, key: i + 1 }));
}

let list = loadList();
let editing = false;
/** Text, der gerade auf der Wall steht (kommt mit dem Wall-State) */
let onWall: string | null = null;

const listEl = $('cheer-list');
const textEl = $('cheer-text') as HTMLInputElement;
const durEl = $('cheer-dur') as HTMLSelectElement;
durEl.value = localStorage.getItem(DUR_KEY) ?? '5';
durEl.onchange = () => localStorage.setItem(DUR_KEY, durEl.value);

function saveList() {
  localStorage.setItem(LIST_KEY, JSON.stringify(list));
}

/** Kleinste freie Taste für einen neuen Eintrag (null = alle belegt) */
function freeKey(): number | null {
  for (let k = 1; k <= 9; k++) if (!list.some((c) => c.key === k)) return k;
  return null;
}

function show(text: string, color: number) {
  if (!text.trim()) return;
  window.bus.send({ type: 'cheer', text, color, duration: Number(durEl.value) });
}

function hide() {
  window.bus.send({ type: 'cheer', text: '' });
}

function render() {
  listEl.innerHTML = '';
  $('cheer-edit').textContent = editing ? 'FERTIG' : 'BEARBEITEN';
  if (editing) {
    list.forEach((cheer, i) => {
      const row = document.createElement('div');
      row.className = 'cheer-edit-row';
      // Taste wählen — ist sie schon vergeben, verliert der andere Eintrag sie
      const keySel = document.createElement('select');
      keySel.title = 'Hotkey';
      keySel.innerHTML =
        '<option value="">–</option>' + Array.from({ length: 9 }, (_, k) => `<option value="${k + 1}">⇧${k + 1}</option>`).join('');
      keySel.value = cheer.key ? String(cheer.key) : '';
      keySel.onchange = () => {
        const key = keySel.value ? Number(keySel.value) : null;
        if (key !== null) for (const other of list) if (other.key === key) other.key = null;
        cheer.key = key;
        saveList();
        render();
      };
      const input = document.createElement('input');
      input.type = 'text';
      input.value = cheer.text;
      input.spellcheck = false;
      input.oninput = () => {
        cheer.text = input.value;
        saveList();
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') input.blur();
      };
      const del = document.createElement('button');
      del.textContent = '×';
      del.title = 'Entfernen';
      del.onclick = () => {
        list.splice(i, 1);
        saveList();
        render();
      };
      row.append(keySel, input, del);
      listEl.appendChild(row);
    });
    const add = document.createElement('button');
    add.textContent = '+ Kommentar';
    add.style.gridColumn = '1 / -1';
    add.onclick = () => {
      list.push({ text: '', key: freeKey() });
      saveList();
      render();
      listEl.querySelector<HTMLInputElement>('.cheer-edit-row:last-of-type input')?.focus();
    };
    listEl.appendChild(add);
    return;
  }
  // Anzeige nach Taste sortiert (⇧1 zuerst), Einträge ohne Taste ans Ende
  const order = list
    .map((cheer, i) => ({ cheer, i }))
    .filter(({ cheer }) => cheer.text.trim())
    .sort((a, b) => (a.cheer.key ?? 99) - (b.cheer.key ?? 99) || a.i - b.i);
  for (const { cheer, i } of order) {
    const btn = document.createElement('button');
    btn.className = 'btn-cheer';
    btn.dataset.index = String(i);
    btn.title = cheer.text;
    if (cheer.key) {
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = `⇧${cheer.key}`;
      btn.appendChild(key);
    }
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = cheer.text;
    btn.appendChild(label);
    btn.onclick = () => show(cheer.text, i);
    listEl.appendChild(btn);
  }
  markOnWall();
}

/** Button des Kommentars hervorheben, der gerade auf der Wall steht */
function markOnWall() {
  listEl.querySelectorAll<HTMLButtonElement>('.btn-cheer').forEach((btn) => {
    const text = list[Number(btn.dataset.index)]?.text ?? '';
    btn.classList.toggle('on', onWall !== null && text.trim().toUpperCase() === onWall);
  });
}

$('cheer-edit').onclick = () => {
  editing = !editing;
  // Leere Einträge beim Verlassen des Bearbeitens wegräumen
  if (!editing) {
    list = list.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text);
    saveList();
  }
  render();
};
$('cheer-send').onclick = () => show(textEl.value, 0);
textEl.onkeydown = (e) => {
  if (e.key === 'Enter') show(textEl.value, 0);
  if (e.key === 'Escape') textEl.blur();
};
$('cheer-off').onclick = hide;

render();

/** Wall-State: welcher Kommentar gerade läuft */
export function setCheerOnWall(text: string | null) {
  if (text === onWall) return;
  onWall = text;
  markOnWall();
}

/** ⇧1–⇧9 = Kommentar mit dieser Taste, ⇧0 = aus (Main relayt aus beiden Fenstern) */
export function fireCheerHotkey(n: number) {
  if (n === 0) {
    hide();
    return;
  }
  const i = list.findIndex((c) => c.key === n);
  if (i < 0 || !list[i].text.trim()) return;
  show(list[i].text, i);
  const btn = listEl.querySelector<HTMLButtonElement>(`.btn-cheer[data-index="${i}"]`);
  if (btn) {
    btn.classList.remove('hit');
    void btn.offsetWidth;
    btn.classList.add('hit');
  }
}

/* ---------- Effekte ---------- */
/** Hotkey-Reihenfolge = Reihenfolge der Buttons (⇧Q, ⇧W, ⇧E) */
export const FX_KEYS = ['KeyQ', 'KeyW', 'KeyE'];

function fireFx(btn: HTMLButtonElement) {
  window.bus.send({ type: 'fx', id: btn.dataset.fx });
  btn.classList.remove('hit');
  void btn.offsetWidth;
  btn.classList.add('hit');
}
const fxButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.btn-fx'));
for (const btn of fxButtons) btn.onclick = () => fireFx(btn);

/** ⇧Q/⇧W/⇧E (Main relayt aus beiden Fenstern) */
export function fireFxHotkey(code: string) {
  const btn = fxButtons[FX_KEYS.indexOf(code)];
  if (btn) fireFx(btn);
}

/* ---------- Schublade ---------- */
const drawer = $('show-drawer');

/** Schublade beginnt direkt unter der Kopfzeile */
function placeDrawer() {
  const header = document.querySelector('header')!;
  document.body.style.setProperty('--drawer-top', `${header.getBoundingClientRect().bottom}px`);
}
window.addEventListener('resize', placeDrawer);

export function toggleShowDrawer(force?: boolean) {
  const open = force ?? !document.body.classList.contains('show-open');
  placeDrawer();
  document.body.classList.toggle('show-open', open);
  drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
  // Fokus nicht in der zugeklappten Schublade lassen (sonst schluckt das
  // Freitextfeld weiter die Tasten)
  if (!open && drawer.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
}
$('show-toggle').onclick = () => toggleShowDrawer();

/** Layout-Info vom Operator: Spiel aktiv? Vorschau rechts (Sidebar-Layout)
 *  → Schublade kommt von links, damit die Vorschau sichtbar bleibt */
export function setShowContext(gameActive: boolean, drawerLeft: boolean) {
  $('show-hint').hidden = gameActive;
  document.body.classList.toggle('drawer-left', drawerLeft);
}
