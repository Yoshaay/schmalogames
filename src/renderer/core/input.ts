/**
 * Tastatur-Input. Fragt Tasten per KeyboardEvent.code ab (layoutunabhängig),
 * z.B. 'KeyW', 'ArrowUp', 'Enter', 'Escape', 'Space'.
 */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    target.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
    });
    target.addEventListener('blur', () => {
      this.down.clear();
      this.pressed.clear();
    });
  }

  /** Taste ist gerade gehalten */
  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** Taste wurde in diesem Frame frisch gedrückt */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /** Vom Host am Frame-Ende aufgerufen */
  endFrame(): void {
    this.pressed.clear();
  }
}
