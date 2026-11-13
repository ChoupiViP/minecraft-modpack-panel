// Notifications Discord (webhook) : serveur en ligne / arrêté / crash, joueurs, sauvegarde ratée.
import { events, getInstance } from './process-manager.js';
import { getSettings, getServer } from './store.js';
import { latestCrash } from './crashes.js';
import { t, err } from './i18n.js';

export const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
export const EVENT_TYPES = ['online', 'offline', 'crash', 'players', 'backupFailed'];
export const DEFAULT_EVENTS = { online: true, offline: true, crash: true, players: false, backupFailed: true };
const COLORS = { online: 0x4caf50, offline: 0x9097a3, crash: 0xe5534b, players: 0x4a9eda, backupFailed: 0xd6a23a, test: 0x4caf50 };

let queue = Promise.resolve();

async function post(webhook, description, kind) {
  const body = JSON.stringify({ username: 'Modpack Panel', embeds: [{ description, color: COLORS[kind] ?? 0x4a9eda }] });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (res.status === 429 && attempt === 0) {
      const wait = Number((await res.json().catch(() => ({}))).retry_after) || 2;
      await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
      continue;
    }
    if (!res.ok) throw err('notify_failed', { status: res.status });
    return;
  }
}

/** Envoie une notification si le webhook est configuré et l'événement activé (file d'attente séquentielle). */
function notify(kind, description) {
  const { discordWebhook, discordEvents } = getSettings();
  if (!discordWebhook || !{ ...DEFAULT_EVENTS, ...discordEvents }[kind]) return;
  queue = queue.then(() => post(discordWebhook, description, kind)).catch((e) => console.warn(`[Discord] ${e.message}`));
}

export async function sendTest() {
  const { discordWebhook } = getSettings();
  if (!discordWebhook) throw err('webhook_missing', {}, 400);
  await post(discordWebhook, t('notify_test'), 'test');
}

const lastStatus = new Map();

export function startNotifications() {
  events.on('status', async ({ id, status }) => {
    const prev = lastStatus.get(id);
    lastStatus.set(id, status);
    if (prev === status) return;
    const server = getServer(id);
    if (!server) return;
    const name = server.name;
    if (status === 'running' && prev === 'starting') notify('online', t('notify_online', { server: name }));
    else if (status === 'stopped' && prev === 'stopping') notify('offline', t('notify_offline', { server: name }));
    else if (status === 'crashed') {
      let detail = '';
      try {
        const crash = await latestCrash(server, getInstance(id).startedAt || 0);
        if (crash?.description) detail += `\n> ${crash.description}`;
        if (crash?.suspects?.length) detail += `\n${t('notify_suspects', { mods: crash.suspects.join(', ') })}`;
      } catch {
        /* pas de crash report lisible */
      }
      notify('crash', t('notify_crash', { server: name }) + detail);
    }
  });
  events.on('player', ({ id, name, joined }) => {
    const server = getServer(id);
    if (server) notify('players', t(joined ? 'notify_join' : 'notify_leave', { player: name, server: server.name }));
  });
  events.on('backup-failed', ({ id, error }) => {
    const server = getServer(id);
    if (server) notify('backupFailed', t('notify_backup_failed', { server: server.name, error }));
  });
}
