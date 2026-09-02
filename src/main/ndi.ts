/**
 * NDI-Ausgabe (Main-Prozess): nimmt RGBA-Frames mit Alphakanal aus dem
 * Wall-Renderer entgegen und schickt sie als benannte NDI-Quelle(n) ins
 * Netz — der Ü-Wagen holt sich Fill+Key in einem Stream.
 *
 * Ausgelegt auf N parallele Streams: jeder Frame trägt einen Stream-Namen,
 * Sender werden beim ersten Frame eines Namens angelegt. Aktuell gibt es
 * genau eine Quelle ("Schmalogames") — beide Videowalls zeigen dasselbe.
 */

// Frame, wie ihn der Renderer über IPC anliefert (Kanal 'ndi-frame')
export interface NdiFrame {
  /** Stream-Name — erscheint im Netz als "RECHNERNAME (name)" */
  stream: string;
  width: number;
  height: number;
  /** Nominelle Framerate des Streams (für die NDI-Metadaten) */
  fps: number;
  /** RGBA, straight alpha (Canvas getImageData) — wird hier premultipliziert */
  data: ArrayBuffer;
}

/** Tally-Zustand einer NDI-Quelle, wie ihn die Empfänger zurückmelden */
export interface NdiTallyState {
  onProgram: boolean;
  onPreview: boolean;
  connections: number;
}

// grandi ist ESM-only und lädt native Addons — bleibt deshalb external
// (nicht ins CJS-Bundle). Electron 36 (Node 22) kann ESM per require() laden.
import type { Grandi, Sender } from 'grandi';

export class NdiOutput {
  private grandi: Grandi | null = null;
  private loadFailed = false;
  private senders = new Map<string, Sender>();
  /** Namen, für die gerade ein Sender angelegt oder ein Frame gesendet wird —
   *  neue Frames werden solange verworfen (droppen statt stauen) */
  private busy = new Set<string>();
  /** Nach einem Fehler: pro Stream erst nach dieser Pause wieder versuchen —
   *  sonst hämmert der 30fps-Frametakt Fehlversuche und flutet das Log
   *  (z.B. wenn eine zweite App-Instanz die NDI-Namen belegt hält) */
  private static readonly RETRY_MS = 5000;
  private retryAt = new Map<string, number>();
  private warned = new Set<string>();

  /** Tally-Rückkanal: NDI-Empfänger melden pro Quelle, ob sie bei ihnen auf
   *  Programm (on air) oder Preview liegt. Wird gepollt und bei Änderung
   *  über den Callback gemeldet (→ Anzeige im Operator). */
  onTally: ((tally: Record<string, NdiTallyState>) => void) | null = null;
  private tallyTimer: ReturnType<typeof setInterval> | null = null;
  private lastTallyJson = '';

  private startTallyPolling() {
    if (this.tallyTimer) return;
    this.tallyTimer = setInterval(() => {
      const snapshot: Record<string, NdiTallyState> = {};
      for (const [name, sender] of this.senders) {
        try {
          const t = sender.tally();
          snapshot[name] = {
            onProgram: t.onProgram,
            onPreview: t.onPreview,
            connections: sender.connections(),
          };
        } catch {}
      }
      const json = JSON.stringify(snapshot);
      if (json !== this.lastTallyJson) {
        this.lastTallyJson = json;
        this.onTally?.(snapshot);
      }
    }, 300);
  }

  private load(): Grandi | null {
    if (this.grandi || this.loadFailed) return this.grandi;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('grandi') as { default?: Grandi };
      this.grandi = (mod.default ?? (mod as unknown)) as Grandi;
      if (!this.grandi.isSupportedCPU()) throw new Error('CPU nicht unterstützt');
      console.log(`NDI bereit: ${this.grandi.version()}`);
    } catch (err) {
      // Ohne NDI läuft die App normal weiter (Fenster-Ausgabe als Fallback)
      this.loadFailed = true;
      console.warn('NDI-Ausgabe nicht verfügbar:', (err as Error).message);
    }
    return this.grandi;
  }

  async pushFrame(frame: NdiFrame) {
    const grandi = this.load();
    if (!grandi) return;
    if (this.busy.has(frame.stream)) return; // Sender hängt noch am letzten Frame
    const retryAt = this.retryAt.get(frame.stream);
    if (retryAt && Date.now() < retryAt) return; // Fehler-Backoff läuft noch

    this.busy.add(frame.stream);
    try {
      let sender = this.senders.get(frame.stream);
      if (!sender) {
        // clockVideo aus: der Renderer taktet die Frames schon (rAF, 30fps)
        sender = await grandi.send({ name: frame.stream, clockVideo: false });
        this.senders.set(frame.stream, sender);
        console.log(`NDI-Quelle angelegt: ${sender.sourceName()}`);
        this.startTallyPolling();
      }
      const data = Buffer.from(frame.data);
      premultiplyAlpha(data);
      await sender.video({
        xres: frame.width,
        yres: frame.height,
        frameRateN: frame.fps > 0 ? frame.fps : 30,
        frameRateD: 1,
        pictureAspectRatio: frame.width / frame.height,
        fourCC: grandi.FourCC.RGBA,
        frameFormatType: grandi.FrameType.Progressive,
        lineStrideBytes: frame.width * 4,
        data,
      });
      // Erfolg: Backoff und Warnstatus zurücksetzen
      if (this.retryAt.delete(frame.stream)) {
        console.log(`NDI-Quelle wieder da: ${frame.stream}`);
      }
      this.warned.delete(frame.stream);
    } catch (err) {
      this.retryAt.set(frame.stream, Date.now() + NdiOutput.RETRY_MS);
      if (!this.warned.has(frame.stream)) {
        this.warned.add(frame.stream);
        console.warn(
          `NDI-Fehler (${frame.stream}): ${(err as Error).message} — neuer Versuch alle ${NdiOutput.RETRY_MS / 1000} s (still). Läuft evtl. eine zweite Instanz der App?`,
        );
      }
    } finally {
      this.busy.delete(frame.stream);
    }
  }

  destroy() {
    if (this.tallyTimer) clearInterval(this.tallyTimer);
    this.tallyTimer = null;
    for (const sender of this.senders.values()) sender.destroy();
    this.senders.clear();
  }
}

/** NDI erwartet premultiplied Alpha; Canvas liefert straight Alpha.
 *  In-place-Konvertierung — die allermeisten Pixel sind voll deckend oder
 *  voll transparent, nur Kanten/Effekte landen im teuren Zweig. */
function premultiplyAlpha(buf: Buffer) {
  for (let i = 0; i < buf.length; i += 4) {
    const a = buf[i + 3];
    if (a === 255) continue;
    if (a === 0) {
      buf[i] = 0;
      buf[i + 1] = 0;
      buf[i + 2] = 0;
      continue;
    }
    buf[i] = (buf[i] * a + 127) / 255;
    buf[i + 1] = (buf[i + 1] * a + 127) / 255;
    buf[i + 2] = (buf[i + 2] * a + 127) / 255;
  }
}
