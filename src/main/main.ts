import { app, BrowserWindow, globalShortcut, ipcMain, systemPreferences } from 'electron';
import * as path from 'node:path';

let wall: BrowserWindow | null = null;
let operator: BrowserWindow | null = null;

function createWindows() {
  const preload = path.join(__dirname, 'preload.js');
  const rendererDir = path.join(__dirname, '../renderer');

  // Cleanfeed für die Videowall — zeigt nur das finale Bild
  wall = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload },
  });
  wall.loadFile(path.join(rendererDir, 'wall.html'));

  // Steuerung für den Operator
  operator = new BrowserWindow({
    width: 1150,
    height: 800,
    backgroundColor: '#0e0f13',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload },
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

  wall.on('closed', () => {
    wall = null;
  });
  operator.on('closed', () => {
    operator = null;
  });
}

// Nachrichten zwischen Operator- und Wall-Fenster vermitteln
ipcMain.on('msg', (event, msg: { type?: string }) => {
  if (msg?.type === 'wall-fullscreen') {
    wall?.setFullScreen(!wall.isFullScreen());
    return;
  }
  const target = event.sender === wall?.webContents ? operator : wall;
  if (target && !target.isDestroyed()) target.webContents.send('msg', msg);
});

app.whenReady().then(async () => {
  // macOS: Mikrofon-Berechtigung anfragen (für das Applausometer)
  if (process.platform === 'darwin') {
    await systemPreferences.askForMediaAccess('microphone');
  }

  createWindows();

  // F11: Wall-Vollbild togglen
  globalShortcut.register('F11', () => {
    if (wall) wall.setFullScreen(!wall.isFullScreen());
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
