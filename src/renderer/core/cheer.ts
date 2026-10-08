import type { StationMode } from './game';
import { rautePath, rauteForTriangle } from './shapes';

/** Wo ein Kommentar auf der Wall steht — Mitte des Bands in View-
 *  Koordinaten + maximale Textbreite (längere Texte schrumpfen). Jedes
 *  Spiel gibt seine freie Fläche über Game.cheerAnchor() vor. */
export interface CheerAnchor {
  x: number;
  y: number;
  maxW: number;
}

/** Knallfarben der Dreiecke, abwechselnd nach Listenplatz. Kein Hellgrün —
 *  das ginge auf den grünen Hintergründen unter. BAYERN 1 / Mitsingkonzert
 *  analog: Senderblau und Koralle im Wechsel. */
const COLORS: Record<StationMode, string[]> = {
  b3: ['#e71d73', '#2699d6'],
  b1: ['#00a0d5', '#e24f36'],
  mk: ['#00a0d5', '#e24f36'],
};

// Ein-/Ausblend-Zeiten: Dreieck-Welle von links nach rechts
const CHEER_IN = 0.65;
const CHEER_OUT = 0.5;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
/** Ease-out-back: schwingt kurz über 1 hinaus (Pop) */
const backOut = (t: number) => {
  const c1 = 1.70158;
  const u = t - 1;
  return 1 + (c1 + 1) * u * u * u + c1 * u * u;
};

interface Tri {
  xJit: number;
  y: number;
  rf: number;
  rot: number;
  accent: boolean;
  u: number;
  /** Phase fürs Schweben/Drehen im Stand */
  ph: number;
}

/**
 * Globaler Kommentar („TANZGOTT“, Freitext, …) im Just-Dance-Stil, aber
 * CI-treu: der Backdrop ist ein Band aus alternierenden Dreiecken (▲▼▲▼,
 * BAYERN 1: abgerundete Rauten aus dem Logo),
 * das sich beim Einblenden als Welle von links nach rechts aufbaut und beim
 * Ausblenden genauso wieder abbaut. Der Host zeichnet ihn über jedes Spiel.
 */
export class CheerOverlay {
  private text: string | null = null;
  /** Farbindex (Listenplatz des Kommentars, Freitext = 0) */
  private colorIndex = 0;
  /** Restlaufzeit — die Schrift verschwindet von selbst */
  private timer = 0;
  private duration = 5;
  private time = 0;
  /** Gewürfeltes Dreieck-Layout (pro Aktivierung neu) */
  private tris: Tri[] = [];

  /** Aktuell angezeigter Text (null = keiner) */
  get current(): string | null {
    return this.text;
  }

  /** Kommentar zeigen. Derselbe Text nochmal = vorzeitig ausblenden. */
  show(text: string, colorIndex: number, duration: number) {
    const t = text.trim().toUpperCase();
    if (!t) return;
    if (this.text === t) {
      this.hide();
      return;
    }
    this.text = t;
    this.colorIndex = colorIndex;
    this.duration = duration;
    this.timer = duration;
    this.tris = makeLayout();
  }

  /** Ausblenden — Zoom-out abspielen statt hart weg */
  hide() {
    this.timer = Math.min(this.timer, CHEER_OUT);
  }

  update(dt: number) {
    this.time += dt;
    if (!this.text) return;
    this.timer -= dt;
    if (this.timer <= 0) this.text = null;
  }

  render(g: CanvasRenderingContext2D, anchor: CheerAnchor, mode: StationMode) {
    if (!this.text) return;

    const palette = COLORS[mode];
    /** BAYERN 1 / Mitsingkonzert: Rauten-Band statt Dreiecke */
    const raute = mode !== 'b3';
    const color = palette[this.colorIndex % palette.length];
    const elapsed = this.duration - this.timer;
    const outElapsed = Math.max(0, CHEER_OUT - this.timer);

    g.save();
    g.translate(anchor.x, anchor.y);
    g.rotate(-0.05);

    // Titel messen und auf die freie Fläche einpassen
    g.font = "800 110px 'TheSans', system-ui, sans-serif";
    let w = g.measureText(this.text).width;
    let fit = 1;
    if (w > anchor.maxW) {
      fit = anchor.maxW / w;
      w = anchor.maxW;
    }

    /* ---- Dreieck-Cluster (zentriert um y = 0) ---- */
    const bandW = w + 120;
    // Rückgrat-Dreiecke: Anzahl passend zur Breite, damit sie sich kaum überlappen
    const n = Math.min(24, Math.max(6, Math.round(bandW / 75)));
    const spacing = bandW / n;

    const grow = 0.22; // Aufplopp-Dauer eines einzelnen Dreiecks
    const shrink = 0.16;

    g.fillStyle = color;
    let backbone = 0;
    for (const t of this.tris) {
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
      if (raute) {
        // BAYERN 1: Raute statt Dreieck — bleibt stehend (wie im Logo), nur
        // leichtes Kippeln statt Durchdrehen
        g.save();
        g.translate(x, y);
        g.rotate((t.accent ? 0 : t.rot) + 0.07 * Math.sin(this.time * wSpeed + t.ph));
        rautePath(g, rauteForTriangle(rs));
        g.fill();
        g.restore();
        continue;
      }
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

    /* ---- Schrift: mittig im Cluster, eigener Pop nach der Welle ---- */
    let ts = backOut(clamp01((elapsed - 0.25) / 0.3));
    const tOut = clamp01(this.timer / 0.3);
    ts *= tOut * tOut;
    if (ts > 0.01) {
      g.transform(1, 0, -0.18, 1, 0, 0); // kursiver Schub wie bei Just Dance
      g.scale(ts * fit, ts * fit);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#ffffff';
      // Versalien sitzen mit baseline=middle optisch etwas tief — leicht anheben
      g.fillText(this.text, 0, 8);
    }
    g.restore();
  }
}

/**
 * Backdrop-Layout würfeln: eine Reihe verschieden großer Dreiecke
 * (▲▼ alternierend, mit Streuung) plus kleine Akzent-Dreiecke drumherum.
 * Normalisiert auf die Bandbreite — skaliert wird beim Rendern.
 */
function makeLayout(): Tri[] {
  const tris: Tri[] = [];
  // Rückgrat: bis zu 24 Plätze, beim Rendern wird passend zur Textbreite gekürzt
  for (let i = 0; i < 24; i++) {
    tris.push({
      u: 0, // wird beim Rendern aus dem Index berechnet
      xJit: (Math.random() - 0.5) * 0.015,
      y: (Math.random() - 0.5) * 22,
      rf: Math.random(), // Größenfaktor 0..1
      rot: (Math.random() - 0.5) * 0.22,
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
      accent: true,
      ph: Math.random() * Math.PI * 2,
    });
  }
  return tris;
}
