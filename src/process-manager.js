// Gestion des processus Java des serveurs : démarrage, arrêt, console, joueurs, redémarrage auto.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { detectLaunch } from './installer.js';
import { getServer } from './store.js';
import { lineSplitter } from './util.js';
import { t, err } from './i18n.js';

export const events = new EventEmitter();
events.setMaxListeners(100);

const MAX_LOG_LINES = 2000;
const BUSY = new Set(['installing', 'starting', 'running', 'stopping', 'restoring']);

class Instance {
  constructor(id) {
    this.id = id;
    this.status = 'stopped';
    this.logs = [];
    this.proc = null;
    this.players = new Set();
    this.startedAt = null;
    this.stopRequested = false;
    this.crashTimes = [];
    this.lineWaiters = [];
    this.silentQueries = [];
    this.stats = []; // échantillons de performance (dernière heure)
    this.lagEvents = [];
    this.tps = null;
    this.mspt = null;
    this.tpsUnsupported = false;
  }

  log(line) {
    this.logs.push(line);
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    events.emit('log', { id: this.id, line });
    for (const w of [...this.lineWaiters]) {
      if (w.re.test(line)) {
        this.lineWaiters.splice(this.lineWaiters.indexOf(w), 1);
        w.resolve(line);
      }
    }
  }

  setStatus(status) {
    this.status = status;
    events.emit('status', this.summary());
  }

  summary() {
    return {
      id: this.id,
      status: this.status,
      players: [...this.players],
      startedAt: this.startedAt,
      pid: this.proc?.pid ?? null,
      stats: this.stats.at(-1) || null,
    };
  }

  /** Attend qu'une ligne de log corresponde à `re`. */
  waitForLine(re, timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = { re, resolve };
      this.lineWaiters.push(w);
      setTimeout(() => {
        const i = this.lineWaiters.indexOf(w);
        if (i >= 0) {
          this.lineWaiters.splice(i, 1);
          reject(new Error('timeout'));
        }
      }, timeoutMs);
    });
  }
}

const instances = new Map();

export function getInstance(id) {
  if (!instances.has(id)) instances.set(id, new Instance(id));
  return instances.get(id);
}

export function allInstances() {
  return [...instances.values()];
}

export function isBusy(id) {
  return BUSY.has(getInstance(id).status);
}

export function start(server) {
  const inst = getInstance(server.id);
  if (inst.proc || BUSY.has(inst.status)) throw err('already_busy', { status: inst.status }, 409);
  if (!server.installed) throw err('not_installed', {}, 409);
  const launch = detectLaunch(server.dir);
  if (!launch) throw err('launch_not_found');

  const ram = Math.max(512, Number(server.ramMB) || 4096);
  const args = [
    `-Xms${Math.min(1024, ram)}M`,
    `-Xmx${ram}M`,
    ...String(server.jvmArgs || '').split(/\s+/).filter(Boolean),
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    ...launch.args,
    'nogui',
  ];

  inst.logs = [];
  inst.players.clear();
  inst.stopRequested = false;
  inst.stats = [];
  inst.lagEvents = [];
  inst.tps = null;
  inst.mspt = null;
  inst.tpsUnsupported = false;
  inst.log(`> ${server.javaPath} ${args.join(' ')}`);
  inst.setStatus('starting');

  const proc = spawn(server.javaPath, args, { cwd: server.dir, windowsHide: true });
  inst.proc = proc;
  inst.startedAt = Date.now();

  const onLine = (line) => handleLine(inst, line);
  proc.stdout.on('data', lineSplitter(onLine));
  proc.stderr.on('data', lineSplitter(onLine));

  proc.on('error', (e) => {
    inst.log(t('launch_error', { error: e.message }));
    inst.proc = null;
    inst.setStatus('crashed');
  });

  proc.on('exit', (code) => {
    inst.proc = null;
    inst.players.clear();
    inst.log(t('process_exited', { code }));
    if (inst.stopRequested) {
      inst.setStatus('stopped');
      return;
    }
    inst.setStatus('crashed');
    maybeAutoRestart(inst);
  });
}

function handleLine(inst, line) {
  // Réponses aux requêtes silencieuses (ex : TPS) : capturées sans polluer la console
  for (const q of inst.silentQueries) {
    if (q.re.test(line)) {
      q.lines.push(line);
      return;
    }
  }
  inst.log(line);
  const lag = line.match(/Can't keep up!.*?Running (\d+)ms/);
  if (lag) {
    const now = Date.now();
    inst.lagEvents = inst.lagEvents.filter((e) => now - e.t < 3_600_000);
    inst.lagEvents.push({ t: now, ms: Number(lag[1]) });
  }
  if (inst.status === 'starting' && /Done \([\d.,]+s\)!/.test(line)) {
    inst.setStatus('running');
  }
  let m;
  if ((m = line.match(/: (\.?[A-Za-z0-9_]{2,16}) joined the game/))) {
    inst.players.add(m[1]);
    events.emit('status', inst.summary());
  } else if ((m = line.match(/: (\.?[A-Za-z0-9_]{2,16}) left the game/))) {
    inst.players.delete(m[1]);
    events.emit('status', inst.summary());
  }
}

function maybeAutoRestart(inst) {
  const server = getServer(inst.id);
  if (!server?.autoRestart) return;
  const now = Date.now();
  inst.crashTimes = inst.crashTimes.filter((t) => now - t < 10 * 60_000);
  inst.crashTimes.push(now);
  if (inst.crashTimes.length > 3) {
    inst.log(t('too_many_crashes'));
    return;
  }
  inst.log(t('crash_restart'));
  setTimeout(() => {
    const s = getServer(inst.id);
    if (s && inst.status === 'crashed') {
      try {
        start(s);
      } catch (e) {
        inst.log(t('restart_failed', { error: e.message }));
      }
    }
  }, 10_000);
}

export function sendCommand(id, command) {
  const inst = getInstance(id);
  if (!inst.proc) throw err('not_running', {}, 409);
  inst.proc.stdin.write(command.replace(/[\r\n]+/g, ' ') + '\n');
}

/**
 * Envoie une commande et capture pendant `ms` les lignes de réponse correspondant à `re`,
 * sans les afficher dans la console.
 */
export function querySilently(id, command, re, ms = 2500) {
  const inst = getInstance(id);
  if (!inst.proc) return Promise.resolve([]);
  return new Promise((resolve) => {
    const q = { re, lines: [] };
    inst.silentQueries.push(q);
    try {
      inst.proc.stdin.write(command + '\n');
    } catch {
      /* processus en cours d'arrêt */
    }
    setTimeout(() => {
      inst.silentQueries.splice(inst.silentQueries.indexOf(q), 1);
      resolve(q.lines);
    }, ms);
  });
}

/** Arrêt propre via la commande "stop", puis kill si le serveur ne répond pas. */
export function stop(id, timeoutMs = 120_000) {
  const inst = getInstance(id);
  if (!inst.proc) {
    if (inst.status === 'crashed') inst.setStatus('stopped');
    return Promise.resolve();
  }
  const proc = inst.proc;
  inst.stopRequested = true;
  inst.setStatus('stopping');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      inst.log(t('not_responding'));
      proc.kill('SIGKILL');
    }, timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.stdin.write('stop\n');
    } catch {
      proc.kill('SIGKILL');
    }
  });
}

export function kill(id) {
  const inst = getInstance(id);
  if (!inst.proc) return;
  inst.stopRequested = true;
  inst.proc.kill('SIGKILL');
}

export async function restart(server) {
  await stop(server.id);
  start(server);
}

export async function stopAll() {
  await Promise.all([...instances.values()].filter((i) => i.proc).map((i) => stop(i.id, 60_000)));
}
