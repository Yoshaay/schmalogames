import { GameHost } from './core/host';
import { games } from './games/registry';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const host = new GameHost(canvas, games);
host.run();
