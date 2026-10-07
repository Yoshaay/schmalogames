import { Game, GameContext, MK_H, MK_W, StationMode, VIEW_W, VIEW_H } from '../../core/game';
import { BeatEngine } from '../../core/beat';
import { LRCParser, parseMarkup, Segment } from './lrc-parser';
import bgUrl from './assets/final/Untertitel_BG_v2.png';

/**
 * Schmalaoke — Karaoke-Lyrics-Player als Schmalogames-Slot.
 * Portiert aus der Standalone-App SchmalKaraoke_ALPHA (die bleibt als
 * Backup unangetastet): State-Machine aus main.js, die Conveyor-Belt-
 * Animation aus player.js/player.css hier als Canvas-Nachbau.
 *
 * Steuerung kommt komplett aus dem Operator-Panel (Space/Pfeile/N/R,
 * Playlist, Sprungpunkte). Die Wall zeigt nur Logo bzw. Lyrics.
 */

/** Nachrichten vom Operator-Panel */
interface Cmd {
  cmd: 'song' | 'space' | 'prev' | 'nextsong' | 'restart' | 'jump' | 'reset' | 'auto' | 'micdev' | 'hello' | 'bpmreset' | 'bpmset' | 'notice' | 'blank';
  name?: string;
  content?: string;
  /** song: Teilungsgrenze, mit der das Panel geparst hat (Default 36) */
  maxChars?: number;
  /** notice: Durchsage-Text ('' = Durchsage aus) */
  text?: string;
  index?: number;
  enabled?: boolean;
  id?: string;
  value?: number;
}

/** Vorlauf: Zeile erscheint N Beats vor ihrem musikalischen Einsatz */
const PRE_BEATS = 1;

/** So viele Leertasten braucht Auto-Advance nach dem Einschalten, bevor es
 *  selbst zählt: 1 = Songstart, 2 = bestätigter Einsatz auf dem Beat */
const ARM_SPACES = 2;

/** Relative Abweichung Erkennung ↔ [bpm:]-Tag, ab der gewarnt wird */
const BPM_TOLERANCE = 0.08;

/* ---------- Conveyor-Animation (aus player.css, skaliert auf 1080p) ---------- */

type Role = 'current' | 'exitUp' | 'enterBelow' | 'exitDown' | 'enterAbove';

interface RoleState {
  y: number; // Offset zur Bildmitte
  alpha: number;
}

/** Anker des Lyric-Blocks: vertikale Mitte des pinken Bands im finalen
 *  Asset (Untertitel_BG_v2) — das Band läuft von y ≈ 204 (linke Spitze)
 *  bis y ≈ 408 (unterer Zacken), seine Mittellinie liegt fast waagerecht
 *  bei y ≈ 310. Der Text steht horizontal, keine Rotation: die Ober- und
 *  Unterkante laufen gegenläufig schräg, die Mitte bleibt gerade. */
const ANCHOR_Y = 310;

/** Lyric-Layout: immer EINE Zeile, horizontal zentriert im pinken Band,
 *  kein Umbruch — Zeilen sind zeichenmäßig unbegrenzt. Wird eine Zeile
 *  breiter als LYRIC_MAX_W, schrumpft die Schrift proportional, bis sie
 *  passt (wie der Cheer-Titel im Schmalogroove). LYRIC_X sitzt rechts
 *  der Bildmitte, weil das Band links spitz zuläuft: auf Zeilenhöhe
 *  (y ≈ 290–335 inkl. Unterlängen) liegt die linke Bandkante bei
 *  x ≈ 160–205, rechts geht das Band bis 1200. Die Fläche ist also
 *  ~200–1180, Mitte 690. LYRIC_MAX_W lässt links ~15 px Luft vor der
 *  schrägen Kante und rechts ~40 px zum Bildrand. */
const LYRIC_SIZE = 56;
/** Unterstreichung (<u>): Lage unter der Mittellinie und Dicke, in em */
const UNDERLINE_Y = 0.4;
const UNDERLINE_H = 0.06;
const LYRIC_X = 690;
const LYRIC_MAX_W = 940;

/** Clip-Maske für die Lyrics: das pinke Band aus dem finalen Asset
 *  (final/Untertitel_BG_v2, 641×1025), pixelgenau ausgemessen und in
 *  View-Koordinaten umgerechnet (Cover-Faktor 1920/1025). Die Schrift
 *  existiert nur innerhalb dieser Fläche — sie taucht beim Reinfliegen
 *  an der Oberkante des Bands auf und wird an der Unterkante weggewischt.
 *  Der grüne Streifen darunter bleibt frei. */
const LYRIC_CLIP: Array<[number, number]> = [
  [79, 204], // linke Spitze des pinken Bands
  [843, 238], // Knick: Oberkante wird steiler
  [1006, 258], // Kerbe — tiefster Punkt der Oberkante
  [1008, 245], // Kerbe — Sprung zurück nach oben
  [VIEW_W, 255], // Oberkante rechts
  [VIEW_W, 363], // Unterkante rechts
  [272, 408], // unterer Zacken (tiefster Punkt)
];

/** BAYERN-1-Layout: kein HG-Asset (nur Alpha), die Zeile steht horizontal
 *  zentriert im unteren Bilddrittel — rechnerische Mitte wäre 1600, auf
 *  Wunsch (2026-09-11) 15 px höher gemessen auf dem 640×1024-Ausgangsbild,
 *  das sind 28 px in View-Koordinaten. Statt des Band-Polygons wischt ein
 *  Rechteck um den Anker die ein- und ausfliegenden Zeilen weg — schmaler
 *  als der Rollen-Hub (±320), damit Exits sauber aus der Maske laufen. */
const B1_ANCHOR_Y = 1572;
const B1_X = VIEW_W / 2;
const B1_MAX_W = 1080;
const B1_CLIP_TOP = B1_ANCHOR_Y - 160;
const B1_CLIP_H = 320;

/** Notfall-Durchsage: freier Operator-Text (Suchmeldung, Warnung) an der
 *  Stelle der Lyrics, in derselben Schrift und Größe — als LAUFBAND: die
 *  ganze Meldung fährt in EINER Zeile von rechts nach links durchs Band
 *  (bzw. durchs untere Drittel in BAYERN 1), kein Umbruch, kein Halten.
 *  Nach dem Ende folgt nach einer Lücke sofort die nächste Runde. Absätze
 *  aus dem Textfeld werden mit „+++“ aneinandergehängt. */
/** Fahrgeschwindigkeit in px/s (bei 56 px Schrift ≈ 6 Zeichen/s) */
const NOTICE_SPEED = 180;
/** Lücke zwischen zwei Durchläufen in px */
const NOTICE_GAP = 480;
/** Die Durchsage läuft in beiden Modi oben auf der Höhe des B3-Bands
 *  (ANCHOR_Y) auf einem vollbreiten Balken auf reinem Alpha — das Band-
 *  Asset ist solange ausgeblendet: BAYERN 3 in Reinrot, BAYERN 1 in
 *  Warnrot. */
const NOTICE_BAR_B3 = '#ff0000';
const NOTICE_BAR_B1 = '#e24f36';
const NOTICE_BAR_H = 120;

/* ---------- Mitsingkonzert-Layout (quadratische View MK_W×MK_H) ----------
 * Oben die aktuelle Zeile groß, darunter die nächsten zwei Zeilen kleiner
 * und gedimmt — das Publikum sieht, was kommt, und bleibt nicht an einer
 * Zeile hängen, falls der Operator mal knapp weiterschaltet. Beim
 * Weiterschalten rutschen alle Zeilen einen Platz nach oben (Größe und
 * Deckkraft gleiten mit), unten blendet die nächste ein. Sprungmarken
 * ({Refrain} usw.) erscheinen bewusst NICHT auf der Wall — die sieht nur
 * der Operator im Rundown.
 *
 * Eine Zeile bricht auf höchstens zwei Reihen um (an der ausgewogensten
 * Wortgrenze) und schrumpft erst danach. Gesetzt wird in Referenzgröße
 * MK_REF_SIZE; die Plätze skalieren nur — so springt der Umbruch beim
 * Hochrutschen nicht. */
/** Schriftgröße der aktuellen Zeile = Referenz für Umbruch und Messung */
const MK_REF_SIZE = 112;
/** Zeilenabstand (× Schriftgröße) zwischen den zwei Reihen einer Zeile */
const MK_LINE_H = 1.1;
/** Nutzbreite für den Text (Rand links/rechts je 96 px) */
const MK_MAX_W = MK_W - 2 * 96;
/** Lyrics in Weiß */
const MK_TEXT = '#ffffff';
/** Plätze: -1 = gerade oben raus, 0 = aktuell, 1/2 = Vorschau, 3 = kommt
 *  unten rein. y = Mitte der Zeile in View-Koordinaten. Zwischen den
 *  Plätzen wird linear interpoliert (die Bewegung selbst ist geeast). */
const MK_SLOTS: Array<{ y: number; size: number; alpha: number }> = [
  { y: 120, size: MK_REF_SIZE, alpha: 0 },
  { y: 440, size: MK_REF_SIZE, alpha: 1 },
  { y: 860, size: 72, alpha: 0.6 },
  { y: 1150, size: 72, alpha: 0.38 },
  { y: 1420, size: 72, alpha: 0 },
];
/** Notfall-Durchsage im Mitsingkonzert: Laufband auf rotem Balken am
 *  unteren Bildrand (Lyrics sind solange ausgeblendet) */
const MK_NOTICE_SIZE = 88;
const MK_NOTICE_BAR_H = 160;

/** Umbruch einer Zeile in Referenzgröße (gecacht pro Text) */
interface MkLayout {
  rows: Array<{ segs: Segment[]; widths: number[]; w: number }>;
  /** Schrumpffaktor, falls auch zwei Reihen zu breit sind */
  fit: number;
}

/** Vertikaler Durchlauf (abwärts): Zeilen fliegen von oben aus dem Bild
 *  rein und knapp unterhalb der Farbfläche raus (dort wischt die Clip-
 *  Maske sie an der Unterkante weg). Kein Alpha-Fade. */
const ROLES: Record<Role, RoleState> = {
  current: { y: 0, alpha: 1 },
  exitUp: { y: -320, alpha: 1 },
  enterBelow: { y: 320, alpha: 1 },
  exitDown: { y: 320, alpha: 1 },
  enterAbove: { y: -320, alpha: 1 },
};

const ANIM_S = 0.4; // 400ms wie im Original

/** Schwarz (Taste S, z.B. für Solos): Dauer des Aus-/Einblendens in s */
const BLANK_FADE_S = 0.3;

/** Eine animierte Textzeile: blendet von einer Rolle zur nächsten */
interface Sprite {
  text: string;
  from: Role;
  to: Role;
  /** Startzeit (Spielzeit in s); Zukunft = wartet noch (Phase 2) */
  t0: number;
  /** nach Ablauf entfernen (Exit-Rollen) */
  transient: boolean;
}

/** cubic-bezier(0.4, 0, 0.2, 1) — angenähert */
const ease = (t: number) => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};

export class Schmalaoke implements Game {
  private ctx: GameContext | null = null;
  private time = 0;

  /** CI-Hintergrund (transparentes Overlay über schwarzer Basis) */
  private bg = new Image();

  /* ---------- Song-State (portiert aus main.js) ---------- */
  private parser = new LRCParser();
  private lines: string[] = [];
  private currentLine = 0;
  private pendingJump = -1;
  private lyricsModeStarted = false;
  private songEndedDisplayed = false;
  private waitingForStart = false;
  private title = '';
  private artist = '';
  private errorText: string | null = null;
  private endTimer = -1; // Countdown bis 'song-ended' ans Panel

  /* ---------- Auto-Advance (Beat-Detection, portiert aus main.js) ---------- */
  private engine = new BeatEngine();
  private autoMode = false;
  private listening = false;
  private actx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private micStream: MediaStream | null = null;
  private micDeviceId: string | null = localStorage.getItem('schmalaoke.micDevice');
  private onDeviceChange = () => this.sendInputList();
  private beatCounts: number[] = [];
  /** Sicherung: ohne einen einzigen <N>-Tag in der LRC bleibt Auto stumm —
   *  sonst würde der Default (1 Beat/Zeile) die Lyrics durchrattern */
  private autoCapable = false;
  /** Fest eingetippter BPM-Wert (0 = Mikrofon-Erkennung). Das Grid läuft
   *  dann rein von der Uhr — ganz ohne Audio-Eingang. */
  private manualBpm = 0;
  /** Referenztempo aus dem [bpm:]-Tag der LRC (0 = keins) — nur Anzeige/
   *  Abgleich, setzt nichts von selbst */
  private refBpm = 0;
  private currentBeatInLine = 0;
  /** Sperrzeit nach manueller Korrektur (ms, Date.now-Basis) */
  private beatCooldownUntil = 0;
  /** Freigabe: Auto zählt erst, nachdem der Operator seit dem Einschalten
   *  (bzw. seit BPM-Änderung / neuem Song) ARM_SPACES-mal Leertaste gedrückt
   *  hat — die erste startet den Song / zeigt die Zeile, erst die zweite
   *  bestätigt, dass Mensch und Musik synchron sind. Damit fährt Auto nie
   *  von selbst los; das Grid übernimmt erst danach. */
  private autoSpaces = 0;

  /* ---------- Anzeige ---------- */
  private sprites: Sprite[] = [];
  /** BAYERN-1-Modus: kein HG-Asset, Lyrics im unteren Drittel */
  private b1 = false;
  /** Mitsingkonzert: quadratische View, Drei-Zeilen-Layout */
  private mk = false;
  /** Mitsingkonzert-Scroll: angezeigte Zeilenposition gleitet von
   *  mkFrom zu currentLine (Start mkT0) */
  private mkFrom = 0;
  private mkT0 = -1;
  /** Zeile, auf die die laufende Gleitbewegung zielt */
  private mkTarget = 0;
  private mkLayouts = new Map<string, MkLayout>();
  /** Notfall-Durchsage: Text ('' = aus), verdrängt die Lyrics-Anzeige */
  private notice = '';
  /** Schwarz: Lyrics ausgeblendet, Song läuft im Hintergrund weiter.
   *  lyricFade gleitet zwischen 1 (sichtbar) und 0 (schwarz). */
  private blank = false;
  private lyricFade = 1;
  private noticeT0 = 0;
  /** Laufband-Zeile + gemessene Breite (Cache, neu bei Textänderung) */
  private noticeLine = '';
  private noticeWidth = 0;
  private noticeKey = '';

  setStationMode(mode: StationMode) {
    this.b1 = mode === 'b1';
    this.mk = mode === 'mk';
    this.mkFrom = this.mkTarget = this.currentLine;
    this.mkT0 = -1;
  }

  init(ctx: GameContext) {
    this.ctx = ctx;
    this.bg.src = bgUrl;
    this.engine.onBeat = () => this.handleDetectedBeat();
    navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
  }

  dispose() {
    navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
    this.stopListening();
    this.actx?.close();
    this.actx = null;
  }

  onMessage(payload: unknown) {
    const msg = payload as Cmd;
    switch (msg.cmd) {
      case 'song':
        this.loadSong(msg.name ?? '', msg.content ?? '', msg.maxChars);
        break;
      case 'space':
        this.handleSpace();
        break;
      case 'prev':
        this.previousLine();
        break;
      case 'nextsong':
        this.finishSong();
        break;
      case 'restart':
        this.restartSong();
        break;
      case 'jump':
        this.armJump(msg.index ?? -1);
        break;
      case 'reset':
        this.resetForNewSong();
        this.title = '';
        this.artist = '';
        this.sendPresenter();
        break;
      case 'hello':
        this.sendInputList();
        this.sendPresenter();
        break;
      case 'blank':
        this.setBlank(!this.blank);
        break;
      case 'notice':
        this.setNotice(msg.text ?? '');
        break;
      case 'auto':
        this.setAutoMode(!!msg.enabled);
        break;
      case 'bpmreset':
        // Erkennung hat sich verrannt bzw. fester Wert soll weg:
        // zurück zur Mikrofon-Erkennung, neu einlocken lassen
        this.manualBpm = 0;
        this.engine.reset();
        this.currentBeatInLine = 0;
        this.beatCooldownUntil = 0;
        this.autoSpaces = 0;
        if (this.autoMode && !this.listening) this.startListening();
        this.sendPresenter();
        break;
      case 'bpmset': {
        const v = Math.round(msg.value ?? 0);
        if (v > 0) {
          // Fester Wert: Mikro freigeben, Grid ab jetzt von der Uhr
          this.stopListening();
          this.manualBpm = Math.min(240, Math.max(40, v));
          this.engine.setBpm(this.manualBpm, performance.now());
          this.currentBeatInLine = 0;
          this.beatCooldownUntil = 0;
          this.autoSpaces = 0;
        } else {
          // Feld geleert: zurück zur Mikrofon-Erkennung
          this.manualBpm = 0;
          this.engine.reset();
          this.currentBeatInLine = 0;
          this.beatCooldownUntil = 0;
          this.autoSpaces = 0;
          if (this.autoMode) this.startListening();
        }
        this.sendPresenter();
        break;
      }
      case 'micdev':
        this.micDeviceId = msg.id && msg.id !== 'default' ? msg.id : null;
        if (this.micDeviceId) localStorage.setItem('schmalaoke.micDevice', this.micDeviceId);
        else localStorage.removeItem('schmalaoke.micDevice');
        if (this.listening) {
          this.stopListening();
          this.startListening();
        }
        break;
    }
  }

  /* ---------- Auto-Advance ---------- */

  private setAutoMode(enabled: boolean) {
    this.autoMode = enabled;
    this.currentBeatInLine = 0;
    this.beatCooldownUntil = 0;
    // Einschalten ist nur Bereitschaft — losfahren darf Auto erst nach
    // zwei Leertasten (siehe autoSpaces)
    this.autoSpaces = 0;
    if (enabled) {
      // Fester BPM-Wert braucht kein Mikro — Grid neu ab jetzt ausrichten
      if (this.manualBpm > 0) this.engine.setBpm(this.manualBpm, performance.now());
      else this.startListening();
    } else {
      this.stopListening();
    }
    this.sendPresenter();
  }

  private async startListening() {
    if (this.listening) return;
    if (!this.actx) {
      this.actx = new AudioContext();
      this.analyser = this.actx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.3;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    }
    if (this.actx.state === 'suspended') this.actx.resume();
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(this.micDeviceId ? { deviceId: { exact: this.micDeviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this.actx.createMediaStreamSource(this.micStream).connect(this.analyser!);
      this.engine.reset();
      this.listening = true;
      this.sendInputList(); // nach erfolgreichem Zugriff sind Labels verfügbar
    } catch {
      this.ctx?.sendToOperator({ kind: 'error', text: 'Audio-Eingang nicht verfügbar' });
      this.autoMode = false;
    }
    this.sendPresenter();
  }

  private stopListening() {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.listening = false;
    this.engine.reset();
  }

  private isArmed(): boolean {
    return this.autoSpaces >= ARM_SPACES;
  }

  /** Erkanntes/festes Tempo weicht mehr als BPM_TOLERANCE vom [bpm:]-Tag
   *  ab (typisch: halbes/doppeltes Tempo) — die <N>-Tags können dann nicht
   *  stimmen */
  private bpmMismatch(): boolean {
    if (this.refBpm <= 0 || this.engine.bpm <= 0) return false;
    return Math.abs(this.engine.bpm / this.refBpm - 1) > BPM_TOLERANCE;
  }

  /** Ampel: grün, sobald die Engine eingerastet ist (oder das Tempo fest
   *  eingetippt wurde) — die Uhr läuft dann durch, bis die Engine einen
   *  echten Tempowechsel erkennt; gelb = sucht noch, manuell fahren */
  private isLocked(): boolean {
    return this.engine.periodMs > 0 && (this.engine.manual || this.engine.locked);
  }

  /** Beat vom Audio-Grid: Zähler pro Zeile, bei <N> erreicht → weiterblättern */
  private handleDetectedBeat() {
    const locked = this.isLocked();
    this.ctx?.sendToOperator({
      kind: 'beat',
      bpm: this.engine.bpm,
      locked,
      lockedFor: this.engine.lockedFor(performance.now()),
      manual: this.manualBpm > 0,
      armed: this.isArmed(),
      spaces: this.autoSpaces,
      ref: this.refBpm,
    });
    if (!this.autoMode || !this.lyricsModeStarted || this.songEndedDisplayed) return;
    // Noch keine Freigabe per Leertaste: Grid läuft mit, zählt aber nicht
    if (!this.isArmed()) return;
    // Song ohne Beat-Tags: Auto greift NICHT ein (nur manuell weiterblättern)
    if (!this.autoCapable) return;
    // Ampel gelb (Erkennung noch nicht stabil): manuell fahren, nicht zählen
    if (!locked) return;
    if (Date.now() < this.beatCooldownUntil) return;

    this.currentBeatInLine++;
    const beatsNeeded = this.beatCounts[this.currentLine] || 1;
    if (this.currentBeatInLine >= beatsNeeded) {
      this.currentBeatInLine = 0;
      this.nextLine();
    }
  }

  /** Verfügbare Audio-Eingänge ans Operator-Panel schicken */
  private async sendInputList() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices
        .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Eingang ${i + 1}` }));
      this.ctx?.sendToOperator({ kind: 'inputs', devices: inputs, selected: this.micDeviceId ?? 'default' });
    } catch {}
  }

  getStatus(): Record<string, string | number> {
    const zustand = this.errorText
      ? 'FEHLER'
      : this.songEndedDisplayed
        ? 'Song-Ende'
        : this.lyricsModeStarted
          ? 'läuft'
          : this.lines.length
            ? 'bereit — Leertaste startet'
            : 'kein Song geladen';
    return {
      Zustand: zustand,
      ...(this.notice ? { Durchsage: 'LIVE — Lyrics ausgeblendet' } : {}),
      Titel: this.title || '—',
      Zeile: this.lyricsModeStarted ? `${Math.min(this.currentLine + 1, this.lines.length)} / ${this.lines.length}` : '—',
      Auto: !this.autoMode
        ? 'aus'
        : this.lines.length && !this.autoCapable
          ? 'AN — Song ohne Beat-Tags, nur manuell!'
          : !this.isArmed()
            ? `AN — wartet auf Leertaste (${this.autoSpaces}/${ARM_SPACES})`
            : this.isLocked()
              ? this.bpmMismatch()
                ? `AN · ${Math.round(this.engine.bpm)} BPM ≠ Song ${this.refBpm} — passt NICHT!`
                : `AN · ${Math.round(this.engine.bpm)} BPM${this.manualBpm > 0 ? ' (fix)' : ''} · fährt`
              : 'AN · lauscht — manuell fahren',
    };
  }

  update(dt: number) {
    this.time += dt;
    const fadeTo = this.blank ? 0 : 1;
    const step = dt / BLANK_FADE_S;
    this.lyricFade = this.lyricFade < fadeTo ? Math.min(fadeTo, this.lyricFade + step) : Math.max(fadeTo, this.lyricFade - step);

    // Beat-Detection: Audio abtasten, Grid weiterschalten (feuert onBeat)
    if (this.listening && this.analyser && this.freq) {
      const now = performance.now();
      this.analyser.getByteFrequencyData(this.freq);
      this.engine.sample(this.freq, now);
      this.engine.update(now, dt);
    } else if (this.autoMode && this.manualBpm > 0) {
      // Fester eingetippter BPM-Wert: Grid läuft rein von der Uhr
      this.engine.update(performance.now(), dt);
    }

    // Song-Ende: nach der Auslauf-Animation ans Panel melden (Auto-Next)
    if (this.endTimer > 0) {
      this.endTimer -= dt;
      if (this.endTimer <= 0) {
        this.endTimer = -1;
        this.ctx?.sendToOperator({ kind: 'song-ended' });
      }
    }
  }

  render(g: CanvasRenderingContext2D) {
    // KEINE schwarze Grundfüllung: alles außerhalb der Farbflächen bleibt
    // echt transparent (Alpha), damit im Ü-Wagen ein Livefeed dahinter
    // gelegt werden kann. Auf der Wall wirkt es weiter schwarz (Fenster-
    // Hintergrund); der Host cleart den Canvas jeden Frame.
    // Während einer Notfall-Durchsage bleibt auch in BAYERN 3 das Band-
    // Asset weg: nur der rote Balken auf Alpha, kein Pink/Grün darunter
    if (this.mk) {
      this.renderMk(g);
      return;
    }
    if (!this.b1 && !this.notice && this.bg.complete && this.bg.naturalWidth) {
      this.drawBg(g);
    }

    // Notfall-Durchsage hat Vorrang vor allem anderen
    if (this.notice) {
      this.drawNotice(g, ANCHOR_Y - NOTICE_BAR_H / 2, VIEW_W, NOTICE_BAR_H, LYRIC_SIZE, this.b1 ? NOTICE_BAR_B1 : NOTICE_BAR_B3);
      return;
    }

    if (this.errorText) {
      this.drawLine(g, this.errorText, ROLES.current, 1);
      return;
    }

    const showLyrics = this.lyricsModeStarted && !this.songEndedDisplayed;
    if (!showLyrics) {
      // Ruhe-/Ready-/Ende-Zustand: nur der Hintergrund, kein Logo
      return;
    }

    // aktive Sprites zeichnen, abgelaufene Exits entsorgen
    this.sprites = this.sprites.filter((s) => {
      const t = (this.time - s.t0) / ANIM_S;
      if (t < 0) return true; // Phase 2 wartet noch — nicht zeichnen
      return !(s.transient && t >= 1);
    });

    // Lyrics innerhalb der Clip-Maske zeichnen
    g.save();
    this.clipLyrics(g);
    for (const s of this.sprites) {
      const t = ease((this.time - s.t0) / ANIM_S);
      if ((this.time - s.t0) / ANIM_S < 0) continue; // Phase 2 wartet noch
      const a = ROLES[s.from];
      const b = ROLES[s.to];
      const state: RoleState = {
        y: a.y + (b.y - a.y) * t,
        alpha: a.alpha + (b.alpha - a.alpha) * t,
      };
      this.drawLine(g, s.text, state, state.alpha);
    }
    g.restore();
  }

  /** Hintergrund als Cover-Crop: Seitenverhältnis erhalten, oben verankert
   *  und horizontal zentriert — die Farbflächen hängen an der Oberkante
   *  der Wall. */
  private drawBg(ctx: CanvasRenderingContext2D) {
    const s = Math.max(VIEW_W / this.bg.naturalWidth, VIEW_H / this.bg.naturalHeight);
    const w = this.bg.naturalWidth * s;
    const h = this.bg.naturalHeight * s;
    ctx.drawImage(this.bg, (VIEW_W - w) / 2, 0, w, h);
  }

  /** Zeile zeichnen — immer einzeilig, zentriert auf dem Anker. Zeilen
   *  breiter als LYRIC_MAX_W werden proportional kleiner skaliert statt
   *  umzubrechen oder an der Maske zu clippen. Formatierungs-Tags
   *  (<b> <i> <u>) werden als Segmente mit eigenem Schnitt gesetzt: fett =
   *  Black (900) statt Bold, kursiv = Italic, unterstrichen = Balken. */
  private drawLine(g: CanvasRenderingContext2D, text: string, state: RoleState, alpha: number) {
    alpha *= this.lyricFade;
    if (!text || alpha <= 0.01) return;
    const segs = parseMarkup(text);
    if (!segs.length) return;
    g.save();
    g.globalAlpha = alpha;
    // Lyrics immer weiß — keine Grau-Abstufung, keine Farbanimation
    g.fillStyle = '#ffffff';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const fontFor = (s: Segment) => `${s.i ? 'italic ' : ''}${s.b ? 900 : 700} ${LYRIC_SIZE}px 'TheSans', system-ui, sans-serif`;
    let total = 0;
    const widths = segs.map((s) => {
      g.font = fontFor(s);
      const w = g.measureText(s.text).width;
      total += w;
      return w;
    });
    const maxW = this.b1 ? B1_MAX_W : LYRIC_MAX_W;
    const fit = Math.min(1, maxW / Math.max(1, total));
    g.translate(this.b1 ? B1_X : LYRIC_X, (this.b1 ? B1_ANCHOR_Y : ANCHOR_Y) + state.y);
    g.scale(fit, fit);
    let x = -total / 2;
    segs.forEach((s, k) => {
      g.font = fontFor(s);
      g.fillText(s.text, x, 0);
      if (s.u) g.fillRect(x, LYRIC_SIZE * UNDERLINE_Y, widths[k], LYRIC_SIZE * UNDERLINE_H);
      x += widths[k];
    });
    g.restore();
  }

  /* ---------- Mitsingkonzert ---------- */

  private renderMk(g: CanvasRenderingContext2D) {
    if (this.notice) {
      this.drawNotice(g, MK_H - MK_NOTICE_BAR_H, MK_W, MK_NOTICE_BAR_H, MK_NOTICE_SIZE, NOTICE_BAR_B1);
      return;
    }
    if (this.errorText) {
      this.drawMkLine(g, this.errorText, 0);
      return;
    }
    if (!this.lyricsModeStarted) return;
    // Song-Ende: die letzte Zeile fährt noch nach oben raus (Ziel = eine
    // Zeile hinter dem Ende, da kommt nichts nach) — danach bleibt es leer
    if (this.songEndedDisplayed && this.mkT0 < 0) return;
    const target = this.songEndedDisplayed ? this.mkTarget : this.currentLine;

    // Angezeigte Position: gleitet vom alten zum neuen Ziel
    let pos = target;
    if (this.mkT0 >= 0) {
      const t = (this.time - this.mkT0) / ANIM_S;
      if (t >= 1) this.mkT0 = -1;
      else pos = this.mkFrom + (target - this.mkFrom) * ease(t);
    }
    const first = Math.max(0, Math.floor(pos) - 1);
    const last = Math.min(this.lines.length - 1, Math.ceil(pos) + MK_SLOTS.length - 2);
    for (let i = first; i <= last; i++) {
      this.drawMkLine(g, this.lines[i], i - pos);
    }
  }

  /** Neue Zeile im Mitsingkonzert: weich gleiten (vor/zurück) oder harter
   *  Schnitt (Start, Sprung, Neustart) */
  private mkMove(hard: boolean) {
    if (hard) {
      this.mkT0 = -1;
      return;
    }
    // Aus der aktuellen Zwischenposition weiter — schnelles Mehrfach-
    // Drücken bleibt flüssig statt zu springen
    let from = this.mkFrom;
    if (this.mkT0 >= 0) {
      const t = Math.min(1, (this.time - this.mkT0) / ANIM_S);
      from = this.mkFrom + (this.mkTarget - this.mkFrom) * ease(t);
    } else {
      from = this.mkTarget;
    }
    this.mkFrom = from;
    this.mkT0 = this.time;
  }
  /** Eine Zeile auf Platz-Position slot (0 = aktuell, 1/2 = Vorschau,
   *  Zwischenwerte während der Bewegung) */
  private drawMkLine(g: CanvasRenderingContext2D, text: string, slot: number) {
    const sp = slot + 1; // Index in MK_SLOTS (Platz -1 liegt bei 0)
    if (sp < 0 || sp > MK_SLOTS.length - 1) return;
    const i0 = Math.floor(sp);
    const i1 = Math.min(MK_SLOTS.length - 1, i0 + 1);
    const f = sp - i0;
    const a = MK_SLOTS[i0];
    const b = MK_SLOTS[i1];
    const y = a.y + (b.y - a.y) * f;
    const size = a.size + (b.size - a.size) * f;
    const alpha = (a.alpha + (b.alpha - a.alpha) * f) * this.lyricFade;
    if (!text || alpha <= 0.01) return;

    const lay = this.mkLayout(g, text);
    const k = size / MK_REF_SIZE;
    const rowH = MK_REF_SIZE * MK_LINE_H;
    const n = lay.rows.length;
    g.save();
    g.globalAlpha = alpha;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.translate(MK_W / 2, y);
    g.scale(k, k);

    g.scale(lay.fit, lay.fit);
    g.fillStyle = MK_TEXT;
    // Vorschauzeilen in leichterem Schnitt, damit der Blick auf der
    // aktuellen Zeile bleibt. Beim Hochrutschen blendet der leichte in den
    // fetten Schnitt über (kein Sprung). Umbruch bleibt der des fetten
    // Schnitts — nur die Breiten werden pro Schnitt gemessen.
    // Überblendung nur im kurzen Abschnitt Platz 0,2–0,5 — überlagerte
    // Schnitte wirken sonst sichtbar doppelt
    const light = Math.min(1, Math.max(0, (slot - 0.2) / 0.3));
    const drawRows = (isLight: boolean, a: number) => {
      if (a <= 0.01) return;
      g.globalAlpha = alpha * a;
      lay.rows.forEach((row, r) => {
        const ry = (r - (n - 1) / 2) * rowH;
        const widths = isLight
          ? row.segs.map((s) => {
              g.font = mkFont(s, true);
              return g.measureText(s.text).width;
            })
          : row.widths;
        let x = -widths.reduce((sum, w) => sum + w, 0) / 2;
        row.segs.forEach((s, j) => {
          g.font = mkFont(s, isLight);
          g.fillText(s.text, x, ry);
          if (s.u) g.fillRect(x, ry + MK_REF_SIZE * UNDERLINE_Y, widths[j], MK_REF_SIZE * UNDERLINE_H);
          x += widths[j];
        });
      });
    };
    drawRows(false, 1 - light);
    drawRows(true, light);
    g.restore();
  }

  /** Umbruch: passt die Zeile in MK_MAX_W, bleibt sie einreihig; sonst an
   *  der Wortgrenze, die die beiden Reihen am gleichmäßigsten macht. Sind
   *  auch zwei Reihen zu breit, schrumpft die ganze Zeile. */
  private mkLayout(g: CanvasRenderingContext2D, text: string): MkLayout {
    const cached = this.mkLayouts.get(text);
    if (cached) return cached;
    const segs = parseMarkup(text);
    // Wörter samt folgendem Leerzeichen als Stil-Stücke
    const tokens: Segment[] = [];
    for (const s of segs) {
      for (const part of s.text.split(/(?<= )/)) if (part) tokens.push({ ...s, text: part });
    }
    const measure = (t: Segment) => {
      g.font = mkFont(t);
      return g.measureText(t.text).width;
    };
    const widths = tokens.map(measure);
    const trimW = (from: number, to: number) => {
      // Breite der Tokens [from, to) ohne das letzte Leerzeichen
      let w = 0;
      for (let i = from; i < to; i++) w += widths[i];
      const lastTok = tokens[to - 1];
      if (lastTok && lastTok.text.endsWith(' ')) {
        g.font = mkFont(lastTok);
        w -= g.measureText(' ').width;
      }
      return w;
    };
    const row = (from: number, to: number) => {
      const rs = tokens.slice(from, to).map((t) => ({ ...t }));
      if (rs.length) rs[rs.length - 1].text = rs[rs.length - 1].text.trimEnd();
      const ws = rs.map(measure);
      return { segs: rs, widths: ws, w: ws.reduce((x, y) => x + y, 0) };
    };

    let lay: MkLayout;
    const full = trimW(0, tokens.length);
    if (full <= MK_MAX_W || tokens.length < 2) {
      lay = { rows: [row(0, tokens.length)], fit: Math.min(1, MK_MAX_W / Math.max(1, full)) };
    } else {
      let best = 1;
      let bestW = Infinity;
      for (let i = 1; i < tokens.length; i++) {
        const w = Math.max(trimW(0, i), trimW(i, tokens.length));
        if (w < bestW) {
          bestW = w;
          best = i;
        }
      }
      lay = { rows: [row(0, best), row(best, tokens.length)], fit: Math.min(1, MK_MAX_W / bestW) };
    }
    this.mkLayouts.set(text, lay);
    return lay;
  }

  /* ---------- Notfall-Durchsage ---------- */

  private setNotice(text: string) {
    const t = text.replace(/\r/g, '').trim();
    if (t !== this.notice) this.noticeT0 = this.time;
    this.notice = t;
    this.sendPresenter();
  }

  /** Laufband auf vollbreitem Balken (top/h in View-Koordinaten). Tempo
   *  und Lücke skalieren mit der Schriftgröße, damit gleich viele Zeichen
   *  pro Sekunde durchlaufen wie im Festival-Layout. */
  private drawNotice(g: CanvasRenderingContext2D, top: number, w: number, h: number, size: number, color: string) {
    g.save();
    // Balken zeichnen, Laufband darauf clippen
    g.fillStyle = color;
    g.fillRect(0, top, w, h);
    g.beginPath();
    g.rect(0, top, w, h);
    g.clip();
    g.fillStyle = '#ffffff';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.font = `700 ${size}px 'TheSans', system-ui, sans-serif`;

    // Laufband-Text: Absätze zu einer Zeile verbinden, Breite einmal messen
    const key = `${size}|${this.notice}`;
    if (this.noticeKey !== key) {
      this.noticeKey = key;
      this.noticeLine = this.notice
        .split('\n')
        .map((l) => l.trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .join(' +++ ');
      this.noticeWidth = g.measureText(this.noticeLine).width;
    }
    if (!this.noticeLine) {
      g.restore();
      return;
    }

    // Startet am rechten Bildrand, fährt nach links; Kopien im Abstand
    // period, damit nach der Lücke nahtlos die nächste Runde folgt
    const k = size / LYRIC_SIZE;
    const period = this.noticeWidth + NOTICE_GAP * k;
    const offset = (Math.max(0, this.time - this.noticeT0) * NOTICE_SPEED * k) % period;
    const y = top + h / 2;
    for (let x = w - offset; x + this.noticeWidth > 0; x -= period) g.fillText(this.noticeLine, x, y);
    g.restore();
  }

  /** Clip-Maske der Lyrics setzen: BAYERN 3 = Polygon-Kante des pinken
   *  Bands (pixelgenau), BAYERN 1 = Rechteck ums untere Drittel */
  private clipLyrics(g: CanvasRenderingContext2D) {
    g.beginPath();
    if (this.b1) {
      g.rect(0, B1_CLIP_TOP, VIEW_W, B1_CLIP_H);
    } else {
      LYRIC_CLIP.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
    }
    g.clip();
  }

  /* ---------- State-Machine (portiert aus main.js) ---------- */

  private resetForNewSong() {
    this.blank = false;
    this.lyricFade = 1;
    this.lines = [];
    this.currentLine = 0;
    this.pendingJump = -1;
    this.lyricsModeStarted = false;
    this.songEndedDisplayed = false;
    this.waitingForStart = false;
    this.errorText = null;
    this.endTimer = -1;
    this.sprites = [];
    this.mkLayouts.clear();
    this.mkT0 = -1;
    this.beatCounts = [];
    this.currentBeatInLine = 0;
    this.beatCooldownUntil = 0;
    this.autoSpaces = 0;
    this.refBpm = 0;
  }

  private loadSong(name: string, content: string, maxChars?: number) {
    this.resetForNewSong();
    if (!this.parser.parseContent(content, maxChars)) {
      this.errorText = 'Keine Lyrics gefunden';
      this.sendPresenter();
      return;
    }
    this.lines = [...this.parser.lyricsLines];
    this.beatCounts = [...this.parser.beatCounts];
    this.autoCapable = this.parser.beatTagged.some(Boolean);
    this.refBpm = this.parser.refBpm;
    this.title = this.parser.metadata.ti || name.replace(/\.lrc$/i, '');
    this.artist = this.parser.metadata.ar || '';
    this.waitingForStart = true;
    this.sendPresenter();
  }

  private currentText(): string {
    const max = this.lines.length - 1;
    return this.currentLine >= 0 && this.currentLine <= max ? this.lines[this.currentLine] : '';
  }

  /** Harter Schnitt ohne Animation (Start, Sprung, Restart) */
  private showHard() {
    this.sprites = [{ text: this.currentText(), from: 'current', to: 'current', t0: this.time, transient: false }];
    this.mkMove(true);
    this.mkTarget = this.currentLine;
  }

  /** Schwarz an/aus (Taste S) */
  private setBlank(on: boolean) {
    if (this.blank === on) return;
    this.blank = on;
    this.sendPresenter();
  }

  private handleSpace() {
    if (this.errorText) return;
    // Nach Schwarz (Solo vorbei): einblenden UND normal weiterschalten —
    // man will dann meist die nächste Zeile sehen, nicht die alte
    this.setBlank(false);
    // Leertasten zählen: erst die ARM_SPACES-te gibt Auto frei. Bei festem
    // BPM wird das Grid genau auf diesen Druck ausgerichtet — der Beat
    // liegt dann phasengleich zum Operator, nicht zum Zeitpunkt der Eingabe
    if (this.autoSpaces < ARM_SPACES) {
      this.autoSpaces++;
      if (this.isArmed() && this.manualBpm > 0) this.engine.setBpm(this.manualBpm, performance.now());
    }

    // Armierter Sprung hat Vorrang
    if (this.pendingJump >= 0) {
      const target = this.pendingJump;
      this.pendingJump = -1;
      this.jumpToLine(target);
      return;
    }

    if (this.waitingForStart || !this.lyricsModeStarted) {
      if (!this.lines.length) return;
      this.waitingForStart = false;
      this.lyricsModeStarted = true;
      this.songEndedDisplayed = false;
      this.currentLine = 0;
      this.currentBeatInLine = PRE_BEATS;
      this.showHard();
      this.sendPresenter();
    } else {
      // Im Auto-Modus ist Space eine Korrektur: Zähler neu ansetzen und
      // Beats kurz ignorieren, damit ein nachlaufender Beat nicht doppelt
      if (this.autoMode) {
        this.currentBeatInLine = PRE_BEATS;
        this.beatCooldownUntil = Date.now() + 400;
      }
      this.nextLine();
    }
  }

  private nextLine() {
    if (!this.lyricsModeStarted || this.songEndedDisplayed) return;

    if (this.currentLine < this.lines.length - 1) {
      this.currentLine++;
      this.animateForward();
      this.sendPresenter();
    } else {
      // letzte Zeile war dran → Song-Ende einleiten
      this.finishSong();
    }
  }

  private previousLine() {
    if (!this.lyricsModeStarted || this.songEndedDisplayed) return;
    if (this.currentLine > 0) {
      this.currentLine--;
      this.currentBeatInLine = PRE_BEATS;
      this.beatCooldownUntil = Date.now() + 400;
      this.animateBackward();
      this.sendPresenter();
    }
  }

  /** Forward: alte Zeile fliegt nach unten raus (Maske wischt sie an der
   *  Unterkante der Farbfläche weg), neue Zeile fliegt von oben ein */
  private animateForward() {
    this.mkMove(false);
    this.mkTarget = this.currentLine;
    const prevText = this.currentLine > 0 ? this.lines[this.currentLine - 1] : '';
    this.sprites = [
      { text: prevText, from: 'current', to: 'exitDown', t0: this.time, transient: true },
      { text: this.currentText(), from: 'enterAbove', to: 'current', t0: this.time, transient: false },
    ];
  }

  /** Backward: gespiegelt — alte Zeile fliegt oben raus, neue kommt von unten */
  private animateBackward() {
    this.mkMove(false);
    this.mkTarget = this.currentLine;
    const oldText = this.currentLine + 1 <= this.lines.length - 1 ? this.lines[this.currentLine + 1] : '';
    this.sprites = [
      { text: oldText, from: 'current', to: 'exitUp', t0: this.time, transient: true },
      { text: this.currentText(), from: 'enterBelow', to: 'current', t0: this.time, transient: false },
    ];
  }

  /** Sprung armieren (Anwählen = markieren, Space löst aus; erneut = abwählen) */
  private armJump(index: number) {
    if (!this.lines.length || index < -1) return;
    if (index === -1) {
      this.pendingJump = -1;
    } else {
      index = Math.max(0, Math.min(index, this.lines.length - 1));
      this.pendingJump = this.pendingJump === index ? -1 : index;
    }
    this.sendPresenter();
  }

  private jumpToLine(index: number) {
    if (!this.lines.length) return;
    index = Math.max(0, Math.min(index, this.lines.length - 1));
    this.pendingJump = -1;
    if (this.waitingForStart || !this.lyricsModeStarted) {
      this.waitingForStart = false;
      this.lyricsModeStarted = true;
    }
    this.songEndedDisplayed = false;
    this.currentLine = index;
    this.currentBeatInLine = PRE_BEATS;
    this.beatCooldownUntil = Date.now() + 400;
    this.showHard(); // Sprung = harter Schnitt
    this.sendPresenter();
  }

  private restartSong() {
    if (!this.lyricsModeStarted || this.songEndedDisplayed) return;
    this.currentLine = 0;
    // Beat-Zähler wie bei Sprung/Korrektur neu ansetzen
    this.currentBeatInLine = PRE_BEATS;
    this.beatCooldownUntil = Date.now() + 400;
    this.showHard();
    this.sendPresenter();
  }

  private finishSong() {
    if (this.songEndedDisplayed || !this.lines.length) return;
    // Mitsingkonzert: letzte Zeile nach oben rausfahren statt abschneiden
    if (this.mk && this.lyricsModeStarted) {
      this.mkMove(false);
      this.mkTarget = this.currentLine + 1;
    }
    this.songEndedDisplayed = true;
    this.sprites = [];
    this.sendPresenter();
    this.endTimer = 1.5; // wie im Original: kurz Logo zeigen, dann Auto-Next
  }

  /** Kompletten Presenter-State ans Panel (klein genug für jede Änderung) */
  private sendPresenter() {
    this.ctx?.sendToOperator({
      kind: 'presenter',
      currentLine: this.currentLine,
      pendingJump: this.pendingJump,
      started: this.lyricsModeStarted,
      ended: this.songEndedDisplayed,
      remaining: this.lyricsModeStarted ? Math.max(0, this.lines.length - 1 - this.currentLine) : -1,
      total: this.lines.length,
      title: this.title,
      artist: this.artist,
      autoMode: this.autoMode,
      autoArmed: this.isArmed(),
      autoSpaces: this.autoSpaces,
      refBpm: this.refBpm,
      notice: this.notice,
      blank: this.blank,
    });
  }
}

/** Schrift einer Lyrics-Zeile im Mitsingkonzert (Referenzgröße) */
function mkFont(s: Segment, light = false): string {
  // light = Vorschauzeile: Plain (400) statt Bold, <b> dann Bold statt Black
  const w = light ? (s.b ? 700 : 400) : s.b ? 900 : 700;
  return `${s.i ? 'italic ' : ''}${w} ${MK_REF_SIZE}px 'TheSans', system-ui, sans-serif`;
}
