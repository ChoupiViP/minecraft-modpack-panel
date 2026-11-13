// Lecture et analyse des crash reports Minecraft (dossier crash-reports/).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_READ = 512 * 1024; // le résumé ne lit que le début du rapport

/**
 * Extrait les informations utiles d'un crash report : description, exception
 * et mods probablement responsables (Forge, NeoForge, Fabric, erreurs de mixin / dépendances).
 */
export function analyzeCrash(text) {
  const lines = text.split(/\r?\n/);
  const descIdx = lines.findIndex((l) => /^Description:/.test(l));
  const description = descIdx >= 0 ? lines[descIdx].replace(/^Description:\s*/, '').trim() : null;
  let exception = null;
  if (descIdx >= 0) {
    exception = lines.slice(descIdx + 1).find((l) => l.trim() && !/^\s*at\s/.test(l))?.trim() || null;
  }

  const suspects = new Set();
  // Forge / NeoForge : "Suspected Mod(s):" / "Suspected Mods:" suivi d'une liste
  const suspIdx = lines.findIndex((l) => /^\s*Suspected Mods?(\(s\))?:/i.test(l));
  if (suspIdx >= 0) {
    const inline = lines[suspIdx].replace(/^\s*Suspected Mods?(\(s\))?:\s*/i, '').trim();
    const block = inline && !/^none$/i.test(inline) ? [inline] : [];
    for (const l of lines.slice(suspIdx + 1)) {
      if (!l.trim() || /^\S/.test(l)) break;
      block.push(l.trim());
    }
    for (const entry of block) {
      const name = entry.match(/^(.+?)\s*\(([\w.-]+)\)/);
      if (name && !/^none$/i.test(entry)) suspects.add(`${name[1].trim()} (${name[2]})`);
      else if (/^[\w .-]+$/.test(entry) && !/^none$/i.test(entry)) suspects.add(entry);
    }
  }
  // Erreurs de mixin : "Mixin apply for mod xxx failed"
  for (const m of text.matchAll(/Mixin apply(?:ing)? for mod ([\w.-]+) failed/gi)) suspects.add(m[1]);
  for (const m of text.matchAll(/mixins?\.json:[\w.$]+ from mod ([\w.-]+)/gi)) suspects.add(m[1]);

  // Dépendances manquantes ou incompatibles, regroupées par dépendance : dépendance → mods qui la demandent
  const deps = new Map();
  const addDep = (dep, by) => {
    if (!deps.has(dep)) deps.set(dep, new Set());
    deps.get(dep).add(by);
  };
  // Forge ancien format : "Mod ID: 'x', Requested by: 'y'"
  for (const m of text.matchAll(/Mod ID: '([\w.-]+)', Requested by: '([\w.-]+)'/g)) addDep(m[1], m[2]);
  // Forge / NeoForge 1.19+ : "Mod y requires x 1.2 or above" + "Currently, x is not installed"
  for (const m of text.matchAll(/Mod ([\w.-]+) requires ([\w.-]+)\b[^\n]*\n\s*Currently, \2 is ([^\n]+)/g)) addDep(m[2], m[1]);
  // Fabric : "Mod 'Nom' (y) 1.0 requires version 2.0 or later of mod 'Nom' (x)"
  for (const m of text.matchAll(/Mod '[^']+' \(([\w.-]+)\) [\w.+-]+ requires (?:any version|version [^ ]+)(?: or later)? of (?:mod )?'?([^',\n(]+?)'?(?: \(([\w.-]+)\))?[,!\n]/g)) {
    addDep(m[3] || m[2].trim(), m[1]);
  }
  const missing = [...deps].map(([dep, by]) => `${dep} ← ${[...by].slice(0, 4).join(', ')}${by.size > 4 ? '…' : ''}`);

  return {
    description,
    exception: exception?.slice(0, 300) || null,
    suspects: [...suspects].slice(0, 10),
    missingDeps: missing.slice(0, 10),
  };
}

export async function listCrashes(server) {
  const dir = path.join(server.dir, 'crash-reports');
  if (!fs.existsSync(dir)) return [];
  const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.txt'));
  const list = await Promise.all(
    names.map(async (name) => {
      const st = await fsp.stat(path.join(dir, name));
      return { name, date: st.mtime.toISOString(), size: st.size, path: `crash-reports/${name}` };
    }),
  );
  return list.sort((a, b) => b.date.localeCompare(a.date));
}

/** Dernier crash report (avec analyse), éventuellement seulement s'il est plus récent que `since`. */
export async function latestCrash(server, since = 0) {
  const [latest] = await listCrashes(server);
  if (!latest || new Date(latest.date).getTime() < since) return null;
  const fh = await fsp.open(path.join(server.dir, latest.path), 'r');
  try {
    const buf = Buffer.alloc(Math.min(latest.size, MAX_READ));
    await fh.read(buf, 0, buf.length, 0);
    return { ...latest, ...analyzeCrash(buf.toString('utf8')) };
  } finally {
    await fh.close();
  }
}
