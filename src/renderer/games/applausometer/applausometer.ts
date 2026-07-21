import { Game, GameContext, SettingValues, VIEW_W, VIEW_H } from '../../core/game';
import { Confetti } from '../../core/confetti';
import bgUrl from './assets/Applausometer_Background.png';
import dashUrl from './assets/Applausometer_Dash.png';

type State = 'playing' | 'won';

/* Aus dem Background-Asset (1920×1080) vermessen: */
// weiße Meter-Bahn links (das weiße Rechteck)
const BAR_X = 117;
const BAR_W = 322 - 117;
// Vertikale Skala = Skalenstriche des Backgrounds (liegen 6 px innerhalb der
// Bahn — das ist das vertikale Padding). So sitzt auch das Dash-Overlay bei
// jedem Grenzwert exakt auf dem Raster des Designs.
const SCALE_BOTTOM = 989;
const SCALE_TOP = 232;
// Horizontaler Innenabstand der Füllung — die Bahn bleibt als Rahmen sichtbar
const PAD = 12;
// Höhe, auf der die Linie im Dash-Overlay liegt
const DASH_Y = 383;
// Mitte der großen weißen Fläche (Konfetti-Ursprung)
const NUM_X = 1216;

export class Applausometer implements Game {
  private state: State = 'playing';
  private threshold = 0.85;
  /** Wie schnell der Pegel fällt, Anteil pro Sekunde (Release) */
  private readonly fallSpeed = 0.3;
  /** Zielwert vom Operator-Fader, 0..1 */
  private fader = 0;
  /** Geglätteter Fader — folgt dem Regler träge, damit nichts springt */
  private faderSmooth = 0;

  /** Angezeigter Pegel 0..1: schneller Anstieg, langsamer Abfall */
  private level = 0;
  /** Peak-Marker, sinkt langsam */
  private peak = 0;
  private time = 0;
  /** Nach einem Gewinn: kurze Pause, bevor der Pegel wieder steigen kann */
  private winTimer = 0;
  /** Humanizer: abklingende Spitze (einzelne laute Klatscher/Rufe) */
  private spike = 0;
  private confetti = new Confetti();
  private ctx: GameContext | null = null;
  private bg = new Image();
  private dash = new Image();

  init(ctx: GameContext) {
    this.ctx = ctx;
    this.bg.src = bgUrl;
    this.dash.src = dashUrl;
  }

  applySettings(values: SettingValues) {
    this.fader = (values.fader ?? this.fader * 100) / 100;
    this.threshold = (values.threshold ?? this.threshold * 100) / 100;
  }

  action(id: string) {
    if (id === 'reset') {
      this.state = 'playing';
      this.winTimer = 0;
      this.level = 0;
      this.peak = 0;
      this.confetti.clear();
      this.fader = 0;
      this.faderSmooth = 0;
      this.ctx?.setSetting('fader', 0);
    }
  }

  getStatus(): Record<string, string | number> {
    return {
      Zustand: this.state === 'won' ? 'GEWONNEN' : 'läuft',
      Pegel: `${Math.round(this.level * 100)} %`,
      Peak: `${Math.round(this.peak * 100)} %`,
    };
  }

  update(dt: number) {
    this.time += dt;

    // --- Gewinn-Pause: erst danach kann der Pegel wieder steigen ---
    if (this.state === 'won') {
      this.winTimer -= dt;
      if (this.winTimer <= 0) this.state = 'playing';
    }

    // --- Fader entschärfen: Reglerbewegungen kommen träge an, nicht 1:1 ---
    this.faderSmooth += (this.fader - this.faderSmooth) * Math.min(1, dt * 1.5);

    // --- Humanizer: Fader-Wert in lebendigen "Applaus"-Pegel übersetzen ---
    const t = this.time;
    // langsames An- und Abschwellen der Menge
    const slow = 0.5 + 0.5 * Math.sin(t * 1.3) * Math.sin(t * 0.7 + 1.7);
    // schnelles Klatsch-Flattern
    const fast = 0.5 + 0.5 * Math.sin(t * 9.1 + Math.sin(t * 4.3) * 2);
    // vereinzelte Spitzen, klingen schnell wieder ab
    this.spike = Math.max(0, this.spike - dt * 3);
    if (Math.random() < dt * 5) this.spike = Math.random() * 0.6;
    const n = 0.45 * slow + 0.35 * fast + 0.2 * this.spike;
    // Fader gibt die Obergrenze vor, der Pegel tanzt knapp darunter
    const raw = Math.min(1, this.faderSmooth * (0.82 + 0.2 * n));

    // --- Pegel glätten ---
    // Steigen nur im Spielbetrieb, Fallen immer (auch nach dem Gewinn)
    if (raw > this.level && this.state === 'playing') {
      // Anschwellen: zügig, aber nicht schlagartig
      this.level += (raw - this.level) * Math.min(1, dt * 6);
    } else if (raw < this.level) {
      // langsamer Abfall (Release)
      this.level = Math.max(raw, this.level - dt * this.fallSpeed);
    }
    this.peak = Math.max(this.peak - dt * 0.08, this.level);

    // --- Gewinn: Konfetti, Fader auf null — der Pegel fällt von allein ab ---
    if (this.state === 'playing' && this.level >= this.threshold) {
      this.state = 'won';
      this.winTimer = 2;
      this.confetti.burst(180, NUM_X, VIEW_H / 3);
      this.fader = 0;
      this.ctx?.setSetting('fader', 0);
    }

    this.confetti.update(dt);
  }

  render(g: CanvasRenderingContext2D) {
    // Hintergrund-Asset (bis es dekodiert ist: neutrale Fläche)
    if (this.bg.complete && this.bg.naturalWidth) {
      g.drawImage(this.bg, 0, 0, VIEW_W, VIEW_H);
    } else {
      g.fillStyle = '#94c01c';
      g.fillRect(0, 0, VIEW_W, VIEW_H);
    }

    this.renderMeter(g);
    // Bei Gewinn: nur Konfetti, kein Schriftzug
    this.confetti.render(g);
  }

  private renderMeter(g: CanvasRenderingContext2D) {
    // Füllbereich: horizontal eingerückt, vertikal auf der Strich-Skala
    const fillX = BAR_X + PAD;
    const fillW = BAR_W - PAD * 2;
    const fillBottom = SCALE_BOTTOM;
    const fillTop = SCALE_TOP;
    const fillH = fillBottom - fillTop;

    // Pegel in festen Farbzonen: untere Hälfte hellgrün, darüber orange, oben pink
    const zones: Array<[from: number, to: number, color: string]> = [
      [0, 0.5, '#9be600'],
      [0.5, 0.75, '#f9b233'],
      [0.75, 1, '#e71d73'],
    ];
    for (const [from, to, color] of zones) {
      const top = Math.min(this.level, to);
      if (top <= from) continue;
      g.fillStyle = color;
      g.fillRect(fillX, fillBottom - top * fillH, fillW, (top - from) * fillH);
    }

    // Peak-Marker — BR3-Blau statt Dunkel: fast-schwarze Pixel würden
    // beim Luma-Key im Ü-Wagen mit ausgestanzt
    const peakY = fillBottom - this.peak * fillH;
    g.fillStyle = '#2699d6';
    g.fillRect(fillX - 6, peakY - 3, fillW + 12, 6);

    // Grenzwert: Dash-Overlay vertikal auf die Grenzwert-Höhe geschoben
    const thrY = fillBottom - this.threshold * fillH;
    if (this.dash.complete && this.dash.naturalWidth) {
      g.drawImage(this.dash, 0, thrY - DASH_Y, VIEW_W, VIEW_H);
    }
  }
}
