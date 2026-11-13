// Gestion des mods d'un serveur : liste (avec métadonnées lues dans les jars), activation, suppression, ajout.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import { getInstance } from './process-manager.js';
import { err } from './i18n.js';

const META_FILES = [
  'fabric.mod.json',
  'quilt.mod.json',
  'META-INF/neoforge.mods.toml',
  'META-INF/mods.toml',
  'mcmod.info',
  'META-INF/MANIFEST.MF',
];
const MAX_META_SIZE = 1024 * 1024;
const FILE_RE = /^[^/\\:*?"<>|]+\.jar(\.disabled)?$/i;
const cache = new Map(); // "chemin|taille|mtime" -> métadonnées

/** Lit certains fichiers texte d'un jar (zip) sans l'extraire. */
function readJarEntries(file, wanted) {
  return new Promise((resolve, reject) => {
    const found = new Map();
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (e, zip) => {
      if (e) return reject(e);
      zip.on('error', reject);
      zip.on('end', () => resolve(found));
      zip.on('entry', (entry) => {
        if (!wanted.includes(entry.fileName) || entry.uncompressedSize > MAX_META_SIZE) return zip.readEntry();
        zip.openReadStream(entry, (e2, stream) => {
          if (e2) return zip.readEntry();
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            found.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
            zip.readEntry();
          });
          stream.on('error', () => zip.readEntry());
        });
      });
      zip.readEntry();
    });
  });
}

/** Lit une valeur simple dans la première section [[mods]] d'un mods.toml. */
function tomlValue(section, key) {
  const m = section.match(new RegExp(`^\\s*${key}\\s*=\\s*("""[\\s\\S]*?"""|'''[\\s\\S]*?'''|"(?:[^"\\\\]|\\\\.)*"|'[^']*')`, 'm'));
  if (!m) return null;
  return m[1].replace(/^("""|'''|"|')|("""|'''|"|')$/g, '').trim();
}

/** Extrait nom / version / description à partir des fichiers de métadonnées d'un mod. */
export function parseModMeta(entries) {
  const manifestVersion = entries.get('META-INF/MANIFEST.MF')?.match(/^Implementation-Version:\s*(.+)$/m)?.[1]?.trim();

  const fabric = entries.get('fabric.mod.json');
  if (fabric) {
    try {
      const j = JSON.parse(fabric.replace(/^﻿/, ''));
      return {
        loader: 'fabric',
        modId: j.id,
        name: j.name || j.id,
        version: j.version,
        description: typeof j.description === 'string' ? j.description : '',
        authors: (j.authors || []).map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean),
        clientOnly: j.environment === 'client',
      };
    } catch {
      /* JSON invalide : on essaie les autres formats */
    }
  }

  const quilt = entries.get('quilt.mod.json');
  if (quilt) {
    try {
      const q = JSON.parse(quilt).quilt_loader || {};
      return {
        loader: 'quilt',
        modId: q.id,
        name: q.metadata?.name || q.id,
        version: q.version,
        description: q.metadata?.description || '',
        authors: Object.keys(q.metadata?.contributors || {}),
        clientOnly: JSON.parse(quilt).minecraft?.environment === 'client',
      };
    } catch {
      /* ignoré */
    }
  }

  const toml = entries.get('META-INF/neoforge.mods.toml') || entries.get('META-INF/mods.toml');
  if (toml) {
    const start = toml.search(/^\s*\[\[mods\]\]/m);
    const rest = start >= 0 ? toml.slice(start).replace(/^\s*\[\[mods\]\]/, '') : '';
    const end = rest.search(/^\s*\[/m);
    const section = end >= 0 ? rest.slice(0, end) : rest;
    let version = tomlValue(section, 'version');
    if (!version || version.includes('${')) version = manifestVersion || version;
    const authors = tomlValue(section, 'authors') || tomlValue(toml, 'authors');
    return {
      loader: entries.has('META-INF/neoforge.mods.toml') ? 'neoforge' : 'forge',
      modId: tomlValue(section, 'modId'),
      name: tomlValue(section, 'displayName') || tomlValue(section, 'modId'),
      version,
      description: (tomlValue(section, 'description') || '').replace(/\s+/g, ' ').trim(),
      authors: authors ? [authors] : [],
      clientOnly: false,
    };
  }

  const mcmod = entries.get('mcmod.info');
  if (mcmod) {
    try {
      const j = JSON.parse(mcmod);
      const m = (Array.isArray(j) ? j : j.modList || [])[0] || {};
      return {
        loader: 'forge',
        modId: m.modid,
        name: m.name || m.modid,
        version: m.version,
        description: m.description || '',
        authors: m.authorList || m.authors || [],
        clientOnly: m.clientSideOnly === true,
      };
    } catch {
      /* ignoré */
    }
  }
  return { version: manifestVersion || null, authors: [], clientOnly: false };
}

async function readMeta(file, stat) {
  const key = `${file}|${stat.size}|${stat.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  let meta;
  try {
    meta = parseModMeta(await readJarEntries(file, META_FILES));
  } catch {
    meta = { authors: [], clientOnly: false, unreadable: true };
  }
  cache.set(key, meta);
  return meta;
}

const modsDir = (server) => path.join(server.dir, 'mods');

function safeFile(server, fileName) {
  if (!FILE_RE.test(String(fileName || '')) || path.basename(fileName) !== fileName) {
    throw err('mod_invalid_name', {}, 400);
  }
  return path.join(modsDir(server), fileName);
}

function ensureStopped(server) {
  if (getInstance(server.id).proc) throw err('stop_before_mods', {}, 409);
}

export async function listMods(server) {
  const dir = modsDir(server);
  if (!fs.existsSync(dir)) return [];
  const files = (await fsp.readdir(dir)).filter((f) => FILE_RE.test(f));
  const mods = await Promise.all(
    files.map(async (fileName) => {
      const full = path.join(dir, fileName);
      const stat = await fsp.stat(full);
      const meta = await readMeta(full, stat);
      return { fileName, enabled: !fileName.toLowerCase().endsWith('.disabled'), size: stat.size, ...meta };
    }),
  );
  return mods.sort((a, b) => (a.name || a.fileName).localeCompare(b.name || b.fileName, undefined, { sensitivity: 'base' }));
}

export async function setModEnabled(server, fileName, enabled) {
  ensureStopped(server);
  const from = safeFile(server, fileName);
  if (!fs.existsSync(from)) throw err('mod_not_found', {}, 404);
  const base = fileName.replace(/\.disabled$/i, '');
  const target = enabled ? base : `${base}.disabled`;
  if (target === fileName) return fileName;
  await fsp.rename(from, path.join(modsDir(server), target));
  return target;
}

export async function deleteMod(server, fileName) {
  ensureStopped(server);
  const file = safeFile(server, fileName);
  if (!fs.existsSync(file)) throw err('mod_not_found', {}, 404);
  await fsp.rm(file);
}

export async function addMod(server, fileName, buffer) {
  ensureStopped(server);
  if (!/\.jar$/i.test(fileName)) throw err('mod_invalid_name', {}, 400);
  const file = safeFile(server, fileName);
  if (fs.existsSync(file) || fs.existsSync(file + '.disabled')) throw err('mod_exists', {}, 409);
  // Un jar est un zip : il commence par "PK"
  if (!buffer?.length || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw err('mod_not_jar', {}, 400);
  await fsp.mkdir(modsDir(server), { recursive: true });
  await fsp.writeFile(file, buffer);
  return fileName;
}
