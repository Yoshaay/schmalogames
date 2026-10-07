/**
 * Ziehbare Spaltengrenze: die Lücke (column-gap) zwischen einem Element
 * und seinem rechten Nachbarn wird zum Griff. Zwei kleine senkrechte
 * Striche mittig in der Lücke zeigen, dass man dort ziehen kann (leuchten
 * bei Hover/Ziehen in --primary). Über der Lücke erscheint der
 * col-resize-Cursor, Ziehen ändert die Breite des linken Elements,
 * Doppelklick setzt sie auf den Layout-Default zurück.
 * Die Breite wird über apply() gesetzt (typisch: eine CSS-Variable) und
 * pro storageKey in localStorage gemerkt.
 */
export interface GapResizeOptions {
  /** Grid-Container, in dessen Lücke gezogen wird */
  container: HTMLElement;
  /** Linkes Element (null/unsichtbar = Griff inaktiv) */
  left: () => HTMLElement | null;
  /** Breite setzen; null = zurück zum Default aus dem CSS */
  apply: (px: number | null) => void;
  /** Speicherplatz der Breite (kann vom Modus abhängen) */
  storageKey: () => string;
  min: number;
  /** Maximale Breite (z.B. Containerbreite minus Platz für rechts) */
  max: () => number;
}

const GRIP_CSS = `
  .gap-grip {
    position: absolute; z-index: 5; width: 10px; height: 36px; pointer-events: none;
    background:
      linear-gradient(var(--grip, #3a3e4c), var(--grip, #3a3e4c)) 2px 0 / 2px 100% no-repeat,
      linear-gradient(var(--grip, #3a3e4c), var(--grip, #3a3e4c)) 6px 0 / 2px 100% no-repeat;
    border-radius: 2px; transition: opacity 0.15s;
  }
  .gap-grip.hot { --grip: var(--primary, #94c01c); }
`;

export function makeGapResizable(o: GapResizeOptions) {
  let drag: { x0: number; w0: number } | null = null;

  if (!document.getElementById('gap-grip-style')) {
    const style = document.createElement('style');
    style.id = 'gap-grip-style';
    style.textContent = GRIP_CSS;
    document.head.appendChild(style);
  }
  // Griff: absolut im Container (belegt keine Grid-Zelle), mittig in der Lücke
  if (getComputedStyle(o.container).position === 'static') o.container.style.position = 'relative';
  const grip = document.createElement('div');
  grip.className = 'gap-grip';
  o.container.appendChild(grip);

  const place = () => {
    const el = o.left();
    if (!el || el.offsetParent === null) {
      grip.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    const cr = o.container.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(o.container).columnGap) || 8;
    grip.hidden = false;
    grip.style.left = `${r.right - cr.left + gap / 2 - 5}px`;
    grip.style.top = `${r.top - cr.top + r.height / 2 - 18}px`;
  };
  // Lage nachführen, wenn sich Container oder Spalten ändern
  const ro = new ResizeObserver(() => place());
  ro.observe(o.container);
  for (const child of Array.from(o.container.children)) if (child !== grip) ro.observe(child);
  const hot = (on: boolean) => grip.classList.toggle('hot', on);

  /** Liegt der Zeiger in der Lücke rechts vom linken Element? */
  const inGap = (e: MouseEvent): boolean => {
    const el = o.left();
    if (!el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(o.container).columnGap) || 8;
    return e.clientX >= r.right - 2 && e.clientX <= r.right + gap + 2 && e.clientY >= r.top && e.clientY <= r.bottom;
  };

  const clamp = (w: number) => Math.round(Math.min(Math.max(w, o.min), Math.max(o.min, o.max())));

  o.container.addEventListener('mousemove', (e) => {
    if (drag) return;
    const on = inGap(e);
    o.container.style.cursor = on ? 'col-resize' : '';
    hot(on);
  });
  o.container.addEventListener('mouseleave', () => {
    if (drag) return;
    o.container.style.cursor = '';
    hot(false);
  });
  o.container.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !inGap(e)) return;
    e.preventDefault();
    drag = { x0: e.clientX, w0: o.left()!.getBoundingClientRect().width };
    document.body.style.cursor = 'col-resize';
  });
  o.container.addEventListener('dblclick', (e) => {
    if (!inGap(e)) return;
    try {
      localStorage.removeItem(o.storageKey());
    } catch {}
    o.apply(null);
    place();
  });
  const onMove = (e: MouseEvent) => {
    if (!drag) return;
    o.apply(clamp(drag.w0 + e.clientX - drag.x0));
    place();
  };
  const onUp = () => {
    if (!drag) return;
    drag = null;
    document.body.style.cursor = '';
    hot(false);
    const el = o.left();
    if (!el) return;
    try {
      localStorage.setItem(o.storageKey(), String(Math.round(el.getBoundingClientRect().width)));
    } catch {}
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  return {
    /** Gemerkte Breite (für den aktuellen storageKey) anwenden */
    restore() {
      let w = NaN;
      try {
        w = Number(localStorage.getItem(o.storageKey()));
      } catch {}
      o.apply(w > 0 ? clamp(w) : null);
      requestAnimationFrame(place);
    },
    /** Fenster-Listener abbauen (Container-Listener gehen mit dem DOM) */
    dispose() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      ro.disconnect();
      grip.remove();
    },
  };
}
