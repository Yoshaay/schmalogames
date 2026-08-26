/** Repariert die Randzeilen eines Asset-Exports.
 *
 * Viele der 641×1025-Exporte haben voll- oder halbtransparente Randzeilen
 * (halbe Pixel-Ausrichtung beim Export — teils 1 px, teils 2 px breit).
 * Beim Skalieren sampelt das Canvas-Filtering in diese Zeilen hinein —
 * ums Bild zieht sich dann eine dunkle Naht, hinter der das Live-Bild
 * durchscheint. Ein Quell-Crop reicht nicht, weil das Filtering auch über
 * den Quellausschnitt hinaus liest. Deshalb: Bild einmalig in einen
 * Offscreen-Canvas kopieren und die äußeren `border` Zeilen/Spalten durch
 * die erste saubere Nachbarzeile ersetzen (unskalierte 1:1-Kopien — bei
 * skaliertem Kopieren würde das Filtering wieder die kaputten Zeilen
 * mitlesen). In ehrlich transparenten Bereichen (Live-Fläche) bleibt die
 * Kante transparent, weil auch die Nachbarzeile dort transparent ist. */
export function repairEdges(img: HTMLImageElement, border = 2): HTMLCanvasElement {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0);
  for (let i = 0; i < border; i++) {
    // obere/untere Zeilen ← erste saubere Zeile
    g.clearRect(0, i, w, 1);
    g.drawImage(img, 0, border, w, 1, 0, i, w, 1);
    g.clearRect(0, h - 1 - i, w, 1);
    g.drawImage(img, 0, h - 1 - border, w, 1, 0, h - 1 - i, w, 1);
    // linke/rechte Spalten ← erste saubere Spalte (aus dem schon
    // zeilen-reparierten Canvas, damit auch die Ecken gefüllt werden)
    g.clearRect(i, 0, 1, h);
    g.drawImage(c, border, 0, 1, h, i, 0, 1, h);
    g.clearRect(w - 1 - i, 0, 1, h);
    g.drawImage(c, w - 1 - border, 0, 1, h, w - 1 - i, 0, 1, h);
  }
  return c;
}
