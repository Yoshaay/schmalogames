// Vom Preload-Skript (src/main/preload.ts) bereitgestellte Brücke
// zwischen den Renderer-Fenstern und dem Main-Prozess.
interface Bus {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
}

declare interface Window {
  bus: Bus;
}
