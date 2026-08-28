import { Game, GameContext, StationMode, VIEW_W, VIEW_H } from '../../core/game';
import { BeatEngine } from '../../core/beat';
import { LRCParser } from './lrc-parser';
import bgUrl from './assets/final/Untertitel_BG_v2.png';

/**
 * Schmalaoke — Karaoke-Lyrics-Player als Schmalogames-Slot.
 * Portiert aus der Standalone-App SchmalKaraoke_ALPHA (die bleibt als
 * Backup unangetastet): State-Machine aus main.js, die Conveyor-Belt-
 * Animation aus player.js/player.css hier als Canvas-Nachbau.
 *
 * Steuerung kommt komplett aus dem Operator-Panel (Space/Pfeile/N/R,
 * Playlist, Sprungpunkte). Die Wall zeigt nur Logo bzw. Lyrics.
 */

/** Nachrichten vom Operator-Panel */
interface Cmd {
  cmd: 'song' | 'space' | 'prev' | 'nextsong' | 'restart' | 'jump' | 'reset' | 'auto' | 'micdev' | 'hello' | 'bpmreset' | 'bpmset';
  name?: string;
  content?: string;
  index?: number;
  enabled?: boolean;
  id?: string;
  value?: number;
}

/** Vorlauf: Zeile erscheint N Beats vor ihrem musikalischen Einsatz */
const PRE_BEATS = 1;

/** Ampel-Logik: Auto-Advance übernimmt erst ab dieser Beat-Konfidenz
 *  (gelb = lauscht, manuell fahren — grün = gelockt, Auto fährt).
 *  Die Engine-Konfidenz pendelt bei normalem Material um 0,3–0,6. */
const LOCK_CONF = 0.3;

/* ---------- Conveyor-Animation (aus player.css, skaliert auf 1080p) ---------- */

type Role = 'current' | 'exitUp' | 'enterBelow' | 'exitDown' | 'enterAbove';

interface RoleState {
  y: number; // Offset zur Bildmitte
  alpha: number;
}

/** Anker des Lyric-Blocks: vertikale Mitte des pinken Bands im finalen
 *  Asset (Untertitel_BG_v2) — das Band läuft von y ≈ 204 (linke Spitze)
 *  bis y ≈ 408 (unterer Zacken), seine Mittellinie liegt fast waagerecht
 *  bei y ≈ 310. Der Text steht horizontal, keine Rotation: die Ober- und
 *  Unterkante laufen gegenläufig schräg, die Mitte bleibt gerade. */
const ANCHOR_Y = 310;

/** Lyric-Layout: immer EINE Zeile, horizontal zentriert im pinken Band,
 *  kein Umbruch — Zeilen sind zeichenmäßig unbegrenzt. Wird eine Zeile
 *  breiter als LYRIC_MAX_W, schrumpft die Schrift proportional, bis sie
 *  passt (wie der Cheer-Titel im Schmalogroove). LYRIC_X sitzt rechts
 *  der Bildmitte, weil das Band links spitz zuläuft — 640 ist die
 *  optische Mitte der Fläche. LYRIC_MAX_W ist so gewählt, dass auch
 *  Unterlängen am linken, spitz zulaufenden Rand nicht angeschnitten
 *  werden. */
const LYRIC_SIZE = 56;
const LYRIC_X = 640;
const LYRIC_MAX_W = 870;

/** Clip-Maske für die Lyrics: das pinke Band aus dem finalen Asset
 *  (final/Untertitel_BG_v2, 641×1025), pixelgenau ausgemessen und in
 *  View-Koordinaten umgerechnet (Cover-Faktor 1920/1025). Die Schrift
 *  existiert nur innerhalb dieser Fläche — sie taucht beim Reinfliegen
 *  an der Oberkante des Bands auf und wird an der Unterkante weggewischt.
 *  Der grüne Streifen darunter bleibt frei. */
const LYRIC_CLIP: Array<[number, number]> = [
  [79, 204], // linke Spitze des pinken Bands
  [843, 238], // Knick: Oberkante wird steiler
  [1006, 258], // Kerbe — tiefster Punkt der Oberkante
  [1008, 245], // Kerbe — Sprung zurück nach oben
  [VIEW_W, 255], // Oberkante rechts
  [VIEW_W, 363], // Unterkante rechts
  [272, 408], // unterer Zacken (tiefster Punkt)
];

/** BAYERN-1-Layout: kein HG-Asset (nur Alpha), die Zeile steht horizontal
 *  zentriert in der Mitte des unteren Bilddrittels (1280–1920 → 1600).
 *  Statt des Band-Polygons wischt ein Rechteck um den Anker die ein- und
 *  ausfliegenden Zeilen weg — schmaler als der Rollen-Hub (±320), damit
 *  Exits sauber aus der Maske laufen. */
const B1_ANCHOR_Y = 1600;
const B1_X = VIEW_W / 2;
const B1_MAX_W = 1080;
const B1_CLIP_TOP = B1_ANCHOR_Y - 160;
const B1_CLIP_H = 320;

/** Vertikaler Durchlauf (abwärts): Zeilen fliegen von oben aus dem Bild
 *  rein und knapp unterhalb der Farbfläche raus (dort wischt die Clip-
 *  Maske sie an der Unterkante weg). Kein Alpha-Fade. */
const ROLES: Record<Role, RoleState> = {
  current: { y: 0, alpha: 1 },
  exitUp: { y: -320, alpha: 1 },
  enterBelow: { y: 320, alpha: 1 },
  exitDown: { y: 320, alpha: 1 },
  enterAbove: { y: -320, alpha: 1 },
};

const ANIM_S = 0.4; // 400ms wie im Original

/** Eine animierte Textzeile: blendet von einer Rolle zur nächsten */
interface Sprite {
  text: string;
  from: Role;
  to: Role;
  /** Startzeit (Spielzeit in s); Zukunft = wartet noch (Phase 2) */
  t0: number;
  /** nach Ablauf entfernen (Exit-Rollen) */
  transient: boolean;
}

/** cubic-bezier(0.4, 0, 0.2, 1) — angenähert */
const ease = (t: number) => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};

export class Schmalaoke implements Game {
  private ctx: GameContext | null = null;
  private time = 0;

  /** CI-Hintergrund (transparentes Overlay über schwarzer Basis) */
  private bg = new Image();

  /* ---------- Song-State (portiert aus main.js) ---------- */
  private parser = new LRCParser();
  private lines: string[] = [];
  private currentLine = 0;
  private pendingJump = -1;
  private lyricsModeStarted = false;
  private songEndedDisplayed = false;
  private waitingForStart = false;
  private title = '';
  private artist = '';
  private errorText: string | null = null;
  private endTimer = -1; // Countdown bis 'song-ended' ans Panel

  /* ---------- Auto-Advance (Beat-Detection, portiert aus main.js) ---------- */
  private engine = new BeatEngine();
  private autoMode = false;
  private listening = false;
  private actx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private micStream: MediaStream | null = null;
  private micDeviceId: string | null = localStorage.getItem('schmalaoke.micDevice');
  private onDeviceChange = () => this.sendInputList();
  private beatCounts: number[] = [];
  /** Sicherung: ohne einen einzigen <N>-Tag in der LRC bleibt Auto stumm —
   *  sonst würde der Default (1 Beat/Zeile) die Lyrics durchrattern */
  private autoCapable = false;
  /** Fest eingetippter BPM-Wert (0 = Mikrofon-Erkennung). Das Grid läuft
   *  dann rein von der Uhr — ganz ohne Audio-Eingang. */
  private manualBpm = 0;
  private currentBeatInLine = 0;
  /** Sperrzeit nach manueller Korrektur (ms, Date.now-Basis) */
  private beatCooldownUntil = 0;

  /* ---------- Anzeige ---------- */
  private sprites: Sprite[] = [];
  /** BAYERN-1-Modus: kein HG-Asset, Lyrics im unteren Drittel */
  private b1 = false;

  setStationMode(mode: StationMode) {
    this.b1 = mode === 'b1';
  }

  init(ctx: GameContext) {
    this.ctx = ctx;
    this.bg.src = bgUrl;
    this.engine.onBeat = () => this.handleDetectedBeat();
    navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
  }

  dispose() {
    navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
    this.stopListening();
    this.actx?.close();
    this.actx = null;
  }

  onMessage(payload: unknown) {
    const msg = payload as Cmd;
    switch (msg.cmd) {
      case 'song':
        this.loadSong(msg.name ?? '', msg.content ?? '');
        break;
      case 'space':
        this.handleSpace();
        break;
      case 'prev':
        this.previousLine();
        break;
      case 'nextsong':
        this.finishSong();
        break;
      case 'restart':
        this.restartSong();
        break;
      case 'jump':
        this.armJump(msg.index ?? -1);
        break;
      case 'reset':
        this.resetForNewSong();
        this.title = '';
        this.artist = '';
        this.sendPresenter();
        break;
      case 'hello':
        this.sendInputList();
        this.sendPresenter();
        break;
      case 'auto':
        this.setAutoMode(!!msg.enabled);
        break;
      case 'bpmreset':
        // Erkennung hat sich verrannt bzw. fester Wert soll weg:
        // zurück zur Mikrofon-Erkennung, neu einlocken lassen
        this.manualBpm = 0;
        this.engine.reset();
        this.currentBeatInLine = 0;
        this.beatCooldownUntil = 0;
        if (this.autoMode && !this.listening) this.startListening();
        break;
      case 'bpmset': {
        const v = Math.round(msg.value ?? 0);
        if (v > 0) {
          // Fester Wert: Mikro freigeben, Grid ab jetzt von der Uhr
          this.stopListening();
          this.manualBpm = Math.min(240, Math.max(40, v));
          this.engine.setBpm(this.manualBpm, performance.now());
          this.currentBeatInLine = 0;
          this.beatCooldownUntil = 0;
        } else {
          // Feld geleert: zurück zur Mikrofon-Erkennung
          this.manualBpm = 0;
          this.engine.reset();
          this.currentBeatInLine = 0;
          this.beatCooldownUntil = 0;
          if (this.autoMode) this.startListening();
        }
        break;
      }
      case 'micdev':
        this.micDeviceId = msg.id && msg.id !== 'default' ? msg.id : null;
        if (this.micDeviceId) localStorage.setItem('schmalaoke.micDevice', this.micDeviceId);
        else localStorage.removeItem('schmalaoke.micDevice');
        if (this.listening) {
          this.stopListening();
          this.startListening();
        }
        break;
    }
  }

  /* ---------- Auto-Advance ---------- */

  private setAutoMode(enabled: boolean) {
    this.autoMode = enabled;
    this.currentBeatInLine = 0;
    this.beatCooldownUntil = 0;
    if (enabled) {
      // Fester BPM-Wert braucht kein Mikro — Grid neu ab jetzt ausrichten
      if (this.manualBpm > 0) this.engine.setBpm(this.manualBpm, performance.now());
      else this.startListening();
    } else {
      this.stopListening();
    }
    this.sendPresenter();
  }

  private async startListening() {
    if (this.listening) return;
    if (!this.actx) {
      this.actx = new AudioContext();
      this.analyser = this.actx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.3;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    }
    if (this.actx.state === 'suspended') this.actx.resume();
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(this.micDeviceId ? { deviceId: { exact: this.micDeviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this.actx.createMediaStreamSource(this.micStream).connect(this.analyser!);
      this.engine.reset();
      this.listening = true;
      this.sendInputList(); // nach erfolgreichem Zugriff sind Labels verfügbar
    } catch {
      this.ctx?.sendToOperator({ kind: 'error', text: 'Audio-Eingang nicht verfügbar' });
      this.autoMode = false;
    }
    this.sendPresenter();
  }

  private stopListening() {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.listening = false;
    this.engine.reset();
  }

  /** Ampel: erst wenn Tempo UND Konfidenz stehen, darf Auto fahren */
  private isLocked(): boolean {
    return this.engine.periodMs > 0 && this.engine.conf >= LOCK_CONF;
  }

  /** Beat vom Audio-Grid: Zähler pro Zeile, bei <N> erreicht → weiterblättern */
  private handleDetectedBeat() {
    const locked = this.isLocked();
    this.ctx?.sendToOperator({ kind: 'beat', bpm: this.engine.bpm, locked, manual: this.manualBpm > 0 });
    if (!this.autoMode || !this.lyricsModeStarted || this.songEndedDisplayed) return;
    // Song ohne Beat-Tags: Auto greift NICHT ein (nur manuell weiterblättern)
    if (!this.autoCapable) return;
    // Ampel gelb (Erkennung noch nicht stabil): manuell fahren, nicht zählen
    if (!locked) return;
    if (Date.now() < this.beatCooldownUntil) return;

    this.currentBeatInLine++;
    const beatsNeeded = this.beatCounts[this.currentLine] || 1;
    if (this.currentBeatInLine >= beatsNeeded) {
      this.currentBeatInLine = 0;
      this.nextLine();
    }
  }

  /** Verfügbare Audio-Eingänge ans Operator-Panel schicken */
  private async sendInputList() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices
        .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Eingang ${i + 1}` }));
      this.ctx?.sendToOperator({ kind: 'inputs', devices: inputs, selected: this.micDeviceId ?? 'default' });
    } catch {}
  }

  getStatus(): Record<string, string | number> {
    const zustand = this.errorText
      ? 'FEHLER'
      : this.songEndedDisplayed
        ? 'Song-Ende'
        : this.lyricsModeStarted
          ? 'läuft'
          : this.lines.length
            ? 'bereit — Leertaste startet'
            : 'kein Song geladen';
    return {
      Zustand: zustand,
      Titel: this.title || '—',
      Zeile: this.lyricsModeStarted ? `${Math.min(this.currentLine + 1, this.lines.length)} / ${this.lines.length}` : '—',
      Auto: !this.autoMode
        ? 'aus'
        : this.lines.length && !this.autoCapable
          ? 'AN — Song ohne Beat-Tags, nur manuell!'
          : this.isLocked()
            ? `AN · ${Math.round(this.engine.bpm)} BPM${this.manualBpm > 0 ? ' (fix)' : ''} · fährt`
            : 'AN · lauscht — manuell fahren',
    };
  }

  update(dt: number) {
    this.time += dt;

    // Beat-Detection: Audio abtasten, Grid weiterschalten (feuert onBeat)
    if (this.listening && this.analyser && this.freq) {
      const now = performance.now();
      this.analyser.getByteFrequencyData(this.freq);
      this.engine.sample(this.freq, now);
      this.engine.update(now, dt);
    } else if (this.autoMode && this.manualBpm > 0) {
      // Fester eingetippter BPM-Wert: Grid läuft rein von der Uhr
      this.engine.update(performance.now(), dt);
    }

    // Song-Ende: nach der Auslauf-Animation ans Panel melden (Auto-Next)
    if (this.endTimer > 0) {
      this.endTimer -= dt;
      if (this.endTimer <= 0) {
        this.endTimer = -1;
        this.ctx?.sendToOperator({ kind: 'song-ended' });
      }
    }
  }

  render(g: CanvasRenderingContext2D) {
    // KEINE schwarze Grundfüllung: alles außerhalb der Farbflächen bleibt
    // echt transparent (Alpha), damit im Ü-Wagen ein Livefeed dahinter
    // gelegt werden kann. Auf der Wall wirkt es weiter schwarz (Fenster-
    // Hintergrund); der Host cleart den Canvas jeden Frame.
    if (!this.b1 && this.bg.complete && this.bg.naturalWidth) {
      this.drawBg(g);
    }

    if (this.errorText) {
      this.drawLine(g, this.errorText, ROLES.current, 1);
      return;
    }

    const showLyrics = this.lyricsModeStarted && !this.songEndedDisplayed;
    if (!showLyrics) {
      // Ruhe-/Ready-/Ende-Zustand: nur der Hintergrund, kein Logo
      return;
    }

    // aktive Sprites zeichnen, abgelaufene Exits entsorgen
    this.sprites = this.sprites.filter((s) => {
      const t = (this.time - s.t0) / ANIM_S;
      if (t < 0) return true; // Phase 2 wartet noch — nicht zeichnen
      return !(s.transient && t >= 1);
    });

    // Lyrics innerhalb der Clip-Maske zeichnen: BAYERN 3 = Polygon-Kante
    // der Farbfläche (pixelgenau), BAYERN 1 = Rechteck ums untere Drittel
    g.save();
    g.beginPath();
    if (this.b1) {
      g.rect(0, B1_CLIP_TOP, VIEW_W, B1_CLIP_H);
    } else {
      LYRIC_CLIP.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
    }
    g.clip();
    for (const s of this.sprites) {
      const t = ease((this.time - s.t0) / ANIM_S);
      if ((this.time - s.t0) / ANIM_S < 0) continue; // Phase 2 wartet noch
      const a = ROLES[s.from];
      const b = ROLES[s.to];
      const state: RoleState = {
        y: a.y + (b.y - a.y) * t,
        alpha: a.alpha + (b.alpha - a.alpha) * t,
      };
      this.drawLine(g, s.text, state, state.alpha);
    }
    g.restore();
  }

  /** Hintergrund als Cover-Crop: Seitenverhältnis erhalten, oben verankert
   *  und horizontal zentriert — die Farbflächen hängen an der Oberkante
   *  der Wall. */
  private drawBg(ctx: CanvasRenderingContext2D) {
    const s = Math.max(VIEW_W / this.bg.naturalWidth, VIEW_H / this.bg.naturalHeight);
    const w = this.bg.naturalWidth * s;
    const h = this.bg.naturalHeight * s;
    ctx.drawImage(this.bg, (VIEW_W - w) / 2, 0, w, h);
  }

  /** Zeile zeichnen — immer einzeilig, zentriert auf dem Anker. Zeilen
   *  breiter als LYRIC_MAX_W werden proportional kleiner skaliert statt
   *  umzubrechen oder an der Maske zu clippen. */
  private drawLine(g: CanvasRenderingContext2D, text: string, state: RoleState, alpha: number) {
    if (!text || alpha <= 0.01) return;
    g.save();
    g.globalAlpha = alpha;
    // Lyrics immer weiß — keine Grau-Abstufung, keine Farbanimation
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${LYRIC_SIZE}px 'TheSans', system-ui, sans-serif`;
    const maxW = this.b1 ? B1_MAX_W : LYRIC_MAX_W;
    const fit = Math.min(1, maxW / Math.max(1, g.measureText(text).width));
    g.translate(this.b1 ? B1_X : LYRIC_X, (this.b1 ? B1_ANCHOR_Y : ANCHOR_Y) + state.y);
    g.scale(fit, fit);
    g.fillText(text, 0, 0);
    g.restore();
  }

  /* ---------- State-Machine (portiert aus main.js) ---------- */

  private resetForNewSong() {
    this.lines = [];
    this.currentLine = 0;
    this.pendingJump = -1;
    this.lyricsModeStarted = false;
    this.songEndedDisplayed = false;
    this.waitingForStart = false;
    this.errorText = null;
    this.endTimer = -1;
    this.sprites = [];
    this.beatCounts = [];
    this.currentBeatInLine = 0;
    this.beatCooldownUntil = 0;
  }

  private loadSong(name: string, content: string) {
    this.resetForNewSong();
    if (!this.parser.parseContent(content)) {
      this.errorText = 'Keine Lyrics gefunden';
      this.sendPresenter();
      return;
    }
    this.lines = [...this.parser.lyricsLines];
    this.beatCounts = [...this.parser.beatCounts];
    this.autoCapable = this.parser.beatTagged.some(Boolean);
    this.title = this.parser.metadata.ti || name.replace(/\.lrc$/i, '');
    this.artist = this.parser.metadata.ar || '';
    this.waitingForStart = true;
    this.sendPresenter();
  }

  private currentText(): string {
    const max = this.lines.length - 1;
    return this.currentLine >= 0 && this.currentLine <= max ? this.lines[this.currentLine] : '';
  }

  /** Harter Schnitt ohne Animation (Start, Sprung, Restart) */
  private showHard() {
    this.sprites = [{ text: this.currentText(), from: 'current', to: 'current', t0: this.time, transient: false }];
  }

  private handleSpace() {
    if (this.errorText) return;

    // Armierter Sprung hat Vorrang
    if (this.pendingJump >= 0) {
      const target = this.pendingJump;
      this.pendingJump = -1;
      this.jumpToLine(target);
      return;
    }

    if (this.waitingForStart || !this.lyricsModeStarted) {
      if (!this.lines.length) return;
      this.waitingForStart = false;
      this.lyricsModeStarted = true;
      this.songEndedDisplayed = false;
      this.currentLine = 0;
      this.currentBeatInLine = PRE_BEATS;
      this.showHard();
      this.sendPresenter();
    } else {
      // Im Auto-Modus ist Space eine Korrektur: Zähler neu ansetzen und
      // Beats kurz ignorieren, damit ein nachlaufender Beat nicht doppelt
      if (this.autoMode) {
        this.currentBeatInLine = PRE_BEATS;
        this.beatCooldownUntil = Date.now() + 400;
      }
      this.nextLine();
    }
  }

  private nextLine() {
    if (!this.lyricsModeStarted || this.songEndedDisplayed) return;

    if (this.currentLine < this.lines.length - 1) {
      this.currentLine++;
      this.animateForward();
      this.sendPresenter();
    } else {
      // letzte Zeile war dran → Song-Ende einleiten
      this.finishSong();
    }
  }

  private previousLine() {
    if (!this.lyricsModeStarted || this.songEndedDisplayed) return;
    if (this.currentLine > 0) {
      this.currentLine--;
      this.currentBeatInLine = PRE_BEATS;
      this.beatCooldownUntil = Date.now() + 400;
      this.animateBackward();
      this.sendPresenter();
    }
  }

  /** Forward: alte Zeile fliegt nach unten raus (Maske wischt sie an der
   *  Unterkante der Farbfläche weg), neue Zeile fliegt von oben ein */
  private animateForward() {
    const prevText = this.currentLine > 0 ? this.lines[this.currentLine - 1] : '';
    this.sprites = [
      { text: prevText, from: 'current', to: 'exitDown', t0: this.time, transient: true },
      { text: this.currentText(), from: 'enterAbove', to: 'current', t0: this.time, transient: false },
    ];
  }

  /** Backward: gespiegelt — alte Zeile fliegt oben raus, neue kommt von unten */
  private animateBackward() {
    const oldText = this.currentLine + 1 <= this.lines.length - 1 ? this.lines[this.currentLine + 1] : '';
    this.sprites = [
      { text: oldText, from: 'current', to: 'exitUp', t0: this.time, transient: true },
      { text: this.currentText(), from: 'enterBelow', to: 'current', t0: this.time, transient: false },
    ];
  }

  /** Sprung armieren (Anwählen = markieren, Space löst aus; erneut = abwählen) */
  private armJump(index: number) {
    if (!this.lines.length || index < -1) return;
    if (index === -1) {
      this.pendingJump = -1;
    } else {
      index = Math.max(0, Math.min(index, this.lines.length - 1));
      this.pendingJump = this.pendingJump === index ? -1 : index;
    }
    this.sendPresenter();
  }

  private jumpToLine(index: number) {
    if (!this.lines.length) return;
    index = Math.max(0, Math.min(index, this.lines.length - 1));
    this.pendingJump = -1;
    if (this.waitingForStart || !this.lyricsModeStarted) {
      this.waitingForStart = false;
      this.lyricsModeStarted = true;
    }
    this.songEndedDisplayed = false;
    this.currentLine = index;
    this.currentBeatInLine = PRE_BEATS;
    this.beatCooldownUntil = Date.now() + 400;
    this.showHard(); // Sprung = harter Schnitt
    this.sendPresenter();
  }

  private restartSong() {
    if (!this.lyricsModeStarted || this.songEndedDisplayed) return;
    this.currentLine = 0;
    // Beat-Zähler wie bei Sprung/Korrektur neu ansetzen
    this.currentBeatInLine = PRE_BEATS;
    this.beatCooldownUntil = Date.now() + 400;
    this.showHard();
    this.sendPresenter();
  }

  private finishSong() {
    if (this.songEndedDisplayed || !this.lines.length) return;
    this.songEndedDisplayed = true;
    this.sprites = [];
    this.sendPresenter();
    this.endTimer = 1.5; // wie im Original: kurz Logo zeigen, dann Auto-Next
  }

  /** Kompletten Presenter-State ans Panel (klein genug für jede Änderung) */
  private sendPresenter() {
    this.ctx?.sendToOperator({
      kind: 'presenter',
      currentLine: this.currentLine,
      pendingJump: this.pendingJump,
      started: this.lyricsModeStarted,
      ended: this.songEndedDisplayed,
      remaining: this.lyricsModeStarted ? Math.max(0, this.lines.length - 1 - this.currentLine) : -1,
      total: this.lines.length,
      title: this.title,
      artist: this.artist,
      autoMode: this.autoMode,
    });
  }
}
