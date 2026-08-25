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

declare interface Window {
  bus: Bus;
  ndi: NdiBridge;
}
