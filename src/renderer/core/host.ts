import { Game, GameContext, GameEntry, SettingValues, VIEW_W, VIEW_H } from './game';
import { Input } from './input';

/**
 * Läuft im Wall-Fenster (Cleanfeed). Besitzt Canvas und Game-Loop.
 * Gesteuert wird ausschließlich über Nachrichten aus dem Operator-Fenster:
 * start / stop / set (Einstellung) / action.
 */
export class GameHost {
  private g: CanvasRenderingContext2D;
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
    canvas.width = VIEW_W;
    canvas.height = VIEW_H;
    this.g = canvas.getContext('2d')!;


    window.addEventListener('resize', () => this.fitCanvas());
    this.fitCanvas();

    window.bus.onMessage((msg) => this.handleMessage(msg as { type: string; [k: string]: unknown }));
    this.sendState();
    // Falls das Operator-Fenster schon lauscht: Vorschau-Verbindung anstoßen
    window.bus.send({ type: 'wall-ready' });
  }

  private fitCanvas() {
    const scale = Math.min(window.innerWidth / VIEW_W, window.innerHeight / VIEW_H);
    this.canvas.style.width = `${VIEW_W * scale}px`;
    this.canvas.style.height = `${VIEW_H * scale}px`;
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

    const stream = this.canvas.captureStream(30);
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
    this.entry = entry;
    this.values = this.loadValues(entry);
    this.current = entry.create();
    this.current.init(this.makeContext());
    this.current.applySettings?.(this.values);
  }

  private stopGame() {
    this.current?.dispose?.();
    this.current = null;
    this.entry = null;
    this.values = {};
    this.sendState();
  }

  private sendState() {
    window.bus.send({
      type: 'state',
      gameId: this.entry?.id ?? null,
      settings: this.values,
      status: this.current?.getStatus?.() ?? {},
    });
  }

  run() {
    const frame = (time: number) => {
      // dt deckeln: nach Rucklern keine Riesensprünge
      const dt = Math.min((time - this.lastTime) / 1000, 1 / 30);
      this.lastTime = time;

      this.current?.update(dt);

      this.g.setTransform(1, 0, 0, 1, 0, 0);
      this.g.clearRect(0, 0, VIEW_W, VIEW_H);
      if (this.current) {
        this.current.render(this.g);
      } else {
        this.renderIdle();
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

  /** Leerlauf: schlichtes Schwarz, ungebrandet — sendefähiger Cleanfeed */
  private renderIdle() {
    this.g.fillStyle = '#000000';
    this.g.fillRect(0, 0, VIEW_W, VIEW_H);
  }
}
