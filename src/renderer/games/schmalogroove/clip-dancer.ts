import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader';
import type { MoveCtx } from './dancer';
import robotData from './assets/test/Robot Hip Hop Dance.fbx';
import snakeData from './assets/test/Snake Hip Hop Dance.fbx';
import waveData from './assets/test/Wave Hip Hop Dance.fbx';

/**
 * Testweise Alternative zum prozeduralen Dancer: spielt echte Mocap-Clips
 * (Mixamo, X-Bot-Rig) über einen AnimationMixer ab. Gleiche Schnittstelle
 * wie Dancer — die Abspielgeschwindigkeit wird auf die erkannten BPM gesynct,
 * Move-Wechsel = Crossfade zum nächsten Clip.
 */

const CLIPS: Array<{ name: string; data: Uint8Array }> = [
  { name: 'ROBOT HIP HOP', data: robotData },
  { name: 'SNAKE HIP HOP', data: snakeData },
  { name: 'WAVE HIP HOP', data: waveData },
];

/** Grobes Tempo, mit dem die Mixamo-Clips choreographiert sind */
const CLIP_BPM = 110;
const ZIEL_GROESSE = 1.72;
const CROSSFADE = 0.6; // s

export class ClipDancer {
  readonly root = new THREE.Group();
  ready = false;
  private mixer: THREE.AnimationMixer | null = null;
  private actions: THREE.AnimationAction[] = [];
  private current = 0;

  get moveName(): string {
    return CLIPS[this.current]?.name ?? '—';
  }

  constructor() {
    this.load();
  }

  private load() {
    const loader = new FBXLoader();
    const parse = (d: Uint8Array) =>
      loader.parse(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer, '');

    // Erste Datei liefert Modell + Clip, die restlichen nur ihre Clips
    const model = parse(CLIPS[0].data);
    const clips: THREE.AnimationClip[] = [model.animations[0]];
    for (let i = 1; i < CLIPS.length; i++) clips.push(parse(CLIPS[i].data).animations[0]);

    // Auf Zielgröße skalieren, Füße auf den Boden
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const s = ZIEL_GROESSE / size.y;
    model.scale.setScalar(s);
    model.position.y = -box.min.y * s;

    this.applyMaterials(model);

    this.mixer = new THREE.AnimationMixer(model);
    this.actions = clips.filter(Boolean).map((c) => this.mixer!.clipAction(c));
    this.actions[0]?.play();

    this.root.add(model);
    this.ready = true;
  }

  /** Toon-Look wie beim CC-Modell: X-Bot-Anzug hell, Gelenke in BR3-Blau */
  private applyMaterials(model: THREE.Group) {
    const gradient = new THREE.DataTexture(new Uint8Array([130, 215, 255]), 3, 1, THREE.LuminanceFormat);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.generateMipmaps = false;
    gradient.needsUpdate = true;
    const toon = (color: number) =>
      new THREE.MeshToonMaterial({ color, gradientMap: gradient, skinning: true });

    const suit = toon(0xf2f3f5);
    const joints = toon(0x2699d6); // BR3 Blau

    model.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      mesh.frustumCulled = false;
      mesh.material = mesh.name === 'Beta_Joints' ? joints : suit;
    });
  }

  /** Zufälliger anderer Clip mit Crossfade */
  nextMove() {
    if (this.actions.length < 2) return;
    let n: number;
    do {
      n = Math.floor(Math.random() * this.actions.length);
    } while (n === this.current);
    const from = this.actions[this.current];
    const to = this.actions[n];
    to.reset();
    to.play();
    from.crossFadeTo(to, CROSSFADE, false);
    this.current = n;
  }

  /**
   * Clip weiterschalten — Tempo folgt den erkannten BPM, und ein Phase-Lock
   * regelt die Geschwindigkeit fein nach, bis die Schritte des Clips exakt
   * auf dem Beat der Musik landen (wie Pitch-Riding am Plattenteller).
   */
  pose(c: MoveCtx, _nowS: number, dt = 1 / 60) {
    if (!this.mixer) return;
    let rate =
      c.k > 0
        ? THREE.MathUtils.clamp((c.bpm && c.bpm > 0 ? c.bpm : CLIP_BPM) / CLIP_BPM, 0.55, 1.7)
        : 0.45; // ohne Musik: gemütliche halbe Kraft

    if (c.k > 0 && c.bpm && c.bpm > 0) {
      // Phase des Clips relativ zu seinem eigenen Beat-Raster (CLIP_BPM)
      const beatLen = 60 / CLIP_BPM;
      const clipPhase = (this.actions[this.current].time / beatLen) % 1;
      // Fehler zur Musik-Phase in ±0.5 Beats falten und sanft ausregeln
      let err = (c.p - clipPhase + 1.5) % 1;
      err -= 0.5;
      rate *= 1 + THREE.MathUtils.clamp(err * 0.6, -0.15, 0.15);
    }

    this.mixer.update(dt * rate);
  }
}
