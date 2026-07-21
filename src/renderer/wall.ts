import { GameHost } from './core/host';
import { games } from './games/registry';

// TheSans vorladen, damit Canvas-Text nie im Fallback-Font aufblitzt
for (const w of [400, 600, 700, 800]) document.fonts.load(`${w} 16px TheSans`);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const host = new GameHost(canvas, games);
host.run();
