// Sauvegardes du monde (zip), restauration et planification automatique.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { BACKUPS_DIR, getServer, listServers } from './store.js';
import { getInstance, sendCommand } from './process-manager.js';
import { extractZip, readProperties } from './util.js';
import { t, err } from './i18n.js';

const NAME_RE = /^(auto|manual|manuel)-[\w.-]+\.zip$/; // "manuel" : anciennes sauvegardes

function backupDir(id) {
  return path.join(BACKUPS_DIR, id);
}

export function backupPath(id, name) {
  if (!NAME_RE.test(name)) throw err('backup_invalid_name', {}, 400);
  return path.join(backupDir(id), name);
}

function levelName(server) {
  return readProperties(path.join(server.dir, 'server.properties'))['level-name'] || 'world';
}

export async function listBackups(id) {
  const dir = backupDir(id);
  if (!fs.existsSync(dir)) return [];
  const names = (await fsp.readdir(dir)).filter((n) => NAME_RE.test(n));
  const list = await Promise.all(
    names.map(async (name) => {
      const st = await fsp.stat(path.join(dir, name));
      return { name, size: st.size, date: st.mtime.toISOString(), auto: name.startsWith('auto-') };
    }),
  );
  return list.sort((a, b) => b.date.localeCompare(a.date));
}

export async function createBackup(server, { auto = false } = {}) {
  const inst = getInstance(server.id);
  if (inst.backupInProgress) throw err('backup_in_progress', {}, 409);
  const level = levelName(server);
  const worldDir = path.join(server.dir, level);
  if (!fs.existsSync(worldDir)) throw err('no_world', { level }, 409);

  inst.backupInProgress = true;
  const running = inst.status === 'running' && inst.proc;
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
  const name = `${auto ? 'auto' : 'manual'}-${stamp}.zip`;
  const dest = path.join(backupDir(server.id), name);
  await fsp.mkdir(path.dirname(dest), { recursive: true });

  inst.log(t('backup_started', { name }));
  try {
    if (running) {
      sendCommand(server.id, 'save-off');
      const saved = inst.waitForLine(/Saved the (game|world)|ThreadedAnvilChunkStorage.*saved|All dimensions are saved/i, 60_000);
      sendCommand(server.id, 'save-all flush');
      await saved.catch(() => inst.log(t('backup_no_confirm')));
    }
    await zipDir(worldDir, level, dest);
    const size = (await fsp.stat(dest)).size;
    inst.log(t('backup_done', { size: (size / 1048576).toFixed(1) }));
  } catch (e) {
    await fsp.rm(dest + '.part', { force: true }).catch(() => {});
    inst.log(t('backup_failed', { error: e.message }));
    throw e;
  } finally {
    if (running && inst.proc) sendCommand(server.id, 'save-on');
    inst.backupInProgress = false;
    inst.lastAutoBackup = Date.now();
  }
  if (auto) await prune(server);
  return name;
}

function zipDir(srcDir, prefix, dest) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part';
    const out = fs.createWriteStream(tmp);
    const archive = archiver('zip', { zlib: { level: 6 } });
    out.on('close', () => fsp.rename(tmp, dest).then(resolve, reject));
    out.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (e) => (e.code === 'ENOENT' ? null : reject(e)));
    archive.pipe(out);
    // session.lock est verrouillé par le serveur sous Windows
    archive.glob('**/*', { cwd: srcDir, dot: true, ignore: ['session.lock'] }, { prefix });
    archive.finalize();
  });
}

async function prune(server) {
  const keep = Math.max(1, Number(server.autoBackup?.keep) || 10);
  const autos = (await listBackups(server.id)).filter((b) => b.auto);
  for (const b of autos.slice(keep)) {
    await fsp.rm(path.join(backupDir(server.id), b.name), { force: true });
  }
}

export async function deleteBackup(id, name) {
  await fsp.rm(backupPath(id, name), { force: true });
}

/** Restaure un monde. L'ancien monde est conservé sous "<monde>.avant-restauration". */
export async function restoreBackup(server, name) {
  const inst = getInstance(server.id);
  if (inst.proc) throw err('stop_before_restore', {}, 409);
  const file = backupPath(server.id, name);
  if (!fs.existsSync(file)) throw err('backup_not_found', {}, 404);
  const level = levelName(server);
  const worldDir = path.join(server.dir, level);
  const previous = path.join(server.dir, `${level}.before-restore`);
  inst.setStatus('restoring');
  try {
    inst.log(t('restore_started', { name }));
    if (fs.existsSync(worldDir)) {
      await fsp.rm(previous, { recursive: true, force: true });
      await fsp.rename(worldDir, previous);
    }
    await extractZip(file, server.dir);
    inst.log(t('restore_done', { folder: `${level}.before-restore` }));
  } finally {
    inst.setStatus('stopped');
  }
}

/** Vérifie chaque minute si une sauvegarde automatique est due (uniquement serveurs en marche). */
export function startScheduler() {
  setInterval(async () => {
    for (const { id } of listServers()) {
      const server = getServer(id);
      const inst = getInstance(id);
      const cfg = server.autoBackup;
      if (!cfg?.enabled || inst.status !== 'running' || inst.backupInProgress) continue;
      const intervalMs = Math.max(0.25, Number(cfg.intervalHours) || 6) * 3_600_000;
      const last = Math.max(inst.lastAutoBackup || 0, inst.startedAt || 0);
      if (Date.now() - last < intervalMs) continue;
      createBackup(server, { auto: true }).catch(() => {});
    }
  }, 60_000).unref();
}
