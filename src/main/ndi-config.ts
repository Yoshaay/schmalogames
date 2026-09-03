/**
 * NDI-Konfiguration: Welche Netzwerkadapter darf die NDI-Lib benutzen?
 *
 * Die libndi liest beim Initialisieren eine Datei `ndi-config.v1.json` aus
 * dem Verzeichnis in der Umgebungsvariable NDI_CONFIG_DIR. Wir legen sie
 * pro App im userData-Ordner ab (nie die globale ~/.newtek-Datei anfassen)
 * und tragen unter `ndi.adapters.allowed` die gewünschte IP ein. Ohne
 * Eintrag sendet NDI über ALLE Adapter und meldet alle IPs per mDNS — der
 * Empfänger sucht sich dann eine aus, z.B. die vom WLAN-Hotspot statt der
 * Ethernet-Strecke zum Ü-Wagen.
 *
 * Die Lib liest die Datei nur einmal beim Start → Änderung braucht Neustart.
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface NdiSettings {
  /** IPv4 des erlaubten Adapters, '' = alle Adapter */
  adapter: string;
}

const settingsPath = () => path.join(app.getPath('userData'), 'ndi-settings.json');
const configDir = () => path.join(app.getPath('userData'), 'ndi-config');

/** Beim Start angewendeter Wert — die Lib hat diesen geladen, egal was
 *  seitdem im Panel eingestellt wurde */
let activeAdapter = '';

export function readNdiSettings(): NdiSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Partial<NdiSettings>;
    return { adapter: typeof raw.adapter === 'string' ? raw.adapter : '' };
  } catch {
    return { adapter: '' };
  }
}

export function writeNdiSettings(s: NdiSettings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
  writeConfigFile(s);
}

/** Konfigdatei für die libndi schreiben (Adapter-Whitelist oder leer) */
function writeConfigFile(s: NdiSettings) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const ndi: Record<string, unknown> = {};
  if (s.adapter) ndi.adapters = { allowed: [s.adapter] };
  fs.writeFileSync(path.join(dir, 'ndi-config.v1.json'), JSON.stringify({ ndi }, null, 2));
}

/** Vor dem ersten Laden von grandi aufrufen: Konfigdatei schreiben und
 *  NDI_CONFIG_DIR setzen. Ein gespeicherter Adapter, den es gerade nicht
 *  gibt (Kabel ab, anderes Netz), wird ignoriert — sonst sendet NDI ins
 *  Leere und die Quelle ist nirgends zu sehen. */
export function applyNdiConfig(): { setting: string; active: string } {
  const s = readNdiSettings();
  const present = listAdapters().some((a) => a.address === s.adapter);
  activeAdapter = present ? s.adapter : '';
  if (s.adapter && !present) {
    console.warn(`NDI-Adapter ${s.adapter} nicht vorhanden — sende über alle Adapter`);
  }
  writeConfigFile({ adapter: activeAdapter });
  process.env.NDI_CONFIG_DIR = configDir();
  return { setting: s.adapter, active: activeAdapter };
}

export function getActiveAdapter(): string {
  return activeAdapter;
}

/** Alle IPv4-Adapter (ohne Loopback) */
export function listAdapters(): { iface: string; address: string }[] {
  const out: { iface: string; address: string }[] = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ iface, address: a.address });
    }
  }
  return out;
}
