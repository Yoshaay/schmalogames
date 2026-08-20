import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader';
import modelData from './assets/DanceAvatar_rigged.fbx';

/**
 * Tänzer auf Basis des FBX-Modells (Mixamo-Rig, mixamorig*-Bones).
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
  /** aktuelles Tempo (für Clip-Playback), 0 = unbekannt */
  bpm?: number;
  /** Block-Zufall 0..1, konstant bis zum Move-Wechsel — für Stil-Varianten */
  v1?: number;
  v2?: number;
  /** Akzent: 1 auf der „1" jedes 4er-Takts, 0.35 auf der „3", sonst 0 */
  acc?: number;
}

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
      const v1 = c.v1 ?? 0.5;
      const acc = c.acc ?? 0;
      b.hips.position.y -= (0.1 + 0.03 * acc) * k * dip;
      b.hips.rotation.z = 0.13 * k * dip * dir;
      b.hips.rotation.y = 0.18 * k * s1 * dir;
      b.chest.rotation.z = -0.09 * k * dip * dir;
      b.chest.rotation.y = -0.24 * k * s1 * dir;
      b.chest.rotation.x = -0.08 * k * acc * dip; // Brust-Pop auf der „1"
      b.spine.rotation.x = 0.06 * k * dip;
      b.head.rotation.x = -0.38 * k * nod + 0.07 * k * dip;
      b.head.rotation.z = 0.06 * k * dip * dir;
      // Block-Variante: Arme pumpen tief an der Hüfte oder vor der Brust
      const lift = 0.3 + 0.5 * v1;
      for (const [side, sx] of SIDES) {
        b['upper_arm.' + side].rotation.z = sx * (0.35 + 0.2 * k * dip);
        b['upper_arm.' + side].rotation.x = -lift - 0.7 * k * s1 * dir * sx;
        b['forearm.' + side].rotation.x = -0.7 - 0.35 * lift - 0.7 * k * dip;
        b['hand.' + side].rotation.x = -0.3 * k * dip;
      }
      bendKnees(b, (0.5 + 0.15 * acc) * k * dip);
    },
  },
  {
    name: 'TWIST', // Chubby-Checker-Hüftschwung
    fn(b, c) {
      const { k, p, dip } = c;
      const v1 = c.v1 ?? 0.5;
      const tw = (0.6 + 0.15 * v1) * k * Math.sin((c.beatCount + p) * Math.PI); // durchgehende Welle
      // über 8 Beats einmal runter in die Knie und wieder hoch — wie beim echten Twist
      const low = 0.5 - 0.5 * Math.cos((((c.beatCount % 8) + p) / 8) * Math.PI * 2);
      b.hips.position.y -= k * (0.05 * dip + 0.16 * low);
      b.hips.rotation.y = tw; // Unterkörper dreht…
      b.chest.rotation.y = -1.7 * tw; // …Oberkörper kontert
      b.head.rotation.y = 0.6 * tw;
      b.spine.rotation.x = 0.12 * k * low; // unten leicht vorgebeugt
      for (const [side, sx] of SIDES) {
        // Arme angewinkelt, schwingen mit
        b['upper_arm.' + side].rotation.z = sx * 0.55;
        b['upper_arm.' + side].rotation.x = -0.35 - 0.25 * k * low;
        b['forearm.' + side].rotation.x = -1.55;
        b['foot.' + side].rotation.y = -0.8 * tw; // Füße pivotieren auf dem Ballen
      }
      bendKnees(b, k * (0.3 * (0.6 + 0.4 * dip) + 0.5 * low));
    },
  },
  {
    name: 'SIDE CLAP', // Lehnen zur Seite mit Clap vor der Brust
    fn(b, c) {
      const { k, dip, dir, s1 } = c;
      const acc = c.acc ?? 0;
      // Lehnen statt seitlich verschieben — verschieben ließe die Füße
      // über den Boden rutschen (Moonwalk-Effekt)
      b.hips.position.y -= 0.07 * k * dip;
      b.hips.rotation.z = -0.13 * k * s1 * dir;
      b.chest.rotation.z = (0.24 + 0.06 * acc) * k * s1 * dir; // lehnt in den Beat
      b.head.rotation.z = -0.1 * k * s1 * dir;
      for (const [side, sx] of SIDES) {
        b['upper_arm.' + side].rotation.z = sx * (0.5 - 0.15 * k * dip); // weit öffnen…
        b['upper_arm.' + side].rotation.x = -0.95;
        b['upper_arm.' + side].rotation.y = -sx * (0.95 + 0.1 * acc) * k * dip; // …und zusammenklatschen
        b['forearm.' + side].rotation.x = -0.5 - 0.35 * k * dip;
      }
      // Spielbein hebt ab
      const lift = dir > 0 ? 'R' : 'L';
      b['thigh.' + lift].rotation.x = 0.35 * k * dip;
      b['shin.' + lift].rotation.x = -0.6 * k * dip;
      bendKnees(b, 0.25 * k * dip);
    },
  },
  {
    name: 'HIP CIRCLE', // Hüfte kreist
    fn(b, c) {
      const { k, p, dip } = c;
      const v1 = c.v1 ?? 0.5;
      const v2 = c.v2 ?? 0.5;
      const rot = v1 < 0.5 ? 1 : -1; // Block-Variante: Kreisrichtung
      const a = (c.beatCount + p) * Math.PI * rot; // halber Kreis pro Beat
      b.hips.rotation.x = 0.16 * k * Math.cos(a);
      b.hips.rotation.z = 0.22 * k * Math.sin(a);
      b.chest.rotation.x = -0.13 * k * Math.cos(a); // Oberkörper kontert
      b.chest.rotation.z = -0.17 * k * Math.sin(a);
      b.head.rotation.z = 0.06 * k * Math.sin(a);
      // Block-Variante: Hände an der Hüfte oder Arme hoch im V,
      // die mit dem Hüftkreis mitschwingen
      const up = v2 >= 0.5;
      for (const [side, sx] of SIDES) {
        if (up) {
          b['upper_arm.' + side].rotation.z = sx * 2.3 + 0.3 * k * Math.sin(a);
          b['upper_arm.' + side].rotation.x = -0.1;
          b['forearm.' + side].rotation.x = -0.35;
          b['hand.' + side].rotation.x = 0.2;
        } else {
          b['upper_arm.' + side].rotation.z = sx * 0.85;
          b['forearm.' + side].rotation.x = -1.9;
          b['forearm.' + side].rotation.z = sx * -0.55;
        }
      }
      bendKnees(b, 0.35 * k * (0.5 + 0.5 * dip));
    },
  },
  {
    name: 'ARM WAVE', // Welle läuft gegenphasig durch beide Arme
    fn(b, c) {
      const { k, p, dip } = c;
      const acc = c.acc ?? 0;
      const t = (c.beatCount + p) * Math.PI;
      for (const [side, sx] of SIDES) {
        const off = side === 'L' ? 0 : Math.PI; // Arme gegenphasig
        b['upper_arm.' + side].rotation.z = sx * k * (1.45 + 0.4 * Math.sin(t + off));
        b['forearm.' + side].rotation.z = sx * 0.55 * k * Math.sin(t + off + 1.2);
        b['hand.' + side].rotation.z = sx * 0.7 * k * Math.sin(t + off + 2.2);
      }
      b.chest.rotation.z = 0.11 * k * Math.sin(t);
      b.head.rotation.z = -0.07 * k * Math.sin(t);
      b.hips.rotation.z = -0.07 * k * Math.sin(t);
      b.hips.position.y -= (0.07 + 0.03 * acc) * k * dip;
      bendKnees(b, (0.35 + 0.1 * acc) * k * dip);
    },
  },
  {
    name: 'KNEE SWING', // Charleston: tief in den Knien, Knie öffnen/schließen
    fn(b, c) {
      const { k, p, dip } = c;
      const acc = c.acc ?? 0;
      const sw = 0.5 + 0.5 * Math.sin((c.beatCount + p) * Math.PI);
      b.hips.position.y -= (0.16 + 0.03 * acc) * k * (0.4 + 0.6 * dip);
      b.spine.rotation.x = 0.26 * k;
      b.head.rotation.x = -0.24 * k;
      bendKnees(b, (0.6 + 0.1 * acc) * k * (0.5 + 0.5 * dip));
      for (const [side, sx] of SIDES) {
        b['thigh.' + side].rotation.y = -sx * 0.5 * k * sw; // Knie öffnen nach außen…
        b['foot.' + side].rotation.y = -sx * 0.42 * k * sw; // …Füße pivotieren mit
        b['upper_arm.' + side].rotation.z = sx * 0.3;
        b['upper_arm.' + side].rotation.x = -0.75 - 0.25 * k * dip;
        b['forearm.' + side].rotation.x = -0.55 - 0.25 * k * sw; // Hände schwingen mit
        b['hand.' + side].rotation.y = sx * 0.4 * k * sw;
      }
    },
  },
  {
    name: 'HIGH CLAP', // Klatschen über dem Kopf, federnd
    fn(b, c) {
      const { k, dip, s1, dir, nod } = c;
      const acc = c.acc ?? 0;
      b.hips.position.y -= (0.1 + 0.04 * acc) * k * dip;
      b.hips.rotation.z = 0.07 * k * s1 * dir;
      b.spine.rotation.x = -0.1 * k * dip;
      b.head.rotation.x = 0.22 * k * dip - 0.1 * k * nod;
      // Schließweg zum Klatschen: hart bei 1 gekappt — Flavor/Akzent treiben
      // k über 1, sonst schieben die Hände über den Kontaktpunkt hinaus
      // und kreuzen durcheinander
      const close = Math.min(1, k * dip);
      for (const [side, sx] of SIDES) {
        // zwischen den Claps weit ins V öffnen, auf dem Beat klatschen die
        // Handflächen wirklich aufeinander: Arme über die Senkrechte nach
        // innen (z→3.0) + Unterarme zueinander gebeugt (Werte per Simulation
        // bestimmt: Handgelenk-Abstand ~12 cm auf 1,86 m Höhe)
        b['upper_arm.' + side].rotation.z = sx * (2.2 + 0.8 * close);
        b['forearm.' + side].rotation.x = -0.25;
        b['forearm.' + side].rotation.z = sx * 0.5 * close; // über Kopf beugt +z zur Mitte
        b['hand.' + side].rotation.x = 0.3;
      }
      bendKnees(b, 0.4 * k * dip);
    },
  },
  {
    name: 'ELLI', // beide Arme angewinkelt, schwingen gemeinsam nach rechts und links
    fn(b, c) {
      const { k, p, dip, nod } = c;
      const v1 = c.v1 ?? 0.5;
      const acc = c.acc ?? 0;
      const sw = Math.sin((c.beatCount + p) * Math.PI); // Schwung wechselt pro Beat die Seite
      // Hüfte groovt im Takt: Bounce auf den Beat, Sway gegen den Schwung
      b.hips.position.y -= (0.09 + 0.03 * acc) * k * dip;
      b.hips.rotation.z = -0.08 * k * sw;
      b.hips.rotation.y = -0.14 * k * sw; // leichte Drehung: Hüfte kontert…
      b.chest.rotation.y = 0.3 * k * sw; // …Oberkörper dreht in den Schwung und trägt die Hände seitlich
      b.chest.rotation.z = -0.06 * k * sw;
      b.head.rotation.y = 0.18 * k * sw; // Blick folgt den Händen
      b.head.rotation.x = -0.2 * k * nod;
      for (const [side, sx] of SIDES) {
        // Arm auf der Schwungseite curlt den Unterarm hoch zur Schulter,
        // der andere streckt sich — wechselt mit dem Schwung pro Beat
        const curl = 0.5 * (1 + sw * sx);
        // Oberarm bleibt weitgehend hängen — nur so beugt der Welt-X-Bend
        // sauber im Ellenbogen-Scharnier (sonst dreht der Arm sich dünn).
        // Beim Curl geht der Ellbogen deutlich vor und leicht raus, damit
        // der Unterarm am Bauch vorbeischwingt statt hindurch
        b['upper_arm.' + side].rotation.z = sx * (0.35 + 0.25 * curl) + 0.2 * k * sw;
        b['upper_arm.' + side].rotation.x = -0.15 - (0.55 + 0.2 * v1) * k * curl;
        b['forearm.' + side].rotation.x = -0.35 - (1.8 + 0.15 * acc) * k * curl; // Unterarm hoch zur Schulter
        b['hand.' + side].rotation.x = -0.3 * k * curl; // Handgelenk zieht mit ein
      }
      bendKnees(b, (0.4 + 0.1 * acc) * k * dip);
    },
  },
  {
    name: 'MAWN-LOWER', // Rasenmäher anreißen: links unten am Holm, rechts zieht das Starterseil hoch
    fn(b, c) {
      const { k, p, dip, dir, s1, nod } = c;
      const acc = c.acc ?? 0;
      const sm = (t: number) => {
        const u = Math.min(Math.max(t, 0), 1);
        return u * u * (3 - 2 * u);
      };
      // Ein Anriss dauert 4 Beats: Beat 1–2 grooven runter zum Griff am
      // Boden, der Anriss KNALLT genau auf Beat 3 (cyc 0.5), danach federt
      // der Arm locker aus. Unter allem läuft der Beat-Bounce durch —
      // der Move darf nie stehen, sonst wirkt er roboterhaft.
      const cyc = ((c.beatCount % 4) + p) / 4;
      const down = cyc < 0.375 ? sm(cyc / 0.375) : cyc < 0.5 ? 1 - sm((cyc - 0.375) / 0.125) : 0;
      const pull = cyc < 0.375 ? 0 : cyc < 0.5 ? sm((cyc - 0.375) / 0.125) : 1 - sm((cyc - 0.5) / 0.3);
      // Nachschwung: der Zugarm pendelt nach dem Anriss zweimal locker aus
      const wob = cyc >= 0.5 ? 0.25 * Math.sin((cyc - 0.5) * Math.PI * 8) * (1 - sm((cyc - 0.5) / 0.5)) : 0;
      // Po-Wackeln in der Beuge: eine volle Welle pro Beat
      const wig = down * Math.sin((c.beatCount + p) * Math.PI * 2);
      // Zugarm wechselt nach jedem Anriss die Seite; die Pose-Trägheit
      // blendet den Wechsel weich über
      const pullL = Math.floor(c.beatCount / 4) % 2 === 1;
      const P = pullL ? 'L' : 'R'; // Zugarm (Starterseil)
      const H = pullL ? 'R' : 'L'; // Holm-Hand
      const sxP = pullL ? 1 : -1;
      // Groove-Basis: Bounce auf jedem Beat, Hüfte wackelt in der Beuge
      // und pendelt oben seitlich mit
      b.hips.position.y -= k * (0.08 * dip + 0.3 * down + 0.02 * acc);
      b.hips.rotation.z = k * (0.12 * wig + 0.08 * dip * dir * (1 - down));
      // Eindrehen: in der Beuge drehen Hüfte und Oberkörper zur Zugarm-Seite
      // ein, damit die Hand den Griff vor der KÖRPERMITTE fasst — der Anriss
      // dreht dann beides in die Gegenrichtung auf (Oberkörper führt)
      b.hips.rotation.y = -sxP * 0.18 * k * down + sxP * 0.1 * k * pull + 0.08 * k * s1 * dir * (1 - down - pull);
      // kräftig vorlehnen: die Zughand muss VOR den Knien greifen,
      // sonst schneidet der Arm auf dem Weg zur Mitte durch die Beine
      b.spine.rotation.x = k * (0.25 + 0.8 * down - 0.15 * pull + 0.05 * dip);
      b.chest.rotation.x = 0.45 * k * down;
      b.chest.rotation.y = -sxP * 0.32 * k * down + sxP * k * (0.08 + 0.35 * pull) - 0.1 * k * s1 * dir * (1 - down - pull);
      b.chest.rotation.z = -0.08 * k * wig; // Schulter kontert das Wackeln
      b.head.rotation.x = -k * (0.26 + 0.22 * down - 0.12 * pull) - 0.25 * k * nod;
      b.head.rotation.y = -sxP * 0.1 * k * down + sxP * 0.18 * k * pull; // Blick folgt der Zughand
      // Holm-Hand unten am Griff — pumpt den Holm im Takt statt still zu halten
      b['upper_arm.' + H].rotation.x = -0.5 - 0.15 * k * down - 0.08 * k * dip;
      b['upper_arm.' + H].rotation.z = -sxP * 0.3;
      b['forearm.' + H].rotation.x = -0.4 - 0.15 * k * dip;
      b['hand.' + H].rotation.x = -0.25;
      // Zugarm: hängt in der Beuge fast senkrecht runter (mit dem
      // vorgeklappten Rumpf reicht das bis an den Boden), der Anriss reißt
      // ihn hoch hinter die Schulter — danach schwingt er nach statt zu stoppen
      // Zugarm weit nach VORN-unten schwingen — der Rumpf ist so weit
      // vorgeklappt, dass "senkrecht hängen" effektiv hinter den Knien
      // landet. Werte per Headless-Messung bestimmt: Hand am tiefsten
      // Punkt bei x≈0 (Körpermitte), z≈0.46 — gut 13 cm VOR der Knieebene
      b['upper_arm.' + P].rotation.x = -0.25 - 1.5 * k * down + k * (1.35 * pull + wob);
      b['upper_arm.' + P].rotation.z = sxP * (0.25 - 0.15 * down + 0.65 * k * pull);
      b['forearm.' + P].rotation.x = -0.15 - 0.2 * down - k * (0.95 * pull + 0.5 * Math.max(0, wob));
      b['hand.' + P].rotation.x = -0.2 * down + 0.35 * k * pull;
      // Knie federn durchgehend, in der Beuge tief in die Hocke
      bendKnees(b, k * (0.3 + 0.45 * down + 0.15 * dip + 0.08 * acc));
    },
  },
];

/** Namen aller prozeduralen Moves — fürs Operator-Panel (Pose-Anwahl) */
export const MOVE_NAMES = MOVES.map((m) => m.name);

/** Nur für Geometrie-Tests (headless): Zugriff auf die Move-Funktionen */
export const MOVES_FOR_TEST = MOVES;

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
