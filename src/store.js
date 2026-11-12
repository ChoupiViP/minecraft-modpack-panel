// Persistance simple en JSON : paramètres globaux + liste des serveurs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const SERVERS_DIR = path.join(DATA_DIR, 'servers');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');

for (const d of [DATA_DIR, SERVERS_DIR, BACKUPS_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');

const DEFAULT_SETTINGS = {
  curseforgeApiKey: '',
  language: '', // 'fr' | 'en' (vide = choisi par l'interface au premier lancement)
  defaultJavaPath: 'java',
  defaultRamMB: 6144,
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

let settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };
let servers = readJson(SERVERS_FILE, []);

export function getSettings() {
  return settings;
}

export function updateSettings(patch) {
  settings = { ...settings, ...patch };
  writeJson(SETTINGS_FILE, settings);
  return settings;
}

export function listServers() {
  return servers;
}

export function getServer(id) {
  return servers.find((s) => s.id === id);
}

export function createServer(data) {
  const slug = (data.name || 'serveur')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'serveur';
  const id = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
  const server = {
    id,
    name: data.name || id,
    dir: path.join(SERVERS_DIR, id),
    javaPath: data.javaPath || settings.defaultJavaPath,
    ramMB: data.ramMB || settings.defaultRamMB,
    jvmArgs: '',
    port: data.port,
    autoRestart: true,
    autoBackup: { enabled: true, intervalHours: 6, keep: 10 },
    pack: data.pack || null,
    mcVersion: null,
    loader: null,
    installed: false,
    missingMods: [],
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(server.dir, { recursive: true });
  servers.push(server);
  save();
  return server;
}

export function updateServer(id, patch) {
  const s = getServer(id);
  if (!s) return null;
  Object.assign(s, patch);
  save();
  return s;
}

export function removeServer(id) {
  servers = servers.filter((s) => s.id !== id);
  save();
}

function save() {
  writeJson(SERVERS_FILE, servers);
}
