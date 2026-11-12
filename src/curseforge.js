// Client minimal de l'API CurseForge (https://docs.curseforge.com/rest-api/)
import { getSettings } from './store.js';
import { err } from './i18n.js';

const BASE = 'https://api.curseforge.com/v1';
const GAME_MINECRAFT = 432;
const CLASS_MODPACK = 4471;

async function cf(pathAndQuery, { method = 'GET', body } = {}) {
  const key = getSettings().curseforgeApiKey;
  if (!key) throw err('NO_API_KEY', {}, 400);
  const res = await fetch(BASE + pathAndQuery, {
    method,
    headers: { 'x-api-key': key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403) throw err('API_KEY_REFUSED', {}, 400);
  if (!res.ok) throw err('cf_http', { status: res.status, path: pathAndQuery });
  return (await res.json()).data;
}

export async function searchModpacks(query, gameVersion) {
  const params = new URLSearchParams({
    gameId: GAME_MINECRAFT,
    classId: CLASS_MODPACK,
    searchFilter: query || '',
    sortField: '2', // popularité
    sortOrder: 'desc',
    pageSize: '30',
  });
  if (gameVersion) params.set('gameVersion', gameVersion);
  const mods = await cf(`/mods/search?${params}`);
  return mods.map((m) => ({
    id: m.id,
    name: m.name,
    summary: m.summary,
    logo: m.logo?.thumbnailUrl,
    downloads: m.downloadCount,
    authors: m.authors?.map((a) => a.name).join(', '),
    url: m.links?.websiteUrl,
    gameVersions: [...new Set(m.latestFilesIndexes?.map((f) => f.gameVersion))].slice(0, 5),
  }));
}

export async function getModpackFiles(modId) {
  const files = await cf(`/mods/${modId}/files?pageSize=50`);
  return files
    .filter((f) => !f.isServerPack)
    .sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate))
    .map((f) => ({
      id: f.id,
      name: f.displayName,
      date: f.fileDate,
      gameVersions: f.gameVersions,
      hasServerPack: Boolean(f.serverPackFileId),
      releaseType: f.releaseType, // 1 release, 2 beta, 3 alpha
    }));
}

export const getMod = (modId) => cf(`/mods/${modId}`);
export const getFile = (modId, fileId) => cf(`/mods/${modId}/files/${fileId}`);
export const getFiles = (fileIds) => cf('/mods/files', { method: 'POST', body: { fileIds } });
export const getMods = (modIds) => cf('/mods', { method: 'POST', body: { modIds } });
