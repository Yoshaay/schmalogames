import * as THREE from 'three';

/**
 * Prozedurale Tänze für den Schmalogroove-Dancer. Jeder Move rechnet auf
 * dem konzeptionellen Rig des Prototyps (hips/spine/chest/…, Rotationen um
 * Welt-Achsen) — das Retargeting auf das echte Mixamo-Skelett übernimmt
 * dancer.ts. Gewechselt wird alle 8 Beats.
 */

export type MoveBones = Record<string, THREE.Object3D>;

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

export const SIDES: Array<[string, number]> = [
  ['L', 1],
  ['R', -1],
];

export function bendKnees(bones: MoveBones, a: number) {
  // Knie federn, Füße bleiben flach
  for (const side of ['L', 'R']) {
    bones['thigh.' + side].rotation.x += a;
    bones['shin.' + side].rotation.x += -1.9 * a;
    bones['foot.' + side].rotation.x += 0.9 * a;
  }
}

/* Jeder Move setzt auf einer neutralen Pose auf. Gewechselt wird alle 8 Beats. */
export const MOVES: Array<{ name: string; fn(b: MoveBones, c: MoveCtx): void }> = [
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
