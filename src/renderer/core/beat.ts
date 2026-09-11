/**
 * Beat-Engine (portiert aus dem Prototyp schmalgroove.html):
 * 1) sample: Spectral Flux pro Frame (positive Magnituden-Änderung, Bässe
 *    stärker gewichtet) → Onset-Kurve mit Zeitstempeln.
 * 2) analyzeTempo (alle 400 ms): Kurve auf 100 Hz resampeln, detrendet,
 *    Autokorrelation über 70–180 BPM mit Harmonischen-Support,
 *    log-Gauss-Tempo-Prior um 120 BPM, Hysterese aufs aktuelle Tempo,
 *    parabolische Peak-Verfeinerung. Update nur bei klarem Peak.
 * 3) alignPhase: Comb-Suche nach dem Phasen-Offset, bei dem das Beat-
 *    Raster die Onset-Kurve am besten trifft → sanfter PLL-Nudge statt
 *    hartem Resync. Beats feuern dann vom Grid, nicht von einzelnen
 *    (verrauschten) Onsets.
 *
 * Lock-Zustände (seit 2026-09-11, Live-Input schwankte zu sichtbar):
 * - SUCHEN: lernt schnell wie bisher. Liegen LOCK_STREAK Schätzungen in
 *   Folge innerhalb LOCK_TOL beieinander, rastet die Engine ein.
 * - GELOCKT: das Tempo ist eingefroren bis auf minimale Drift (gedeckelt
 *   auf DRIFT_MAX_REL pro Analyse), die Phase wird nur noch sanft
 *   nachgeführt (Totzone + Deckel pro Schritt, kleiner Gain). Halbes/
 *   doppeltes Tempo gilt als dieselbe Musik (Oktav-Schutz). Die Uhr
 *   läuft dabei IMMER weiter — sinkt die Konfidenz, wird nur weniger
 *   korrigiert, nie gestoppt. Neu gelernt wird erst, wenn RELEARN_STREAK
 *   klare Schätzungen in Folge um mehr als RELEARN_TOL abweichen (echter
 *   Tempowechsel / neuer Song) → zurück auf SUCHEN, Grid neu.
 */

const FS = 100; // Abtastrate der Onset-Kurve für die Analyse (Hz)
const WIN_MS = 6000; // Analysefenster

/** So viele klare Schätzungen in Folge (je 400 ms) müssen innerhalb von
 *  LOCK_TOL beieinanderliegen, bevor die Engine einrastet */
const LOCK_STREAK = 3;
const LOCK_TOL = 0.02;
/** Weicher Lock für unruhiges Material: reicht die enge Toleranz nie,
 *  rastet sie auch ein, wenn LOCK_STREAK_SOFT Schätzungen in Folge
 *  innerhalb von LOCK_TOL_SOFT liegen (~2,4 s) — sonst bliebe sie ewig
 *  im Suchen (= altes Verhalten) */
const LOCK_STREAK_SOFT = 6;
const LOCK_TOL_SOFT = 0.04;
/** Gelockt: Schätzungen bis hierhin gelten als Drift und werden minimal
 *  eingemischt (DRIFT_GAIN), maximal DRIFT_MAX_REL Tempoänderung je Analyse */
const RELEARN_TOL = 0.08;
const DRIFT_GAIN = 0.05;
const DRIFT_MAX_REL = 0.003;
/** So viele klare, abweichende Schätzungen in Folge (~2 s) lösen den Lock */
const RELEARN_STREAK = 5;
/** Phasenkorrektur gelockt: Fehler unter der Totzone werden ignoriert, pro
 *  Analyse wird höchstens PHASE_MAX_STEP_MS geschoben, mit kleinem Gain */
const PHASE_GAIN_SEARCH = 0.4;
const PHASE_GAIN_LOCKED = 0.12;
const PHASE_DEADBAND_MS = 15;
const PHASE_MAX_STEP_MS = 20;
/** Mindest-Konfidenz, die ein gelockter Zustand nach außen meldet */
const LOCKED_MIN_CONF = 0.6;

export class BeatEngine {
  bpm = 0;
  periodMs = 0;
  conf = 0;
  /** 0..1 innerhalb eines Beats (kann im Fallback leicht über 1 laufen) */
  beatPhase = 0;
  beatCount = 0;
  /** aktueller Flux in Sigma-Einheiten (für Akzente) */
  accent = 0;
  /** geglättete Gesamtenergie 0..1 */
  energy = 0;
  /** Tap-Override aktiv: Auto-Erkennung pausiert */
  manual = false;
  /** Eingerastet: Tempo steht, nur noch Drift/Phase werden nachgeführt */
  locked = false;
  /** Zeitpunkt des Einrastens (Analyse-Uhr, ms) — 0 = nicht gelockt */
  lockedAt = 0;
  /** Sync-Offset: verzögert die VISUALS gegen die Analyse (ms) */
  offsetMs = 0;
  /** Regler-Rohwert 110–180 → Onset-Gate im Fallback vor dem Tempo-Lock */
  sensitivity = 135;
  /** feuert bei jedem Beat mit der Flash-Stärke 0..1 */
  onBeat: ((flash: number) => void) | null = null;

  private fluxT: number[] = [];
  private fluxV: number[] = [];
  private nextBeatAt = 0;
  private fluxMean = 0;
  private fluxVar = 1;
  private lastAnalysisAt = 0;
  private lastOnsetAt = 0;
  private pendingOnsets: number[] = [];
  private taps: number[] = [];
  private prevFreq: Uint8Array | null = null;
  /** Suchen: Zahl aufeinanderfolgender Schätzungen nah am aktuellen Tempo */
  private lockStreak = 0;
  private lockStreakSoft = 0;
  /** Gelockt: Zahl aufeinanderfolgender klar abweichender Schätzungen */
  private relearnStreak = 0;

  reset() {
    this.fluxT.length = 0;
    this.fluxV.length = 0;
    this.bpm = 0;
    this.periodMs = 0;
    this.conf = 0;
    this.nextBeatAt = 0;
    this.beatPhase = 0;
    this.beatCount = 0;
    this.fluxMean = 0;
    this.fluxVar = 1;
    this.accent = 0;
    this.lastAnalysisAt = 0;
    this.lastOnsetAt = 0;
    this.pendingOnsets.length = 0;
    this.manual = false;
    this.taps.length = 0;
    this.prevFreq?.fill(0);
    this.locked = false;
    this.lockedAt = 0;
    this.lockStreak = 0;
    this.lockStreakSoft = 0;
    this.relearnStreak = 0;
  }

  /** Sekunden seit dem Einrasten (0 = nicht gelockt) */
  lockedFor(nowMs: number): number {
    return this.locked && this.lockedAt ? Math.max(0, (nowMs - this.lockedAt) / 1000) : 0;
  }

  /** Seek: Tempo behalten, Beat-Grid neu ausrichten lassen */
  realign() {
    this.nextBeatAt = 0;
  }

  sample(freq: Uint8Array, nowMs: number) {
    if (!this.prevFreq || this.prevFreq.length !== freq.length) {
      this.prevFreq = new Uint8Array(freq.length);
    }
    const prev = this.prevFreq;

    // Spectral Flux bis ~4 kHz, Bass-Bins (<~200 Hz) doppelt gewichtet
    let f = 0;
    let tot = 0;
    for (let i = 1; i < 186; i++) {
      const d = freq[i] - prev[i];
      if (d > 0) f += (i < 10 ? 2 : 1) * d;
      prev[i] = freq[i];
      if (i < 120) tot += freq[i];
    }
    this.energy += (tot / 119 / 255 - this.energy) * 0.08;

    this.fluxT.push(nowMs);
    this.fluxV.push(f);
    while (this.fluxT.length && nowMs - this.fluxT[0] > WIN_MS + 1000) {
      this.fluxT.shift();
      this.fluxV.shift();
    }

    // Laufende Statistik → Akzentstärke in Sigma-Einheiten
    this.fluxMean += (f - this.fluxMean) * 0.05;
    this.fluxVar += ((f - this.fluxMean) * (f - this.fluxMean) - this.fluxVar) * 0.05;
    this.accent = Math.max(0, (f - this.fluxMean) / (Math.sqrt(this.fluxVar) + 1e-6));
  }

  update(nowMs: number, dt: number) {
    if (!this.manual && nowMs - this.lastAnalysisAt > 400) {
      this.lastAnalysisAt = nowMs;
      this.analyzeTempo(nowMs);
    }

    /* Visuelle Uhr: läuft offsetMs hinter der Analyse-Uhr.
       Die Engine (Tempo, Phase-Alignment) bleibt in Echtzeit an der
       Audioquelle — nur Beats/Phase für die Darstellung werden verzögert.
       Da das Grid periodisch ist, reicht ein Offset von 0..1 Beat, um
       JEDE Kettenlatenz auszugleichen (Modulo-Trick). */
    const vnow = nowMs - this.offsetMs;

    if (this.periodMs > 0) {
      // Grid-Modus: Beats feuern vom Raster, Akzentstärke aus dem Signal
      if (!this.nextBeatAt) this.nextBeatAt = vnow + this.periodMs;
      while (vnow >= this.nextBeatAt) {
        this.beatCount++;
        this.onBeat?.(Math.min(1, 0.55 + this.accent * 0.2));
        this.nextBeatAt += this.periodMs;
      }
      // Nie negativ: nach PLL-Nudges oder Sync-Offset-Änderungen kann
      // nextBeatAt kurzzeitig mehr als eine Periode entfernt liegen
      this.beatPhase = Math.max(0, 1 - (this.nextBeatAt - vnow) / this.periodMs);
    } else {
      // Fallback vor dem Tempo-Lock: adaptive Onsets, um offsetMs verzögert
      const gate = 1.5 + (this.sensitivity - 110) * 0.03; // 1.5–3.6 σ
      if (this.accent > gate && nowMs - this.lastOnsetAt > 280) {
        this.lastOnsetAt = nowMs;
        this.pendingOnsets.push(nowMs + this.offsetMs);
      }
      while (this.pendingOnsets.length && nowMs >= this.pendingOnsets[0]) {
        this.pendingOnsets.shift();
        this.beatCount++;
        this.beatPhase = 0;
        this.onBeat?.(1);
      }
      this.beatPhase = Math.min(this.beatPhase + dt * 2, 1.2); // ~120 BPM Annahme
    }
  }

  /** Tap-Tempo: manueller Override. Liefert die Zahl gemittelter Intervalle. */
  tap(nowMs: number): number {
    if (this.taps.length && nowMs - this.taps[this.taps.length - 1] > 2000) {
      this.taps.length = 0; // Pause → neu ansetzen
    }
    this.taps.push(nowMs);
    if (this.taps.length > 9) this.taps.shift(); // Mittel über max. 8 Intervalle
    if (this.taps.length < 2) return 0;

    let mean = 0;
    for (let i = 1; i < this.taps.length; i++) mean += this.taps[i] - this.taps[i - 1];
    mean /= this.taps.length - 1;

    this.manual = true;
    this.locked = false;
    this.lockedAt = 0;
    this.lockStreak = 0;
    this.lockStreakSoft = 0;
    this.relearnStreak = 0;
    this.bpm = 60000 / mean;
    this.periodMs = mean;
    this.conf = 1;
    // Der letzte Tap IST ein Beat (Analyse-Domäne) — der Sync-Offset
    // wirkt wie im Auto-Modus obendrauf. Grid vom Tap aus in die Zukunft.
    this.nextBeatAt = this.taps[this.taps.length - 1];
    while (this.nextBeatAt <= nowMs - this.offsetMs) this.nextBeatAt += this.periodMs;
    return this.taps.length - 1;
  }

  /** Fester, eingetippter BPM-Wert: manueller Override wie Tap-Tempo,
   *  aber ohne Taps — das Grid startet einen Beat nach jetzt. */
  setBpm(bpm: number, nowMs: number) {
    this.manual = true;
    this.taps.length = 0;
    this.locked = false;
    this.lockedAt = 0;
    this.lockStreak = 0;
    this.lockStreakSoft = 0;
    this.relearnStreak = 0;
    this.bpm = bpm;
    this.periodMs = 60000 / bpm;
    this.conf = 1;
    this.nextBeatAt = nowMs - this.offsetMs + this.periodMs;
  }

  backToAuto() {
    this.manual = false;
    this.taps.length = 0;
    // bpm/periodMs/Grid bewusst behalten: der Tänzer läuft nahtlos weiter,
    // die Auto-Analyse übernimmt beim nächsten Tick (Hysterese greift).
  }

  private analyzeTempo(nowMs: number) {
    if (this.fluxT.length < 120 || nowMs - this.fluxT[0] < 3500) return;

    // --- 1) Onset-Kurve auf festes 100-Hz-Raster resampeln ---
    const span = Math.min(WIN_MS, nowMs - this.fluxT[0]);
    const t0 = nowMs - span;
    const N = Math.floor((span * FS) / 1000);
    const env = new Float32Array(N);
    let j = 0;
    for (let n = 0; n < N; n++) {
      const t = t0 + (n * 1000) / FS;
      while (j < this.fluxT.length - 2 && this.fluxT[j + 1] < t) j++;
      const t1 = this.fluxT[j];
      const t2 = this.fluxT[j + 1] ?? t1;
      const v1 = this.fluxV[j];
      const v2 = this.fluxV[j + 1] ?? v1;
      env[n] = t2 > t1 ? v1 + ((v2 - v1) * (t - t1)) / (t2 - t1) : v1;
    }

    // --- 2) Detrend (lokalen Mittelwert abziehen) + Halbwellen-Gleichrichtung ---
    const W = FS >> 1; // 0,5-s-Fenster
    const det = new Float32Array(N);
    let acc = 0;
    for (let n = 0; n < N; n++) {
      acc += env[n];
      if (n >= W) acc -= env[n - W];
      det[n] = Math.max(0, env[n] - acc / Math.min(n + 1, W));
    }

    // --- 3) Autokorrelation über Beat-Perioden (70–180 BPM) ---
    const Lmin = Math.round((60 * FS) / 185); // ≈ 32 Samples
    const Lmax = Math.round((60 * FS) / 68); // ≈ 88 Samples
    const curL = this.bpm > 0 ? (60 * FS) / this.bpm : 0;
    const score = new Float32Array(Lmax + 2);
    let best = -1;
    let bestL = 0;
    let sum = 0;
    let cnt = 0;

    for (let L = Lmin; L <= Lmax; L++) {
      let r = 0;
      for (let n = L; n < N; n++) r += det[n] * det[n - L];
      r /= N - L;

      // Harmonischen-Support: die doppelte Periode (der Takt) stützt den Beat
      // und unterscheidet ihn vom Off-Beat
      let h = r;
      if (2 * L < N) {
        let r2 = 0;
        for (let n = 2 * L; n < N; n++) r2 += det[n] * det[n - 2 * L];
        h += (0.5 * r2) / (N - 2 * L);
      }

      // Tempo-Prior: log-Gauss um 120 BPM gegen Oktav-Ambiguität
      h *= Math.exp(-0.5 * Math.pow(Math.log2((60 * FS) / L / 120) / 0.85, 2));

      // Hysterese: aktuelles Tempo leicht bevorzugen (kein Flackern)
      if (curL > 0 && Math.abs(L - curL) < curL * 0.05) h *= 1.25;

      score[L] = h;
      sum += h;
      cnt++;
      if (h > best) {
        best = h;
        bestL = L;
      }
    }
    if (!bestL) return;
    const prominence = best / (sum / cnt + 1e-9);

    // Parabolische Verfeinerung um den Peak (Sub-Sample-Genauigkeit)
    let L = bestL;
    if (bestL > Lmin && bestL < Lmax) {
      const y1 = score[bestL - 1];
      const y2 = score[bestL];
      const y3 = score[bestL + 1];
      const denom = y1 - 2 * y2 + y3;
      if (denom !== 0) {
        const d = (y1 - y3) / (2 * denom);
        if (Math.abs(d) < 1) L = bestL + d;
      }
    }
    const newBpm = (60 * FS) / L;

    // Kein klarer Peak → keine Information, nichts anfassen (gelockt läuft
    // die Uhr einfach weiter)
    if (prominence <= 1.35) return;
    const quality = Math.min(1, (prominence - 1) / 1.5);

    if (this.locked) {
      // --- GELOCKT: Tempo steht, nur Drift + Phase ---
      // Oktav-Schutz: halbes/doppeltes Tempo ist dieselbe Musik
      let est = newBpm;
      if (Math.abs(est / this.bpm - 2) < 0.16) est /= 2;
      else if (Math.abs(est / this.bpm - 0.5) < 0.04) est *= 2;
      const rel = Math.abs(est - this.bpm) / this.bpm;

      if (rel < RELEARN_TOL) {
        this.relearnStreak = 0;
        // minimale Drift, hart gedeckelt — das BPM zittert nicht mehr
        const maxStep = this.bpm * DRIFT_MAX_REL;
        this.bpm += Math.max(-maxStep, Math.min(maxStep, (est - this.bpm) * DRIFT_GAIN));
        this.periodMs = 60000 / this.bpm;
        this.conf = Math.max(LOCKED_MIN_CONF, this.conf * 0.8 + quality * 0.2);
        this.alignPhase(nowMs, det, t0, PHASE_GAIN_LOCKED, PHASE_DEADBAND_MS, PHASE_MAX_STEP_MS);
      } else {
        // Klar abweichend: erst nach RELEARN_STREAK in Folge glauben — dann
        // ist es ein echter Tempowechsel (oder neuer Song), zurück auf SUCHEN
        this.relearnStreak++;
        if (this.relearnStreak >= RELEARN_STREAK) {
          this.locked = false;
          this.lockedAt = 0;
          this.lockStreak = 0;
          this.relearnStreak = 0;
          this.bpm = newBpm;
          this.periodMs = 60000 / this.bpm;
          this.conf = quality;
          this.nextBeatAt = 0; // Grid neu ausrichten
          this.alignPhase(nowMs, det, t0, PHASE_GAIN_SEARCH, 0, Infinity);
        }
        // sonst: Tempo und Phase unverändert behalten
      }
      return;
    }

    // --- SUCHEN: schnell lernen wie bisher ---
    // nah am aktuellen Tempo → glätten, weit weg → nur bei sehr hoher
    // Konfidenz springen (echter Tempowechsel)
    if (this.bpm && Math.abs(newBpm - this.bpm) / this.bpm < 0.06) {
      const rel = Math.abs(newBpm - this.bpm) / this.bpm;
      this.lockStreak = rel < LOCK_TOL ? this.lockStreak + 1 : 0;
      this.lockStreakSoft = rel < LOCK_TOL_SOFT ? this.lockStreakSoft + 1 : 0;
      this.bpm = this.bpm * 0.7 + newBpm * 0.3;
    } else if (!this.bpm || prominence > 1.9) {
      this.bpm = newBpm;
      this.lockStreak = 0;
      this.lockStreakSoft = 0;
      this.nextBeatAt = 0; // Grid neu ausrichten
    } else {
      return; // widersprüchlich & unsicher → behalten
    }
    this.periodMs = 60000 / this.bpm;
    this.conf = Math.max(this.conf * 0.6, quality);
    this.alignPhase(nowMs, det, t0, PHASE_GAIN_SEARCH, 0, Infinity);

    if (this.lockStreak >= LOCK_STREAK || this.lockStreakSoft >= LOCK_STREAK_SOFT) {
      // Stabil genug: einrasten
      this.locked = true;
      this.lockedAt = nowMs;
      this.relearnStreak = 0;
      this.conf = Math.max(this.conf, LOCKED_MIN_CONF);
    }
  }

  /** Phase des Beat-Rasters an die Onset-Kurve heranführen. gain = Anteil
   *  des Fehlers pro Aufruf, deadbandMs = Fehler darunter werden ignoriert,
   *  maxStepMs = Deckel pro Aufruf (gelockt: unmerkliches Gleiten) */
  private alignPhase(nowMs: number, det: Float32Array, t0: number, gain: number, deadbandMs: number, maxStepMs: number) {
    const T = this.periodMs;
    const steps = 24;
    let bestOff = 0;
    let bestS = -1;
    for (let s = 0; s < steps; s++) {
      const off = (s * T) / steps;
      let sm = 0;
      let k = 0;
      for (let t = nowMs - off; t >= t0 + 300; t -= T) {
        const n = Math.round(((t - t0) * FS) / 1000);
        if (n >= 0 && n < det.length) {
          sm += det[n];
          k++;
        }
      }
      if (k && sm / k > bestS) {
        bestS = sm / k;
        bestOff = off;
      }
    }
    const target = nowMs - bestOff + T; // nächster Beat laut Onset-Kurve
    if (!this.nextBeatAt) {
      this.nextBeatAt = target;
      return;
    }
    // PLL: Phasenfehler in ±T/2 falten und nur zu 40 % korrigieren.
    // (+1,5T dann −0,5T — das Pärchen muss zusammenpassen, sonst landet
    // der Fixpunkt der Regelung auf dem OFF-Beat!)
    const err = ((((target - this.nextBeatAt) % T) + 1.5 * T) % T) - 0.5 * T;
    if (Math.abs(err) < deadbandMs) return;
    const step = Math.max(-maxStepMs, Math.min(maxStepMs, err * gain));
    this.nextBeatAt += step;
  }
}
