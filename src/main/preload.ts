import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bus', {
  send: (msg: unknown) => ipcRenderer.send('msg', msg),
  onMessage: (cb: (msg: unknown) => void) => {
    ipcRenderer.on('msg', (_event, msg) => cb(msg));
  },
});

// NDI-Ausgabe: Wall-Renderer schiebt RGBA-Frames (mit Alpha) zum Main-Prozess
contextBridge.exposeInMainWorld('ndi', {
  sendFrame: (frame: { stream: string; width: number; height: number; fps: number; data: ArrayBuffer }) =>
    ipcRenderer.send('ndi-frame', frame),
});

// Debug-Panel: Momentaufnahme aus dem Main-Prozess (IPs, NDI-Quelle, Displays)
contextBridge.exposeInMainWorld('debug', {
  getInfo: () => ipcRenderer.invoke('debug-info'),
});
