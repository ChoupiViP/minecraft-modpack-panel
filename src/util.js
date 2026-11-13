import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import extractZipLib from 'extract-zip';
import { err } from './i18n.js';

/** Télécharge une URL vers un fichier (écriture atomique via .part). */
export async function download(url, dest, { headers = {}, onProgress } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) throw err('download_failed', { status: res.status, url });
  const total = Number(res.headers.get('content-length')) || 0;
  const body = Readable.fromWeb(res.body);
  if (onProgress && total) {
    let done = 0;
    let last = -1;
    body.on('data', (chunk) => {
      done += chunk.length;
      const pct = Math.floor((done * 100) / total);
      if (pct >= last + 10) {
        last = pct;
        onProgress(pct, total);
      }
    });
  }
  const tmp = dest + '.part';
  await pipeline(body, fs.createWriteStream(tmp));
  await fsp.rename(tmp, dest);
}

/** Extrait un zip. Si le zip contient un unique dossier racine, son contenu est remonté. */
export async function extractZip(zipPath, destDir, { stripSingleRoot = false, tmpDir } = {}) {
  if (!stripSingleRoot) {
    await fsp.mkdir(destDir, { recursive: true });
    await extractZipLib(zipPath, { dir: path.resolve(destDir) });
    return;
  }
  const work = path.join(tmpDir || path.dirname(zipPath), `extract-${Date.now()}`);
  await extractZipLib(zipPath, { dir: path.resolve(work) });
  let root = work;
  const entries = (await fsp.readdir(work)).filter((e) => e !== '__MACOSX');
  if (entries.length === 1 && (await fsp.stat(path.join(work, entries[0]))).isDirectory()) {
    root = path.join(work, entries[0]);
  }
  await moveMerge(root, destDir);
  await fsp.rm(work, { recursive: true, force: true });
}

/** Déplace le contenu de src dans dest, en fusionnant les dossiers existants. */
export async function moveMerge(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory() && fs.existsSync(to)) {
      await moveMerge(from, to);
    } else {
      try {
        await fsp.rename(from, to);
      } catch {
        await fsp.cp(from, to, { recursive: true, force: true });
      }
    }
  }
}

/** Exécute une commande en streamant chaque ligne de sortie vers log(). */
export function runProcess(cmd, args, { cwd, log }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, windowsHide: true });
    const onData = lineSplitter((line) => log?.(line));
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(err('process_exit', { cmd: path.basename(cmd), code }))));
  });
}

/** Retourne un handler de flux qui découpe en lignes. */
export function lineSplitter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    // Retire les codes couleur ANSI et les codes de formatage Minecraft (§a, §l, §r…)
    for (const l of lines) onLine(l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/§[0-9a-fk-orx]/gi, ''));
  };
}

/** Exécute des tâches async avec une concurrence limitée. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Lecture / écriture de server.properties en conservant l'ordre et les commentaires. */
export function readProperties(file) {
  const map = {};
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([^#!][^=:]*?)\s*[=:]\s*(.*)$/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

export function setProperties(file, values) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const remaining = { ...values };
  const out = lines.map((line) => {
    const m = line.match(/^\s*([^#!][^=:]*?)\s*[=:]/);
    if (m && m[1] in remaining) {
      const v = remaining[m[1]];
      delete remaining[m[1]];
      return `${m[1]}=${v}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of Object.entries(remaining)) out.push(`${k}=${v}`);
  fs.writeFileSync(file, out.join('\n') + '\n');
}
