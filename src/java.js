// Détection et téléchargement automatique de Java (Eclipse Temurin via l'API Adoptium).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { DATA_DIR, TMP_DIR } from './store.js';
import { download, extractZip, moveMerge, runProcess } from './util.js';
import { t, err } from './i18n.js';

export const JAVA_DIR = path.join(DATA_DIR, 'java');
export const javaEvents = new EventEmitter();
const EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const jobs = new Map(); // version -> Promise

/** Version de Java recommandée pour une version de Minecraft. */
export function recommendedJava(mc) {
  if (!mc) return null;
  const [, minor = 0, patch = 0] = mc.split('.').map(Number);
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 17) return 17;
  return 8;
}

/** Chemin de l'exécutable Java géré par le panel pour une version donnée (ou null). */
export function managedJavaPath(version) {
  const base = path.join(JAVA_DIR, String(version));
  for (const p of [path.join(base, 'bin', EXE), path.join(base, 'Contents', 'Home', 'bin', EXE)]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function javaVersion(javaPath) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try {
      proc = spawn(javaPath, ['-version'], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    proc.stderr.on('data', (d) => (out += d));
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const m = out.match(/version "([^"]+)"/);
      if (!m) return resolve(null);
      const v = m[1].startsWith('1.') ? Number(m[1].split('.')[1]) : parseInt(m[1], 10);
      resolve(v || null);
    });
  });
}

let cache = null;
let cacheTime = 0;

/** Liste les Java disponibles : gérés par le panel + installations système courantes. */
export async function findJavaInstalls({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheTime < 60_000) return cache;
  const candidates = new Map(); // path -> managed?
  if (fs.existsSync(JAVA_DIR)) {
    for (const v of fs.readdirSync(JAVA_DIR)) {
      const p = managedJavaPath(v);
      if (p) candidates.set(p, true);
    }
  }
  candidates.set('java', false);
  const roots = [];
  if (process.platform === 'win32') {
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru']) {
        roots.push(path.join(pf, vendor));
      }
    }
  } else {
    roots.push('/usr/lib/jvm', '/Library/Java/JavaVirtualMachines');
  }
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = await fsp.readdir(root);
    } catch {
      continue;
    }
    for (const d of dirs) {
      for (const p of [path.join(root, d, 'bin', EXE), path.join(root, d, 'Contents', 'Home', 'bin', EXE)]) {
        if (fs.existsSync(p) && !candidates.has(p)) candidates.set(p, false);
      }
    }
  }
  const results = [];
  await Promise.all(
    [...candidates].map(async ([p, managed]) => {
      const version = await javaVersion(p);
      if (version) results.push({ path: p, version, managed });
    }),
  );
  results.sort((a, b) => b.version - a.version || Number(b.managed) - Number(a.managed));
  cache = results;
  cacheTime = Date.now();
  return results;
}

/** Trouve un Java de la version exacte demandée parmi ceux installés. */
export async function findJava(version) {
  const managed = managedJavaPath(version);
  if (managed) return managed;
  return (await findJavaInstalls()).find((j) => j.version === version)?.path || null;
}

function adoptiumTarget() {
  const os = { win32: 'windows', linux: 'linux', darwin: 'mac' }[process.platform];
  const arch = { x64: 'x64', arm64: 'aarch64' }[process.arch];
  if (!os || !arch) throw err('java_platform', { platform: `${process.platform}/${process.arch}` });
  return { os, arch };
}

/** Télécharge et installe Temurin (JRE) dans data/java/<version>. Un seul téléchargement par version à la fois. */
export function installJava(version, log = () => {}) {
  version = Number(version);
  if (![8, 11, 17, 21, 25].includes(version)) throw err('java_version_unsupported', { version }, 400);
  const existing = managedJavaPath(version);
  if (existing) return Promise.resolve(existing);
  if (jobs.has(version)) return jobs.get(version);

  const emit = (status, extra = {}) => javaEvents.emit('progress', { version, status, ...extra });
  const job = (async () => {
    const { os, arch } = adoptiumTarget();
    emit('downloading', { pct: 0 });
    log(t('java_searching', { version }));
    const url = `https://api.adoptium.net/v3/assets/latest/${version}/hotspot?architecture=${arch}&image_type=jre&os=${os}&vendor=eclipse`;
    const res = await fetch(url);
    if (!res.ok) throw err('adoptium_http', { status: res.status });
    const pkg = (await res.json())[0]?.binary?.package;
    if (!pkg?.link) throw err('java_none_for', { version, platform: `${os}/${arch}` });

    const work = path.join(TMP_DIR, `java-${version}-${Date.now()}`);
    await fsp.mkdir(work, { recursive: true });
    try {
      const archive = path.join(work, pkg.name);
      log(t('java_downloading', { name: pkg.name, size: (pkg.size / 1048576).toFixed(0) }));
      await download(pkg.link, archive, {
        onProgress: (pct) => {
          emit('downloading', { pct });
          log(`  Java ${version} : ${pct}%`);
        },
      });
      const sum = crypto.createHash('sha256').update(await fsp.readFile(archive)).digest('hex');
      if (pkg.checksum && sum !== pkg.checksum) throw err('java_checksum');

      emit('extracting');
      log(t('java_extracting'));
      const dest = path.join(JAVA_DIR, String(version));
      await fsp.rm(dest, { recursive: true, force: true });
      if (pkg.name.endsWith('.zip')) {
        await extractZip(archive, dest, { stripSingleRoot: true, tmpDir: work });
      } else {
        const out = path.join(work, 'out');
        await fsp.mkdir(out);
        await runProcess('tar', ['-xzf', archive, '-C', out], { cwd: work });
        const entries = await fsp.readdir(out);
        await moveMerge(entries.length === 1 ? path.join(out, entries[0]) : out, dest);
      }
      const javaPath = managedJavaPath(version);
      if (!javaPath) throw err('java_no_exe');
      cache = null;
      log(t('java_installed', { version, path: javaPath }));
      emit('done', { path: javaPath });
      return javaPath;
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  })();

  jobs.set(version, job);
  job.catch((e) => emit('error', { error: e.message })).finally(() => jobs.delete(version));
  return job;
}

export function javaJobs() {
  return [...jobs.keys()];
}

/**
 * S'assure qu'un Java adapté à `mcVersion` est disponible ; le télécharge sinon.
 * Retourne le chemin à utiliser, ou null si aucune recommandation.
 */
export async function ensureJavaFor(mcVersion, log) {
  const rec = recommendedJava(mcVersion);
  if (!rec) return null;
  const found = await findJava(rec);
  if (found) return found;
  log(t('java_required', { version: rec, mc: mcVersion }));
  return installJava(rec, log);
}
