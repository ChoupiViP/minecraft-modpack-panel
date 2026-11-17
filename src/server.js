// Point d'entrée : API REST + WebSocket (console en direct) + interface web.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import * as store from './store.js';
import * as cf from './curseforge.js';
import * as pm from './process-manager.js';
import * as backups from './backups.js';
import { installPack } from './installer.js';
import { t, err } from './i18n.js';
import { readProperties, setProperties } from './util.js';
import { findJavaInstalls, recommendedJava, installJava, javaJobs, javaEvents } from './java.js';
import { getPlayers, playerAction } from './players.js';
import { startStats, stopStats, statsEvents, systemInfo, tpsCommand } from './stats.js';
import { listMods, setModEnabled, deleteMod, addMod } from './mods.js';
import { normalizeSchedules, nextRun, startScheduler } from './scheduler.js';
import * as files from './files.js';
import { listCrashes, latestCrash } from './crashes.js';
import { autostartStatus, enableAutostart, disableAutostart } from './autostart.js';
import { startNotifications, sendTest, WEBHOOK_RE, EVENT_TYPES, DEFAULT_EVENTS } from './notify.js';
import * as botlink from './botlink.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 8080;
const PASSWORD = process.env.PANEL_PASSWORD || '';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Authentification HTTP Basic optionnelle (recommandée si HOST=0.0.0.0)
function checkAuth(req) {
  if (!PASSWORD) return true;
  const [type, value] = (req.headers.authorization || '').split(' ');
  if (type !== 'Basic' || !value) return false;
  const pass = Buffer.from(value, 'base64').toString().split(':').slice(1).join(':');
  return pass === PASSWORD;
}
app.use((req, res, next) => {
  // Clé du bot Discord : accès limité aux routes dont le bot a besoin
  if (botlink.isBotToken(req.headers.authorization)) {
    if (botlink.botRouteAllowed(req.method, req.path)) return next();
    return res.status(403).json({ error: t('bot_forbidden'), code: 'bot_forbidden' });
  }
  if (checkAuth(req)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Minecraft Modpack Panel"').status(401).send(t('auth_required'));
});

app.use(express.static(path.join(store.ROOT, 'public')));

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => res.status(e.status || 500).json({ error: e.message, code: e.code }));

function serverOr404(req) {
  const s = store.getServer(req.params.id);
  if (!s) throw err('server_not_found', {}, 404);
  return s;
}

function publicServer(s) {
  return { ...s, runtime: pm.getInstance(s.id).summary(), recommendedJava: recommendedJava(s.mcVersion) };
}

// ---------- Paramètres ----------
const mask = (secret, keep) => (secret ? '••••••••' + secret.slice(-keep) : '');

app.get('/api/settings', (req, res) => {
  const s = store.getSettings();
  res.json({
    ...s,
    curseforgeApiKey: mask(s.curseforgeApiKey, 4),
    discordWebhook: mask(s.discordWebhook, 6),
    discordEvents: { ...DEFAULT_EVENTS, ...s.discordEvents },
    autostart: autostartStatus(),
  });
});

app.put('/api/settings', wrap(async (req, res) => {
  const patch = {};
  const { curseforgeApiKey, defaultJavaPath, defaultRamMB, language, discordWebhook, discordEvents } = req.body;
  if (typeof curseforgeApiKey === 'string' && !curseforgeApiKey.startsWith('••')) patch.curseforgeApiKey = curseforgeApiKey.trim();
  if (defaultJavaPath) patch.defaultJavaPath = String(defaultJavaPath);
  if (defaultRamMB) patch.defaultRamMB = Number(defaultRamMB);
  if (language === 'fr' || language === 'en') patch.language = language;
  if (typeof discordWebhook === 'string' && !discordWebhook.startsWith('••')) {
    const url = discordWebhook.trim();
    if (url && !WEBHOOK_RE.test(url)) throw err('webhook_invalid', {}, 400);
    patch.discordWebhook = url;
  }
  if (discordEvents && typeof discordEvents === 'object') {
    patch.discordEvents = Object.fromEntries(EVENT_TYPES.map((k) => [k, Boolean(discordEvents[k])]));
  }
  store.updateSettings(patch);
  res.json({ ok: true });
}));

app.post('/api/notify/test', wrap(async (req, res) => {
  await sendTest();
  res.json({ ok: true });
}));

app.post('/api/autostart', wrap(async (req, res) => {
  res.json(req.body?.enabled ? await enableAutostart() : await disableAutostart());
}));

// ---------- Bot Discord ----------
app.get('/api/bot', (req, res) => {
  botlink.ensureSecret();
  res.json(botlink.botLinkStatus());
});
app.put('/api/bot', wrap(async (req, res) => {
  const { url, tunnel, publicUrl } = req.body || {};
  await botlink.updateLink({ url, tunnel, publicUrl }, PORT);
  res.json(botlink.botLinkStatus());
}));
app.post('/api/bot/secret', (req, res) => {
  botlink.regenerateSecret();
  res.json(botlink.botLinkStatus());
});
app.post('/api/bot/ping', wrap(async (req, res) => {
  await botlink.pingBot();
  res.json(botlink.botLinkStatus());
}));
app.get('/api/bot-config', (req, res) => res.json(botlink.getBotConfig()));
app.put('/api/bot-config', wrap(async (req, res) => res.json(botlink.updateBotConfig(req.body))));

app.get('/api/java', wrap(async (req, res) => {
  res.json({ installs: await findJavaInstalls({ fresh: req.query.fresh === '1' }), downloading: javaJobs() });
}));

// Télécharge Java en arrière-plan ; la progression arrive par WebSocket ("java").
app.post('/api/java/install', wrap(async (req, res) => {
  const version = Number(req.body.version);
  const job = installJava(version);
  job.catch(() => {});
  // Optionnel : appliquer ce Java à un serveur une fois installé
  if (req.body.serverId && store.getServer(req.body.serverId)) {
    job.then((javaPath) => store.updateServer(req.body.serverId, { javaPath })).catch(() => {});
  }
  res.status(202).json({ ok: true });
}));

app.get('/api/system', (req, res) => res.json(systemInfo()));

// ---------- CurseForge ----------
app.get('/api/curseforge/search', wrap(async (req, res) => {
  res.json(await cf.searchModpacks(String(req.query.q || ''), req.query.version ? String(req.query.version) : undefined));
}));

app.get('/api/curseforge/modpacks/:modId/files', wrap(async (req, res) => {
  res.json(await cf.getModpackFiles(Number(req.params.modId)));
}));

// ---------- Serveurs ----------
app.get('/api/servers', (req, res) => res.json(store.listServers().map(publicServer)));

app.get('/api/servers/:id', wrap(async (req, res) => res.json(publicServer(serverOr404(req)))));

app.post('/api/servers', wrap(async (req, res) => {
  const { name, modId, fileId, packName, versionName, port, ramMB, javaPath, acceptEula } = req.body;
  if (!acceptEula) throw err('eula_required', {}, 400);
  if (!modId || !fileId) throw err('no_modpack', {}, 400);
  const p = Number(port) || 25565;
  if (store.listServers().some((s) => Number(s.port) === p)) {
    throw err('port_used_other', { port: p }, 400);
  }
  const server = store.createServer({
    name: name || packName,
    port: p,
    ramMB: Number(ramMB) || undefined,
    javaPath: javaPath || undefined,
    pack: { modId: Number(modId), fileId: Number(fileId), name: packName, version: versionName },
  });
  runInstall(server);
  res.status(201).json(publicServer(server));
}));

function runInstall(server) {
  const inst = pm.getInstance(server.id);
  inst.logs = [];
  inst.setStatus('installing');
  installPack(server, (l) => inst.log(l))
    .then((result) => {
      store.updateServer(server.id, { ...result, installed: true });
      inst.setStatus('stopped');
      const rec = recommendedJava(result.mcVersion);
      if (rec) inst.log(t('java_recommended', { version: rec, mc: result.mcVersion }));
    })
    .catch((e) => {
      inst.log(t('install_failed', { error: e.message }));
      inst.setStatus('install-failed');
    });
}

app.post('/api/servers/:id/reinstall', wrap(async (req, res) => {
  const s = serverOr404(req);
  if (pm.getInstance(s.id).proc || pm.isBusy(s.id)) throw err('stop_first', {}, 409);
  if (req.body?.fileId) store.updateServer(s.id, { pack: { ...s.pack, fileId: Number(req.body.fileId), version: req.body.versionName } });
  runInstall(s);
  res.json({ ok: true });
}));

app.patch('/api/servers/:id', wrap(async (req, res) => {
  const s = serverOr404(req);
  const patch = {};
  const b = req.body;
  if (b.name) patch.name = String(b.name);
  if (b.ramMB) patch.ramMB = Math.max(512, Number(b.ramMB));
  if (b.javaPath) patch.javaPath = String(b.javaPath);
  if (typeof b.jvmArgs === 'string') patch.jvmArgs = b.jvmArgs;
  if (typeof b.autoRestart === 'boolean') patch.autoRestart = b.autoRestart;
  if (typeof b.autoStart === 'boolean') patch.autoStart = b.autoStart;
  if (b.autoBackup) {
    patch.autoBackup = {
      enabled: Boolean(b.autoBackup.enabled),
      intervalHours: Math.max(0.25, Number(b.autoBackup.intervalHours) || 6),
      keep: Math.max(1, Number(b.autoBackup.keep) || 10),
    };
  }
  if (b.port && Number(b.port) !== Number(s.port)) {
    const p = Number(b.port);
    if (store.listServers().some((o) => o.id !== s.id && Number(o.port) === p)) {
      throw err('port_used_other', { port: p }, 400);
    }
    patch.port = p;
    setProperties(path.join(s.dir, 'server.properties'), { 'server-port': p });
  }
  res.json(publicServer(store.updateServer(s.id, patch)));
}));

app.delete('/api/servers/:id', wrap(async (req, res) => {
  const s = serverOr404(req);
  if (pm.getInstance(s.id).proc || pm.isBusy(s.id)) throw err('stop_before_delete', {}, 409);
  store.removeServer(s.id);
  await fsp.rm(s.dir, { recursive: true, force: true });
  if (req.query.backups === '1') await fsp.rm(path.join(store.BACKUPS_DIR, s.id), { recursive: true, force: true });
  res.json({ ok: true });
}));

app.post('/api/servers/:id/start', wrap(async (req, res) => {
  pm.start(serverOr404(req));
  res.json({ ok: true });
}));
app.post('/api/servers/:id/stop', wrap(async (req, res) => {
  const s = serverOr404(req);
  pm.stop(s.id);
  res.json({ ok: true });
}));
app.post('/api/servers/:id/restart', wrap(async (req, res) => {
  const s = serverOr404(req);
  pm.restart(s).catch((e) => pm.getInstance(s.id).log(`[Panel] ${e.message}`));
  res.json({ ok: true });
}));
app.post('/api/servers/:id/kill', wrap(async (req, res) => {
  pm.kill(serverOr404(req).id);
  res.json({ ok: true });
}));
app.post('/api/servers/:id/command', wrap(async (req, res) => {
  const s = serverOr404(req);
  const cmd = String(req.body.command || '').trim().replace(/^\//, '');
  if (!cmd) throw err('empty_command', {}, 400);
  pm.getInstance(s.id).log(`> ${cmd}`);
  pm.sendCommand(s.id, cmd);
  res.json({ ok: true });
}));
app.get('/api/servers/:id/players', wrap(async (req, res) => res.json(getPlayers(serverOr404(req)))));
app.post('/api/servers/:id/players', wrap(async (req, res) => {
  res.json({ command: playerAction(serverOr404(req), req.body || {}) });
}));

app.get('/api/servers/:id/stats', wrap(async (req, res) => {
  const s = serverOr404(req);
  const inst = pm.getInstance(s.id);
  res.json({
    samples: inst.stats,
    lagEvents: inst.lagEvents,
    tpsAvailable: Boolean(tpsCommand(s)) && !inst.tpsUnsupported,
    ramMax: s.ramMB,
    system: systemInfo(),
  });
}));

// ---------- Mods ----------
app.get('/api/servers/:id/mods', wrap(async (req, res) => {
  const s = serverOr404(req);
  res.json({ mods: await listMods(s), running: Boolean(pm.getInstance(s.id).proc) });
}));
app.post('/api/servers/:id/mods/:file/toggle', wrap(async (req, res) => {
  res.json({ fileName: await setModEnabled(serverOr404(req), req.params.file, Boolean(req.body?.enabled)) });
}));
app.delete('/api/servers/:id/mods/:file', wrap(async (req, res) => {
  await deleteMod(serverOr404(req), req.params.file);
  res.json({ ok: true });
}));
// Upload d'un .jar : corps brut, nom de fichier dans ?name=
app.post('/api/servers/:id/mods', express.raw({ type: () => true, limit: '256mb' }), wrap(async (req, res) => {
  res.status(201).json({ fileName: await addMod(serverOr404(req), String(req.query.name || ''), req.body) });
}));

// ---------- Fichiers ----------
app.get('/api/servers/:id/files', wrap(async (req, res) => {
  res.json(await files.listDir(serverOr404(req), String(req.query.path || '')));
}));
app.get('/api/servers/:id/files/content', wrap(async (req, res) => {
  res.json(await files.readText(serverOr404(req), String(req.query.path || '')));
}));
app.put('/api/servers/:id/files/content', express.text({ type: () => true, limit: '4mb' }), wrap(async (req, res) => {
  await files.writeText(serverOr404(req), String(req.query.path || ''), typeof req.body === 'string' ? req.body : '');
  res.json({ ok: true });
}));
app.post('/api/servers/:id/files/upload', express.raw({ type: () => true, limit: '512mb' }), wrap(async (req, res) => {
  await files.uploadFile(serverOr404(req), String(req.query.path || ''), String(req.query.name || ''), req.body);
  res.status(201).json({ ok: true });
}));
app.post('/api/servers/:id/files/mkdir', wrap(async (req, res) => {
  await files.makeDir(serverOr404(req), String(req.body?.path || ''));
  res.status(201).json({ ok: true });
}));
app.delete('/api/servers/:id/files', wrap(async (req, res) => {
  await files.deletePath(serverOr404(req), String(req.query.path || ''));
  res.json({ ok: true });
}));
app.get('/api/servers/:id/files/download', wrap(async (req, res) => {
  res.download(await files.downloadPath(serverOr404(req), String(req.query.path || '')));
}));

// ---------- Crash reports ----------
app.get('/api/servers/:id/crashes', wrap(async (req, res) => res.json(await listCrashes(serverOr404(req)))));
app.get('/api/servers/:id/crashes/latest', wrap(async (req, res) => {
  const s = serverOr404(req);
  // Par défaut : seulement un crash survenu depuis le dernier démarrage
  const since = req.query.all === '1' ? 0 : pm.getInstance(s.id).startedAt || 0;
  res.json(await latestCrash(s, since));
}));

// ---------- Tâches planifiées ----------
app.get('/api/servers/:id/schedules', wrap(async (req, res) => {
  const s = serverOr404(req);
  res.json((s.schedules || []).map((sc) => ({ ...sc, nextRun: nextRun(sc) })));
}));
app.put('/api/servers/:id/schedules', wrap(async (req, res) => {
  const s = serverOr404(req);
  const schedules = normalizeSchedules(req.body);
  store.updateServer(s.id, { schedules });
  res.json(schedules.map((sc) => ({ ...sc, nextRun: nextRun(sc) })));
}));

app.get('/api/servers/:id/logs', wrap(async (req, res) => res.json(pm.getInstance(serverOr404(req).id).logs)));

app.get('/api/servers/:id/properties', wrap(async (req, res) => {
  const file = path.join(serverOr404(req).dir, 'server.properties');
  res.type('text/plain').send(fs.existsSync(file) ? await fsp.readFile(file, 'utf8') : '');
}));
app.put('/api/servers/:id/properties', express.text({ limit: '1mb' }), wrap(async (req, res) => {
  const s = serverOr404(req);
  const text = typeof req.body === 'string' ? req.body : '';
  await fsp.writeFile(path.join(s.dir, 'server.properties'), text);
  const port = Number(readProperties(path.join(s.dir, 'server.properties'))['server-port']);
  if (port && port !== Number(s.port)) store.updateServer(s.id, { port });
  res.json({ ok: true });
}));

// ---------- Sauvegardes ----------
app.get('/api/servers/:id/backups', wrap(async (req, res) => res.json(await backups.listBackups(serverOr404(req).id))));
app.post('/api/servers/:id/backups', wrap(async (req, res) => {
  res.json({ name: await backups.createBackup(serverOr404(req)) });
}));
app.post('/api/servers/:id/backups/:name/restore', wrap(async (req, res) => {
  await backups.restoreBackup(serverOr404(req), req.params.name);
  res.json({ ok: true });
}));
app.delete('/api/servers/:id/backups/:name', wrap(async (req, res) => {
  await backups.deleteBackup(serverOr404(req).id, req.params.name);
  res.json({ ok: true });
}));
app.get('/api/servers/:id/backups/:name/download', wrap(async (req, res) => {
  res.download(backups.backupPath(serverOr404(req).id, req.params.name));
}));

// ---------- WebSocket ----------
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !(checkAuth(req) || botlink.isBotToken(req.headers.authorization))) {
    socket.destroy();
    return;
  }
  const isBot = botlink.isBotToken(req.headers.authorization);
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.isBot = isBot;
    wss.emit('connection', ws, req);
  });
});
// Nouvelle clé du bot : l'ancienne connexion du bot est coupée
botlink.onSecretChange(() => {
  for (const c of wss.clients) if (c.isBot) c.terminate();
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}
pm.events.on('log', ({ id, line }) => broadcast({ type: 'log', id, line }));
pm.events.on('status', (summary) => broadcast({ type: 'status', ...summary }));
statsEvents.on('sample', ({ id, sample }) => broadcast({ type: 'stats', id, sample }));
javaEvents.on('progress', (p) => broadcast({ type: 'java', ...p }));

// ---------- Démarrage / arrêt ----------
// Une installation interrompue (panel fermé) est marquée comme échouée.
for (const s of store.listServers()) {
  if (!s.installed) pm.getInstance(s.id).status = 'install-failed';
}

backups.startScheduler();
startNotifications();

// Serveurs à démarrer automatiquement avec le panel (espacés de 5 s pour ne pas tout charger d'un coup)
store
  .listServers()
  .filter((s) => s.autoStart && s.installed)
  .forEach((s, i) =>
    setTimeout(() => {
      try {
        pm.getInstance(s.id).log(t('autostart_server'));
        pm.start(store.getServer(s.id));
      } catch (e) {
        pm.getInstance(s.id).log(`[Panel] ${e.message}`);
      }
    }, 2000 + i * 5000),
  );
startStats();
startScheduler();
botlink.startBotLink(PORT);

httpServer.listen(PORT, HOST, () => {
  console.log(t('panel_ready', { url: `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}` }));
  if (HOST !== '127.0.0.1' && !PASSWORD) console.warn(t('panel_exposed'));
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return process.exit(1);
  shuttingDown = true;
  console.log(t('shutting_down'));
  botlink.stopBotLink();
  await pm.stopAll();
  stopStats();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
