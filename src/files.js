// Gestionnaire de fichiers d'un serveur : navigation, lecture / édition de fichiers texte, envoi, suppression.
// Tous les chemins sont relatifs au dossier du serveur et ne peuvent jamais en sortir.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { err } from './i18n.js';

export const MAX_EDIT_SIZE = 2 * 1024 * 1024; // au-delà, le fichier n'est pas ouvert dans l'éditeur

/** Résout un chemin relatif dans le dossier du serveur ; refuse toute sortie (.., chemin absolu, lien). */
export async function resolveInside(server, rel = '') {
  const root = await fsp.realpath(server.dir);
  const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').some((part) => part === '..') || path.isAbsolute(clean) || /^[a-zA-Z]:/.test(clean)) {
    throw err('path_invalid', {}, 400);
  }
  const full = path.resolve(root, clean);
  if (full !== root && !full.startsWith(root + path.sep)) throw err('path_invalid', {}, 400);
  // Si le fichier existe, on vérifie aussi sa cible réelle (liens symboliques / jonctions)
  if (fs.existsSync(full)) {
    const real = await fsp.realpath(full);
    if (real !== root && !real.startsWith(root + path.sep)) throw err('path_invalid', {}, 400);
  }
  return { root, full, rel: path.relative(root, full).split(path.sep).join('/') };
}

export async function listDir(server, rel) {
  const { full, rel: clean } = await resolveInside(server, rel);
  const stat = await fsp.stat(full).catch(() => null);
  if (!stat?.isDirectory()) throw err('path_not_found', {}, 404);
  const entries = await fsp.readdir(full, { withFileTypes: true });
  const items = await Promise.all(
    entries.map(async (e) => {
      const st = await fsp.stat(path.join(full, e.name)).catch(() => null);
      return { name: e.name, dir: Boolean(st?.isDirectory()), size: st?.size ?? 0, mtime: st?.mtime?.toISOString() ?? null };
    }),
  );
  items.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  return { path: clean, items };
}

/** Un fichier est considéré comme texte s'il ne contient pas d'octet nul dans ses premiers 8 Ko. */
function looksBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

export async function readText(server, rel) {
  const { full, rel: clean } = await resolveInside(server, rel);
  const stat = await fsp.stat(full).catch(() => null);
  if (!stat?.isFile()) throw err('path_not_found', {}, 404);
  if (stat.size > MAX_EDIT_SIZE) throw err('file_too_large', { max: MAX_EDIT_SIZE / 1048576 }, 413);
  const buf = await fsp.readFile(full);
  if (looksBinary(buf)) throw err('file_binary', {}, 415);
  return { path: clean, content: buf.toString('utf8'), mtime: stat.mtime.toISOString(), size: stat.size };
}

export async function writeText(server, rel, content) {
  const { full, root } = await resolveInside(server, rel);
  if (full === root) throw err('path_invalid', {}, 400);
  const stat = await fsp.stat(full).catch(() => null);
  if (stat?.isDirectory()) throw err('path_invalid', {}, 400);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.panel-tmp`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, full);
}

export async function uploadFile(server, dirRel, name, buffer) {
  if (!name || name !== path.basename(name) || name === '.' || name === '..' || /[<>:"|?*]/.test(name)) {
    throw err('path_invalid', {}, 400);
  }
  const { full: dir } = await resolveInside(server, dirRel);
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) throw err('path_not_found', {}, 404);
  const { full } = await resolveInside(server, path.posix.join(String(dirRel || ''), name));
  await fsp.writeFile(full, buffer);
}

export async function deletePath(server, rel) {
  const { full, root } = await resolveInside(server, rel);
  if (full === root) throw err('path_invalid', {}, 400);
  if (!fs.existsSync(full)) throw err('path_not_found', {}, 404);
  try {
    await fsp.rm(full, { recursive: true });
  } catch (e) {
    if (['EBUSY', 'EPERM'].includes(e.code)) throw err('file_locked', {}, 409);
    throw e;
  }
}

export async function makeDir(server, rel) {
  const { full, root } = await resolveInside(server, rel);
  if (full === root) throw err('path_invalid', {}, 400);
  await fsp.mkdir(full, { recursive: true });
}

/** Chemin absolu d'un fichier à télécharger (vérifié). */
export async function downloadPath(server, rel) {
  const { full } = await resolveInside(server, rel);
  const stat = await fsp.stat(full).catch(() => null);
  if (!stat?.isFile()) throw err('path_not_found', {}, 404);
  return full;
}
