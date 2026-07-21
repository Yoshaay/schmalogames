import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'node:fs';

// Main-Prozess + Preload
await esbuild.build({
  entryPoints: ['src/main/main.ts', 'src/main/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outdir: 'dist/main',
});

// Renderer: Wall (Cleanfeed) + Operator
await esbuild.build({
  entryPoints: ['src/renderer/wall.ts', 'src/renderer/operator.ts'],
  bundle: true,
  format: 'iife',
  outdir: 'dist/renderer',
  // Game-Assets direkt ins Bundle: Bilder als Data-URL, 3D-Modelle als Binärdaten
  loader: { '.png': 'dataurl', '.fbx': 'binary' },
});

cpSync('src/renderer/wall.html', 'dist/renderer/wall.html');
cpSync('src/renderer/operator.html', 'dist/renderer/operator.html');

// TheSans (BR-Hausschrift) aus dem Projekt-Fontordner mitnehmen.
// Der Ordner ist lizenzbedingt NICHT im Repo — ohne ihn greift der Fallback-Font.
if (existsSync('fonts')) {
  mkdirSync('dist/renderer/fonts', { recursive: true });
  for (const weight of ['5_Plain', '6_SemiBold', '7_Bold', '8_ExtraBold']) {
    cpSync(`fonts/TheSansC5s-${weight}.otf`, `dist/renderer/fonts/TheSansC5s-${weight}.otf`);
  }
} else {
  console.warn('Hinweis: fonts/ fehlt — TheSans wird nicht gebündelt (Fallback-Font aktiv).');
}

console.log('Build fertig.');
