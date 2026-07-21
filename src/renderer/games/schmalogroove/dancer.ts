import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader';
import modelData from './assets/uploads_files_4370839_MOBF001.fbx';

/**
 * Tänzer auf Basis des FBX-Modells (Character-Creator-Rig, CC_Base_*-Bones).
 * Die Moves rechnen weiter auf dem einfachen konzeptionellen Rig des Prototyps
 * (hips/spine/chest/…, Rotationen um Welt-Achsen). Eine Retarget-Schicht
 * überträgt sie auf das echte Skelett: Pro Bone wird die Welt-Achsen-Rotation
 * über die Rest-Pose in den lokalen Bone-Raum konjugiert.
 */

type MoveBones = Record<string, THREE.Object3D>;

/** Parameter, aus denen ein Move die Pose berechnet */
export interface MoveCtx {
  /** Gesamt-Intensität */
  k: number;
  /** Beat-Phase 0..1 */
  p: number;
  /** runter auf den Beat */
  dip: number;
  /** Seite, wechselt pro Beat: 1 | -1 */
  dir: number;
  /** Bogen über den Beat */
  s1: number;
  /** volle Welle */
  s2: number;
  /** Kopfnicken, klingt nach dem Beat ab */
  nod: number;
  beatCount: number;
}

/** Konzeptionelles Rig → CC-Bones im FBX */
const BONE_MAP: Record<string, string> = {
  hips: 'CC_Base_Hip',
  spine: 'CC_Base_Waist',
  chest: 'CC_Base_Spine02',
  neck: 'CC_Base_NeckTwist01',
  head: 'CC_Base_Head',
  'upper_arm.L': 'CC_Base_L_Upperarm',
  'forearm.L': 'CC_Base_L_Forearm',
  'hand.L': 'CC_Base_L_Hand',
  'thigh.L': 'CC_Base_L_Thigh',
  'shin.L': 'CC_Base_L_Calf',
  'foot.L': 'CC_Base_L_Foot',
  'upper_arm.R': 'CC_Base_R_Upperarm',
  'forearm.R': 'CC_Base_R_Forearm',
  'hand.R': 'CC_Base_R_Hand',
  'thigh.R': 'CC_Base_R_Thigh',
  'shin.R': 'CC_Base_R_Calf',
  'foot.R': 'CC_Base_R_Foot',
};

/**
 * Grundhaltung: bringt das Modell aus seiner Bind-Pose (A/T-Pose) in die
 * "Arme hängen locker"-Haltung, auf der die Moves aufsetzen.
 * Welt-Achsen-Winkel [x, y, z] in rad — nach dem ersten Render nachjustieren.
 */
const NEUTRAL: Record<string, [number, number, number]> = {
  'upper_arm.L': [0, 0, -1.25],
  'upper_arm.R': [0, 0, 1.25],
  'forearm.L': [-0.15, 0, -0.15],
  'forearm.R': [-0.15, 0, 0.15],
};

/**
 * Achsen-Korrektur pro Bone: Vorzeichen-Faktoren [x, y, z] für die
 * Move-Rotationen. Die Beine des CC-Rigs beugen um X gespiegelt zum
 * konzeptionellen Rig — sonst knicken die Knie nach vorn durch.
 */
const AXIS_FIX: Record<string, [number, number, number]> = {
  'thigh.L': [-1, 1, 1],
  'shin.L': [-1, 1, 1],
  'foot.L': [-1, 1, 1],
  'thigh.R': [-1, 1, 1],
  'shin.R': [-1, 1, 1],
  'foot.R': [-1, 1, 1],
};

const SIDES: Array<[string, number]> = [
  ['L', 1],
  ['R', -1],
];

function bendKnees(bones: MoveBones, a: number) {
  // Knie federn, Füße bleiben flach
  for (const side of ['L', 'R']) {
    bones['thigh.' + side].rotation.x += a;
    bones['shin.' + side].rotation.x += -1.9 * a;
    bones['foot.' + side].rotation.x += 0.9 * a;
  }
}

/* Jeder Move setzt auf einer neutralen Pose auf. Gewechselt wird alle 8 Beats. */
const MOVES: Array<{ name: string; fn(b: MoveBones, c: MoveCtx): void }> = [
  {
    name: 'GROOVE', // der Basis-Move
    fn(b, c) {
      const { k, dip, dir, s1, nod } = c;
      b.hips.position.y -= 0.075 * k * dip;
      b.hips.rotation.z = 0.1 * k * dip * dir;
      b.hips.rotation.y = 0.14 * k * s1 * dir;
      b.chest.rotation.z = -0.07 * k * dip * dir;
      b.chest.rotation.y = -0.18 * k * s1 * dir;
      b.spine.rotation.x = 0.05 * k * dip;
      b.head.rotation.x = -0.3 * k * nod + 0.06 * k * dip;
      b.head.rotation.z = 0.05 * k * dip * dir;
      for (const [side, sx] of SIDES) {
        b['upper_arm.' + side].rotation.z = sx * (0.35 + 0.15 * k * dip);
        b['upper_arm.' + side].rotation.x = -0.25 - 0.55 * k * s1 * dir * sx;
        b['forearm.' + side].rotation.x = -0.85 - 0.55 * k * dip;
        b['hand.' + side].rotation.x = -0.2 * k * dip;
      }
      bendKnees(b, 0.45 * k * dip);
    },
  },
  {
    name: 'DISCO POINT', // Saturday-Night-Fever-Zeigefinger
    fn(b, c) {
      const { k, dip, dir, s1 } = c;
      const pt = dir > 0 ? 'L' : 'R';
      const hip = dir > 0 ? 'R' : 'L';
      const sxP = dir;
      const sxH = -dir;
      b.hips.position.y -= 0.05 * k * dip;
      b.hips.rotation.z = 0.09 * k * s1 * dir;
      b.chest.rotation.z = 0.1 * k * s1 * dir;
      b.head.rotation.z = -0.1 * k * s1 * dir;
      b.head.rotation.y = 0.25 * k * s1 * dir; // Blick folgt der Hand
      // Zeigearm: diagonal nach schräg oben, auf dem Beat voll gestreckt
      b['upper_arm.' + pt].rotation.z = sxP * (0.9 + 1.5 * k * dip);
      b['upper_arm.' + pt].rotation.x = -0.35;
      b['forearm.' + pt].rotation.x = -0.55 + 0.45 * k * dip; // streckt sich
      // Andere Hand in die Hüfte
      b['upper_arm.' + hip].rotation.z = sxH * 0.85;
      b['forearm.' + hip].rotation.x = -1.9;
      b['forearm.' + hip].rotation.z = sxH * -0.6;
      bendKnees(b, 0.3 * k * dip);
    },
  },
  {
    name: 'RUNNING MAN', // Laufschritt auf der Stelle
    fn(b, c) {
      const { k, dip, dir, s1, nod } = c;
      b.hips.position.y -= 0.1 * k * dip;
      b.spine.rotation.x = 0.12 * k; // leicht vorgebeugt
      b.head.rotation.x = -0.25 * k * nod;
      const front = dir > 0 ? 'L' : 'R';
      const back = dir > 0 ? 'R' : 'L';
      b['thigh.' + front].rotation.x = 0.85 * k * s1; // Knie hoch
      b['shin.' + front].rotation.x = -1.3 * k * s1;
      b['foot.' + front].rotation.x = 0.5 * k * s1;
      b['thigh.' + back].rotation.x = -0.35 * k * s1; // Standbein schiebt zurück
      b['shin.' + back].rotation.x = -0.25 * k * s1;
      for (const [side, sx] of SIDES) {
        // Arme pumpen gegengleich
        const opp = side === front ? -1 : 1;
        b['upper_arm.' + side].rotation.z = sx * 0.25;
        b['upper_arm.' + side].rotation.x = -0.25 + 0.8 * k * s1 * opp;
        b['forearm.' + side].rotation.x = -1.45;
      }
    },
  },
  {
    name: 'TWIST', // Chubby-Checker-Hüftschwung
    fn(b, c) {
      const { k, p, dip } = c;
      const tw = 0.55 * k * Math.sin((c.beatCount + p) * Math.PI); // durchgehende Welle
      b.hips.position.y -= 0.05 * k * dip;
      b.hips.rotation.y = tw; // Unterkörper dreht…
      b.chest.rotation.y = -1.7 * tw; // …Oberkörper kontert
      b.head.rotation.y = 0.6 * tw;
      for (const [side, sx] of SIDES) {
        // Arme angewinkelt, schwingen mit
        b['upper_arm.' + side].rotation.z = sx * 0.55;
        b['upper_arm.' + side].rotation.x = -0.35;
        b['forearm.' + side].rotation.x = -1.55;
        b['foot.' + side].rotation.y = -0.8 * tw; // Füße pivotieren auf dem Ballen
      }
      bendKnees(b, 0.35 * k * (0.6 + 0.4 * dip));
    },
  },
  {
    name: 'RAISE THE ROOF', // beide Hände pushen nach oben
    fn(b, c) {
      const { k, dip, dir, s1, nod } = c;
      b.hips.position.y -= 0.07 * k * dip;
      b.hips.rotation.z = 0.05 * k * s1 * dir;
      b.spine.rotation.x = -0.12 * k * dip; // leicht ins Hohlkreuz
      b.head.rotation.x = 0.28 * k * dip - 0.1 * k * nod; // Blick nach oben
      for (const [side, sx] of SIDES) {
        b['upper_arm.' + side].rotation.z = sx * (2.45 + 0.25 * k * dip);
        b['upper_arm.' + side].rotation.x = -0.15;
        b['forearm.' + side].rotation.x = -1.15 + 0.95 * k * dip; // Push = strecken
        b['hand.' + side].rotation.x = 1.4; // Handflächen zur Decke
      }
      bendKnees(b, 0.4 * k * dip);
    },
  },
  {
    name: 'SIDE CLAP', // Side-Step mit Clap vor der Brust
    fn(b, c) {
      const { k, dip, dir, s1 } = c;
      b.hips.position.x = 0.16 * k * s1 * dir; // Schritt zur Seite
      b.hips.position.y -= 0.06 * k * dip;
      b.hips.rotation.z = -0.06 * k * s1 * dir;
      b.chest.rotation.z = 0.1 * k * s1 * dir; // lehnt in den Schritt
      b.head.rotation.z = -0.06 * k * s1 * dir;
      for (const [side, sx] of SIDES) {
        b['upper_arm.' + side].rotation.z = sx * 0.3;
        b['upper_arm.' + side].rotation.x = -0.95;
        b['upper_arm.' + side].rotation.y = -sx * 0.75 * k * dip; // Hände zueinander
        b['forearm.' + side].rotation.x = -0.55 - 0.25 * k * dip;
      }
      // Spielbein hebt leicht ab
      const lift = dir > 0 ? 'R' : 'L';
      b['thigh.' + lift].rotation.x = 0.25 * k * dip;
      b['shin.' + lift].rotation.x = -0.45 * k * dip;
      bendKnees(b, 0.2 * k * dip);
    },
  },
];

/** Retarget-Ziel: ein CC-Bone samt eingefrorener Rest-Pose */
interface MappedBone {
  node: THREE.Object3D;
  restLocalQuat: THREE.Quaternion;
  restWorldQuat: THREE.Quaternion;
  restWorldQuatInv: THREE.Quaternion;
  restPos: THREE.Vector3;
  /** Welt-Achsen-Offset der Grundhaltung, vorberechnet */
  neutralQuat: THREE.Quaternion;
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
  /** Umrechnung Welt-Meter → lokale Einheiten der Hüfte (Position-Bounce) */
  private hipUnit = 1;
  private hipParentQuatInv = new THREE.Quaternion();

  get moveName(): string {
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
    model.rotation.y = Math.PI;

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

    // Bones auflösen — WICHTIG, das FBX enthält drei Knotensorten mit
    // denselben Namen: (a) einen Group-Baum ohne Skin-Wirkung, (b) den echten
    // artikulierenden Bone-Baum unter CC_Base_BoneRoot<Bone> und (c) pro Name
    // 9 gestapelte Leaf-Bones (eines je Mesh-Cluster, das ist der Inhalt von
    // skeleton.bones). Nur (b) bewegt das Mesh: per BFS den flachsten Bone
    // mit passendem Namen im Bone-Baum suchen.
    let boneRoot: THREE.Object3D | null = null;
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone && o.name === 'CC_Base_BoneRoot' && !boneRoot) boneRoot = o;
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

    for (const [ours, cc] of Object.entries(BONE_MAP)) {
      const node = findShallowest(cc) ?? model.getObjectByName(cc);
      if (!node) {
        console.warn('Dancer: Bone fehlt im Modell:', cc);
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
      });
    }

    // Hüfte: Positions-Offsets von Welt-Metern in den lokalen Raum umrechnen
    const hip = this.mapped.get('hips');
    if (hip?.node.parent) {
      const parentScale = hip.node.parent.getWorldScale(new THREE.Vector3());
      this.hipUnit = 1 / parentScale.y;
      this.hipParentQuatInv = hip.node.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    }

    this.ready = true;
  }

  /**
   * Das FBX bringt keine Texturen mit (externe Dateien) — die Meshes bekommen
   * ein eigenes Styling in Markenfarben (Just-Dance-Look).
   */
  private applyMaterials(model: THREE.Group) {
    // Just-Dance-Look: Cel-Shading mit hartem 3-Stufen-Verlauf statt
    // realistischem Licht — flächige, knallige Farben mit Comic-Schattenkante.
    // (skinning: true ist bei three r128 Pflicht auf SkinnedMeshes — sonst
    // rendert die GPU die Bind-Pose, egal was die Bones machen.)
    const gradient = new THREE.DataTexture(new Uint8Array([130, 215, 255]), 3, 1, THREE.LuminanceFormat);
    gradient.minFilter = THREE.NearestFilter;
    gradient.magFilter = THREE.NearestFilter;
    gradient.generateMipmaps = false;
    gradient.needsUpdate = true;
    const toon = (color: number) => new THREE.MeshToonMaterial({ color, gradientMap: gradient, skinning: true });

    const skin = toon(0xf2f3f5); // fast weiß, nur ein Hauch Grau — Just-Dance-Haut
    const top = toon(0xe71d73); // BR3 Pink
    const leggings = toon(0x2699d6); // BR3 Blau
    const hair = toon(0xf9b233); // BR3 Orange — Just-Dance-Haarfarbe
    // Overlay-Meshes (Tränenlinie, Augen-Schatten, Wimpern) brauchen Alpha-Maps,
    // die wir nicht haben → unsichtbar schalten
    const hidden = new THREE.MeshBasicMaterial({ visible: false });

    model.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      switch (mesh.name) {
        case 'CC_Base_Body':
          // Material-Reihenfolge im FBX: Head, Body, Arm, Leg, Nails, Eyelash
          mesh.material = [skin, skin, skin, skin, skin, hidden];
          break;
        case 'Tanktop':
          mesh.material = top;
          break;
        case 'ShortLeggings':
          mesh.material = leggings;
          break;
        case 'Haircut':
          mesh.material = hair;
          break;
        default:
          // Kein Gesicht: Augen, Zähne, Zunge, TearLine, EyeOcclusion & Co.
          // komplett aus — nur die blanke Kopfform bleibt
          mesh.material = hidden;
          mesh.castShadow = false;
      }
    });
  }

  /** Zufälliger anderer Move (nie derselbe zweimal hintereinander) */
  nextMove() {
    let n: number;
    do {
      n = Math.floor(Math.random() * MOVES.length);
    } while (n === this.moveIndex);
    this.moveIndex = n;
  }

  /** Pose für den aktuellen Frame; k=0 → ruhiges Atmen (Idle) */
  pose(c: MoveCtx, nowS: number, dt = 1 / 60) {
    if (!this.ready) return;
    this.resetDummies();

    if (c.k > 0) {
      MOVES[this.moveIndex].fn(this.dummies, c);
      this.addHumanNoise(nowS, 0.05 * c.k);
    } else {
      const idle = Math.sin(nowS * 1.2);
      this.dummies.hips.position.y += 0.01 * idle;
      this.dummies.chest.rotation.y = 0.04 * idle;
      this.dummies.head.rotation.x = 0.03 * Math.sin(nowS * 0.9);
      bendKnees(this.dummies, 0.03);
      this.addHumanNoise(nowS, 0.012);
    }

    this.applyToModel(dt);
  }

  /**
   * Humanizer: kleine, unregelmäßige Zusatzbewegungen. Pro Körperteil ein
   * leicht verstimmtes Sinus-Paar mit eigener Phase — dadurch ist die
   * Bewegung nie exakt symmetrisch und wiederholt sich nie sichtbar.
   */
  private addHumanNoise(t: number, a: number) {
    const d = this.dummies;
    const n = (f: number, ph: number) => Math.sin(t * f + ph) * Math.sin(t * f * 0.31 + ph * 1.7);
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
  private static eFixed = new THREE.Euler();

  /** Dummy-Rotationen (Welt-Achsen-Semantik) auf die CC-Bones übertragen */
  private applyToModel(dt: number) {
    // Pose-Trägheit: Bones folgen dem Ziel weich (~150 ms) statt hart pro
    // Frame — Move-Wechsel blenden über, Beats federn statt zu schnappen
    const follow = 1 - Math.exp(-Math.min(dt, 0.1) * 14);

    for (const [name, m] of this.mapped) {
      const dummy = this.dummies[name];

      // Gesamtrotation in Welt-Achsen: erst Grundhaltung, dann Move obendrauf
      const fix = AXIS_FIX[name];
      if (fix) {
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
      m.node.quaternion.slerp(Dancer.qTarget, follow);
      // Selbstheilung: ein einziges NaN würde im Slerp für immer hängen
      // bleiben (unsichtbares Mesh) — dann hart auf das Ziel setzen
      if (m.node.quaternion.x !== m.node.quaternion.x) m.node.quaternion.copy(Dancer.qTarget);

      if (name === 'hips') {
        // Positions-Bounce: Welt-Offset in den lokalen Raum der Hüfte drehen
        Dancer.vOff
          .set(dummy.position.x, dummy.position.y - 0.9, dummy.position.z)
          .applyQuaternion(this.hipParentQuatInv)
          .multiplyScalar(this.hipUnit)
          .add(m.restPos);
        m.node.position.lerp(Dancer.vOff, follow);
        if (m.node.position.y !== m.node.position.y) m.node.position.copy(Dancer.vOff);
      }
    }
  }
}
