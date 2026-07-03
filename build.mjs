import * as esbuild from 'esbuild';
import { cpSync } from 'node:fs';

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
});

cpSync('src/renderer/wall.html', 'dist/renderer/wall.html');
cpSync('src/renderer/operator.html', 'dist/renderer/operator.html');

console.log('Build fertig.');
