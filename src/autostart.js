// Lancement du panel au démarrage de Windows (script .vbs dans le dossier Démarrage de l'utilisateur).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './store.js';
import { err } from './i18n.js';

const SCRIPT_NAME = 'minecraft-modpack-panel.vbs';

function startupDir() {
  if (process.platform !== 'win32' || !process.env.APPDATA) return null;
  return path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

const vbsString = (s) => `"${String(s).replace(/"/g, '""')}"`;

export function autostartStatus() {
  const dir = startupDir();
  return { supported: Boolean(dir), enabled: Boolean(dir && fs.existsSync(path.join(dir, SCRIPT_NAME))) };
}

/**
 * Crée le script de démarrage. Il reprend la configuration réseau actuelle du panel
 * (HOST, PORT, PANEL_PASSWORD, PANEL_DATA_DIR) et lance Node sans fenêtre.
 */
export async function enableAutostart() {
  const dir = startupDir();
  if (!dir) throw err('autostart_unsupported', {}, 400);
  const env = ['HOST', 'PORT', 'PANEL_PASSWORD', 'PANEL_DATA_DIR']
    .filter((k) => process.env[k])
    .map((k) => `env(${vbsString(k)}) = ${vbsString(process.env[k])}`);
  const script = [
    "' Lance Minecraft Modpack Panel au démarrage de la session (créé par le panel).",
    'Set sh = CreateObject("WScript.Shell")',
    'Set env = sh.Environment("PROCESS")',
    ...env,
    `sh.CurrentDirectory = ${vbsString(ROOT)}`,
    // 0 = fenêtre cachée, False = ne pas attendre
    `sh.Run ${vbsString(`"${process.execPath}" "${path.join(ROOT, 'src', 'server.js')}"`)}, 0, False`,
    '',
  ].join('\r\n');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, SCRIPT_NAME), script, 'latin1');
  return autostartStatus();
}

export async function disableAutostart() {
  const dir = startupDir();
  if (dir) await fsp.rm(path.join(dir, SCRIPT_NAME), { force: true });
  return autostartStatus();
}
