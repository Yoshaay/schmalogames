import { Game, GameContext, GameEntry, SettingValues, StationMode, VIEW_W, VIEW_H } from './game';
import { Input } from './input';

/** Ausgabeformat: normales FHD-Signal 16:9 (1920×1080) für die
 *  Anlieferung — der Ü-Wagen croppt sich den Wall-Ausschnitt selbst raus. */
export const OUT_W = 1920;
export const OUT_H = 1080;

/** Nutzbild im FHD-Frame: die 10:16-View (1200×1920) auf 640×1024
 *  skaliert, mittig platziert. Drumherum liegt die 675×1080-Zone (volle
 *  Signalhöhe), links und rechts davon CI-Grün — der Ü-Wagen croppt exakt
 *  das 640×1024-Nutzbild auf die großen Walls, die Backstage-9:16-Walls
 *  zeigen den vollen Frame und damit Grün statt Schwarz außenrum. */
const CONTENT_W = 640;
const CONTENT_H = 1024;
const CONTENT_X = (OUT_W - CONTENT_W) / 2;
const CONTENT_Y = (OUT_H - CONTENT_H) / 2;
/** Grüne 675×1080-Zone um das Nutzbild (das, was die Walls croppen) */
const WALL_W = 675;
const WALL_H = 1080;
const WALL_X = Math.round((OUT_W - WALL_W) / 2);
const WALL_Y = Math.round((OUT_H - WALL_H) / 2);
/** CI-Grün der Umrandung (alles außerhalb der 675×1080-Zone) — BAYERN 3 */
const FRAME_GREEN = '#94c01c';
/** Name der NDI-Quelle — erscheint im Netz als "RECHNERNAME (Schmalogames)" */
const NDI_STREAM = 'Schmalogames';
/** Umrandung im BAYERN-1-Modus (Sender-Umschalter im Operator) */
const FRAME_BLUE = '#00a0d5';
/** Ring zwischen 675×1080-Zone und Nutzbild — showfertig in der Frame-Farbe.
 *  (Zum Einmessen des Crops den zweiten fillRect in composite() testweise
 *  auf Rot stellen: sobald Rot im gecroppten Bild auftaucht, sitzt der
 *  Crop daneben.) */

/**
 * Läuft im Wall-Fenster (Cleanfeed). Besitzt Canvas und Game-Loop.
 * Gesteuert wird ausschließlich über Nachrichten aus dem Operator-Fenster:
 * start / stop / set (Einstellung) / action.
 */
export class GameHost {
  /** Sichtbarer Canvas im Wall-Fenster (HDMI-Fallback) */
  private g: CanvasRenderingContext2D;
  /** Offscreen-View, in die das Game in seiner virtuellen Auflösung rendert.
   *  Beide Videowalls zeigen dasselbe Bild — es gibt nur EINEN Stream. */
  private view = document.createElement('canvas');
  private vg: CanvasRenderingContext2D;
  /** Fertig komponiertes 16:9-Anlieferungsbild — Quelle für den NDI-Stream,
   *  die Vorschau und das Fenster */
  private out = document.createElement('canvas');
  private og: CanvasRenderingContext2D;
  /** Offscreen für die Stanzmaske (weiße Silhouette der Game-Grafik) */
  private maskCanvas = document.createElement('canvas');
  private mg: CanvasRenderingContext2D;
  /** Stanzmasken-Modus: statt des Nutzbilds geht die Alphamaske raus —
   *  Weiß = Grafik, Schwarz = Live-Bild. Der Ü-Wagen greift sich die Maske
   *  als Key ab; danach wieder ausschalten. Startet pro Spiel immer AUS. */
  private maskMode = false;
  /** NDI: Drossel-Akku — das Spiel rendert mit Display-Refresh (meist 60),
   *  ins Netz geht die eingestellte NDI-Rate */
  private ndiAccum = 0;
  /** NDI-Framerate (Operator-einstellbar, persistiert). Obergrenze ist der
   *  Display-Refresh (rAF); krumme Teiler davon juddern minimal — das
   *  glättet der Frame-Sync im Empfänger. */
  private ndiFps = 30;
  /** Sender-Modus vom Operator — bestimmt die Rahmenfarbe und geht per
   *  setStationMode() an das laufende Spiel. Aus localStorage vorbelegt
   *  (gleiche Origin wie das Operator-Fenster), damit ein Wall-Neustart
   *  nicht kurz im falschen Modus hochkommt. */
  private stationMode: StationMode = localStorage.getItem('operator.mode') === 'b1' ? 'b1' : 'b3';
  private input = new Input(window);
  private current: Game | null = null;
  private entry: GameEntry | null = null;
  private values: SettingValues = {};
  private lastTime = 0;
  private stateTimer = 0;

  // Live-Vorschau: der Canvas wird per WebRTC als Videostream
  // ans Operator-Fenster gestreamt (Signaling über den Nachrichtenkanal)
  private previewPC: RTCPeerConnection | null = null;
  private rtcPendingIce: RTCIceCandidateInit[] = [];
  private rtcRemoteSet = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private games: GameEntry[],
  ) {
    canvas.width = OUT_W;
    canvas.height = OUT_H;
    this.g = canvas.getContext('2d')!;
    this.g.imageSmoothingQuality = 'high';
    this.view.width = VIEW_W;
    this.view.height = VIEW_H;
    this.vg = this.view.getContext('2d')!;
    this.out.width = OUT_W;
    this.out.height = OUT_H;
    // willReadFrequently: der NDI-Abgriff liest das Composite 25–60×/s
    // per getImageData — ohne den Hint wäre das jedes Mal ein GPU-Readback
    this.og = this.out.getContext('2d', { willReadFrequently: true })!;
    this.og.imageSmoothingQuality = 'high';
    this.maskCanvas.width = VIEW_W;
    this.maskCanvas.height = VIEW_H;
    this.mg = this.maskCanvas.getContext('2d')!;

    const savedFps = Number(localStorage.getItem('ndi.fps'));
    if (savedFps > 0) this.ndiFps = savedFps;

    window.addEventListener('resize', () => this.fitCanvas());
    this.fitCanvas();

    window.bus.onMessage((msg) => this.handleMessage(msg as { type: string; [k: string]: unknown }));
    this.sendState();
    // Falls das Operator-Fenster schon lauscht: Vorschau-Verbindung anstoßen
    window.bus.send({ type: 'wall-ready' });
  }

  private fitCanvas() {
    const scale = Math.min(window.innerWidth / OUT_W, window.innerHeight / OUT_H);
    this.canvas.style.width = `${OUT_W * scale}px`;
    this.canvas.style.height = `${OUT_H * scale}px`;
  }

  private handleMessage(msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case 'start': {
        const entry = this.games.find((e) => e.id === msg.gameId);
        if (entry) this.startGame(entry);
        break;
      }
      case 'stop':
        this.stopGame();
        break;
      case 'set': {
        if (!this.entry) break;
        this.values[msg.key as string] = msg.value as number;
        this.saveValues();
        this.current?.applySettings?.(this.values);
        break;
      }
      case 'action':
        this.current?.action?.(msg.id as string);
        break;
      case 'mask':
        this.maskMode = msg.on === true;
        break;
      case 'ndi-fps': {
        const fps = Number(msg.fps);
        if (fps > 0) {
          this.ndiFps = fps;
          localStorage.setItem('ndi.fps', String(fps));
        }
        break;
      }
      case 'mode':
        // Sender-Umschalter im Operator: BAYERN 1 färbt den 16:9-Rahmen
        // blau, und das laufende Spiel darf sein Layout anpassen
        this.stationMode = msg.mode === 'b1' ? 'b1' : 'b3';
        this.current?.setStationMode?.(this.stationMode);
        break;
      case 'game':
        // Nachricht vom spielspezifischen Operator-Panel
        this.current?.onMessage?.(msg.payload);
        break;
      case 'preview-ready':
        this.startPreviewStream();
        break;
      case 'rtc-answer': {
        const pc = this.previewPC;
        if (!pc) break;
        pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp as string })
          .then(() => {
            this.rtcRemoteSet = true;
            for (const c of this.rtcPendingIce) pc.addIceCandidate(c).catch(() => {});
            this.rtcPendingIce = [];
          })
          .catch(() => {});
        break;
      }
      case 'rtc-ice': {
        const candidate = msg.candidate as RTCIceCandidateInit;
        if (this.previewPC && this.rtcRemoteSet) {
          this.previewPC.addIceCandidate(candidate).catch(() => {});
        } else {
          this.rtcPendingIce.push(candidate);
        }
        break;
      }
    }
    this.sendState();
  }

  /** Baut die WebRTC-Verbindung zum Operator-Fenster (neu) auf */
  private async startPreviewStream() {
    this.previewPC?.close();
    this.rtcPendingIce = [];
    this.rtcRemoteSet = false;

    const pc = new RTCPeerConnection();
    this.previewPC = pc;

    // Das Anlieferungsbild als Video-Track
    const stream = this.out.captureStream(30);
    for (const track of stream.getTracks()) pc.addTrack(track, stream);

    pc.onicecandidate = (e) => {
      if (e.candidate) window.bus.send({ type: 'rtc-ice', candidate: e.candidate.toJSON() });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    window.bus.send({ type: 'rtc-offer', sdp: offer.sdp });
  }

  private loadValues(entry: GameEntry): SettingValues {
    const values: SettingValues = {};
    for (const def of entry.settings ?? []) values[def.key] = def.default;
    try {
      const raw = localStorage.getItem(`settings.${entry.id}`);
      if (raw) Object.assign(values, JSON.parse(raw));
    } catch {}
    // Transiente Werte starten immer auf default
    for (const def of entry.settings ?? []) {
      if (def.transient) values[def.key] = def.default;
    }
    return values;
  }

  /** Persistiert die aktuellen Werte — ohne transiente (z.B. Live-Fader) */
  private saveValues() {
    if (!this.entry) return;
    const persist: SettingValues = {};
    for (const def of this.entry.settings ?? []) {
      if (!def.transient && this.values[def.key] !== undefined) persist[def.key] = this.values[def.key];
    }
    localStorage.setItem(`settings.${this.entry.id}`, JSON.stringify(persist));
  }

  private makeContext(): GameContext {
    return {
      input: this.input,
      exit: () => this.stopGame(),
      setSetting: (key, value) => {
        this.values[key] = value;
        this.saveValues();
        this.current?.applySettings?.(this.values);
        this.sendState();
      },
      sendToOperator: (payload) => {
        window.bus.send({ type: 'game-event', payload });
      },
    };
  }

  private startGame(entry: GameEntry) {
    this.current?.dispose?.();
    // Show-Sicherheit: die Maske nie versehentlich in den Spielstart mitnehmen
    this.maskMode = false;
    this.entry = entry;
    this.values = this.loadValues(entry);
    this.current = entry.create();
    this.current.init(this.makeContext());
    this.current.setStationMode?.(this.stationMode);
    this.current.applySettings?.(this.values);
  }

  private stopGame() {
    this.current?.dispose?.();
    this.current = null;
    this.entry = null;
    this.values = {};
    this.maskMode = false;
    this.sendState();
  }

  private sendState() {
    window.bus.send({
      type: 'state',
      gameId: this.entry?.id ?? null,
      settings: this.values,
      status: this.current?.getStatus?.() ?? {},
      mask: this.maskMode,
      ndiFps: this.ndiFps,
    });
  }

  /** Komponiert aus einer Game-View das FHD-16:9-Anlieferungsbild:
   *  außen Grün, die 675×1080-Zone in RING_COLOR, und nur das mittige
   *  640×1024-Nutzbild ist echtes Alpha (dort zeichnet nur das Game —
   *  der HG passt exakt rein). Im Stanzmasken-Modus ersetzt eine
   *  Luma-Matte das Nutzbild (Weiß = Grafik, Schwarz = Live-Bild;
   *  halbtransparente Kanten werden zu Grauwerten = weicher Key). */
  private composite(og: CanvasRenderingContext2D, view: HTMLCanvasElement) {
    og.setTransform(1, 0, 0, 1, 0, 0);
    og.fillStyle = this.stationMode === 'b1' ? FRAME_BLUE : FRAME_GREEN;
    og.fillRect(0, 0, OUT_W, OUT_H);
    og.fillRect(WALL_X, WALL_Y, WALL_W, WALL_H);
    if (this.maskMode) {
      this.mg.setTransform(1, 0, 0, 1, 0, 0);
      this.mg.globalCompositeOperation = 'source-over';
      this.mg.clearRect(0, 0, VIEW_W, VIEW_H);
      this.mg.drawImage(view, 0, 0);
      this.mg.globalCompositeOperation = 'source-in';
      this.mg.fillStyle = '#ffffff';
      this.mg.fillRect(0, 0, VIEW_W, VIEW_H);
      og.fillStyle = '#000000';
      og.fillRect(CONTENT_X, CONTENT_Y, CONTENT_W, CONTENT_H);
      og.drawImage(this.maskCanvas, CONTENT_X, CONTENT_Y, CONTENT_W, CONTENT_H);
    } else {
      og.clearRect(CONTENT_X, CONTENT_Y, CONTENT_W, CONTENT_H);
      if (this.current) {
        og.drawImage(view, CONTENT_X, CONTENT_Y, CONTENT_W, CONTENT_H);
      }
    }
  }

  run() {
    const frame = (time: number) => {
      // dt deckeln: nach Rucklern keine Riesensprünge
      const dt = Math.min((time - this.lastTime) / 1000, 1 / 30);
      this.lastTime = time;

      this.current?.update(dt);

      // Das Game rendert in die virtuelle 10:16-View …
      this.vg.setTransform(1, 0, 0, 1, 0, 0);
      this.vg.clearRect(0, 0, VIEW_W, VIEW_H);
      this.current?.render(this.vg);

      // … der Host komponiert daraus das FHD-16:9-Anlieferungsbild
      this.composite(this.og, this.view);

      // Sichtbares Wall-Fenster (HDMI-Fallback) zeigt dasselbe Bild.
      // Erst leeren: das Composite hat im Nutzbild echtes Alpha — ohne
      // clearRect bleibt dort der vorherige Frame stehen (Konfetti-Schlieren)
      this.g.setTransform(1, 0, 0, 1, 0, 0);
      this.g.clearRect(0, 0, OUT_W, OUT_H);
      this.g.drawImage(this.out, 0, 0);

      // NDI: das Anlieferungsbild als EINE Quelle ins Netz (beide Walls
      // zeigen dasselbe) — Grün/Ring deckend (Backstage-16:9-Monitore zeigen
      // es randlos), das Nutzbild mit ECHTEM Alphakanal, der Ü-Wagen croppt
      // und stanzt. Läuft auch im Leerlauf weiter, damit der Stream steht.
      this.ndiAccum += dt;
      if (this.ndiAccum >= 1 / this.ndiFps) {
        this.ndiAccum %= 1 / this.ndiFps;
        const img = this.og.getImageData(0, 0, OUT_W, OUT_H);
        window.ndi.sendFrame({
          stream: NDI_STREAM,
          width: OUT_W,
          height: OUT_H,
          fps: this.ndiFps,
          data: img.data.buffer,
        });
      }

      this.stateTimer += dt;
      if (this.stateTimer >= 0.15) {
        this.stateTimer = 0;
        this.sendState();
      }

      this.input.endFrame();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame((t) => {
      this.lastTime = t;
      requestAnimationFrame(frame);
    });
  }

}
