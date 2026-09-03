// Vom Preload-Skript (src/main/preload.ts) bereitgestellte Brücke
// zwischen den Renderer-Fenstern und dem Main-Prozess.
interface Bus {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
}

interface NdiBridge {
  /** RGBA-Frame (straight alpha) als NDI-Stream rausgeben; data = width*height*4 Bytes */
  sendFrame(frame: { stream: string; width: number; height: number; fps: number; data: ArrayBuffer }): void;
}

interface DebugInfo {
  hostname: string;
  ips: { iface: string; address: string }[];
  ndi: {
    status: 'ok' | 'fehlt' | 'wartet';
    version: string;
    sources: {
      name: string;
      sourceName: string;
      connections: number;
      onProgram: boolean;
      onPreview: boolean;
      error: string;
    }[];
    sentFps: number;
    droppedFps: number;
  };
  /** NDI-Adapterwahl: setting = gespeichert, active = beim Start angewendet ('' = alle) */
  ndiAdapter: { setting: string; active: string };
  displays: { id: number; label: string; size: string; hz: number; scale: number; internal: boolean; wall: boolean }[];
  wallFullscreen: boolean;
  app: {
    version: string;
    packaged: boolean;
    electron: string;
    node: string;
    arch: string;
    platform: string;
    uptime: number;
  };
}

interface DebugBridge {
  getInfo(): Promise<DebugInfo>;
  /** NDI auf einen Adapter (IPv4) beschränken, '' = alle; greift nach Neustart */
  setNdiAdapter(adapter: string): Promise<string>;
  relaunch(): void;
}

declare interface Window {
  bus: Bus;
  ndi: NdiBridge;
  debug: DebugBridge;
}
