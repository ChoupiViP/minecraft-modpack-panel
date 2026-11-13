// Installation d'un modpack CurseForge + du mod loader (Forge / NeoForge / Fabric).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as cf from './curseforge.js';
import { TMP_DIR, updateServer } from './store.js';
import { ensureJavaFor } from './java.js';
import { t, err } from './i18n.js';
import { download, extractZip, moveMerge, runProcess, pool, setProperties } from './util.js';

/** Détermine comment lancer le serveur présent dans `dir`. */
export function detectLaunch(dir) {
  const argsFile = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  // Forge >= 1.17 et NeoForge : fichier d'arguments dans libraries/
  for (const [type, base] of [
    ['neoforge', 'libraries/net/neoforged/neoforge'],
    ['neoforge', 'libraries/net/neoforged/forge'],
    ['forge', 'libraries/net/minecraftforge/forge'],
  ]) {
    const p = path.join(dir, base);
    if (!fs.existsSync(p)) continue;
    const versions = fs.readdirSync(p).filter((v) => fs.existsSync(path.join(p, v, argsFile)));
    if (versions.length) {
      versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return { type, args: ['@' + [base, versions.at(-1), argsFile].join('/')] };
    }
  }
  if (!fs.existsSync(dir)) return null;
  const jars = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar') && !/installer/i.test(f));
  const pick = (re) => jars.find((f) => re.test(f));
  const fabric = pick(/^fabric-server-launch(er)?\.jar$/i) || pick(/^fabric-server.*\.jar$/i);
  if (fabric) return { type: 'fabric', args: ['-jar', fabric] };
  const quilt = pick(/^quilt-server-launch(er)?\.jar$/i);
  if (quilt) return { type: 'quilt', args: ['-jar', quilt] };
  const forge = pick(/^(neo)?forge-.*\.jar$/i) || pick(/^minecraftforge.*\.jar$/i);
  if (forge) return { type: /^neo/i.test(forge) ? 'neoforge' : 'forge', args: ['-jar', forge] };
  const vanilla = pick(/^server\.jar$/i) || pick(/^minecraft_server.*\.jar$/i);
  if (vanilla) return { type: 'vanilla', args: ['-jar', vanilla] };
  return null;
}

function findInstaller(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).find((f) => /^(neo)?forge-.*installer\.jar$/i.test(f)) || null;
}

/** Installe le mod loader à partir d'un identifiant de manifest CurseForge ("forge-47.2.0", "fabric-0.15.11"...). */
export async function installLoader(dir, mc, loaderId, javaPath, log) {
  const [kind, ...rest] = loaderId.split('-');
  const ver = rest.join('-');
  log(t('loader_installing', { kind, version: ver, mc }));

  if (kind === 'fabric') {
    const installers = await (await fetch('https://meta.fabricmc.net/v2/versions/installer')).json();
    const installer = (installers.find((i) => i.stable) || installers[0]).version;
    const url = `https://meta.fabricmc.net/v2/versions/loader/${mc}/${ver}/${installer}/server/jar`;
    await download(url, path.join(dir, 'fabric-server-launch.jar'));
    log(t('fabric_installed'));
    return;
  }

  let url;
  if (kind === 'forge') {
    url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${ver}/forge-${mc}-${ver}-installer.jar`;
  } else if (kind === 'neoforge') {
    url = ver.startsWith('1.20.1')
      ? `https://maven.neoforged.net/releases/net/neoforged/forge/${ver}/forge-${ver}-installer.jar`
      : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`;
  } else {
    throw err('loader_unsupported', { loader: loaderId });
  }
  const installer = path.join(dir, `${kind}-installer.jar`);
  await download(url, installer);
  await runInstaller(dir, path.basename(installer), javaPath, log);
}

/**
 * Les Forge 1.16.5 antérieurs à 36.2.26 plantent au démarrage avec les Java récents
 * (8u321+, 11.0.14+ : NoSuchMethodError ManifestEntryVerifier). On les remplace par la
 * version de Forge 1.16.5 recommandée, compatible avec les mêmes mods.
 */
const FIXED_FORGE_1165 = [36, 2, 26];
const FALLBACK_FORGE_1165 = '36.2.34';

export function isBrokenForge1165(jarName) {
  const m = String(jarName).match(/^forge-1\.16\.5-(\d+)\.(\d+)\.(\d+)\.jar$/i);
  if (!m) return false;
  const v = m.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== FIXED_FORGE_1165[i]) return v[i] < FIXED_FORGE_1165[i];
  return false;
}

async function upgradeBrokenForge(dir, launch, javaPath, log) {
  const jar = launch.type === 'forge' && launch.args[0] === '-jar' ? launch.args[1] : null;
  if (!jar || !isBrokenForge1165(jar)) return launch;
  let target = FALLBACK_FORGE_1165;
  try {
    const promos = (await (await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).json()).promos;
    target = promos['1.16.5-recommended'] || target;
  } catch {
    /* hors ligne : version de repli */
  }
  log(t('forge_upgrade', { from: jar.replace(/^forge-1\.16\.5-|\.jar$/gi, ''), to: target }));
  await fsp.rm(path.join(dir, jar), { force: true });
  await installLoader(dir, '1.16.5', `forge-${target}`, javaPath, log);
  return detectLaunch(dir) || launch;
}

async function runInstaller(dir, jar, javaPath, log) {
  log(t('installer_running', { jar }));
  await runProcess(javaPath, ['-jar', jar, '--installServer'], { cwd: dir, log: (l) => log('  ' + l) });
  await fsp.rm(path.join(dir, jar), { force: true });
}

async function downloadMods(files, dir, log) {
  const wanted = files.filter((f) => f.required !== false);
  const infos = [];
  for (let i = 0; i < wanted.length; i += 500) {
    infos.push(...(await cf.getFiles(wanted.slice(i, i + 500).map((f) => f.fileID))));
  }
  const byId = new Map(infos.map((f) => [f.id, f]));
  const modsDir = path.join(dir, 'mods');
  await fsp.mkdir(modsDir, { recursive: true });

  const missing = [];
  let done = 0;
  log(t('mods_downloading', { count: wanted.length }));
  await pool(wanted, 6, async (f) => {
    const info = byId.get(f.fileID);
    if (!info?.downloadUrl) {
      missing.push({ modId: f.projectID, fileId: f.fileID, fileName: info?.fileName || null });
      return;
    }
    if (!info.fileName.toLowerCase().endsWith('.jar')) return; // resource packs / shaders : inutiles côté serveur
    const dest = path.join(modsDir, info.fileName);
    if (!fs.existsSync(dest)) {
      try {
        await download(info.downloadUrl, dest);
      } catch (e) {
        missing.push({ modId: f.projectID, fileId: f.fileID, fileName: info.fileName, error: e.message });
        return;
      }
    }
    done++;
    if (done % 10 === 0 || done === wanted.length) log(`  ${done}/${wanted.length}`);
  });

  if (missing.length) {
    const mods = await cf.getMods([...new Set(missing.map((m) => m.modId))]).catch(() => []);
    const byMod = new Map(mods.map((m) => [m.id, m]));
    for (const m of missing) {
      const mod = byMod.get(m.modId);
      m.name = mod?.name || `Projet ${m.modId}`;
      m.url = mod?.links?.websiteUrl ? `${mod.links.websiteUrl}/files/${m.fileId}` : null;
      log(t('mod_not_downloadable', { name: m.name, file: m.fileName ? `(${m.fileName})` : '' }));
    }
  }
  return missing;
}

/**
 * Installe le modpack d'un serveur. Préfère le "server pack" officiel ; sinon reconstruit
 * le serveur depuis le pack client (overrides + mods + loader).
 */
export async function installPack(server, log) {
  const { modId, fileId } = server.pack;
  const dir = server.dir;
  const tmp = path.join(TMP_DIR, server.id);
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  const progress = (label) => (pct) => log(`  ${label} ${pct}%`);

  try {
    const file = await cf.getFile(modId, fileId);
    log(t('modpack_name', { name: file.displayName }));

    // Java adapté à la version de Minecraft (téléchargé automatiquement si absent)
    const mcGuess = file.gameVersions.find((v) => /^\d+\.\d+(\.\d+)?$/.test(v));
    try {
      const javaPath = await ensureJavaFor(mcGuess, log);
      if (javaPath && javaPath !== server.javaPath) {
        server.javaPath = javaPath;
        updateServer(server.id, { javaPath });
        log(t('java_used', { path: javaPath }));
      }
    } catch (e) {
      log(t('java_auto_failed', { error: e.message }));
    }
    let usedServerPack = false;
    let missingMods = [];

    if (file.serverPackFileId) {
      const sp = await cf.getFile(modId, file.serverPackFileId);
      if (sp.downloadUrl) {
        log(t('serverpack_downloading', { file: sp.fileName }));
        const zip = path.join(tmp, 'serverpack.zip');
        await download(sp.downloadUrl, zip, { onProgress: progress('server pack') });
        log(t('extracting'));
        await extractZip(zip, dir, { stripSingleRoot: true, tmpDir: tmp });
        usedServerPack = true;
      } else {
        log(t('serverpack_not_api'));
      }
    } else {
      log(t('no_serverpack'));
    }

    let manifest = null;
    if (!usedServerPack || (!detectLaunch(dir) && !findInstaller(dir))) {
      if (!file.downloadUrl) throw err('pack_no_api');
      log(t('client_downloading', { file: file.fileName }));
      const zip = path.join(tmp, 'client.zip');
      await download(file.downloadUrl, zip, { onProgress: progress('pack client') });
      const clientDir = path.join(tmp, 'client');
      await extractZip(zip, clientDir);
      manifest = JSON.parse(await fsp.readFile(path.join(clientDir, 'manifest.json'), 'utf8'));
      if (!usedServerPack) {
        const overrides = path.join(clientDir, manifest.overrides || 'overrides');
        if (fs.existsSync(overrides)) await moveMerge(overrides, dir);
        missingMods = await downloadMods(manifest.files || [], dir, log);
        log(t('client_only_hint'));
      }
    }

    const mcVersion = manifest?.minecraft?.version || file.gameVersions.find((v) => /^\d+\.\d+(\.\d+)?$/.test(v)) || null;
    const loaders = manifest?.minecraft?.modLoaders || [];
    const loaderId = (loaders.find((l) => l.primary) || loaders[0])?.id || null;

    let launch = detectLaunch(dir);
    if (!launch) {
      const inst = findInstaller(dir);
      if (inst) await runInstaller(dir, inst, server.javaPath, log);
      else if (loaderId && mcVersion) await installLoader(dir, mcVersion, loaderId, server.javaPath, log);
      launch = detectLaunch(dir);
    }
    if (!launch) throw err('launch_unknown');
    launch = await upgradeBrokenForge(dir, launch, server.javaPath, log);

    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
    setProperties(path.join(dir, 'server.properties'), {
      'server-port': server.port,
      motd: server.name.replace(/[\r\n]/g, ' '),
    });

    log(t('install_done', { loader: loaderId || launch.type, mc: mcVersion || '?' }));
    return { mcVersion, loader: loaderId || launch.type, missingMods };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
