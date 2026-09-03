import { Game, GameContext, SettingValues, VIEW_W, VIEW_H } from '../../core/game';
import { Confetti } from '../../core/confetti';
import { repairEdges } from '../../core/assets';
import bgUrl from './assets/final/Applausemeter_hk_bg.png';
import textUrl from './assets/final/Applausometer_hk_text.png';

type State = 'playing' | 'won';

/* Aus dem finalen Hochkant-Asset (Applausemeter_hk_bg.png, 641×1025) vermessen
 * und mit dem Cover-Faktor 1920/1025 in View-Koordinaten umgerechnet: */
// Die weiße Meter-Bahn ist ein spitz zulaufendes Dreieck im grünen Keil,
// jetzt LINKS: oben breit, linke Kante senkrecht, rechte Kante läuft schräg
// auf die Spitze unten zu. Gefüllt wird per Clip auf dieses Polygon.
// Die schräge rechte Kante liegt bewusst 3 px ÜBER der Weiß-Kante im Grün:
// endet der Clip exakt auf dem Weiß, lässt seine Anti-Aliasing-Feder einen
// hellen Saum zwischen Füllung und Grün durchscheinen (links passiert das
// nicht — die senkrechte Kante ist pixel-bündig).
const SLOT: Array<[number, number]> = [
  [88, 208], // oben links
  [381, 208], // oben rechts (+3 Überdeckung)
  [91, 1435], // Spitze unten (+3 Überdeckung)
  [88, 1435], // Spitze, linke Kante
];
// Vertikale Skala = Skalenstriche des Backgrounds
const SCALE_BOTTOM = 1442;
const SCALE_TOP = 214;
// Mitte der freien (transparenten) Fläche rechts — Konfetti-Ursprung
const NUM_X = 840;

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
  /** Peak-Balken (blau) zeichnen — Operator-Toggle */
  private showPeak = true;
  private time = 0;
  /** Nach einem Gewinn: kurze Pause, bevor der Pegel wieder steigen kann */
  private winTimer = 0;
  /** Gewinn-Schwung: abklingende Aufwärts-Geschwindigkeit fürs Überschießen */
  private winPush = 0;
  /** aktuelle Steiggeschwindigkeit des Pegels (für die nahtlose Übergabe) */
  private riseVel = 0;
  /** Humanizer: abklingende Spitze (einzelne laute Klatscher/Rufe) */
  private spike = 0;
  private confetti = new Confetti();
  private ctx: GameContext | null = null;
  private bg = new Image();
  /** BG mit repariertem Export-Rand (siehe core/assets.ts), lazy erzeugt */
  private bgFixed: HTMLCanvasElement | null = null;
  private text = new Image();

  init(ctx: GameContext) {
    this.ctx = ctx;
    this.bg.src = bgUrl;
    this.text.src = textUrl;
  }

  applySettings(values: SettingValues) {
    this.fader = (values.fader ?? this.fader * 100) / 100;
    this.threshold = (values.threshold ?? this.threshold * 100) / 100;
    this.showPeak = (values.peak ?? 1) > 0;
  }

  action(id: string) {
    if (id === 'reset') {
      this.state = 'playing';
      this.winTimer = 0;
      this.winPush = 0;
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
    // Steigen nur im Spielbetrieb; Fallen erst, wenn der Gewinn-Schwung
    // (winPush) ausgelaufen ist — sonst würde der Release das Überschießen
    // sofort wieder auffressen
    const prevLevel = this.level;
    if (raw > this.level && this.state === 'playing') {
      // Anschwellen: zügig, aber nicht schlagartig
      this.level += (raw - this.level) * Math.min(1, dt * 6);
    } else if (raw < this.level && this.winPush < 0.02) {
      // langsamer Abfall (Release)
      this.level = Math.max(raw, this.level - dt * this.fallSpeed);
    }

    // Gewinn-Schwung: abklingende Aufwärts-Geschwindigkeit — der Pegel
    // gleitet mit Ease-out über den Grenzwert hinaus statt zu springen
    if (this.winPush > 0.005) {
      this.level = Math.min(1, this.level + this.winPush * dt);
      this.winPush *= Math.exp(-dt * 4);
    }
    if (dt > 0) this.riseVel = (this.level - prevLevel) / dt;
    this.peak = Math.max(this.peak - dt * 0.08, this.level);

    // --- Gewinn: Konfetti, Fader auf null — der Pegel fällt von allein ab ---
    if (this.state === 'playing' && this.level >= this.threshold) {
      this.state = 'won';
      this.winTimer = 2;
      this.confetti.burst(180, NUM_X, VIEW_H / 3);
      // Schwung mitgeben: startet mit der ECHTEN Steiggeschwindigkeit des
      // Gewinn-Moments (kein Knick an der Linie) und klingt dann weich ab
      this.winPush = Math.min(0.6, Math.max(0.18, this.riseVel));
      this.fader = 0;
      this.ctx?.setSetting('fader', 0);
    }

    this.confetti.update(dt);
  }

  render(g: CanvasRenderingContext2D) {
    // Hintergrund-Asset (bis es dekodiert ist: neutrale Fläche)
    if (!this.bgFixed && this.bg.complete && this.bg.naturalWidth) {
      this.bgFixed = repairEdges(this.bg);
    }
    if (this.bgFixed) {
      g.drawImage(this.bgFixed, 0, 0, VIEW_W, VIEW_H);
    } else {
      g.fillStyle = '#94c01c';
      g.fillRect(0, 0, VIEW_W, VIEW_H);
    }

    this.renderMeter(g);

    // Schriftzug-Ebene ("Applausometer") über Bahn und Füllung
    if (this.text.complete && this.text.naturalWidth) {
      g.drawImage(this.text, 0, 0, VIEW_W, VIEW_H);
    }

    // Bei Gewinn: nur Konfetti, kein Schriftzug
    this.confetti.render(g);
  }

  private renderMeter(g: CanvasRenderingContext2D) {
    const fillBottom = SCALE_BOTTOM;
    const fillH = fillBottom - SCALE_TOP;

    // Füllung und Peak leben NUR im Schlitz: Clip auf das Bahn-Dreieck —
    // die weiße Bahn bleibt außenrum als Rahmen/Restfläche sichtbar
    g.save();
    g.beginPath();
    SLOT.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.clip();

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
      g.fillRect(0, fillBottom - top * fillH, SLOT[1][0], (top - from) * fillH);
    }

    // Peak-Marker — BR3-Blau statt Dunkel: fast-schwarze Pixel würden
    // beim Luma-Key im Ü-Wagen mit ausgestanzt
    if (this.showPeak) {
      const peakY = fillBottom - this.peak * fillH;
      g.fillStyle = '#2699d6';
      g.fillRect(0, peakY - 4, SLOT[1][0], 8);
    }

    // Grenzwert: gestrichelte Pink-Linie — läuft im selben Clip wie die
    // Füllung und ist damit NUR auf der weißen Bahn sichtbar
    const thrY = fillBottom - this.threshold * fillH;
    g.strokeStyle = '#e71d73';
    g.lineWidth = 8;
    g.setLineDash([26, 16]);
    g.beginPath();
    g.moveTo(0, thrY);
    g.lineTo(SLOT[1][0], thrY);
    g.stroke();
    g.restore();
  }
}
