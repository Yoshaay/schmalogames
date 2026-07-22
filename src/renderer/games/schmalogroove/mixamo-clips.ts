import hipHopData from './assets/test/Hip Hop Dancing.fbx';
import shufflingData from './assets/test/Shuffling.fbx';
import sillyData from './assets/test/Silly Dancing.fbx';

/**
 * Mixamo-Clips (skinless) fürs Retargeting auf das CC-Modell. Die bpm-Angabe
 * ist das Tempo, mit dem der Clip choreographiert wurde (fürs BPM-/Phase-
 * Sync) — bei Bedarf pro Clip nachjustieren.
 */
export const MIXAMO_CLIPS: Array<{ name: string; bpm: number; data: Uint8Array }> = [
  { name: 'HIP HOP', bpm: 110, data: hipHopData },
  { name: 'SHUFFLE', bpm: 110, data: shufflingData },
  { name: 'SILLY DANCE', bpm: 110, data: sillyData },
];
