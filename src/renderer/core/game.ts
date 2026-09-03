import type { Input } from './input';

// Virtuelle Auflösung: alle Games rendern in 1200x1920 (10:16 Hochformat
// für die Ziel-Videowalls),
// der Host skaliert aufs Fenster (Letterboxing).
export const VIEW_W = 1200;
export const VIEW_H = 1920;

export interface GameContext {
  input: Input;
  /** Spiel beenden, Wall zeigt wieder den Leerlauf-Screen */
  exit(): void;
  /** Einstellungswert vom Spiel aus ändern — Operator-Regler zieht mit (z.B. Fader-Reset) */
  setSetting(key: string, value: number): void;
  /** Ereignis ans Operator-Panel des Spiels schicken (OperatorPanel.onEvent) */
  sendToOperator(payload: unknown): void;
}

/** Brücke fürs spielspezifische Operator-UI */
export interface OperatorPanelApi {
  /** Nachricht ans laufende Spiel im Wall-Fenster (Game.onMessage) */
  send(payload: unknown): void;
}

/** Spielspezifisches UI im Operator-Fenster (z.B. Transport, Waveform) */
export interface OperatorPanel {
  /** Ereignis vom Spiel (GameContext.sendToOperator) */
  onEvent?(payload: unknown): void;
  /** Spiel-Taste aus dem WALL-Fenster (Main relayt z.B. Space/Pfeile) */
  onKey?(code: string): void;
  /** Aufräumen beim Spielwechsel (Listener entfernen etc.) */
  dispose?(): void;
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
  /** Nicht speichern — startet bei jedem Spielstart wieder auf default (z.B. Live-Fader) */
  transient?: boolean;
  /** 'fader': großer vertikaler Regler im Live-Bereich statt Slider bei den
   *  Einstellungen; 'toggle': An/Aus-Schalter (Wert 0/1, min/max/step egal) */
  variant?: 'fader' | 'toggle';
}

export type SettingValues = Record<string, number>;

/** Sender-Modus (Umschalter im Operator): BAYERN 3 bzw. BAYERN 1 */
export type StationMode = 'b3' | 'b1';

export interface Game {
  /** Wird beim Start des Spiels aufgerufen */
  init(ctx: GameContext): void;
  /** dt in Sekunden */
  update(dt: number): void;
  /** Zeichnet das Bild in die virtuelle View — beide Videowalls zeigen
   *  dasselbe, es gibt nur einen Stream */
  render(g: CanvasRenderingContext2D): void;
  /** Aufräumen (Mikrofon, Timer, ...) beim Verlassen des Spiels */
  dispose?(): void;
  /** Neue Einstellungswerte vom Operator */
  applySettings?(values: SettingValues): void;
  /** Aktion aus dem Operator-Fenster (z.B. "Neue Runde") */
  action?(id: string): void;
  /** Nachricht vom Operator-Panel des Spiels (OperatorPanelApi.send) */
  onMessage?(payload: unknown): void;
  /** Sender-Modus — der Host ruft das beim Spielstart und bei jedem
   *  Umschalten auf (z.B. Schmalaoke: anderes Lyrics-Layout in BAYERN 1) */
  setStationMode?(mode: StationMode): void;
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
  /** Eigenes Operator-UI (Transport, Anzeigen, …) — läuft nur im Operator-Fenster */
  buildOperatorPanel?(container: HTMLElement, api: OperatorPanelApi): OperatorPanel;
  /** 'sidebar': Panel als hochkante Spalte links neben der Vorschau
   *  (statt unter ihr) — z.B. für Setlisten im Rundown-Stil */
  panelLayout?: 'sidebar';
  create(): Game;
}
