// Mesure des performances : CPU / RAM du processus Java (toutes les 5 s) et TPS (toutes les 30 s).
import os from 'node:os';
import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { allInstances, querySilently } from './process-manager.js';
import { getServer } from './store.js';
import { lineSplitter } from './util.js';

export const statsEvents = new EventEmitter();
const SAMPLE_MS = 5_000;
const TPS_MS = 30_000;
const HISTORY = 720; // 1 heure à 5 s
const CORES = os.cpus().length;

// ---------- CPU / RAM par processus ----------
const prev = new Map(); // pid -> { cpuMs, t }

function runningInstances() {
  return allInstances().filter((i) => i.proc?.pid && ['starting', 'running', 'stopping'].includes(i.status));
}

function onSnapshot(snapshot, t) {
  for (const inst of runningInstances()) {
    const pid = inst.proc.pid;
    const cur = snapshot.get(pid);
    if (!cur) continue;
    const p = prev.get(pid);
    prev.set(pid, { cpuMs: cur.cpuMs, t });
    if (!p) continue; // il faut deux mesures pour un pourcentage
    const cpu = Math.max(0, Math.min(100, ((cur.cpuMs - p.cpuMs) / ((t - p.t) * CORES)) * 100));
    const sample = {
      t,
      cpu: Math.round(cpu * 10) / 10,
      ram: Math.round(cur.rss / 1048576),
      tps: inst.tps,
      mspt: inst.mspt,
      players: inst.players.size,
      sysFree: Math.round(os.freemem() / 1048576),
    };
    inst.stats.push(sample);
    if (inst.stats.length > HISTORY) inst.stats.splice(0, inst.stats.length - HISTORY);
    statsEvents.emit('sample', { id: inst.id, sample });
  }
  for (const pid of prev.keys()) if (!snapshot.has(pid)) prev.delete(pid);
}

// Windows : un seul PowerShell longue durée qui liste les processus java toutes les 5 s
// (bien moins coûteux que de lancer une commande à chaque mesure).
let psProc = null;
function startWindowsSampler() {
  const script =
    "while($true){ Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'java*' } | " +
    "ForEach-Object { '{0} {1} {2}' -f $_.Id, [int64]$_.TotalProcessorTime.TotalMilliseconds, $_.WorkingSet64 }; '---'; Start-Sleep -Seconds 5 }";
  psProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  let batch = new Map();
  psProc.stdout.on('data', lineSplitter((line) => {
    if (line.trim() === '---') {
      onSnapshot(batch, Date.now());
      batch = new Map();
      return;
    }
    const [pid, cpuMs, rss] = line.trim().split(/\s+/).map(Number);
    if (pid) batch.set(pid, { cpuMs, rss });
  }));
  psProc.on('error', () => (psProc = null));
  psProc.on('exit', () => (psProc = null));
}

// Linux : /proc ; macOS : ps
function sampleUnix() {
  const pids = runningInstances().map((i) => i.proc.pid);
  if (!pids.length) return;
  const t = Date.now();
  if (process.platform === 'linux') {
    const snap = new Map();
    for (const pid of pids) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const cpuMs = ((Number(f[11]) + Number(f[12])) / 100) * 1000; // utime + stime (CLK_TCK = 100)
        const rss = Number(f[21]) * 4096;
        snap.set(pid, { cpuMs, rss });
      } catch {
        /* processus terminé */
      }
    }
    onSnapshot(snap, t);
  } else {
    execFile('ps', ['-o', 'pid=,time=,rss=', '-p', pids.join(',')], (err, out) => {
      if (err) return;
      const snap = new Map();
      for (const line of out.trim().split('\n')) {
        const [pid, time, rssKb] = line.trim().split(/\s+/);
        const parts = time.split(':').map(Number);
        const secs = parts.reduce((acc, v) => acc * 60 + v, 0);
        snap.set(Number(pid), { cpuMs: secs * 1000, rss: Number(rssKb) * 1024 });
      }
      onSnapshot(snap, Date.now());
    });
  }
}

// ---------- TPS ----------
const SILENT_RE =
  /Mean tick time|Mean TPS|\bTPS \(|ms\/tick|The game is (running normally|frozen|sprinting)|Target tick rate|Average time per tick|Percentiles|Unknown or incomplete command|Incorrect argument for command|<--\[HERE\]/i;

// Dernière ligne de chaque format de réponse (fin de la capture)
const END_RE = /Overall|Percentiles|Unknown or incomplete command|Incorrect argument for command|<--\[HERE\]/i;

function mcAtLeast(mc, target) {
  if (!mc) return false;
  const a = mc.split('.').map(Number);
  const b = target.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

/** Commande donnant le TPS selon le loader (null si aucune commande intégrée). */
export function tpsCommand(server) {
  const loader = String(server.loader || '').toLowerCase();
  if (loader.startsWith('neoforge') && server.mcVersion !== '1.20.1') return 'neoforge tps';
  if (loader.startsWith('forge') || loader.startsWith('neoforge')) return 'forge tps';
  if (mcAtLeast(server.mcVersion, '1.20.3')) return 'tick query';
  return null;
}

const num = (s) => Number(String(s).replace(',', '.'));

export function parseTps(lines) {
  const text = lines.join('\n');
  let m = text.match(/Overall\s*:?\s*Mean tick time:\s*([\d.,]+)\s*ms\.?\s*Mean TPS:\s*([\d.,]+)/i);
  if (m) return { mspt: num(m[1]), tps: num(m[2]) };
  m = text.match(/Overall\s*:?\s*([\d.,]+)\s*TPS\s*\(([\d.,]+)\s*ms/i);
  if (m) return { tps: num(m[1]), mspt: num(m[2]) };
  m = text.match(/Average time per tick:\s*([\d.,]+)\s*ms/i);
  if (m) {
    const target = num(text.match(/Target tick rate:\s*([\d.,]+)/i)?.[1] || 20);
    const mspt = num(m[1]);
    return { mspt, tps: Math.min(target, 1000 / Math.max(mspt, 0.001)) };
  }
  return null;
}

async function pollTps() {
  for (const inst of runningInstances()) {
    if (inst.status !== 'running' || inst.tpsUnsupported || inst.backupInProgress) continue;
    const server = getServer(inst.id);
    const cmd = server && tpsCommand(server);
    if (!cmd) {
      inst.tpsUnsupported = true;
      continue;
    }
    const lines = await querySilently(inst.id, cmd, SILENT_RE, { endRe: END_RE });
    const r = parseTps(lines);
    if (r) {
      inst.tps = Math.round(r.tps * 10) / 10;
      inst.mspt = Math.round(r.mspt * 10) / 10;
    } else if (lines.some((l) => /Unknown or incomplete command|Incorrect argument/i.test(l))) {
      inst.tpsUnsupported = true;
    }
  }
}

// ---------- Démarrage ----------
export function startStats() {
  setInterval(() => {
    const anyRunning = runningInstances().length > 0;
    if (process.platform === 'win32') {
      if (anyRunning && !psProc) startWindowsSampler();
      if (!anyRunning && psProc) {
        psProc.kill();
        psProc = null;
      }
    } else if (anyRunning) {
      sampleUnix();
    }
  }, SAMPLE_MS).unref();
  setInterval(() => pollTps().catch(() => {}), TPS_MS).unref();
}

export function stopStats() {
  psProc?.kill();
}

export function systemInfo() {
  return {
    cores: CORES,
    totalMem: Math.round(os.totalmem() / 1048576),
    freeMem: Math.round(os.freemem() / 1048576),
  };
}
