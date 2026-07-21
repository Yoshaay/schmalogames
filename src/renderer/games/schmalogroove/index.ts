import { GameEntry } from '../../core/game';
import { CHEERS, Schmalogroove } from './schmalogroove';
import { buildGroovePanel } from './operator-panel';

/**
 * Slot-Manifest. Der 3D-Beat-Dancer läuft als Cleanfeed auf der Wall,
 * Transport/BPM/Waveform liegen im spielspezifischen Operator-Panel
 * (buildOperatorPanel), die Regler laufen als normale Settings.
 * Referenz-Prototyp: schmalgroove.html im selben Ordner.
 */
export const schmalogrooveEntry: GameEntry = {
  id: 'schmalogroove',
  title: 'Schmalogroove',
  description: 'Beat-Dancer: Track laden (oder Mikro), die Figur tanzt im Takt. Tempo kommt automatisch oder per Tap.',
  settings: [
    { key: 'sens', label: 'Beat-Empfindlichkeit', min: 110, max: 180, step: 1, default: 135 },
    { key: 'moves', label: 'Move-Intensität', min: 20, max: 150, step: 5, default: 100, unit: '%' },
    { key: 'sync', label: 'Sync-Offset', min: 0, max: 1000, step: 5, default: 0, unit: 'ms' },
    { key: 'cheerDur', label: 'Auszeichnungs-Dauer', min: 2, max: 15, step: 1, default: 5, unit: 's' },
  ],
  // Auszeichnungen: Klick = an (mit Konfetti), nochmal Klick = aus
  actions: CHEERS.map((cheer, i) => ({ id: `cheer${i}`, label: `🎉 ${cheer}` })),
  buildOperatorPanel: buildGroovePanel,
  create: () => new Schmalogroove(),
};
