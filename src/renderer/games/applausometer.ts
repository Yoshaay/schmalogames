import { Game, GameContext, GameEntry, SettingValues, VIEW_W, VIEW_H } from '../core/game';
import { Mic } from '../core/mic';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

type State = 'starting' | 'error' | 'playing' | 'won';

class Applausometer implements Game {
  private mic = new Mic();
  private state: State = 'starting';
  private sensitivity = 8;
  private threshold = 0.85;
  /** Wie schnell der Pegel fällt, Anteil pro Sekunde (Release) */
  private fallSpeed = 0.3;

  /** Angezeigter Pegel 0..1: schneller Anstieg, langsamer Abfall */
  private level = 0;
  /** Peak-Marker, sinkt langsam */
  private peak = 0;
  private time = 0;
  /** Nach einem Gewinn: kurze Pause, bevor der Pegel wieder steigen kann */
  private winTimer = 0;
  private particles: Particle[] = [];

  init(_ctx: GameContext) {
    this.mic
      .start()
      .then(() => {
        if (this.state === 'starting') this.state = 'playing';
      })
      .catch(() => {
        this.state = 'error';
      });
  }

  dispose() {
    this.mic.stop();
  }

  applySettings(values: SettingValues) {
    this.sensitivity = values.sensitivity ?? this.sensitivity;
    this.threshold = (values.threshold ?? this.threshold * 100) / 100;
    this.fallSpeed = (values.release ?? this.fallSpeed * 100) / 100;
  }

  action(id: string) {
    if (id === 'reset') {
      this.state = 'playing';
      this.winTimer = 0;
      this.level = 0;
      this.peak = 0;
      this.particles = [];
    }
  }

  getStatus(): Record<string, string | number> {
    const zustand =
      this.state === 'starting'
        ? 'Mikrofon startet …'
        : this.state === 'error'
          ? 'FEHLER: kein Mikrofonzugriff'
          : this.state === 'won'
            ? 'GEWONNEN'
            : 'läuft';
    return {
      Zustand: zustand,
      Pegel: `${Math.round(this.level * 100)} %`,
      Peak: `${Math.round(this.peak * 100)} %`,
    };
  }

  update(dt: number) {
    this.time += dt;

    // --- Gewinn-Pause: Meter bleibt kurz auf null, dann geht's weiter ---
    if (this.state === 'won') {
      this.winTimer -= dt;
      if (this.winTimer <= 0) this.state = 'playing';
    }

    // --- Pegel messen ---
    if (this.state === 'playing') {
      const raw = Math.min(1, this.mic.getLevel() * this.sensitivity);
      if (raw > this.level) {
        // schneller Anstieg
        this.level += (raw - this.level) * Math.min(1, dt * 25);
      } else {
        // langsamer Abfall (Release)
        this.level = Math.max(raw, this.level - dt * this.fallSpeed);
      }
      this.peak = Math.max(this.peak - dt * 0.08, this.level);
    }

    // --- Gewinn: einmal Konfetti, Meter zurücksetzen ---
    if (this.state === 'playing' && this.level >= this.threshold) {
      this.state = 'won';
      this.winTimer = 2;
      this.level = 0;
      this.peak = 0;
      this.spawnConfetti(180);
    }

    // --- Konfetti ---
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 900 * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  private spawnConfetti(count = 120) {
    const colors = ['#94c01c', '#9be600', '#2699d6', '#e71d73', '#f9b233'];
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 300 + Math.random() * 700;
      this.particles.push({
        x: VIEW_W / 2 + (Math.random() - 0.5) * 400,
        y: VIEW_H / 3,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 400,
        life: 1.5 + Math.random() * 1.5,
        color: colors[i % colors.length],
      });
    }
  }

  render(g: CanvasRenderingContext2D) {
    g.fillStyle = '#0b0b12';
    g.fillRect(0, 0, VIEW_W, VIEW_H);

    g.textAlign = 'center';
    if (this.state === 'starting') {
      g.fillStyle = '#888899';
      g.font = '48px system-ui, sans-serif';
      g.fillText('Mikrofon wird gestartet …', VIEW_W / 2, VIEW_H / 2);
      return;
    }
    if (this.state === 'error') {
      g.fillStyle = '#e71d73';
      g.font = '48px system-ui, sans-serif';
      g.fillText('Kein Mikrofonzugriff!', VIEW_W / 2, VIEW_H / 2);
      return;
    }

    this.renderMeter(g);
    // Bei Gewinn: nur Konfetti, kein Schriftzug
    this.renderConfetti(g);
  }

  private renderMeter(g: CanvasRenderingContext2D) {
    const barW = 240;
    const barX = VIEW_W / 2 - barW / 2;
    const barTop = 120;
    const barBottom = VIEW_H - 140;
    const barH = barBottom - barTop;

    // Hintergrund der Skala
    g.fillStyle = '#1a1a26';
    g.fillRect(barX, barTop, barW, barH);

    // Skalenstriche
    g.strokeStyle = '#333344';
    g.lineWidth = 2;
    g.font = '28px system-ui, sans-serif';
    g.textAlign = 'right';
    for (let i = 0; i <= 10; i++) {
      const y = barBottom - (i / 10) * barH;
      g.beginPath();
      g.moveTo(barX - 20, y);
      g.lineTo(barX, y);
      g.stroke();
      g.fillStyle = '#666677';
      g.fillText(`${i * 10}`, barX - 30, y + 10);
    }

    // Pegel: Farbverlauf grün -> gelb -> rot
    const levelH = this.level * barH;
    const grad = g.createLinearGradient(0, barBottom, 0, barTop);
    grad.addColorStop(0, '#94c01c');
    grad.addColorStop(0.6, '#f9b233');
    grad.addColorStop(0.9, '#e71d73');
    g.fillStyle = grad;
    g.fillRect(barX, barBottom - levelH, barW, levelH);

    // Peak-Marker
    const peakY = barBottom - this.peak * barH;
    g.fillStyle = '#ffffff';
    g.fillRect(barX - 10, peakY - 3, barW + 20, 6);

    // Grenzwert-Linie
    const thrY = barBottom - this.threshold * barH;
    g.strokeStyle = '#e71d73';
    g.lineWidth = 6;
    g.setLineDash([24, 16]);
    g.beginPath();
    g.moveTo(barX - 80, thrY);
    g.lineTo(barX + barW + 80, thrY);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#ff5d5d';
    g.font = 'bold 34px system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText('ZIEL', barX + barW + 90, thrY + 12);

    // Prozentzahl
    g.textAlign = 'center';
    g.fillStyle = '#ffffff';
    g.font = 'bold 110px system-ui, sans-serif';
    g.fillText(`${Math.round(this.level * 100)}%`, barX - 260, VIEW_H / 2 + 40);
  }

  private renderConfetti(g: CanvasRenderingContext2D) {
    for (const p of this.particles) {
      g.globalAlpha = Math.min(1, p.life);
      g.fillStyle = p.color;
      g.fillRect(p.x - 8, p.y - 8, 16, 16);
    }
    g.globalAlpha = 1;
  }
}

export const applausometerEntry: GameEntry = {
  id: 'applausometer',
  title: 'Applausometer',
  description: 'Je lauter das Publikum, desto höher der Pegel. Über der Ziellinie ist gewonnen.',
  settings: [
    { key: 'sensitivity', label: 'Empfindlichkeit', min: 1, max: 30, step: 0.5, default: 8 },
    { key: 'threshold', label: 'Grenzwert', min: 20, max: 100, step: 5, default: 85, unit: '%' },
    { key: 'release', label: 'Release (Pegel-Abfall)', min: 5, max: 100, step: 5, default: 30, unit: '%/s' },
  ],
  actions: [{ id: 'reset', label: 'Neue Runde' }],
  create: () => new Applausometer(),
};
