// Client minimal de l'API CurseForge (https://docs.curseforge.com/rest-api/)
//
// Certaines clés API n'ont pas accès à toutes les routes (ex : /mods/search et /mods/{id}/files
// renvoient 403 alors que le reste fonctionne). Dans ce cas, le panel se rabat sur des routes
// autorisées : modpacks mis en avant, recherche par ID de projet, versions tirées de la fiche du modpack.
import { getSettings } from './store.js';
import { err } from './i18n.js';

const BASE = 'https://api.curseforge.com/v1';
const GAME_MINECRAFT = 432;
const CLASS_MODPACK = 4471;
const RESTRICTED = Symbol('restricted');

async function cf(pathAndQuery, { method = 'GET', body, allowRestricted = false } = {}) {
  const key = getSettings().curseforgeApiKey;
  if (!key) throw err('NO_API_KEY', {}, 400);
  const res = await fetch(BASE + pathAndQuery, {
    method,
    headers: { 'x-api-key': key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403) {
    if (allowRestricted) return RESTRICTED;
    throw err('API_KEY_REFUSED', {}, 400);
  }
  if (res.status === 404) throw err('cf_not_found', {}, 404);
  if (!res.ok) throw err('cf_http', { status: res.status, path: pathAndQuery });
  return (await res.json()).data;
}

const toPack = (m) => ({
  id: m.id,
  name: m.name,
  summary: m.summary,
  logo: m.logo?.thumbnailUrl,
  downloads: m.downloadCount,
  authors: m.authors?.map((a) => a.name).join(', '),
  url: m.links?.websiteUrl,
  gameVersions: [...new Set(m.latestFilesIndexes?.map((f) => f.gameVersion))].slice(0, 5),
});

/** Modpacks mis en avant / populaires / récemment mis à jour (route accessible à toutes les clés). */
async function featuredModpacks() {
  const data = await cf('/mods/featured', { method: 'POST', body: { gameId: GAME_MINECRAFT, excludedModIds: [], gameVersionTypeId: null } });
  const seen = new Map();
  for (const m of [...(data.featured || []), ...(data.popular || []), ...(data.recentlyUpdated || [])]) {
    if (m.classId === CLASS_MODPACK && !seen.has(m.id)) seen.set(m.id, m);
  }
  return [...seen.values()].sort((a, b) => b.downloadCount - a.downloadCount);
}

/** Extrait un ID de projet d'une saisie : "715572" ou une URL contenant ?projectId= / /projects/715572. */
function parseProjectId(query) {
  const q = String(query || '').trim();
  if (/^\d{3,9}$/.test(q)) return Number(q);
  const m = q.match(/(?:projectId=|\/projects\/)(\d{3,9})/i);
  return m ? Number(m[1]) : null;
}

/**
 * Recherche de modpacks. Renvoie { results, restricted } : `restricted` indique que la recherche
 * complète n'est pas autorisée pour cette clé (résultats = modpacks mis en avant filtrés).
 */
export async function searchModpacks(query, gameVersion) {
  const projectId = parseProjectId(query);
  if (projectId) {
    const mod = await cf(`/mods/${projectId}`);
    if (mod.classId !== CLASS_MODPACK) throw err('cf_not_modpack', {}, 400);
    return { results: [toPack(mod)], restricted: false };
  }

  const params = new URLSearchParams({
    gameId: GAME_MINECRAFT,
    classId: CLASS_MODPACK,
    searchFilter: query || '',
    sortField: '2', // popularité
    sortOrder: 'desc',
    pageSize: '30',
  });
  if (gameVersion) params.set('gameVersion', gameVersion);
  const mods = await cf(`/mods/search?${params}`, { allowRestricted: true });
  if (mods !== RESTRICTED) return { results: mods.map(toPack), restricted: false };

  // Recherche non autorisée : filtrage local des modpacks mis en avant
  const q = String(query || '').trim().toLowerCase();
  const packs = (await featuredModpacks()).filter(
    (m) =>
      (!q || m.name.toLowerCase().includes(q) || m.slug?.includes(q.replace(/\s+/g, '-'))) &&
      (!gameVersion || m.latestFilesIndexes?.some((f) => f.gameVersion === gameVersion)),
  );
  return { results: packs.map(toPack), restricted: true };
}

const toFile = (f) => ({
  id: f.id,
  name: f.displayName,
  date: f.fileDate,
  gameVersions: f.gameVersions,
  hasServerPack: Boolean(f.serverPackFileId),
  releaseType: f.releaseType, // 1 release, 2 beta, 3 alpha
});

export async function getModpackFiles(modId) {
  let files = await cf(`/mods/${modId}/files?pageSize=50`, { allowRestricted: true });
  if (files === RESTRICTED) {
    // Liste complète non autorisée : on reconstruit à partir des dernières versions de la fiche
    const mod = await cf(`/mods/${modId}`);
    const ids = [...new Set([...(mod.latestFiles || []).map((f) => f.id), ...(mod.latestFilesIndexes || []).map((f) => f.fileId)])];
    files = ids.length ? await cf('/mods/files', { method: 'POST', body: { fileIds: ids } }) : [];
  }
  return files
    .filter((f) => !f.isServerPack)
    .sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate))
    .map(toFile);
}

export const getMod = (modId) => cf(`/mods/${modId}`);
export const getFile = (modId, fileId) => cf(`/mods/${modId}/files/${fileId}`);
export const getFiles = (fileIds) => cf('/mods/files', { method: 'POST', body: { fileIds } });
export const getMods = (modIds) => cf('/mods', { method: 'POST', body: { modIds } });
