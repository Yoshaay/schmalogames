/**
 * Adaption von speedburst.js (Prototyp, liegt als Referenz im Ordner) für die
 * Wall-Pipeline: statt DOM-Overlay mit eigenem rAF-Loop rendert der Burst in
 * ein eigenes WebGL-Canvas und wird vom Game-Loop getrieben — dadurch landet
 * er im Wall-Canvas-Compositing und damit auch im Operator-Preview.
 * Shader unverändert übernommen.
 */

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;

const FRAG = `precision highp float;
uniform vec2  u_res;
uniform float u_t;        // Burst-Fortschritt 0..1
uniform float u_dens;     // Basisanzahl Winkel-Segmente
uniform vec3  u_colA;     // Farbe innen
uniform vec3  u_colB;     // Farbe außen

float hash(float n){ return fract(sin(n*127.1)*43758.5453); }

float rayLayer(float a01, float r, float N, float seed){
  float id   = floor(a01 * N);
  float rnd  = hash(id + seed*91.7);
  float rnd2 = hash(id + seed*57.3 + 11.0);

  // Nur ein Teil der Segmente bekommt überhaupt einen Strahl
  if (rnd2 > 0.75) return 0.0;

  float start = rnd * 0.25;                        // leicht versetzte Starts
  float dur   = 0.45 + rnd2 * 0.35;
  float lt    = clamp((u_t - start) / dur, 0.0, 1.0);
  if (lt <= 0.0 || lt >= 1.0) return 0.0;

  float env   = smoothstep(0.0, 0.10, lt) * (1.0 - smoothstep(0.55, 1.0, lt));

  // Innenkante wandert beschleunigt nach außen, Schweif wird kürzer
  float inner = mix(0.10, 1.6, pow(lt, 1.4));
  float len   = mix(0.50, 0.15, lt);
  float band  = smoothstep(inner, inner + 0.04, r)
              * (1.0 - smoothstep(inner + len - 0.02, inner + len, r));

  // Position entlang des Strahls: 0 = Basis (innen), 1 = Spitze (außen)
  float u    = clamp((r - inner) / len, 0.0, 1.0);
  float f    = fract(a01 * N);
  float w    = (0.10 + rnd * 0.22) * (1.0 - u);   // Breite läuft zur Spitze auf 0 -> Dreieck
  float line = smoothstep(0.5 - w, 0.5 - w + 0.04, f)
             * (1.0 - smoothstep(0.5 + w - 0.04, 0.5 + w, f));

  return line * env * band * (0.5 + rnd * 0.5);
}

void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p  = uv - 0.5;
  p.x    *= u_res.x / u_res.y;
  float r   = length(p);
  float a01 = atan(p.y, p.x) / 6.2831853 + 0.5;

  float i = rayLayer(a01, r, u_dens,        1.0)
          + rayLayer(a01, r, u_dens * 0.6,  2.0) * 0.7
          + rayLayer(a01, r, u_dens * 1.5,  3.0) * 0.5;

  i *= smoothstep(0.08, 0.45, r);   // Mitte frei lassen
  i  = smoothstep(0.22, 0.38, i);   // harte Kante: deckend oder gar nicht (Flat-/Cel-Look)

  vec3 col = mix(u_colA, u_colB, smoothstep(0.3, 0.9, r));

  // Premultiplied Alpha für sauberes Compositing über beliebigem Hintergrund
  gl_FragColor = vec4(col * i, i);
}`;

export class SpeedBurst {
  readonly canvas = document.createElement('canvas');
  private gl: WebGLRenderingContext | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};
  /** 0..1 während des Bursts, >= 1 = inaktiv */
  private progress = 1;
  private readonly duration: number;
  private readonly density: number;
  private readonly color: [number, number, number];

  constructor(
    size = 1100,
    opts: { duration?: number; density?: number; color?: [number, number, number] } = {},
  ) {
    this.duration = opts.duration ?? 1.1; // s
    this.density = opts.density ?? 64;
    this.color = opts.color ?? [0.976, 0.698, 0.2]; // #f9b233
    this.canvas.width = size;
    this.canvas.height = size;

    const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!gl) return; // ohne WebGL: Burst bleibt einfach aus
    this.gl = gl;

    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) ?? 'Shader-Fehler');
      }
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {
      res: gl.getUniformLocation(prog, 'u_res'),
      t: gl.getUniformLocation(prog, 'u_t'),
      dens: gl.getUniformLocation(prog, 'u_dens'),
      colA: gl.getUniformLocation(prog, 'u_colA'),
      colB: gl.getUniformLocation(prog, 'u_colB'),
    };

    gl.viewport(0, 0, size, size);
    gl.clearColor(0, 0, 0, 0);
  }

  get active(): boolean {
    return this.progress < 1 && !!this.gl;
  }

  /** Einmaligen Burst starten (setzt einen laufenden zurück) */
  fire() {
    if (this.gl) this.progress = 0;
  }

  /** Fortschritt weiterschalten und aktuellen Frame ins eigene Canvas rendern */
  update(dt: number) {
    const gl = this.gl;
    if (!gl || this.progress >= 1) return;
    this.progress = Math.min(1, this.progress + dt / this.duration);

    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.progress >= 1) return; // letzter Frame: leer

    gl.uniform2f(this.u.res, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.t, this.progress);
    gl.uniform1f(this.u.dens, this.density);
    gl.uniform3fv(this.u.colA, this.color);
    gl.uniform3fv(this.u.colB, this.color);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
