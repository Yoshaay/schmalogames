/** Repariert die Randzeilen eines Asset-Exports.
 *
 * Viele der 641×1025-Exporte haben voll- oder halbtransparente Randzeilen
 * (halbe Pixel-Ausrichtung beim Export — teils 1 px, teils 2 px breit).
 * Beim Skalieren sampelt das Canvas-Filtering in diese Zeilen hinein —
 * ums Bild zieht sich dann eine dunkle Naht, hinter der das Live-Bild
 * durchscheint. Ein Quell-Crop reicht nicht, weil das Filtering auch über
 * den Quellausschnitt hinaus liest.
 *
 * Repariert wird PIXELGENAU statt zeilenweise: Ein Randpixel wird nur
 * aufgefüllt, wenn sein innerer Nachbar deckend ist (dann gehört es zur
 * Fläche und der Export hat es kaputtgemacht). Halbtransparente Pixel an
 * echten Schräg-Kanten (Keil-/Banner-Spitzen, Live-Flächen) behalten ihr
 * Anti-Aliasing — zeilenweises Kopieren hatte solche Spitzen blockig
 * gemacht. Gearbeitet wird von der inneren zur äußeren Randlinie, damit
 * sich die Reparatur nach außen durchkettet. */
export function repairEdges(img: HTMLImageElement): HTMLCanvasElement {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, w, h);
  const px = d.data;

  /** Randpixel (x,y) anhand des inneren Nachbarn (ix,iy) auffüllen —
   *  KOMPLETT übernehmen (Farbe + Alpha): Halbtransparente Randpixel
   *  tragen oft eine Misch-Farbe aus dem Kanten-Anti-Aliasing; nur das
   *  Alpha zu heben würde diese Blend-Farbe als deckende Linie sichtbar
   *  machen. */
  const fix = (x: number, y: number, ix: number, iy: number) => {
    const o = (y * w + x) * 4;
    const i = (iy * w + ix) * 4;
    if (px[o + 3] >= 250 || px[i + 3] < 250) return;
    px[o] = px[i];
    px[o + 1] = px[i + 1];
    px[o + 2] = px[i + 2];
    px[o + 3] = 255;
  };

  for (let k = 1; k >= 0; k--) {
    for (let x = 0; x < w; x++) {
      fix(x, k, x, k + 1);
      fix(x, h - 1 - k, x, h - 2 - k);
    }
    for (let y = 0; y < h; y++) {
      fix(k, y, k + 1, y);
      fix(w - 1 - k, y, w - 2 - k, y);
    }
  }
  g.putImageData(d, 0, 0);
  return c;
}
