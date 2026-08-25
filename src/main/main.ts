import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import { NdiOutput, NdiFrame } from './ndi';

let wall: BrowserWindow | null = null;
let operator: BrowserWindow | null = null;
const ndi = new NdiOutput();

function createWindows() {
  const preload = path.join(__dirname, 'preload.js');
  const rendererDir = path.join(__dirname, '../renderer');

  // Cleanfeed für die Anlieferung — volles FHD-Bild 16:9 (1920×1080), Wall-Bereich mittig
  wall = new BrowserWindow({
    width: 960,
    height: 540,
    // 960×540 (16:9) soll der INHALT sein (sonst klaut die Titelleiste Höhe → Letterbox-Balken)
    useContentSize: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    // backgroundThrottling: false — SHOW-KRITISCH: sonst friert Chromium den
    // rAF-Loop (und damit das Spiel + die Vorschau) ein, sobald das Fenster
    // komplett verdeckt oder minimiert ist
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload, backgroundThrottling: false },
  });
  // Beim manuellen Resizen 16:9 halten — im Fenstermodus keine schwarzen Balken
  wall.setAspectRatio(16 / 9);
  wall.loadFile(path.join(rendererDir, 'wall.html'));

  // Steuerung für den Operator
  operator = new BrowserWindow({
    width: 1150,
    height: 800,
    backgroundColor: '#0e0f13',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload, backgroundThrottling: false },
  });
  operator.loadFile(path.join(rendererDir, 'operator.html'));

  if (process.argv.includes('--dev')) {
    wall.webContents.openDevTools({ mode: 'detach' });
    operator.webContents.openDevTools({ mode: 'detach' });
  }

  // Vollbild-Status der Wall an den Operator melden
  const sendFullscreenState = () => {
    if (operator && !operator.isDestroyed()) {
      operator.webContents.send('msg', {
        type: 'wall-fullscreen-state',
        fullscreen: wall?.isFullScreen() ?? false,
      });
    }
  };
  wall.on('enter-full-screen', sendFullscreenState);
  wall.on('leave-full-screen', sendFullscreenState);
  operator.webContents.on('did-finish-load', sendFullscreenState);

  // Hotkeys 1–9 (Spiel-Aktionen) und F11 (Wall-Vollbild) funktionieren in
  // beiden Fenstern — egal, welches gerade den Fokus hat. Bewusst per
  // before-input-event statt globalShortcut: der würde SYSTEMWEIT feuern,
  // auch wenn eine ganz andere App den Fokus hat.
  for (const win of [wall, operator]) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      if (input.key === 'F11') {
        wall?.setFullScreen(!wall.isFullScreen());
        return;
      }
      if (input.control || input.meta || input.alt) return;
      if (!/^[1-9]$/.test(input.key)) return;
      if (operator && !operator.isDestroyed()) {
        operator.webContents.send('msg', { type: 'hotkey', key: Number(input.key) });
      }
    });
  }

  // Spiel-Tasten (z.B. Schmalaoke: Space/Pfeile/N/Home, Groove: T) auch bei
  // fokussierter WALL abfangen und ans Operator-Panel weiterreichen. Nur von
  // der Wall — im Operator übernimmt der lokale Handler (kennt Eingabefelder
  // & Buttons).
  const GAME_KEYS = new Set(['Space', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'KeyN', 'KeyT', 'Home']);
  wall.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    if (input.control || input.meta || input.alt) return;
    if (!GAME_KEYS.has(input.code)) return;
    if (operator && !operator.isDestroyed()) {
      operator.webContents.send('msg', { type: 'gamekey', code: input.code });
    }
  });

  wall.on('closed', () => {
    wall = null;
  });
  operator.on('closed', () => {
    operator = null;
  });
}

// NDI: RGBA-Frames (mit Alpha) aus dem Wall-Renderer ins Netz senden.
// Eigener Kanal — die Frames sind groß (~9 MB) und sollen nicht durch
// die 'msg'-Vermittlung laufen.
ipcMain.on('ndi-frame', (_event, frame: NdiFrame) => {
  void ndi.pushFrame(frame);
});

// Nachrichten zwischen Operator- und Wall-Fenster vermitteln
ipcMain.on('msg', (event, msg: { type?: string }) => {
  if (msg?.type === 'wall-fullscreen') {
    wall?.setFullScreen(!wall.isFullScreen());
    return;
  }
  const target = event.sender === wall?.webContents ? operator : wall;
  if (target && !target.isDestroyed()) target.webContents.send('msg', msg);
});

// Nur EINE Instanz: eine zweite würde sich mit der ersten um die
// NDI-Sendernamen prügeln (NDI erlaubt pro Rechner nur eine Quelle je Name)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Doppelstart: vorhandene Fenster nach vorn holen statt neu zu starten
    operator?.focus();
  });
  app.whenReady().then(() => {
    createWindows();
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  ndi.destroy();
});
