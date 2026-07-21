// speedburst.js — einmaliger radialer Goldstreifen-Burst, transparenter Hintergrund.
// Kein Framework nötig. Legt ein Overlay-Canvas (pointer-events: none) über den Container.
//
// Verwendung:
//   import { SpeedBurst } from './speedburst.js';
//   const burst = new SpeedBurst(document.querySelector('#stage'), { density: 64 });
//   burst.fire();                        // einmal auslösen, danach ist das Canvas wieder leer
//   burst.fire({ onComplete: () => {} });
//
// Über Three.js legen: einfach Container = Elternelement des WebGL-Canvas.
// Alternativ läuft der Fragment-Shader unverändert als ShaderMaterial auf einem
// Fullscreen-Quad (transparent: true, blending: THREE.NormalBlending, premultipliedAlpha: true).

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
  constructor(container, opts = {}) {
    this.opts = Object.assign({
      density:  64,                     // Winkel-Segmente
      duration: 1100,                   // ms für den kompletten Burst
      colorInner: [0.976, 0.698, 0.200], // #f9b233
      colorOuter: [0.976, 0.698, 0.200], // flat — identisch mit colorInner
      zIndex: 10,
      maxDpr: 2,
    }, opts);

    const cv = document.createElement('canvas');
    Object.assign(cv.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: String(this.opts.zIndex),
    });
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(cv);
    this.container = container;
    this.canvas = cv;

    const gl = cv.getContext('webgl', {
      alpha: true, premultipliedAlpha: true, antialias: true,
    });
    this.gl = gl;

    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s));
      }
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    this.prog = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {
      res:  gl.getUniformLocation(prog, 'u_res'),
      t:    gl.getUniformLocation(prog, 'u_t'),
      dens: gl.getUniformLocation(prog, 'u_dens'),
      colA: gl.getUniformLocation(prog, 'u_colA'),
      colB: gl.getUniformLocation(prog, 'u_colB'),
    };

    gl.clearColor(0, 0, 0, 0);
    this._raf = null;
  }

  _resize() {
    const { canvas, gl } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, this.opts.maxDpr);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  // Einmaliger Burst. Läuft duration ms, danach ist das Canvas leer.
  fire({ onComplete } = {}) {
    if (this._raf) cancelAnimationFrame(this._raf);
    const { gl, u, opts } = this;
    const t0 = performance.now();

    const frame = (now) => {
      const t = (now - t0) / opts.duration;
      this._resize();
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (t >= 1) {
        this._raf = null;
        if (onComplete) onComplete();
        return;
      }
      gl.uniform2f(u.res, this.canvas.width, this.canvas.height);
      gl.uniform1f(u.t, t);
      gl.uniform1f(u.dens, opts.density);
      gl.uniform3fv(u.colA, opts.colorInner);
      gl.uniform3fv(u.colB, opts.colorOuter);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this._raf = requestAnimationFrame(frame);
    };
    this._raf = requestAnimationFrame(frame);
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this.canvas.remove();
  }
}
