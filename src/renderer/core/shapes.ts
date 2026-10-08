/** Grundformen der Sender-CIs: BAYERN 3 arbeitet mit Dreiecken, BAYERN 1
 *  mit der abgerundeten Raute aus dem Logo. */

/** BAYERN-1-Raute, vermessen am Logo (BR1_lang_250201_ws_rgb.svg, Außenkontur
 *  der Raute um die „1“): stehend, halbe Höhe = 1,265 × halbe Breite. Die
 *  Rundung skaliert mit der Raute (CI: 6,5 mm Radius bei A4, proportional) —
 *  an Spitze/Fuß enger als an den Seiten. Werte relativ zur halben Breite. */
const RAUTE_H = 1.265;
const RAUTE_R_TIP = 0.17;
const RAUTE_R_SIDE = 0.33;

/** Gleichseitiges Dreieck um den Mittelpunkt, Umkreisradius r, Spitze oben.
 *  Nur Pfad — füllen macht der Aufrufer. */
export function trianglePath(g: CanvasRenderingContext2D, r: number) {
  g.beginPath();
  g.moveTo(0, -r);
  g.lineTo(r * 0.866, r * 0.5);
  g.lineTo(-r * 0.866, r * 0.5);
  g.closePath();
}

/** BAYERN-1-Raute um den Mittelpunkt, halbe Breite w. Nur Pfad. */
export function rautePath(g: CanvasRenderingContext2D, w: number) {
  const h = w * RAUTE_H;
  const rt = w * RAUTE_R_TIP;
  const rs = w * RAUTE_R_SIDE;
  g.beginPath();
  // Start auf der Kantenmitte oben rechts, dann reihum über die Ecken
  g.moveTo(w / 2, -h / 2);
  g.arcTo(w, 0, 0, h, rs);
  g.arcTo(0, h, -w, 0, rt);
  g.arcTo(-w, 0, 0, -h, rs);
  g.arcTo(0, -h, w, 0, rt);
  g.closePath();
}

/** Halbe Breite einer Raute, die ungefähr so viel Fläche einnimmt wie ein
 *  Dreieck mit Umkreisradius r — damit Partikel beim Senderwechsel nicht
 *  größer oder kleiner wirken. */
export function rauteForTriangle(r: number): number {
  return r * 0.72;
}
