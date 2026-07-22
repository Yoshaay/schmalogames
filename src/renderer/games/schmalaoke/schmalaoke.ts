import { Game, GameContext, VIEW_W, VIEW_H } from '../../core/game';
import { BeatEngine } from '../../core/beat';
import { LRCParser } from './lrc-parser';
import logoUrl from './assets/logo2.png';

/**
 * Schmalaoke — Karaoke-Lyrics-Player als Schmalogames-Slot.
 * Portiert aus der Standalone-App SchmalKaraoke_ALPHA (die bleibt als
 * Backup unangetastet): State-Machine aus main.js, die Conveyor-Belt-
 * Animation aus player.js/player.css hier als Canvas-Nachbau.
 *
 * Steuerung kommt komplett aus dem Operator-Panel (Space/Pfeile/N/Home,
 * Playlist, Sprungpunkte). Die Wall zeigt nur Logo bzw. Lyrics.
 */

/** Nachrichten vom Operator-Panel */
interface Cmd {
  cmd: 'song' | 'space' | 'prev' | 'nextsong' | 'restart' | 'jump' | 'reset' | 'auto' | 'micdev' | 'hello';
  name?: string;
  content?: string;
  index?: number;
  enabled?: boolean;
  id?: string;
}

/** Vorlauf: Zeile erscheint N Beats vor ihrem musikalischen Einsatz */
const PRE_BEATS = 1;

/* ---------- Conveyor-Animation (aus player.css, skaliert auf 1080p) ---------- */

type Role = 'current' | 'next' | 'exitUp' | 'enterBelow' | 'exitDown' | 'enterAbove';

interface RoleState {
  size: number; // Schriftgröße px
  y: number; // Offset zur Bildmitte
  bright: number; // 0..1 → Grauwert (1 = weiß, 0.45 ≈ #727272)
  alpha: number;
}

const ROLES: Record<Role, RoleState> = {
  current: { size: 76, y: -105, bright: 1, alpha: 1 },
  next: { size: 32, y: 78, bright: 0.45, alpha: 1 },
  exitUp: { size: 32, y: -300, bright: 0.45, alpha: 0 },
  enterBelow: { size: 32, y: 185, bright: 0.45, alpha: 0 },
  exitDown: { size: 32, y: 300, bright: 0.45, alpha: 0 },
  enterAbove: { size: 76, y: -300, bright: 1, alpha: 0 },
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
  private logo = new Image();
  private time = 0;

  /* ---------- Song-State (portiert aus main.js) ---------- */
  private parser = new LRCParser();
  private lines: string[] = [];
  private sections: Array<string | null> = [];
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
  private currentBeatInLine = 0;
  /** Sperrzeit nach manueller Korrektur (ms, Date.now-Basis) */
  private beatCooldownUntil = 0;

  /* ---------- Anzeige ---------- */
  private sprites: Sprite[] = [];

  init(ctx: GameContext) {
    this.ctx = ctx;
    this.logo.src = logoUrl;
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
    if (enabled) this.startListening();
    else this.stopListening();
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

  /** Beat vom Audio-Grid: Zähler pro Zeile, bei <N> erreicht → weiterblättern */
  private handleDetectedBeat() {
    this.ctx?.sendToOperator({ kind: 'beat', bpm: this.engine.bpm, conf: this.engine.conf });
    if (!this.autoMode || !this.lyricsModeStarted || this.songEndedDisplayed) return;
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
      Auto: this.autoMode ? (this.engine.bpm > 0 ? `AN · ${Math.round(this.engine.bpm)} BPM` : 'AN · lauscht …') : 'aus',
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
    // Karaoke-Wall ist schlicht schwarz (wie das Original)
    g.fillStyle = '#000000';
    g.fillRect(0, 0, VIEW_W, VIEW_H);

    if (this.errorText) {
      this.drawLine(g, this.errorText, ROLES.current, 1);
      return;
    }

    const showLyrics = this.lyricsModeStarted && !this.songEndedDisplayed;
    if (!showLyrics) {
      // Ruhe-/Ready-/Ende-Zustand: Logo mittig
      if (this.logo.complete && this.logo.naturalWidth) {
        const w = Math.min(700, this.logo.naturalWidth);
        const h = (w / this.logo.naturalWidth) * this.logo.naturalHeight;
        g.drawImage(this.logo, (VIEW_W - w) / 2, (VIEW_H - h) / 2, w, h);
      }
      return;
    }

    // aktive Sprites zeichnen, abgelaufene Exits entsorgen
    this.sprites = this.sprites.filter((s) => {
      const t = (this.time - s.t0) / ANIM_S;
      if (t < 0) return true; // Phase 2 wartet noch — nicht zeichnen
      return !(s.transient && t >= 1);
    });
    for (const s of this.sprites) {
      const t = ease((this.time - s.t0) / ANIM_S);
      if ((this.time - s.t0) / ANIM_S < 0) continue;
      const a = ROLES[s.from];
      const b = ROLES[s.to];
      const state: RoleState = {
        size: a.size + (b.size - a.size) * t,
        y: a.y + (b.y - a.y) * t,
        bright: a.bright + (b.bright - a.bright) * t,
        alpha: a.alpha + (b.alpha - a.alpha) * t,
      };
      this.drawLine(g, s.text, state, state.alpha);
    }
  }

  /** Zeile zeichnen — mit Umbruch, zentriert um die Rollen-Position */
  private drawLine(g: CanvasRenderingContext2D, text: string, state: RoleState, alpha: number) {
    if (!text || alpha <= 0.01) return;
    g.save();
    g.globalAlpha = alpha;
    const v = Math.round(state.bright * 255);
    g.fillStyle = `rgb(${v}, ${v}, ${v})`;
    g.font = `400 ${Math.round(state.size)}px 'TheSans', system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    // Umbruch auf 90% Breite (wie padding im Original)
    const maxW = VIEW_W * 0.9;
    const words = text.split(' ');
    const rows: string[] = [];
    let row = '';
    for (const word of words) {
      const probe = row ? row + ' ' + word : word;
      if (g.measureText(probe).width > maxW && row) {
        rows.push(row);
        row = word;
      } else {
        row = probe;
      }
    }
    if (row) rows.push(row);

    const lineH = state.size * 1.2;
    const cy = VIEW_H / 2 + state.y - ((rows.length - 1) * lineH) / 2;
    rows.forEach((r, i) => g.fillText(r, VIEW_W / 2, cy + i * lineH));
    g.restore();
  }

  /* ---------- State-Machine (portiert aus main.js) ---------- */

  private resetForNewSong() {
    this.lines = [];
    this.sections = [];
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
    this.sections = [...this.parser.sections];
    this.beatCounts = [...this.parser.beatCounts];
    this.title = this.parser.metadata.ti || name.replace(/\.lrc$/i, '');
    this.artist = this.parser.metadata.ar || '';
    this.waitingForStart = true;
    this.sendPresenter();
  }

  private texts() {
    const max = this.lines.length - 1;
    return {
      current: this.currentLine >= 0 && this.currentLine <= max ? this.lines[this.currentLine] : '',
      next: this.currentLine + 1 <= max ? this.lines[this.currentLine + 1] : '',
    };
  }

  /** Harter Schnitt ohne Animation (Start, Sprung, Restart) */
  private showHard() {
    const t = this.texts();
    this.sprites = [
      { text: t.current, from: 'current', to: 'current', t0: this.time, transient: false },
      { text: t.next, from: 'next', to: 'next', t0: this.time, transient: false },
    ];
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

  /** Forward: current fährt hoch raus, next wächst zur Current, neue Next kommt von unten */
  private animateForward() {
    const t = this.texts();
    const prevText = this.currentLine > 0 ? this.lines[this.currentLine - 1] : '';
    this.sprites = [
      { text: prevText, from: 'current', to: 'exitUp', t0: this.time, transient: true },
      { text: t.current, from: 'next', to: 'current', t0: this.time, transient: false },
      // Phase 2: neue Next erst nach der ersten Animation (wie im Original)
      { text: t.next, from: 'enterBelow', to: 'next', t0: this.time + ANIM_S, transient: false },
    ];
  }

  /** Backward: next fährt unten raus, current schrumpft zur Next, neue Current von oben */
  private animateBackward() {
    const t = this.texts();
    const oldNext = this.currentLine + 2 <= this.lines.length - 1 ? this.lines[this.currentLine + 2] : '';
    this.sprites = [
      { text: oldNext, from: 'next', to: 'exitDown', t0: this.time, transient: true },
      { text: t.next, from: 'current', to: 'next', t0: this.time, transient: false },
      { text: t.current, from: 'enterAbove', to: 'current', t0: this.time + ANIM_S, transient: false },
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
