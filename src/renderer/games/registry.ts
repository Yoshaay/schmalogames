import { GameEntry } from '../core/game';
import { applausometerEntry } from './applausometer';
import { schmalogrooveEntry } from './schmalogroove';

// Jedes Spiel ist ein Slot: eigener Ordner unter games/, dessen index.ts ein
// GameEntry exportiert. Hier registrieren — Wall und Operator lesen beide diese Liste.
export const games: GameEntry[] = [applausometerEntry, schmalogrooveEntry];
