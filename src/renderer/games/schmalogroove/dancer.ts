import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader';
import modelData from './assets/DanceAvatar_rigged.fbx';
import { MoveBones, MoveCtx, MOVES, SIDES, bendKnees } from './moves';

/**
 * Tänzer auf Basis des FBX-Modells (Mixamo-Rig, mixamorig*-Bones).
 * Die Moves (moves.ts) rechnen weiter auf dem einfachen konzeptionellen Rig
 * des Prototyps (hips/spine/chest/…, Rotationen um Welt-Achsen). Eine
 * Retarget-Schicht überträgt sie auf das echte Skelett: Pro Bone wird die
 * Welt-Achsen-Rotation über die Rest-Pose in den lokalen Bone-Raum konjugiert.
 */

/** Konzeptionelles Rig → Mixamo-Bones im FBX (FBXLoader entfernt die ':') */
const BONE_MAP: Record<string, string> = {
  hips: 'mixamorigHips',
  spine: 'mixamorigSpine',
  chest: 'mixamorigSpine2',
  neck: 'mixamorigNeck',
  head: 'mixamorigHead',
  'upper_arm.L': 'mixamorigLeftArm',
  'forearm.L': 'mixamorigLeftForeArm',
  'hand.L': 'mixamorigLeftHand',
  'thigh.L': 'mixamorigLeftUpLeg',
  'shin.L': 'mixamorigLeftLeg',
  'foot.L': 'mixamorigLeftFoot',
  'upper_arm.R': 'mixamorigRightArm',
  'forearm.R': 'mixamorigRightForeArm',
  'hand.R': 'mixamorigRightHand',
  'thigh.R': 'mixamorigRightUpLeg',
  'shin.R': 'mixamorigRightLeg',
  'foot.R': 'mixamorigRightFoot',
};

/**
 * Mixamo-Skelett (Clip) → Bones des Modells: Mapping für das Clip-Retargeting.
 * Das Modell trägt selbst ein Mixamo-Rig, daher ist das Mapping die Identität —
 * die Rest-Posen-Konjugation über Welt-Deltas bleibt trotzdem nötig, weil
 * Clip-Rig und Modell-Rig unterschiedliche Proportionen haben können.
 */
const CLIP_BONE_MAP: Record<string, string> = Object.fromEntries(
  [
    'mixamorigHips',
    'mixamorigSpine',
    'mixamorigSpine1',
    'mixamorigSpine2',
    'mixamorigNeck',
    'mixamorigHead',
    'mixamorigLeftShoulder',
    'mixamorigLeftArm',
    'mixamorigLeftForeArm',
    'mixamorigLeftHand',
    'mixamorigLeftUpLeg',
    'mixamorigLeftLeg',
    'mixamorigLeftFoot',
    'mixamorigLeftToeBase',
    'mixamorigRightShoulder',
    'mixamorigRightArm',
    'mixamorigRightForeArm',
    'mixamorigRightHand',
    'mixamorigRightUpLeg',
    'mixamorigRightLeg',
    'mixamorigRightFoot',
    'mixamorigRightToeBase',
  ].map((n) => [n, n]),
);

/** Ein fertig auf das Modell-Rig gebackener Mocap-Clip */
interface BakedClip {
  name: string;
  bpm: number;
  duration: number;
  fps: number;
  frames: number;
  /** Clip-Zeit (s), bei der der erste Beat liegt — automatisch gemessen */
  beatOffset: number;
  /** pro Ziel-Bone: Quaternions im lokalen Bone-Raum, Frame-Raster */
  tracks: Array<{ rest: BoneRest; quats: Float32Array }>;
  /** Hüft-Position (lokaler Bone-Raum), xyz pro Frame */
  hipsPos: Float32Array;
}

/** Eingefrorene Rest-Pose eines Modell-Bones (Bind-Pose) */
interface BoneRest {
  node: THREE.Object3D;
  restLocalQuat: THREE.Quaternion;
  restWorldQuat: THREE.Quaternion;
  restWorldQuatInv: THREE.Quaternion;
  restPos: THREE.Vector3;
}

/**
 * Grundhaltung: bringt das Modell aus seiner Bind-Pose (A/T-Pose) in die
 * "Arme hängen locker"-Haltung, auf der die Moves aufsetzen.
 * Welt-Achsen-Winkel [x, y, z] in rad — nach dem ersten Render nachjustieren.
 */
const NEUTRAL: Record<string, [number, number, number]> = {
  'upper_arm.L': [0, 0, -1.25],
  'upper_arm.R': [0, 0, 1.25],
  // leichte Grundbeuge der Ellbogen — auf diesem Rig beugt Welt-Y (s. AXIS_REMAP)
  'forearm.L': [0, -0.15, -0.15],
  'forearm.R': [0, 0.15, 0.15],
};

/**
 * Achsen-Korrektur pro Bone: Vorzeichen-Faktoren [x, y, z] für die
 * Move-Rotationen. Die Beine beugen um X gespiegelt zum konzeptionellen
 * Rig — sonst knicken die Knie nach vorn durch. (Vom CC-Rig übernommen;
 * beim Mixamo-Rig nach dem ersten Render prüfen.)
 */
const AXIS_FIX: Record<string, [number, number, number]> = {
  'thigh.L': [-1, 1, 1],
  'shin.L': [-1, 1, 1],
  'foot.L': [-1, 1, 1],
  'thigh.R': [-1, 1, 1],
  'shin.R': [-1, 1, 1],
  'foot.R': [-1, 1, 1],
};

/**
 * Achsen-UMLEITUNG für Unterarme und Hände: Das Rig bindet in strenger
 * T-Pose, die Arme liegen also auf der Welt-X-Achse — eine Move-Rotation
 * um X ist dort reiner Twist um die Armlängsachse statt einer Beugung
 * (empirisch gemessen: x=-1.9 ergibt nur 23° Beugung, y=-1.9 dagegen 108°,
 * Hand kommt nach vorn-oben). Die Move-Semantik "x = Ellbogen beugen"
 * bleibt erhalten, indem x hier auf die Welt-Y-Achse umgeleitet wird —
 * links negativ, rechts positiv (Spiegelbild). z (Beugen zur Körpermitte,
 * mit sx-Vorzeichen in den Moves) stimmt auf beiden Seiten und bleibt.
 */
const AXIS_REMAP: Record<string, (e: THREE.Euler, out: THREE.Euler) => void> = {
  'forearm.L': (e, out) => out.set(e.y, e.x, e.z),
  'forearm.R': (e, out) => out.set(-e.y, -e.x, e.z),
  'hand.L': (e, out) => out.set(e.y, e.x, e.z),
  'hand.R': (e, out) => out.set(-e.y, -e.x, e.z),
};

/** Retarget-Ziel: ein CC-Bone samt eingefrorener Rest-Pose */
interface MappedBone {
  node: THREE.Object3D;
  restLocalQuat: THREE.Quaternion;
  restWorldQuat: THREE.Quaternion;
  restWorldQuatInv: THREE.Quaternion;
  restPos: THREE.Vector3;
  /** Welt-Achsen-Offset der Grundhaltung, vorberechnet */
  neutralQuat: THREE.Quaternion;
  /** Zwischenstufe der zweistufigen Glättung (Ease-in UND Ease-out) */
  qMid: THREE.Quaternion;
  posMid: THREE.Vector3;
}

const ZIEL_GROESSE = 1.72; // Körpergröße in Szene-Einheiten (m)

export class Dancer {
  readonly root = new THREE.Group();
  /** false, bis das FBX geparst ist */
  ready = false;
  private moveIndex = 0;
  private mapped = new Map<string, MappedBone>();
  /** Dummy-Rig, auf dem die Move-Funktionen rechnen */
  private dummies: MoveBones = {};
  /** Ground-Clamp: Fuß-/Zehen-Knochen + Rest-Höhe des tieferen Fußes */
  private model: THREE.Group | null = null;
  private modelBaseY = 0;
  private groundOffset = 0;
  private groundBones: THREE.Object3D[] = [];
  private restFootY = 0;

  /* ---------- Mocap-Clips (Mixamo-Retarget) ---------- */
  /** Rest-Posen aller Clip-Ziel-Bones (Bind-Pose, beim Laden eingefroren) */
  private boneRest = new Map<string, BoneRest>();
  private hipRestWorldY = 1;
  private clips: BakedClip[] = [];
  private clipIndex = 0;
  private clipTime = 0;
  /** letzte Musik-Beat-Phase — für phasenrichtigen Clip-Einstieg */
  private lastMusicPhase = 0;
  /** Crossfade beim Clip-Wechsel */
  private prevClipIndex = -1;
  private prevClipTime = 0;
  private clipFade = 1;
  /** Umrechnung Welt-Meter → lokale Einheiten der Hüfte (Position-Bounce) */
  private hipUnit = 1;
  private hipParentQuatInv = new THREE.Quaternion();

  get moveName(): string {
    if (this.clips.length) return this.clips[this.clipIndex].name;
    return MOVES[this.moveIndex].name;
  }

  constructor() {
    for (const name of Object.keys(BONE_MAP)) this.dummies[name] = new THREE.Object3D();
    this.load();
  }

  private load() {
    const buf = modelData.buffer.slice(modelData.byteOffset, modelData.byteOffset + modelData.byteLength) as ArrayBuffer;
    const model = new FBXLoader().parse(buf, '');

    // Auf Zielgröße skalieren, zur Kamera drehen, Füße auf den Boden
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const s = ZIEL_GROESSE / size.y;
    model.scale.setScalar(s);
    model.position.y = -box.min.y * s;
    // Der neue Avatar schaut nativ zur Kamera — keine 180°-Drehung nötig

    model.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh) {
        mesh.castShadow = true;
        // Skinned-Bounds stimmen beim Tanzen nicht mehr — nie wegculllen
        mesh.frustumCulled = false;
      }
    });
    this.applyMaterials(model);

    this.root.add(model);
    this.root.updateWorldMatrix(true, true);

    // Bones auflösen: per BFS den flachsten Bone mit passendem Namen im
    // Skelett suchen — robust, falls ein FBX mehrere gleichnamige Knoten
    // enthält (beim alten CC-Rig war das der Fall)
    let boneRoot: THREE.Object3D | null = null;
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone && o.name === 'mixamorigHips' && !boneRoot) boneRoot = o;
    });
    const findShallowest = (name: string): THREE.Object3D | null => {
      if (!boneRoot) return null;
      const queue: THREE.Object3D[] = [boneRoot];
      while (queue.length) {
        const n = queue.shift()!;
        if (n.name === name) return n;
        queue.push(...n.children);
      }
      return null;
    };

    for (const [ours, boneName] of Object.entries(BONE_MAP)) {
      const node = findShallowest(boneName) ?? model.getObjectByName(boneName);
      if (!node) {
        console.warn('Dancer: Bone fehlt im Modell:', boneName);
        continue;
      }
      const restWorld = node.getWorldQuaternion(new THREE.Quaternion());
      const neutral = NEUTRAL[ours];
      this.mapped.set(ours, {
        node,
        restLocalQuat: node.quaternion.clone(),
        restWorldQuat: restWorld.clone(),
        restWorldQuatInv: restWorld.clone().invert(),
        restPos: node.position.clone(),
        neutralQuat: neutral
          ? new THREE.Quaternion().setFromEuler(new THREE.Euler(neutral[0], neutral[1], neutral[2]))
          : new THREE.Quaternion(),
        qMid: node.quaternion.clone(),
        posMid: node.position.clone(),
      });
    }

    // Hüfte: Positions-Offsets von Welt-Metern in den lokalen Raum umrechnen
    const hip = this.mapped.get('hips');
    if (hip?.node.parent) {
      const parentScale = hip.node.parent.getWorldScale(new THREE.Vector3());
      this.hipUnit = 1 / parentScale.y;
      this.hipParentQuatInv = hip.node.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    }

    // Rest-Posen aller Clip-Ziel-Bones einfrieren (für das Mocap-Retargeting) —
    // hier ist das Modell garantiert noch in Bind-Pose
    for (const boneName of Object.values(CLIP_BONE_MAP)) {
      const node = findShallowest(boneName);
      if (!node) continue;
      const restWorld = node.getWorldQuaternion(new THREE.Quaternion());
      this.boneRest.set(boneName, {
        node,
        restLocalQuat: node.quaternion.clone(),
        restWorldQuat: restWorld.clone(),
        restWorldQuatInv: restWorld.clone().invert(),
        restPos: node.position.clone(),
      });
    }
    this.hipRestWorldY = this.boneRest.get('mixamorigHips')?.node.getWorldPosition(new THREE.Vector3()).y ?? 1;

    // Ground-Clamp vorbereiten: Füße + Zehen beobachten, Rest-Höhe merken
    this.model = model;
    this.modelBaseY = model.position.y;
    this.groundBones = [
      this.mapped.get('foot.L')?.node,
      this.mapped.get('foot.R')?.node,
      findShallowest('mixamorigLeftToeBase'),
      findShallowest('mixamorigRightToeBase'),
    ].filter((n): n is THREE.Object3D => !!n);
    this.restFootY = this.lowestFootY();

    this.ready = true;
  }

  /** Welt-Y des tiefsten beobachteten Fuß-Punkts (nach updateWorldMatrix) */
  private lowestFootY(): number {
    this.root.updateWorldMatrix(true, true);
    let min = Infinity;
    for (const b of this.groundBones) {
      const y = b.getWorldPosition(Dancer.vFoot).y;
      if (y < min) min = y;
    }
    return min;
  }

  /**
   * Ground-Clamp: den ganzen Körper so verschieben, dass der tiefere Fuß
   * exakt auf dem Boden steht — die Figur steht immer auf mindestens
   * einem Fuß, statt zu schweben oder einzusinken.
   */
  private applyGrounding(dt: number) {
    if (!this.model || !this.groundBones.length) return;
    const err = this.restFootY - this.lowestFootY();
    this.groundOffset = THREE.MathUtils.clamp(
      this.groundOffset + err * Math.min(1, dt * 22),
      -0.35,
      0.35,
    );
    this.model.position.y = this.modelBaseY + this.groundOffset;
  }

  /**
   * Der Avatar bringt sein eigenes Farbdesign mit (Materialfarben aus Blender,
   * keine Texturen). CI-Regel: Grundfarbe exakt, Abdunkeln nur in 10%-Stufen —
   * Cel-Shading mit den Stufen 100% / 90% / 80%. Voraussetzung dafür ist das
   * Licht-Setup der Szene: EINE weiße Lichtquelle mit Intensität 1,0, dann ist
   * die beleuchtete Stufe exakt der CI-Farbwert.
   */
  private applyMaterials(model: THREE.Group) {
    // CI-Sollwerte pro Material. Blender exportiert die Farben linear und
    // three r128 zeigt sie ohne Output-Encoding roh an (dadurch zu dunkel/satt)
    // — deshalb hier die exakten sRGB-Hexwerte statt der FBX-Werte.
    const ciColors: Record<string, number> = {
      M_Top: 0xf9b233,
      M_Pants: 0xf9b233,
      M_Hands: 0xe71d73,
      M_KneeWarmer: 0xe71d73,
      M_AnkleWarmer: 0x2699d6,
    };

    // (skinning: true ist bei three r128 Pflicht auf SkinnedMeshes — sonst
    // rendert die GPU die Bind-Pose, egal was die Bones machen.)
    // 3 Stufen: 80% (204), 90% (230), 100% (255)
    const gradient = new THREE.DataTexture(new Uint8Array([204, 230, 255]), 3, 1, THREE.LuminanceFormat);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.generateMipmaps = false;
    gradient.needsUpdate = true;

    model.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const toonMats = mats.map((m) => {
        const toon = new THREE.MeshToonMaterial({
          color: ciColors[m.name] !== undefined
            ? new THREE.Color(ciColors[m.name])
            : (m as THREE.MeshPhongMaterial).color ?? new THREE.Color(0xffffff),
          gradientMap: gradient,
          skinning: true,
        });
        toon.name = m.name;
        return toon;
      });
      mesh.material = Array.isArray(mesh.material) ? toonMats : toonMats[0];
    });
  }

  /**
   * Mixamo-Clips (skinless oder with-skin) auf das CC-Rig backen.
   * Direkt nach dem Konstruktor aufrufen — die Rest-Posen sind eingefroren.
   */
  loadMixamoClips(files: Array<{ name: string; bpm: number; data: Uint8Array }>) {
    if (!this.ready) return;
    const loader = new FBXLoader();
    for (const f of files) {
      try {
        const buf = f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer;
        const src = loader.parse(buf, '');
        const clip = src.animations.find((a) => a.duration > 0.5);
        if (!clip) {
          console.warn('Mixamo-Clip ohne Animation:', f.name);
          continue;
        }
        const baked = this.bakeClip(src, clip, f.name, f.bpm);
        if (baked) {
          // Natives Tempo MESSEN (Hüft-Bounce-Autokorrelation, oktavgefaltet)
          // statt raten, dann die Loop-Dauer auf echte Phrasenlängen
          // (4/8/16/32/64 Beats) einrasten — ohne ganze Beats springt die
          // Phase an jedem Loop-Ende
          const measured = Dancer.measureClipBpm(baked) ?? f.bpm;
          let bestBeats = 8;
          let bestDist = Infinity;
          for (const n of [4, 8, 16, 32, 64]) {
            const cand = (n * 60) / baked.duration;
            if (cand < 55 || cand > 210) continue;
            const dist = Math.abs(Math.log2(cand / measured));
            if (dist < bestDist) {
              bestDist = dist;
              bestBeats = n;
            }
          }
          baked.bpm = (bestBeats * 60) / baked.duration;
          console.log(
            `Mocap-Clip "${f.name}": gemessen ~${measured.toFixed(1)} BPM → Loop = ${bestBeats} Beats ≙ ${baked.bpm.toFixed(1)} BPM`,
          );

          // Beat-Offset messen: beim Groove geht die Hüfte auf dem Beat nach
          // unten — Offset suchen, bei dem die Hüft-Tiefpunkte aufs Raster fallen
          const fpb = (60 / baked.bpm) * baked.fps; // Frames pro Beat
          let bestOffset = 0;
          let bestScore = Infinity;
          for (let o = 0; o < Math.round(fpb); o++) {
            let sum = 0;
            let n = 0;
            for (let t = o; t < baked.frames; t += fpb) {
              sum += baked.hipsPos[(Math.round(t) % baked.frames) * 3 + 1];
              n++;
            }
            if (n && sum / n < bestScore) {
              bestScore = sum / n;
              bestOffset = o;
            }
          }
          baked.beatOffset = bestOffset / baked.fps;

          this.clips.push(baked);
        }
      } catch (err) {
        console.warn('Clip-Retarget fehlgeschlagen:', f.name, err);
      }
    }
  }

  /**
   * Retarget-Bake: das Mixamo-Skelett frame-weise abspielen, pro Bone das
   * Welt-Delta zur T-Pose messen und über die Rest-Posen-Konjugation in den
   * lokalen Raum des CC-Bones umrechnen. Ergebnis: fertige Quaternion-Spuren.
   */
  private bakeClip(src: THREE.Group, clip: THREE.AnimationClip, name: string, bpm: number): BakedClip | null {
    src.updateWorldMatrix(true, true);

    // Paare (Clip-Bone, Modell-Rest) einsammeln — Clip-Rest = T-Pose vor dem Abspielen
    const pairs: Array<{ mix: THREE.Object3D; mixRestWorldInv: THREE.Quaternion; rest: BoneRest }> = [];
    for (const [mixName, boneName] of Object.entries(CLIP_BONE_MAP)) {
      const mix = THREE.PropertyBinding.findNode(src, mixName) as THREE.Object3D | null;
      const rest = this.boneRest.get(boneName);
      if (!mix || !rest) continue;
      pairs.push({
        mix,
        mixRestWorldInv: mix.getWorldQuaternion(new THREE.Quaternion()).invert(),
        rest,
      });
    }
    if (!pairs.length) return null;

    // Pro Paar den nächsten GEMAPPTEN Vorfahren bestimmen: Rotationen werden
    // relativ zu dessen Delta übertragen — sonst zählen tiefe Ketten
    // (Wirbelsäule → Schulter → Arm) die Eltern-Rotation doppelt
    const nodeToIdx = new Map(pairs.map((p, i) => [p.mix, i] as const));
    const ancestorIdx = pairs.map((p) => {
      for (let a = p.mix.parent; a; a = a.parent) {
        const idx = nodeToIdx.get(a);
        if (idx !== undefined) return idx;
      }
      return -1;
    });
    const deltas = pairs.map(() => new THREE.Quaternion());

    const mixHips = THREE.PropertyBinding.findNode(src, 'mixamorigHips') as THREE.Object3D | null;
    const hipRest = this.boneRest.get('mixamorigHips');
    if (!mixHips || !hipRest) return null;
    const mixHipsRestPos = mixHips.getWorldPosition(new THREE.Vector3());
    // Positions-Maßstab: Hüfthöhen-Verhältnis (Mixamo-cm → CC-Welt-Meter)
    const posScale = this.hipRestWorldY / Math.max(1e-3, mixHipsRestPos.y);

    const fps = 30;
    const frames = Math.max(2, Math.round(clip.duration * fps));
    const tracks = pairs.map((p) => ({ rest: p.rest, quats: new Float32Array(frames * 4) }));
    const hipsPos = new Float32Array(frames * 3);

    const mixer = new THREE.AnimationMixer(src);
    mixer.clipAction(clip).play();

    const qNow = new THREE.Quaternion();
    const qDelta = new THREE.Quaternion();
    const qAncInv = new THREE.Quaternion();
    const qCc = new THREE.Quaternion();
    const vNow = new THREE.Vector3();

    for (let fi = 0; fi < frames; fi++) {
      mixer.setTime((fi / fps) % clip.duration);
      src.updateWorldMatrix(true, true);

      // Pass 1: Welt-Deltas aller gemappten Mixamo-Bones zur T-Pose
      for (let pi = 0; pi < pairs.length; pi++) {
        pairs[pi].mix.getWorldQuaternion(qNow);
        deltas[pi].copy(qNow).multiply(pairs[pi].mixRestWorldInv);
      }

      // Pass 2: Delta relativ zum gemappten Vorfahren, dann konjugieren
      for (let pi = 0; pi < pairs.length; pi++) {
        const p = pairs[pi];
        qDelta.copy(deltas[pi]);
        const ai = ancestorIdx[pi];
        if (ai >= 0) qDelta.premultiply(qAncInv.copy(deltas[ai]).invert()); // Da⁻¹ ⊗ Dc
        // local = restLocal * (restWorld⁻¹ * deltaRel * restWorld)
        qCc
          .copy(p.rest.restLocalQuat)
          .multiply(p.rest.restWorldQuatInv.clone().multiply(qDelta).multiply(p.rest.restWorldQuat));
        qCc.toArray(tracks[pi].quats, fi * 4);
      }

      // Hüft-Position: Welt-Delta skaliert in den lokalen CC-Hüft-Raum.
      // Horizontal stark gedämpft — die Tänze wandern sonst durch den Raum
      // und die Figur läuft von der Fläche (vertikal bleibt voll erhalten).
      mixHips.getWorldPosition(vNow).sub(mixHipsRestPos).multiplyScalar(posScale);
      vNow.x = THREE.MathUtils.clamp(vNow.x * 0.3, -0.2, 0.2);
      vNow.z = THREE.MathUtils.clamp(vNow.z * 0.3, -0.2, 0.2);
      vNow.applyQuaternion(this.hipParentQuatInv).multiplyScalar(this.hipUnit).add(hipRest.restPos);
      vNow.toArray(hipsPos, fi * 3);
    }

    return { name, bpm, duration: clip.duration, fps, frames, beatOffset: 0, tracks, hipsPos };
  }

  /**
   * Natives Clip-Tempo aus dem Hüft-Bounce messen: Autokorrelation der
   * Hüft-Y-Kurve, stärkster Peak, parabolisch verfeinert, oktavgefaltet
   * in den plausiblen Bereich 60–200 BPM. null, wenn kein klarer Bounce.
   */
  private static measureClipBpm(clip: BakedClip): number | null {
    const n = clip.frames;
    if (n < 32) return null;
    // Hüft-Y extrahieren, Mittelwert + linearen Trend entfernen
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = clip.hipsPos[i * 3 + 1];
    let mean = 0;
    for (let i = 0; i < n; i++) mean += y[i];
    mean /= n;
    let sxy = 0;
    let sxx = 0;
    const mid = (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      sxy += (i - mid) * (y[i] - mean);
      sxx += (i - mid) * (i - mid);
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    for (let i = 0; i < n; i++) y[i] -= mean + slope * (i - mid);

    // Autokorrelation über Half-Beat @200 BPM bis Doppel-Beat @60 BPM
    const ac = (lag: number) => {
      let s = 0;
      for (let i = lag; i < n; i++) s += y[i] * y[i - lag];
      return s / (n - lag);
    };
    const ac0 = ac(0);
    if (ac0 <= 1e-12) return null;
    const lo = Math.max(2, Math.floor((clip.fps * 60) / (200 * 2)));
    const hi = Math.min(n - 2, Math.ceil((clip.fps * 60) / (60 * 0.5)));
    if (hi <= lo + 2) return null;
    const vals: number[] = [];
    for (let lag = lo; lag <= hi; lag++) vals.push(ac(lag) / ac0);
    // stärkster lokaler Peak über der Signifikanz-Schwelle
    let bestLag = -1;
    let bestVal = 0.2;
    for (let i = 1; i < vals.length - 1; i++) {
      if (vals[i] > vals[i - 1] && vals[i] >= vals[i + 1] && vals[i] > bestVal) {
        bestVal = vals[i];
        bestLag = lo + i;
      }
    }
    if (bestLag < 0) return null;
    // parabolische Verfeinerung
    let lag = bestLag;
    const y1 = vals[bestLag - lo - 1];
    const y2 = vals[bestLag - lo];
    const y3 = vals[bestLag - lo + 1];
    const denom = y1 - 2 * y2 + y3;
    if (Math.abs(denom) > 1e-12) {
      const d = (0.5 * (y1 - y3)) / denom;
      if (Math.abs(d) < 1) lag += d;
    }
    let bpm = 60 / (lag / clip.fps);
    while (bpm < 60) bpm *= 2;
    while (bpm > 200) bpm /= 2;
    return bpm;
  }

  /** Clip-Pose für Zeit t (geloopt), optional in bestehende Bones gemischt */
  private static qSampleA = new THREE.Quaternion();
  private static qSampleB = new THREE.Quaternion();
  private applyClipPose(clip: BakedClip, t: number, mix: number) {
    const f = (t % clip.duration) * clip.fps;
    const i0 = Math.floor(f) % clip.frames;
    const i1 = (i0 + 1) % clip.frames;
    const a = f - Math.floor(f);
    for (const tr of clip.tracks) {
      Dancer.qSampleA.fromArray(tr.quats, i0 * 4);
      Dancer.qSampleB.fromArray(tr.quats, i1 * 4);
      Dancer.qSampleA.slerp(Dancer.qSampleB, a);
      if (mix >= 1) tr.rest.node.quaternion.copy(Dancer.qSampleA);
      else tr.rest.node.quaternion.slerp(Dancer.qSampleA, mix);
    }
    const hip = this.boneRest.get('mixamorigHips');
    if (hip) {
      Dancer.vOff.set(
        THREE.MathUtils.lerp(clip.hipsPos[i0 * 3], clip.hipsPos[i1 * 3], a),
        THREE.MathUtils.lerp(clip.hipsPos[i0 * 3 + 1], clip.hipsPos[i1 * 3 + 1], a),
        THREE.MathUtils.lerp(clip.hipsPos[i0 * 3 + 2], clip.hipsPos[i1 * 3 + 2], a),
      );
      if (mix >= 1) hip.node.position.copy(Dancer.vOff);
      else hip.node.position.lerp(Dancer.vOff, mix);
    }
  }

  /** Mocap-Playback: BPM-Sync + Phase-Lock + Crossfade, dann Ground-Clamp */
  private poseFromClips(c: MoveCtx, dt: number) {
    const clip = this.clips[this.clipIndex];
    let rate =
      c.k > 0
        ? THREE.MathUtils.clamp((c.bpm && c.bpm > 0 ? c.bpm : clip.bpm) / clip.bpm, 0.55, 1.7)
        : 0.45; // ohne Musik: gemütlich weiter

    this.lastMusicPhase = c.p;
    if (c.k > 0 && c.bpm && c.bpm > 0) {
      // Phase-Lock: Clip-Schritte (ab gemessenem Beat-Offset) auf den Musik-Beat ziehen
      const beatLen = 60 / clip.bpm;
      const clipPhase = ((((this.clipTime - clip.beatOffset) / beatLen) % 1) + 1) % 1;
      let err = (c.p - clipPhase + 1.5) % 1;
      err -= 0.5;
      rate *= 1 + THREE.MathUtils.clamp(err * 0.8, -0.2, 0.2);
    }

    this.clipTime += dt * rate;
    this.clipFade = Math.min(1, this.clipFade + dt / 0.5);

    if (this.clipFade < 1 && this.prevClipIndex >= 0) {
      const prev = this.clips[this.prevClipIndex];
      this.prevClipTime += dt * rate;
      this.applyClipPose(prev, this.prevClipTime, 1);
      this.applyClipPose(clip, this.clipTime, this.clipFade);
    } else {
      this.applyClipPose(clip, this.clipTime, 1);
    }

    this.applyGrounding(dt);
  }

  /** Zufalls-„Flavor" des aktuellen Move-Blocks: Größe, Seite, Stil-Varianten */
  private flavor = { amp: 1, mir: 1, v1: 0.5, v2: 0.5 };

  /** Pro Move-Block neu würfeln — kein 8-Beat-Block tanzt wie der vorige */
  private rollFlavor() {
    this.flavor = {
      amp: 0.95 + 0.35 * Math.random(),
      mir: Math.random() < 0.5 ? 1 : -1,
      v1: Math.random(),
      v2: Math.random(),
    };
  }

  /** Bestimmten Move fest anwählen (Pose-Review im Operator-Panel) */
  setMove(name: string) {
    const i = MOVES.findIndex((m) => m.name === name);
    if (i >= 0) this.moveIndex = i;
    this.rollFlavor();
  }

  /** Zufälliger anderer Move (nie derselbe zweimal hintereinander) */
  nextMove() {
    if (this.clips.length > 1) {
      let n: number;
      do {
        n = Math.floor(Math.random() * this.clips.length);
      } while (n === this.clipIndex);
      this.prevClipIndex = this.clipIndex;
      this.prevClipTime = this.clipTime;
      this.clipFade = 0;
      this.clipIndex = n;
      // Phasenrichtig einsteigen: der neue Clip startet so, dass sein
      // nächster Beat exakt auf dem Musik-Beat liegt
      const clip = this.clips[n];
      this.clipTime = clip.beatOffset + this.lastMusicPhase * (60 / clip.bpm);
      return;
    }
    let n: number;
    do {
      n = Math.floor(Math.random() * MOVES.length);
    } while (n === this.moveIndex);
    this.moveIndex = n;
    this.rollFlavor();
  }

  /** Pose für den aktuellen Frame; k=0 → ruhiges Atmen (Idle) */
  pose(c: MoveCtx, nowS: number, dt = 1 / 60) {
    if (!this.ready) return;

    // Mocap-Modus: gebackene Clips statt prozeduraler Moves
    if (this.clips.length) {
      this.poseFromClips(c, dt);
      return;
    }

    this.resetDummies();

    if (c.k > 0) {
      // Block-Flavor einmischen: Größe, Spiegelung, Varianten-Würfel — plus
      // Akzent auf der „1" jedes 4er-Takts (Tänzer betonen die Eins)
      const f = this.flavor;
      const accBase = c.beatCount % 4 === 0 ? 1 : c.beatCount % 4 === 2 ? 0.35 : 0;
      c.k = Math.min(1.45, c.k * f.amp * (1 + 0.15 * accBase * c.dip));
      c.dir *= f.mir;
      c.v1 = f.v1;
      c.v2 = f.v2;
      c.acc = accBase;
      MOVES[this.moveIndex].fn(this.dummies, c);
      this.anchorLegs();
      this.addHumanNoise(nowS, 0.075 * c.k);
    } else {
      const idle = Math.sin(nowS * 1.2);
      this.dummies.hips.position.y += 0.01 * idle;
      this.dummies.chest.rotation.y = 0.04 * idle;
      this.dummies.head.rotation.x = 0.03 * Math.sin(nowS * 0.9);
      bendKnees(this.dummies, 0.03);
      this.addHumanNoise(nowS, 0.012);
    }

    this.applyToModel(dt);
    this.applyGrounding(dt);
  }

  /**
   * Anatomie-Korrektur: Hüft-Kippungen (Roll um z, Neigung um x) dürfen
   * nicht auf die Beine durchschlagen — im echten Leben bleiben die Füße
   * am Boden stehen und das Becken kippt DARÜBER. Die Oberschenkel werden
   * gegenrotiert, und die halbe Seitkippung wandert als Beugung in den
   * Rumpf, damit der sichtbare Sway erhalten bleibt.
   * (Hüft-Drehung um y bleibt: dafür pivotieren die Füße, siehe TWIST.)
   */
  private anchorLegs() {
    const d = this.dummies;
    const roll = d.hips.rotation.z;
    const tilt = d.hips.rotation.x;
    for (const side of ['L', 'R']) {
      d['thigh.' + side].rotation.z -= roll;
      // AXIS_FIX spiegelt die Bein-x-Achse — Vorzeichen daher gedreht
      d['thigh.' + side].rotation.x += tilt;
    }
    d.spine.rotation.z += roll * 0.5;
  }

  /**
   * Humanizer: kleine, unregelmäßige Zusatzbewegungen. Pro Körperteil ein
   * leicht verstimmtes Sinus-Paar mit eigener Phase — dadurch ist die
   * Bewegung nie exakt symmetrisch und wiederholt sich nie sichtbar.
   */
  private addHumanNoise(t: number, a: number) {
    const d = this.dummies;
    const n = (f: number, ph: number) => Math.sin(t * f + ph) * Math.sin(t * f * 0.31 + ph * 1.7);
    d.head.rotation.x += a * 0.8 * n(1.5, 2.4);
    d.head.rotation.y += a * 1.2 * n(1.9, 1.0);
    d.head.rotation.z += a * 0.6 * n(2.3, 4.0);
    d.chest.rotation.y += a * n(1.3, 2.0);
    d.spine.rotation.z += a * 0.5 * n(0.9, 5.0);
    d.hips.rotation.y += a * 0.7 * n(0.7, 1.4);
    d['upper_arm.L'].rotation.x += a * 1.5 * n(1.7, 0.5);
    d['upper_arm.R'].rotation.x += a * 1.5 * n(1.45, 3.2);
    d['forearm.L'].rotation.x += a * n(2.1, 2.6);
    d['forearm.R'].rotation.x += a * n(1.75, 0.8);
  }

  /** Dummy-Rig auf die neutrale Ausgangspose des Prototyps zurücksetzen */
  private resetDummies() {
    this.dummies.hips.position.set(0, 0.9, 0);
    for (const n of ['hips', 'spine', 'chest', 'neck', 'head']) this.dummies[n].rotation.set(0, 0, 0);
    for (const [side, sx] of SIDES) {
      this.dummies['upper_arm.' + side].rotation.set(-0.15, 0, sx * 0.3);
      this.dummies['forearm.' + side].rotation.set(-0.4, 0, 0);
      this.dummies['hand.' + side].rotation.set(0, 0, 0);
      this.dummies['thigh.' + side].rotation.set(0, 0, 0);
      this.dummies['shin.' + side].rotation.set(0, 0, 0);
      this.dummies['foot.' + side].rotation.set(0, 0, 0);
    }
  }

  private static qMove = new THREE.Quaternion();
  private static qWorld = new THREE.Quaternion();
  private static qTarget = new THREE.Quaternion();
  private static vOff = new THREE.Vector3();
  private static vFoot = new THREE.Vector3();
  private static eFixed = new THREE.Euler();

  /**
   * Pose-Trägheit pro Körperteil: Rumpf und Beine reagieren schnell,
   * Kopf und Extremitäten ziehen nach (Follow-Through) — das nimmt der
   * Bewegung das Synchron-Roboterhafte.
   */
  private static FOLLOW: Record<string, number> = {
    hips: 18,
    spine: 15,
    chest: 12,
    neck: 9,
    head: 7,
    'upper_arm.L': 11,
    'upper_arm.R': 11,
    'forearm.L': 9,
    'forearm.R': 9,
    'hand.L': 7,
    'hand.R': 7,
    'thigh.L': 16,
    'thigh.R': 16,
    'shin.L': 16,
    'shin.R': 16,
    'foot.L': 16,
    'foot.R': 16,
  };

  /** Dummy-Rotationen (Welt-Achsen-Semantik) auf die CC-Bones übertragen */
  private applyToModel(dt: number) {
    const dtc = Math.min(dt, 0.1);

    for (const [name, m] of this.mapped) {
      // zweistufig gefiltert: Ziel → qMid → Bone. Zwei gekettete Filter
      // wirken wie eine kritisch gedämpfte Feder — Bewegungen starten sanft
      // (Ease-in) statt mit voller Geschwindigkeit, und landen weich.
      const follow = 1 - Math.exp(-dtc * (Dancer.FOLLOW[name] ?? 14) * 1.8);
      const dummy = this.dummies[name];

      // Gesamtrotation in Welt-Achsen: erst Grundhaltung, dann Move obendrauf
      const remap = AXIS_REMAP[name];
      const fix = AXIS_FIX[name];
      if (remap) {
        remap(dummy.rotation, Dancer.eFixed);
        Dancer.qMove.setFromEuler(Dancer.eFixed);
      } else if (fix) {
        Dancer.eFixed.set(dummy.rotation.x * fix[0], dummy.rotation.y * fix[1], dummy.rotation.z * fix[2]);
        Dancer.qMove.setFromEuler(Dancer.eFixed);
      } else {
        Dancer.qMove.setFromEuler(dummy.rotation);
      }
      Dancer.qWorld.copy(Dancer.qMove).multiply(m.neutralQuat);

      // In den lokalen Bone-Raum konjugieren und auf die Rest-Pose setzen:
      // local = restLocal * (restWorld⁻¹ * world * restWorld)
      Dancer.qTarget
        .copy(m.restLocalQuat)
        .multiply(m.restWorldQuatInv.clone().multiply(Dancer.qWorld).multiply(m.restWorldQuat));
      m.qMid.slerp(Dancer.qTarget, follow);
      m.node.quaternion.slerp(m.qMid, follow);
      // Selbstheilung: ein einziges NaN würde im Slerp für immer hängen
      // bleiben (unsichtbares Mesh) — dann hart auf das Ziel setzen
      if (m.qMid.x !== m.qMid.x) m.qMid.copy(Dancer.qTarget);
      if (m.node.quaternion.x !== m.node.quaternion.x) m.node.quaternion.copy(Dancer.qTarget);

      if (name === 'hips') {
        // Positions-Bounce: Welt-Offset in den lokalen Raum der Hüfte drehen
        Dancer.vOff
          .set(dummy.position.x, dummy.position.y - 0.9, dummy.position.z)
          .applyQuaternion(this.hipParentQuatInv)
          .multiplyScalar(this.hipUnit)
          .add(m.restPos);
        m.posMid.lerp(Dancer.vOff, follow);
        m.node.position.lerp(m.posMid, follow);
        if (m.posMid.y !== m.posMid.y) m.posMid.copy(Dancer.vOff);
        if (m.node.position.y !== m.node.position.y) m.node.position.copy(Dancer.vOff);
      }
    }
  }
}
