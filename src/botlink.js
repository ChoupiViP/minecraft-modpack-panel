// Lien avec le bot Discord (Minecraft Modpack Panel Bot) :
// - clé d'accès limitée (BOT_SECRET) que le bot utilise à la place du mot de passe du panel ;
// - tunnel Cloudflare optionnel pour rendre le panel joignable depuis Internet (bot hébergé sur Render…) ;
// - signal envoyé au bot toutes les 5 min avec l'adresse du panel (le garde aussi éveillé sur Render) ;
// - configuration du bot (salons, rôles…), stockée ici pour survivre aux redémarrages du bot.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR, getSettings, updateSettings, listServers } from './store.js';
import { lineSplitter } from './util.js';
import { err } from './i18n.js';

const BOT_CONFIG_FILE = path.join(DATA_DIR, 'bot.json');
const CF_DIR = path.join(DATA_DIR, 'cloudflared');
const PING_EVERY_MS = 5 * 60_000;
const SNOWFLAKE = /^\d{15,22}$/;
export const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// ---------- Réglages du lien (dans settings.json) ----------
const DEFAULT_LINK = { url: '', secret: '', tunnel: false, publicUrl: '' };

export function linkSettings() {
  return { ...DEFAULT_LINK, ...getSettings().bot };
}

function saveLink(patch) {
  updateSettings({ bot: { ...linkSettings(), ...patch } });
}

export function ensureSecret() {
  if (!linkSettings().secret) saveLink({ secret: crypto.randomBytes(24).toString('base64url') });
  return linkSettings().secret;
}

const secretListeners = new Set();
/** Appelé quand la clé change (le serveur ferme alors les connexions WebSocket du bot). */
export function onSecretChange(fn) {
  secretListeners.add(fn);
}

export function regenerateSecret() {
  saveLink({ secret: crypto.randomBytes(24).toString('base64url') });
  for (const fn of secretListeners) fn();
  pingSoon();
  return linkSettings().secret;
}

function cleanUrl(value, field) {
  const v = String(value || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol)) throw new Error();
  } catch {
    throw err('bot_url_invalid', { field }, 400);
  }
  return v;
}

/** Met à jour l'adresse du bot, le tunnel et l'adresse publique manuelle. */
export async function updateLink({ url, tunnel, publicUrl }, port) {
  const patch = {};
  if (url !== undefined) patch.url = cleanUrl(url, 'url');
  if (publicUrl !== undefined) patch.publicUrl = cleanUrl(publicUrl, 'publicUrl');
  if (tunnel !== undefined) {
    if (tunnel && !process.env.PANEL_PASSWORD) throw err('tunnel_needs_password', {}, 400);
    patch.tunnel = Boolean(tunnel);
  }
  saveLink(patch);
  if (patch.tunnel === true) startTunnel(port).catch(() => {});
  if (patch.tunnel === false) stopTunnel();
  pingSoon();
}

/** Authentification "Bearer <secret>" du bot (comparaison en temps constant). */
export function isBotToken(header) {
  const [type, value] = String(header || '').split(' ');
  const secret = linkSettings().secret;
  if (type !== 'Bearer' || !value || !secret) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Ce que la clé du bot permet : lire les serveurs, les contrôler, la console, sa propre config.
const BOT_ROUTES = [
  ['GET', /^\/api\/servers\/?$/],
  ['GET', /^\/api\/servers\/[^/]+\/?$/],
  ['POST', /^\/api\/servers\/[^/]+\/(start|stop|restart|command)\/?$/],
  ['GET', /^\/api\/bot-config\/?$/],
  ['PUT', /^\/api\/bot-config\/?$/],
  ['GET', /^\/ws$/],
];
export function botRouteAllowed(method, url) {
  const p = String(url).split('?')[0];
  return BOT_ROUTES.some(([m, re]) => m === method && re.test(p));
}

// ---------- Configuration du bot (bot.json) ----------
export const DEFAULT_BOT_CONFIG = {
  language: 'fr',
  guildId: '',
  adminRoleIds: [],
  statusChannelId: '',
  statusInterval: 30,
  serverAddress: '',
  chatChannels: {}, // serverId → channelId
  statusMessageId: '',
};

export function getBotConfig() {
  try {
    return { ...DEFAULT_BOT_CONFIG, ...JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_BOT_CONFIG };
  }
}

const snowflakeOrEmpty = (v, field) => {
  const s = String(v ?? '').trim();
  if (s && !SNOWFLAKE.test(s)) throw err('bot_config_invalid', { field }, 400);
  return s;
};

/** Valide un patch partiel de configuration ; ignore les clés inconnues. */
export function sanitizeBotConfig(patch, serverIds) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if ('language' in patch) out.language = patch.language === 'en' ? 'en' : 'fr';
  for (const key of ['guildId', 'statusChannelId', 'statusMessageId']) {
    if (key in patch) out[key] = snowflakeOrEmpty(patch[key], key);
  }
  if ('adminRoleIds' in patch) {
    if (!Array.isArray(patch.adminRoleIds)) throw err('bot_config_invalid', { field: 'adminRoleIds' }, 400);
    out.adminRoleIds = [...new Set(patch.adminRoleIds.map((id) => snowflakeOrEmpty(id, 'adminRoleIds')).filter(Boolean))];
  }
  if ('statusInterval' in patch) out.statusInterval = Math.min(3600, Math.max(15, Math.round(Number(patch.statusInterval) || 30)));
  if ('serverAddress' in patch) out.serverAddress = String(patch.serverAddress || '').trim().slice(0, 100);
  if ('chatChannels' in patch) {
    const map = patch.chatChannels;
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw err('bot_config_invalid', { field: 'chatChannels' }, 400);
    out.chatChannels = {};
    for (const [serverId, channelId] of Object.entries(map)) {
      const ch = snowflakeOrEmpty(channelId, 'chatChannels');
      if (ch && (!serverIds || serverIds.includes(serverId))) out.chatChannels[serverId] = ch;
    }
  }
  return out;
}

export function updateBotConfig(patch) {
  const next = { ...getBotConfig(), ...sanitizeBotConfig(patch, listServers().map((s) => s.id)) };
  const tmp = BOT_CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, BOT_CONFIG_FILE);
  return next;
}

// ---------- Tunnel Cloudflare ----------
const tunnel = { proc: null, url: '', status: 'off', error: '', wanted: false, restartTimer: null };

function cloudflaredAsset() {
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[process.arch];
  if (process.platform === 'win32' && (arch === 'amd64' || arch === '386')) return `cloudflared-windows-${arch}.exe`;
  if (process.platform === 'linux' && arch) return `cloudflared-linux-${arch}`;
  return null; // macOS : `brew install cloudflared`
}

function cloudflaredInPath() {
  try {
    execFileSync('cloudflared', ['--version'], { stdio: 'ignore', windowsHide: true });
    return 'cloudflared';
  } catch {
    return null;
  }
}

/** Retourne le chemin de cloudflared (téléchargé depuis GitHub si absent). */
async function ensureCloudflared() {
  const asset = cloudflaredAsset();
  const local = path.join(CF_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(local)) return local;
  const inPath = cloudflaredInPath();
  if (inPath) return inPath;
  if (!asset) throw err('cloudflared_unsupported');
  tunnel.status = 'downloading';
  fs.mkdirSync(CF_DIR, { recursive: true });
  const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`);
  if (!res.ok) throw err('cloudflared_download_failed', { status: res.status });
  const part = local + '.part';
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
  fs.renameSync(part, local);
  if (process.platform !== 'win32') fs.chmodSync(local, 0o755);
  return local;
}

export async function startTunnel(port) {
  tunnel.wanted = true;
  clearTimeout(tunnel.restartTimer);
  if (tunnel.proc) return;
  if (!process.env.PANEL_PASSWORD) {
    tunnel.status = 'error';
    tunnel.error = err('tunnel_needs_password').message;
    return;
  }
  tunnel.error = '';
  tunnel.url = '';
  let exe;
  try {
    exe = await ensureCloudflared();
  } catch (e) {
    tunnel.status = 'error';
    tunnel.error = e.message;
    return;
  }
  if (!tunnel.wanted || tunnel.proc) return;
  tunnel.status = 'starting';
  const host = !process.env.HOST || process.env.HOST === '0.0.0.0' ? '127.0.0.1' : process.env.HOST;
  const proc = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://${host}:${port}`], { windowsHide: true });
  tunnel.proc = proc;
  const onLine = (line) => {
    const m = line.match(TUNNEL_URL_RE);
    if (m && m[0] !== tunnel.url) {
      tunnel.url = m[0];
      tunnel.status = 'on';
      console.log(`[Tunnel] ${tunnel.url}`);
      pingSoon();
    }
  };
  proc.stdout.on('data', lineSplitter(onLine));
  proc.stderr.on('data', lineSplitter(onLine));
  proc.on('error', (e) => {
    tunnel.status = 'error';
    tunnel.error = e.message;
  });
  proc.on('exit', (code) => {
    tunnel.proc = null;
    tunnel.url = '';
    if (!tunnel.wanted) {
      tunnel.status = 'off';
      return;
    }
    tunnel.status = 'error';
    tunnel.error ||= `cloudflared (code ${code})`;
    tunnel.restartTimer = setTimeout(() => startTunnel(port).catch(() => {}), 15_000);
  });
}

export function stopTunnel() {
  tunnel.wanted = false;
  clearTimeout(tunnel.restartTimer);
  tunnel.proc?.kill();
  tunnel.status = 'off';
  tunnel.url = '';
  tunnel.error = '';
}

/** Adresse à laquelle le bot peut joindre le panel. */
export function panelPublicUrl() {
  return linkSettings().publicUrl || tunnel.url || '';
}

// ---------- Signal au bot ----------
const link = { ok: null, at: null, error: '', bot: '', configUrl: '' };
let pingTimer = null;
let pingDelay = null;
let pinging = null;

export async function pingBot() {
  if (pinging) return pinging;
  pinging = (async () => {
    const { url, secret } = linkSettings();
    if (!url || !secret) {
      Object.assign(link, { ok: null, at: null, error: '', bot: '' });
      return link;
    }
    // Bot sur la même machine : l'adresse locale du panel suffit, pas besoin de tunnel
    const local = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(url);
    const panelUrl = panelPublicUrl() || (local && panelPort ? `http://127.0.0.1:${panelPort}` : '');
    try {
      // Jusqu'à 90 s : un service Render gratuit en veille met environ une minute à se réveiller
      const res = await fetch(`${url}/api/link`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ panelUrl }),
        signal: AbortSignal.timeout(90_000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw err('bot_secret_mismatch');
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      Object.assign(link, { ok: true, at: Date.now(), error: panelUrl ? '' : err('bot_no_public_url').message, bot: data.bot || '', configUrl: data.configUrl || url });
    } catch (e) {
      Object.assign(link, { ok: false, at: Date.now(), error: e.code === 'bot_secret_mismatch' ? e.message : e.cause?.message || e.message });
    }
    return link;
  })();
  try {
    return await pinging;
  } finally {
    pinging = null;
  }
}

function pingSoon() {
  clearTimeout(pingDelay);
  pingDelay = setTimeout(() => pingBot().catch(() => {}), 1000);
}

let panelPort = null;

export function startBotLink(port) {
  panelPort = port;
  if (linkSettings().tunnel) startTunnel(port).catch(() => {});
  pingSoon();
  pingTimer = setInterval(() => pingBot().catch(() => {}), PING_EVERY_MS);
}

export function stopBotLink() {
  clearInterval(pingTimer);
  clearTimeout(pingDelay);
  stopTunnel();
}

/** État pour l'interface du panel. */
export function botLinkStatus() {
  const s = linkSettings();
  return {
    url: s.url,
    secret: s.secret,
    tunnel: s.tunnel,
    publicUrl: s.publicUrl,
    hasPassword: Boolean(process.env.PANEL_PASSWORD),
    tunnelState: { status: tunnel.status, url: tunnel.url, error: tunnel.error },
    panelUrl: panelPublicUrl(),
    link: { ...link },
  };
}
