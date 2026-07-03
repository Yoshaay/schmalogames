import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bus', {
  send: (msg: unknown) => ipcRenderer.send('msg', msg),
  onMessage: (cb: (msg: unknown) => void) => {
    ipcRenderer.on('msg', (_event, msg) => cb(msg));
  },
});
