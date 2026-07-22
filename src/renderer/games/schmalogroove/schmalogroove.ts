import * as THREE from 'three';
import { Game, GameContext, SettingValues, VIEW_W, VIEW_H } from '../../core/game';
import { Confetti } from '../../core/confetti';
import { BeatEngine } from './beat';
import { Dancer } from './dancer';
import { MIXAMO_CLIPS } from './mixamo-clips';
import { SpeedBurst } from './burst';

// Mocap-Clips (Mixamo, auf das CC-Modell retargetet) statt prozeduraler
// Moves. Auf false stellen → prozedurales System.
const USE_MOCAP_CLIPS = false;
import bgUrl from './assets/Tanzspiel_Hintergrund.png';

// Position der Tänzerin im Frame: auf der grünen Fläche rechts, unter dem
// "Tanz mit!"-Schriftzug — die transparente Fläche links zeigt das Livebild
const STAGE_CENTER_X = 1620;

// Auszeichnung + Konfetti erscheinen unter der Tänzerin auf der grünen Fläche
// (CHEER_Y = vertikale MITTE des Banners)
const CHEER_X = STAGE_CENTER_X;
const CHEER_Y = 950;

// Zentrum der freien Bühnenfläche (später Publikumscam) — dort zündet der Burst.
// Er wird UNTER dem Hintergrund-Asset gerendert: dessen deckende Teile (Rahmen,
// Diagonale) maskieren ihn automatisch, sichtbar bleibt er nur im transparenten
// Fenster. Groß genug, damit die quadratische Canvas-Kante außerhalb liegt.
const BURST_X = 610;
const BURST_Y = 520;
const BURST_SIZE = 1600;
// verfügbare Breite auf der grünen Fläche
const CHEER_MAX_W = 540;

/** Auszeichnungen: je ein Operator-Button, togglebar, immer mit Konfetti */
export const CHEERS = ['TANZGOTT', 'GROOVE-LEGENDE', 'TANZMASCHINE', 'DISCO-FIEBER'];
/** Knallfarbe pro Auszeichnung (BR3-Palette), Index parallel zu CHEERS.
 *  Kein Hellgrün — das ginge auf dem grünen Hintergrund unter. */
const CHEER_COLORS = ['#e71d73', '#2699d6', '#f9b233', '#e71d73'];

// Ein-/Ausblend-Zeiten der Auszeichnung: Dreieck-Welle von links nach rechts
const CHEER_IN = 0.65;
const CHEER_OUT = 0.5;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** Ease-out-back: schwingt kurz über 1 hinaus (Pop) */
const backOut = (t: number) => {
  const c1 = 1.70158;
  const u = t - 1;
  return 1 + (c1 + 1) * u * u * u + c1 * u * u;
};

/** Nachrichten vom Operator-Panel (operator-panel.ts) */
interface Cmd {
  cmd: 'hello' | 'load' | 'play' | 'pause' | 'tap' | 'auto' | 'mic' | 'seek';
  name?: string;
  data?: ArrayBuffer;
  frac?: number;
}

/**
 * Beat-Dancer auf der Wall: Three.js-Szene wird offscreen in 1920×1080
 * gerendert und in den 2D-Canvas des Hosts geblittet. Cleanfeed — das
 * komplette HUD lebt im Operator-Panel.
 */
export class Schmalogroove implements Game {
  private ctx: GameContext | null = null;

  /* ---------- Szene ---------- */
  private glCanvas = document.createElement('canvas');
  private bg = new Image();
  /** Zwischenpuffer für die weiße Charakter-Silhouette (Outline) */
  private outlineCanvas = document.createElement('canvas');
  private outlineCtx: CanvasRenderingContext2D | null = null;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private dancer = new Dancer();

  /* ---------- Audio ---------- */
  private actx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private micStream: MediaStream | null = null;
  private audioBuffer: AudioBuffer | null = null;
  private trackName = '';
  private playing = false;
  private usingMic = false;
  private pauseOffset = 0;
  private startedAt = 0;

  /* ---------- Beat + Show ---------- */
  private engine = new BeatEngine();
  private moveAmp = 1;
  /** Geglätteter Seitenwechsel — kein hartes Umschnappen pro Beat */
  private dirSmooth = 1;
  private time = 0;
  private tickTimer = 0;

  /* ---------- Sync-Debug: Blink-Signal auf dem visuellen Beat ---------- */
  private debugSync = false;

  /* ---------- Auszeichnung (Cheer) ---------- */
  /** Gewürfeltes Dreieck-Layout des Backdrops (pro Aktivierung neu) */
  private cheerTris: Array<{
    xJit: number;
    y: number;
    rf: number;
    rot: number;
    delay: number;
    accent: boolean;
    u: number;
    /** Phase fürs Schweben/Drehen im Stand */
    ph: number;
  }> = [];
  private cheer: string | null = null;
  /** Goldstreifen-Burst über der Publikumscam-Fläche */
  private burst = new SpeedBurst(BURST_SIZE);
  /** Restlaufzeit — die Schrift verschwindet von selbst */
  private cheerTimer = 0;
  /** Anzeigedauer in s (Operator-Regler) */
  private cheerDuration = 5;
  private confetti = new Confetti();
  private confettiTimer = 0;

  init(ctx: GameContext) {
    this.ctx = ctx;
    this.bg.src = bgUrl;
    if (USE_MOCAP_CLIPS) this.dancer.loadMixamoClips(MIXAMO_CLIPS);
    this.buildScene();
    this.engine.onBeat = () => {
      if (this.engine.beatCount % 8 === 0) this.dancer.nextMove();
    };
  }

  dispose() {
    this.stopSource();
    this.actx?.close();
    this.actx = null;
    this.renderer.dispose();
  }

  applySettings(values: SettingValues) {
    this.engine.sensitivity = values.sens ?? this.engine.sensitivity;
    this.moveAmp = (values.moves ?? this.moveAmp * 100) / 100;
    this.engine.offsetMs = values.sync ?? this.engine.offsetMs;
    this.cheerDuration = values.cheerDur ?? this.cheerDuration;
  }

  action(id: string) {
    if (id === 'burst') {
      this.burst.fire();
      return;
    }
    if (id === 'syncdebug') {
      this.debugSync = !this.debugSync;
      return;
    }
    if (!id.startsWith('cheer')) return;
    const text = CHEERS[Number(id.slice(5))] ?? CHEERS[0];
    if (this.cheer === text) {
      // Nochmal gedrückt: vorzeitig aus — Zoom-out abspielen, Konfetti regnet aus
      this.cheerTimer = Math.min(this.cheerTimer, CHEER_OUT);
    } else {
      this.cheer = text;
      this.cheerTimer = this.cheerDuration;
      this.cheerTris = this.makeCheerLayout();
      // eng hinter dem Oberkörper spawnen — der Avatar verdeckt das Auftauchen
      this.confetti.burst(180, CHEER_X, 500, 160);
      this.confettiTimer = 0.7;
    }
  }

  /**
   * Backdrop-Layout würfeln: eine Reihe verschieden großer Dreiecke
   * (▲▼ alternierend, mit Streuung) plus kleine Akzent-Dreiecke drumherum.
   * Normalisiert auf die Bandbreite — skaliert wird beim Rendern.
   */
  private makeCheerLayout() {
    const tris: typeof this.cheerTris = [];
    // Rückgrat: bis zu 24 Plätze, beim Rendern wird passend zur Textbreite gekürzt
    for (let i = 0; i < 24; i++) {
      tris.push({
        u: 0, // wird beim Rendern aus dem Index berechnet
        xJit: (Math.random() - 0.5) * 0.015,
        y: (Math.random() - 0.5) * 22,
        rf: Math.random(), // Größenfaktor 0..1
        rot: (Math.random() - 0.5) * 0.22,
        delay: 0,
        accent: false,
        ph: Math.random() * Math.PI * 2,
      });
    }
    // Akzente: kleine Dreiecke ober-/unterhalb des Bands
    for (let i = 0; i < 7; i++) {
      const above = Math.random() < 0.5;
      tris.push({
        u: 0.06 + Math.random() * 0.88,
        xJit: 0,
        y: above ? -92 - Math.random() * 26 : 88 + Math.random() * 26,
        rf: Math.random(),
        rot: Math.random() * Math.PI * 2,
        delay: 0,
        accent: true,
        ph: Math.random() * Math.PI * 2,
      });
    }
    return tris;
  }

  onMessage(payload: unknown) {
    const msg = payload as Cmd;
    switch (msg.cmd) {
      case 'hello':
        // Operator-Panel (neu) gestartet — aktuellen Stand nachliefern
        if (this.audioBuffer) this.sendPeaks();
        break;
      case 'load':
        if (msg.data) this.loadTrack(msg.name ?? 'Track', msg.data);
        break;
      case 'play':
        if (this.audioBuffer && !this.usingMic) this.startPlayback();
        break;
      case 'pause':
        if (this.playing && !this.usingMic) this.pausePlayback();
        break;
      case 'tap':
        this.engine.tap(performance.now());
        break;
      case 'auto':
        this.engine.backToAuto();
        break;
      case 'mic':
        this.usingMic ? this.stopMic() : this.startMic();
        break;
      case 'seek':
        this.seekTo(msg.frac ?? 0);
        break;
    }
  }

  getStatus(): Record<string, string | number> {
    return {
      Zustand: !this.dancer.ready
        ? 'Modell lädt …'
        : this.usingMic
          ? 'Mikrofon live'
          : this.playing
            ? 'läuft'
            : this.audioBuffer
              ? 'Pause'
              : 'bereit',
      BPM: this.engine.bpm > 0 ? Math.round(this.engine.bpm) : '—',
      Move: this.dancer.moveName,
      Auszeichnung: this.cheer ?? '—',
      ...(this.debugSync ? { 'Sync-Debug': 'AN' } : {}),
    };
  }

  update(dt: number) {
    this.time += dt;
    const now = performance.now();

    if (this.playing && this.analyser && this.freq) {
      this.analyser.getByteFrequencyData(this.freq);
      this.engine.sample(this.freq, now);
      this.engine.update(now, dt);
    }

    this.dance(dt, now / 1000);

    this.burst.update(dt);

    // Auszeichnung aktiv: Konfetti regnet nach, bis die Zeit abläuft
    this.confetti.update(dt);
    if (this.cheer) {
      this.cheerTimer -= dt;
      if (this.cheerTimer <= 0) {
        this.cheer = null; // automatisch ausblenden
      } else {
        this.confettiTimer -= dt;
        if (this.confettiTimer <= 0) {
          this.confettiTimer = 0.7;
          this.confetti.burst(50, CHEER_X, 500, 160);
        }
      }
    }

    // Kamera schwebt leicht
    this.camera.position.x = Math.sin(this.time * 0.15) * 0.5;
    this.camera.position.y = 1.5 + Math.sin(this.time * 0.4) * 0.05;
    this.camera.lookAt(0, 0.85, 0);

    // Live-Daten ans Operator-Panel (~10 Hz)
    this.tickTimer += dt;
    if (this.tickTimer >= 0.1) {
      this.tickTimer = 0;
      this.sendTick();
    }
  }

  render(g: CanvasRenderingContext2D) {
    // Ebene 0: Burst — liegt unter dem HG, dessen deckende Teile maskieren ihn
    if (this.burst.active) {
      g.drawImage(this.burst.canvas, BURST_X - BURST_SIZE / 2, BURST_Y - BURST_SIZE / 2);
    }
    // Ebene 1: Hintergrund-Asset (transparente Bühnenfläche bleibt durchsichtig
    // fürs Keying im Ü-Wagen)
    if (this.bg.complete && this.bg.naturalWidth) g.drawImage(this.bg, 0, 0, VIEW_W, VIEW_H);
    // Ebene 2: Konfetti HINTER dem Charakter — die Partikel tauchen von
    // der Silhouette verdeckt auf und werden erst beim Rausfliegen sichtbar
    this.confetti.render(g);

    // Ebene 3: 3D-Szene mit Alpha obendrauf
    this.renderer.render(this.scene, this.camera);

    // Just-Dance-Outline im Screen-Space: die Silhouette des gerenderten
    // Charakters weiß einfärben und ringförmig versetzt hinter ihn stempeln.
    // Nur die Außenkontur bekommt eine Linie — keine Artefakte im Inneren.
    if (this.outlineCtx) {
      const oc = this.outlineCtx;
      oc.globalCompositeOperation = 'source-over';
      oc.clearRect(0, 0, VIEW_W, VIEW_H);
      oc.drawImage(this.glCanvas, 0, 0);
      oc.globalCompositeOperation = 'source-in';
      oc.fillStyle = '#ffffff';
      oc.fillRect(0, 0, VIEW_W, VIEW_H);

      const R = 9; // Outline-Dicke in Pixeln
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        g.drawImage(this.outlineCanvas, Math.cos(a) * R, Math.sin(a) * R);
      }
    }

    g.drawImage(this.glCanvas, 0, 0, VIEW_W, VIEW_H);
    // Ebene 4: Auszeichnung obendrauf
    this.renderCheer(g);
    if (this.debugSync) this.renderSyncDebug(g);
  }

  /**
   * Sync-Debug: komplett phasengetrieben von der visuellen Beat-Uhr der
   * Tänzerin — Blitz bei Phase 0 und ein umlaufender Punkt als Metronom
   * (oben = Beat), den man auf den Beat zulaufen sieht. Sync-Offset
   * schieben, bis der Treffer oben mit dem hörbaren Beat zusammenfällt.
   */
  private renderSyncDebug(g: CanvasRenderingContext2D) {
    const cx = 610;
    const cy = 460;
    const R = 100;
    const p = Math.min(Math.max(this.engine.beatPhase, 0), 1);
    const hasGrid = this.engine.periodMs > 0 && this.playing;

    // Groß und unübersehbar — ist ja nur zum Debuggen
    if (hasGrid) {
      const flash = Math.max(0, 1 - p / 0.16);
      if (flash > 0.01) {
        g.globalAlpha = Math.pow(flash, 0.6) * 0.9;
        g.fillStyle = '#e71d73';
        g.beginPath();
        g.arc(cx, cy, 120 + flash * 300, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
      }
    }

    // statischer Ring als Blickanker — kontrastiert auf Weiß UND Livebild
    g.strokeStyle = '#1a1a22';
    g.lineWidth = 12;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = '#e71d73';
    g.lineWidth = 6;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    // Beat-Markierung oben
    g.fillStyle = '#1a1a22';
    g.fillRect(cx - 5, cy - R - 26, 10, 20);

    if (hasGrid) {
      // Metronom: Punkt läuft einmal pro Beat im Uhrzeigersinn um,
      // Treffer oben = Beat
      const ang = p * Math.PI * 2 - Math.PI / 2;
      const dx = cx + Math.cos(ang) * R;
      const dy = cy + Math.sin(ang) * R;
      g.fillStyle = '#1a1a22';
      g.beginPath();
      g.arc(dx, dy, 17, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(dx, dy, 12, 0, Math.PI * 2);
      g.fill();
    }

    // Referenzwerte zum Ablesen beim Schieben
    g.font = "700 40px 'TheSans', system-ui, sans-serif";
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    const bpm = this.engine.bpm > 0 ? Math.round(this.engine.bpm) : '—';
    const mode = !hasGrid ? 'WARTE AUF BEAT' : this.engine.manual ? 'TAP' : `AUTO ${Math.round(this.engine.conf * 100)}%`;
    const info = `${bpm} BPM · Offset ${Math.round(this.engine.offsetMs)} ms · ${mode}`;
    g.strokeStyle = '#1a1a22';
    g.lineWidth = 8;
    g.strokeText(info, cx, cy + 145);
    g.fillStyle = '#ffffff';
    g.fillText(info, cx, cy + 145);
  }

  /**
   * Auszeichnung im Just-Dance-Stil, aber CI-treu: der Backdrop ist ein Band
   * aus alternierenden Dreiecken (▲▼▲▼), das sich beim Einblenden als Welle
   * von links nach rechts aufbaut und beim Ausblenden genauso wieder abbaut.
   */
  private renderCheer(g: CanvasRenderingContext2D) {
    if (!this.cheer) return;

    const color = CHEER_COLORS[CHEERS.indexOf(this.cheer)] ?? CHEER_COLORS[0];
    const elapsed = this.cheerDuration - this.cheerTimer;
    const outElapsed = Math.max(0, CHEER_OUT - this.cheerTimer);

    g.save();
    g.translate(CHEER_X, CHEER_Y);
    g.rotate(-0.05);

    // Titel messen und auf die grüne Fläche einpassen
    g.font = "800 110px 'TheSans', system-ui, sans-serif";
    let w = g.measureText(this.cheer).width;
    let fit = 1;
    if (w > CHEER_MAX_W) {
      fit = CHEER_MAX_W / w;
      w = CHEER_MAX_W;
    }

    /* ---- Dreieck-Cluster (zentriert um y = 0) ---- */
    const bandW = w + 120;
    // Rückgrat-Dreiecke: Anzahl passend zur Breite, damit sie sich kaum überlappen
    const n = Math.min(24, Math.max(6, Math.round(bandW / 75)));
    const spacing = bandW / n;

    const grow = 0.22; // Aufplopp-Dauer eines einzelnen Dreiecks
    const shrink = 0.16;

    g.fillStyle = color;
    g.shadowColor = color;
    g.shadowBlur = 26;
    let backbone = 0;
    for (const t of this.cheerTris) {
      let u: number;
      let r: number;
      let dir: number;
      if (t.accent) {
        u = t.u;
        r = 20 + t.rf * 26;
        dir = t.rf < 0.5 ? 1 : -1;
      } else {
        if (backbone >= n) continue; // überzählige Rückgrat-Plätze bei kurzen Titeln
        u = (backbone + 0.5) / n + t.xJit;
        r = spacing * (0.82 + t.rf * 0.28); // verschieden groß, kaum Überlappung
        dir = backbone % 2 === 0 ? 1 : -1; // Spitze abwechselnd oben/unten
        backbone++;
      }

      // Auf- und Abbau-Welle von links nach rechts
      let s = backOut(clamp01((elapsed - u * (CHEER_IN - grow)) / grow));
      if (outElapsed > 0) s *= Math.pow(1 - clamp01((outElapsed - u * (CHEER_OUT - shrink)) / shrink), 1.5);
      if (s <= 0.01) continue;

      // Schweben + langsames Durchdrehen im Stand — jedes Dreieck mit eigener
      // Geschwindigkeit, Richtung und Phase, damit nichts synchron läuft
      const wSpeed = 0.5 + t.rf * 0.6;
      const spin = (t.rf < 0.5 ? -1 : 1) * (0.12 + Math.abs(t.rf - 0.5) * 0.55);
      const wob = t.rot + this.time * spin + 0.07 * Math.sin(this.time * wSpeed + t.ph);
      const x = (u - 0.5) * bandW + 3 * Math.sin(this.time * (wSpeed * 0.8) + t.ph * 1.7);
      const y = t.y + 4 * Math.sin(this.time * (0.7 + t.rf * 0.4) + t.ph);

      const rs = r * s;
      g.beginPath();
      for (let k = 0; k < 3; k++) {
        // gleichseitiges Dreieck, gedreht um wob, Spitze je nach dir oben/unten
        const ang = wob + (dir * -Math.PI) / 2 + (k * 2 * Math.PI) / 3;
        const px = x + Math.cos(ang) * rs;
        const py = y + Math.sin(ang) * rs;
        k === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
      }
      g.closePath();
      g.fill();
    }
    g.shadowBlur = 0;

    /* ---- Schrift: mittig im Cluster, eigener Pop nach der Welle ---- */
    let ts = backOut(clamp01((elapsed - 0.25) / 0.3));
    const tOut = clamp01(this.cheerTimer / 0.3);
    ts *= tOut * tOut;
    if (ts > 0.01) {
      g.transform(1, 0, -0.18, 1, 0, 0); // kursiver Schub wie bei Just Dance
      g.scale(ts * fit, ts * fit);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.shadowColor = 'rgba(255, 255, 255, 0.85)';
      g.shadowBlur = 28;
      g.fillStyle = '#ffffff';
      // Versalien sitzen mit baseline=middle optisch etwas tief — leicht anheben
      g.fillText(this.cheer, 0, 8);
      g.shadowBlur = 0;
      g.fillText(this.cheer, 0, 8);
    }
    g.restore();
  }

  /* ================== Szene ================== */

  private buildScene() {
    this.glCanvas.width = VIEW_W;
    this.glCanvas.height = VIEW_H;
    this.outlineCanvas.width = VIEW_W;
    this.outlineCanvas.height = VIEW_H;
    this.outlineCtx = this.outlineCanvas.getContext('2d');
    // alpha: die 3D-Ebene liegt über dem Hintergrund-Asset (Overlay-Optik)
    this.renderer = new THREE.WebGLRenderer({ canvas: this.glCanvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(VIEW_W, VIEW_H, false);
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(40, VIEW_W / VIEW_H, 0.1, 50);
    this.camera.position.set(0, 1.5, 4.2);
    this.camera.lookAt(0, 0.85, 0);
    // Blick nach rechts verschieben → der Tänzer landet im Zentrum der
    // transparenten Bühnenfläche des Hintergrunds
    this.camera.setViewOffset(VIEW_W, VIEW_H, VIEW_W / 2 - STAGE_CENTER_X, 0, VIEW_W, VIEW_H);

    /* Gleichmäßiges Licht, keine Schatten, keine Effekte.
       Summe ≈ 1,0 — mehr würde die Toon-Farben Richtung Weiß clippen */
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xdde5cc, 0.5));
    const key = new THREE.SpotLight(0xffffff, 0.55, 20, Math.PI / 5, 0.5, 1.2);
    key.position.set(2.5, 5, 3);
    this.scene.add(key);

    this.scene.add(this.dancer.root);
  }

  private dance(dt: number, nowS: number) {
    // Energie moduliert die Amplitude
    const k = this.playing ? this.moveAmp * Math.min(1, 0.35 + this.engine.energy * 1.6) : 0;

    // in [0..1] klemmen — negative Phase würde über pow(sin·π) NaN erzeugen
    const p = Math.min(Math.max(this.engine.beatPhase, 0), 1);
    // Seite wechselt pro Beat, aber weich übergeblendet statt hart geschnappt
    const dirTarget = this.engine.beatCount % 2 ? 1 : -1;
    this.dirSmooth += (dirTarget - this.dirSmooth) * Math.min(1, dt * 9);
    this.dancer.pose(
      {
        k,
        p,
        dip: Math.pow(Math.sin(p * Math.PI), 1.4), // runter auf den Beat
        dir: this.dirSmooth,
        s1: Math.sin(p * Math.PI),
        s2: Math.sin(p * Math.PI * 2),
        nod: Math.exp(-p * 5), // klingt nach dem Beat ab
        beatCount: this.engine.beatCount,
        bpm: this.engine.bpm,
      },
      nowS,
      dt,
    );
  }

  /* ================== Audio ================== */

  private ensureCtx() {
    if (!this.actx) {
      this.actx = new AudioContext();
      this.analyser = this.actx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.3; // wenig Smoothing → schärfere Onsets
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    }
    if (this.actx.state === 'suspended') this.actx.resume();
  }

  private stopSource() {
    if (this.sourceNode) {
      try {
        this.sourceNode.stop();
      } catch {}
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    this.playing = false;
    this.usingMic = false;
  }

  private async loadTrack(name: string, data: ArrayBuffer) {
    this.ensureCtx();
    this.audioBuffer = await this.actx!.decodeAudioData(data);
    this.trackName = name;
    this.pauseOffset = 0;
    this.sendPeaks();
    this.startPlayback();
  }

  private startPlayback(keepTracking = false) {
    if (!this.audioBuffer) return;
    this.ensureCtx();
    this.stopSource();
    if (keepTracking) this.engine.realign(); // Seek: Tempo behalten, Beat-Grid neu ausrichten
    else this.engine.reset();
    this.sourceNode = this.actx!.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.loop = true;
    this.sourceNode.connect(this.analyser!);
    this.analyser!.connect(this.actx!.destination);
    this.startedAt = this.actx!.currentTime - this.pauseOffset;
    this.sourceNode.start(0, this.pauseOffset % this.audioBuffer.duration);
    this.playing = true;
    this.sendTick();
  }

  private pausePlayback() {
    this.pauseOffset = this.actx!.currentTime - this.startedAt;
    this.stopSource();
    try {
      this.analyser?.disconnect();
    } catch {}
    this.sendTick();
  }

  private async startMic() {
    this.ensureCtx();
    this.stopSource();
    this.engine.reset();
    try {
      this.analyser?.disconnect(); // Mikro nicht auf die Boxen legen
    } catch {}
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const src = this.actx!.createMediaStreamSource(this.micStream);
      src.connect(this.analyser!);
      this.playing = true;
      this.usingMic = true;
    } catch {
      this.ctx?.sendToOperator({ kind: 'error', text: 'Mikrofon-Zugriff verweigert' });
    }
    this.sendTick();
  }

  private stopMic() {
    this.stopSource();
    this.sendTick();
  }

  private currentPos(): number {
    if (!this.audioBuffer) return 0;
    const t = this.playing && !this.usingMic ? this.actx!.currentTime - this.startedAt : this.pauseOffset;
    const d = this.audioBuffer.duration;
    return ((t % d) + d) % d; // loop-sicher
  }

  private seekTo(frac: number) {
    if (!this.audioBuffer || this.usingMic) return;
    this.pauseOffset = Math.min(0.999, Math.max(0, frac)) * this.audioBuffer.duration;
    if (this.playing) this.startPlayback(true); // Tempo behalten, Grid neu ausrichten
    else this.sendTick();
  }

  /* ================== Events ans Operator-Panel ================== */

  private sendTick() {
    this.ctx?.sendToOperator({
      kind: 'tick',
      playing: this.playing,
      usingMic: this.usingMic,
      hasTrack: !!this.audioBuffer,
      trackName: this.trackName,
      pos: this.currentPos(),
      dur: this.audioBuffer?.duration ?? 0,
      bpm: this.engine.bpm,
      conf: this.engine.conf,
      manual: this.engine.manual,
      move: this.dancer.moveName,
    });
  }

  /** RMS-Peaks der Wellenform fürs Operator-Panel (einmal pro Track) */
  private sendPeaks(buckets = 900) {
    const buffer = this.audioBuffer!;
    const chs: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chs.push(buffer.getChannelData(c));
    const step = buffer.length / buckets;
    const peaks = new Array<number>(buckets);
    let maxV = 1e-6;
    for (let b = 0; b < buckets; b++) {
      const s0 = Math.floor(b * step);
      const s1 = Math.floor((b + 1) * step);
      let sum = 0;
      let n = 0;
      for (let s = s0; s < s1; s += 16) {
        // Stride reicht fürs Bild
        for (const ch of chs) sum += ch[s] * ch[s];
        n += chs.length;
      }
      peaks[b] = Math.sqrt(sum / Math.max(1, n)); // RMS pro Bucket
      if (peaks[b] > maxV) maxV = peaks[b];
    }
    // Normalisieren + leichte Kompression → Hook/Drop stechen sichtbar raus
    for (let b = 0; b < buckets; b++) peaks[b] = Math.pow(peaks[b] / maxV, 0.7);
    this.ctx?.sendToOperator({ kind: 'peaks', peaks, duration: buffer.duration, name: this.trackName });
  }
}
