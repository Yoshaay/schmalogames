import { GameEntry } from '../../core/game';
import { Applausometer } from './applausometer';

/**
 * Slot-Manifest: alles, was Wall und Operator über dieses Spiel wissen müssen.
 * Registriert wird es in ../registry.ts.
 */
export const applausometerEntry: GameEntry = {
  id: 'applausometer',
  title: 'Applausometer',
  description: 'Der Operator steuert den Pegel über den Fader — der Humanizer lässt ihn wie echten Applaus wirken. Über der Ziellinie ist gewonnen.',
  settings: [
    { key: 'fader', label: 'Applaus', min: 0, max: 100, step: 1, default: 0, unit: '%', transient: true, variant: 'fader' },
    { key: 'threshold', label: 'Grenzwert', min: 20, max: 100, step: 5, default: 85, unit: '%' },
  ],
  actions: [{ id: 'reset', label: 'Neue Runde' }],
  create: () => new Applausometer(),
};
