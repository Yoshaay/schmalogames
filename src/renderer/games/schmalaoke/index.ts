import { GameEntry } from '../../core/game';
import { Schmalaoke } from './schmalaoke';
import { buildSchmalaokePanel } from './operator-panel';

/**
 * Slot-Manifest. Portiert aus der Standalone-App SchmalKaraoke_ALPHA —
 * die bleibt als Backup bestehen, hier lebt die integrierte Kopie.
 * Steuerung: Leertaste/Pfeile/N/Home (Operator-Fenster) + Panel-Buttons.
 */
export const schmalaokeEntry: GameEntry = {
  id: 'schmalaoke',
  title: 'Schmalaoke',
  description: 'Karaoke-Lyrics von LRC-Dateien: Setlist im Panel verwalten, Leertaste blättert die Zeilen im Conveyor-Stil weiter.',
  settings: [],
  actions: [],
  buildOperatorPanel: buildSchmalaokePanel,
  panelLayout: 'sidebar', // hochkant links neben der Vorschau, wie das Original-Rundown
  create: () => new Schmalaoke(),
};
