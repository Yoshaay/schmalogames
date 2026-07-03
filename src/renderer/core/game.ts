import type { Input } from './input';

// Virtuelle Auflösung: alle Games rendern in 1920x1080,
// der Host skaliert aufs Fenster (Letterboxing).
export const VIEW_W = 1920;
export const VIEW_H = 1080;

export interface GameContext {
  input: Input;
  /** Spiel beenden, Wall zeigt wieder den Leerlauf-Screen */
  exit(): void;
}

/** Ein Regler im Operator-Fenster */
export interface SettingDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

export type SettingValues = Record<string, number>;

export interface Game {
  /** Wird beim Start des Spiels aufgerufen */
  init(ctx: GameContext): void;
  /** dt in Sekunden */
  update(dt: number): void;
  render(g: CanvasRenderingContext2D): void;
  /** Aufräumen (Mikrofon, Timer, ...) beim Verlassen des Spiels */
  dispose?(): void;
  /** Neue Einstellungswerte vom Operator */
  applySettings?(values: SettingValues): void;
  /** Aktion aus dem Operator-Fenster (z.B. "Neue Runde") */
  action?(id: string): void;
  /** Live-Status fürs Operator-Fenster */
  getStatus?(): Record<string, string | number>;
}

export interface GameEntry {
  id: string;
  title: string;
  /** Kurzbeschreibung fürs Operator-Fenster */
  description?: string;
  /** Regler, die der Operator sieht */
  settings?: SettingDef[];
  /** Buttons, die der Operator sieht */
  actions?: { id: string; label: string }[];
  create(): Game;
}
