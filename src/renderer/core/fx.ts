import type { CheerAnchor } from './cheer';
import type { StationMode } from './game';
import { rautePath, rauteForTriangle, trianglePath } from './shapes';

/** Globale Show-Effekte (Operator-Schublade „Show“) — der Host legt sie wie
 *  die Kommentare über jedes Spiel. Partikel sind bei BAYERN 3 Dreiecke, bei
 *  BAYERN 1 / Mitsingkonzert die abgerundete Raute (core/shapes.ts). Ursprung ist die freie Fläche, die das
 *  Spiel über Game.cheerAnchor() meldet. */
export type FxId = 'confetti' | 'rain' | 'explode';

/** Partikel-Farben: BAYERN 3 = CI-Palette (Hellgrün, Blau, Pink, Orange),
 *  BAYERN 1 / Mitsingkonzert = B1-Palette (Blau, Hellblau, Dunkelblau, Koralle) */
const B1_COLORS = ['#00a0d5', '#00bef5', '#001e46', '#e24f36'];
const COLORS: Record<StationMode, string[]> = {
  b3: ['#9be600', '#2699d6', '#e71d73', '#f9b233'],
  b1: B1_COLORS,
  mk: B1_COLORS,
};

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  spin: number;
  /** Umkreisradius des Dreiecks */
  r: number;
  life: number;
  maxLife: number;
  color: string;
  /** Schwerkraft px/s² */
  grav: number;
  /** Luftwiderstand: Anteil Geschwindigkeit, der pro Sekunde bleibt */
  drag: number;
  /** wächst kurz auf (Pop) statt sofort voll da zu sein */
  pop: boolean;
  /** BAYERN 1 / Mitsingkonzert: Raute statt Dreieck */
  raute: boolean;
}

export class ShowFx {
  private particles: Particle[] = [];
  /** Dreiecks-Regen: Restlaufzeit + Nachschub-Akku */
  private rainTimer = 0;
  private rainAcc = 0;
  private rainW = 0;
  private rainColors: string[] = COLORS.b3;
  private rainRaute = false;
  /** Form der Partikel, die gerade gefeuert werden */
  private raute = false;

  fire(id: FxId, anchor: CheerAnchor, viewW: number, viewH: number, mode: StationMode) {
    const colors = COLORS[mode];
    this.raute = mode !== 'b3';
    if (id === 'confetti') this.confetti(anchor, viewH, colors);
    else if (id === 'explode') this.explode(anchor, colors);
    else if (id === 'rain') {
      // nochmal gedrückt während er läuft = verlängern
      this.rainTimer = Math.min(this.rainTimer + 4, 8);
      this.rainW = viewW;
      this.rainColors = colors;
      this.rainRaute = this.raute;
    }
  }

  /** Konfetti-Kanone aus der freien Fläche (wie beim Applausometer-Gewinn) */
  private confetti(a: CheerAnchor, viewH: number, colors: string[]) {
    const cy = Math.min(a.y + 200, viewH * 0.6);
    for (let i = 0; i < 180; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 300 + Math.random() * 700;
      const life = 1.5 + Math.random() * 1.5;
      this.particles.push({
        x: a.x + (Math.random() - 0.5) * Math.min(400, a.maxW),
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 400,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 10,
        r: 7 + Math.random() * 5,
        life,
        maxLife: life,
        color: colors[i % colors.length],
        grav: 900,
        drag: 1,
        pop: false,
        raute: this.raute,
      });
    }
  }

  /** Dreiecks-Explosion: große Dreiecke fliegen ringförmig auseinander,
   *  bremsen ab und schrumpfen weg — schwerelos, kein Fallen */
  private explode(a: CheerAnchor, colors: string[]) {
    const n = 46;
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
      const speed = 500 + Math.random() * 900;
      const life = 0.9 + Math.random() * 0.6;
      this.particles.push({
        x: a.x,
        y: a.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        // Rauten bleiben stehend (wie im Logo) und kippeln nur leicht
        rot: this.raute ? (Math.random() - 0.5) * 0.4 : Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * (this.raute ? 0.8 : 6),
        r: 18 + Math.random() * 38,
        life,
        maxLife: life,
        color: colors[Math.floor(Math.random() * colors.length)],
        grav: 0,
        drag: 0.08,
        pop: true,
        raute: this.raute,
      });
    }
  }

  private spawnRain(n: number) {
    for (let i = 0; i < n; i++) {
      const life = 3 + Math.random();
      this.particles.push({
        x: Math.random() * this.rainW,
        y: -60,
        vx: (Math.random() - 0.5) * 80,
        vy: 450 + Math.random() * 350,
        rot: this.rainRaute ? (Math.random() - 0.5) * 0.4 : Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * (this.rainRaute ? 0.8 : 4),
        r: 10 + Math.random() * 22,
        life,
        maxLife: life,
        color: this.rainColors[Math.floor(Math.random() * this.rainColors.length)],
        grav: 120,
        drag: 1,
        pop: false,
        raute: this.rainRaute,
      });
    }
  }

  update(dt: number) {
    if (this.rainTimer > 0) {
      this.rainTimer -= dt;
      this.rainAcc += dt * 70;
      const n = Math.floor(this.rainAcc);
      this.rainAcc -= n;
      this.spawnRain(n);
    }
    for (const p of this.particles) {
      const k = Math.pow(p.drag, dt);
      p.vx *= k;
      p.vy *= k;
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  render(g: CanvasRenderingContext2D) {
    for (const p of this.particles) {
      let s = 1;
      if (p.pop) {
        // kurz aufploppen, zum Ende hin wegschrumpfen
        const age = p.maxLife - p.life;
        s = Math.min(1, age / 0.12) * Math.min(1, p.life / (p.maxLife * 0.6));
      } else {
        g.globalAlpha = Math.min(1, p.life);
      }
      if (s <= 0.01) continue;
      const r = p.r * s;
      g.fillStyle = p.color;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      if (p.raute) rautePath(g, rauteForTriangle(r));
      else trianglePath(g, r);
      g.fill();
      g.restore();
      g.globalAlpha = 1;
    }
  }
}
