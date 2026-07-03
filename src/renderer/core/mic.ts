/**
 * Mikrofon-Pegelmessung über die Web Audio API.
 * Liefert pro Frame den RMS-Pegel (0 = still, ~0.5 = sehr laut).
 */
export class Mic {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private buffer: Float32Array<ArrayBuffer> = new Float32Array(0);

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Verarbeitung aus: wir wollen den rohen Pegel, keine Sprachoptimierung
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    this.audioCtx = new AudioContext();
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);
  }

  /** Aktueller RMS-Pegel des Eingangssignals */
  getLevel(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      sum += this.buffer[i] * this.buffer[i];
    }
    return Math.sqrt(sum / this.buffer.length);
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close();
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
  }
}
