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
 */

const FS = 100; // Abtastrate der Onset-Kurve für die Analyse (Hz)
const WIN_MS = 6000; // Analysefenster

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
    this.bpm = 60000 / mean;
    this.periodMs = mean;
    this.conf = 1;
    // Der letzte Tap IST ein Beat (Analyse-Domäne) — der Sync-Offset
    // wirkt wie im Auto-Modus obendrauf. Grid vom Tap aus in die Zukunft.
    this.nextBeatAt = this.taps[this.taps.length - 1];
    while (this.nextBeatAt <= nowMs - this.offsetMs) this.nextBeatAt += this.periodMs;
    return this.taps.length - 1;
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

    // Update nur bei klarem Peak; nah am aktuellen Tempo → glätten,
    // weit weg → nur bei sehr hoher Konfidenz springen (echter Tempowechsel)
    if (prominence > 1.35) {
      if (this.bpm && Math.abs(newBpm - this.bpm) / this.bpm < 0.06) {
        this.bpm = this.bpm * 0.7 + newBpm * 0.3;
      } else if (!this.bpm || prominence > 1.9) {
        this.bpm = newBpm;
        this.nextBeatAt = 0; // Grid neu ausrichten
      } else {
        return; // widersprüchlich & unsicher → behalten
      }
      this.periodMs = 60000 / this.bpm;
      this.conf = Math.max(this.conf * 0.6, Math.min(1, (prominence - 1) / 1.5));
      this.alignPhase(nowMs, det, t0);
    }
  }

  private alignPhase(nowMs: number, det: Float32Array, t0: number) {
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
    // PLL: Phasenfehler in ±T/2 falten und nur zu 40 % korrigieren
    let err = (((target - this.nextBeatAt) % T) + 1.5 * T) % T;
    if (err > T / 2) err -= T;
    this.nextBeatAt += err * 0.4;
  }
}
