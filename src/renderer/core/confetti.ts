import { VIEW_W, VIEW_H } from './game';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Drehwinkel + Drehgeschwindigkeit (rad, rad/s) */
  rot: number;
  spin: number;
  size: number;
  life: number;
  color: string;
}

/** Konfetti-Regen für den Gewinn-Moment: Dreiecke in den BR3-Farben */
export class Confetti {
  private particles: Particle[] = [];

  // BR3 Hellgrün, Blau, Pink, Orange
  private readonly colors = ['#9be600', '#2699d6', '#e71d73', '#f9b233'];

  burst(count = 120, cx = VIEW_W / 2, cy = VIEW_H / 3, spread = 400) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 300 + Math.random() * 700;
      this.particles.push({
        x: cx + (Math.random() - 0.5) * spread,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 400,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 10,
        size: 14 + Math.random() * 10,
        life: 1.5 + Math.random() * 1.5,
        color: this.colors[i % this.colors.length],
      });
    }
  }

  update(dt: number) {
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 900 * dt;
      p.rot += p.spin * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  render(g: CanvasRenderingContext2D) {
    for (const p of this.particles) {
      g.globalAlpha = Math.min(1, p.life);
      g.fillStyle = p.color;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      // gleichseitiges Dreieck um den Mittelpunkt
      const r = p.size / 2;
      g.beginPath();
      g.moveTo(0, -r);
      g.lineTo(r * 0.866, r * 0.5);
      g.lineTo(-r * 0.866, r * 0.5);
      g.closePath();
      g.fill();
      g.restore();
    }
    g.globalAlpha = 1;
  }

  clear() {
    this.particles = [];
  }
}
