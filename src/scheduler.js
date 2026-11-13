// Tâches planifiées par serveur : redémarrage (avec annonces aux joueurs), démarrage, arrêt, sauvegarde, commande.
import crypto from 'node:crypto';
import { listServers, getServer } from './store.js';
import * as pm from './process-manager.js';
import { createBackup } from './backups.js';
import { t, err } from './i18n.js';

export const TASK_TYPES = ['restart', 'start', 'stop', 'backup', 'command'];
const WARN_MINUTES = [5, 1]; // annonces avant un redémarrage / arrêt
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Valide et normalise la liste de tâches envoyée par l'interface. */
export function normalizeSchedules(list) {
  if (!Array.isArray(list) || list.length > 50) throw err('sched_invalid', {}, 400);
  return list.map((s) => {
    if (!TASK_TYPES.includes(s?.type) || !TIME_RE.test(String(s.time))) throw err('sched_invalid', {}, 400);
    const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number))].filter((d) => d >= 0 && d <= 6).sort();
    const command = s.type === 'command' ? String(s.command || '').replace(/[\r\n]+/g, ' ').trim().replace(/^\//, '').slice(0, 500) : '';
    if (s.type === 'command' && !command) throw err('sched_invalid', {}, 400);
    return {
      id: /^[a-f0-9]{8}$/.test(s.id) ? s.id : crypto.randomBytes(4).toString('hex'),
      type: s.type,
      time: s.time,
      days, // vide = tous les jours ; 0 = dimanche … 6 = samedi
      command,
      warn: s.type === 'restart' || s.type === 'stop' ? s.warn !== false : false,
      enabled: s.enabled !== false,
    };
  });
}

function matches(schedule, date) {
  const [h, m] = schedule.time.split(':').map(Number);
  if (date.getHours() !== h || date.getMinutes() !== m) return false;
  return schedule.days.length === 0 || schedule.days.includes(date.getDay());
}

/**
 * Indique ce qu'une tâche doit faire à la minute `date` :
 * 'run', 'warn:<minutes>' (annonce préalable) ou null.
 */
export function dueAction(schedule, date) {
  if (!schedule.enabled) return null;
  if (matches(schedule, date)) return 'run';
  if (schedule.warn) {
    for (const min of WARN_MINUTES) {
      if (matches(schedule, new Date(date.getTime() + min * 60_000))) return `warn:${min}`;
    }
  }
  return null;
}

/** Prochaine exécution d'une tâche après `from` (pour l'affichage). */
export function nextRun(schedule, from = new Date()) {
  if (!schedule.enabled) return null;
  const d = new Date(from);
  d.setSeconds(0, 0);
  for (let i = 1; i <= 8 * 24 * 60; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (matches(schedule, d)) return d.toISOString();
  }
  return null;
}

async function execute(server, schedule, action) {
  const inst = pm.getInstance(server.id);
  const running = inst.status === 'running' && inst.proc;

  if (action.startsWith('warn:')) {
    if (running) {
      const n = Number(action.split(':')[1]);
      pm.sendCommand(server.id, `say ${t(schedule.type === 'stop' ? 'sched_warn_stop' : 'sched_warn_restart', { n })}`);
    }
    return;
  }

  const label = t(`sched_type_${schedule.type}`);
  const skip = () => inst.log(t('sched_skipped', { task: label }));
  switch (schedule.type) {
    case 'restart':
      if (!running) return skip();
      inst.log(t('sched_ran', { task: label }));
      if (schedule.warn) pm.sendCommand(server.id, `say ${t('sched_now_restart')}`);
      await pm.restart(getServer(server.id));
      break;
    case 'stop':
      if (!inst.proc) return skip();
      inst.log(t('sched_ran', { task: label }));
      if (schedule.warn && running) pm.sendCommand(server.id, `say ${t('sched_now_stop')}`);
      await pm.stop(server.id);
      break;
    case 'start':
      if (inst.proc || pm.isBusy(server.id) || !server.installed) return skip();
      inst.log(t('sched_ran', { task: label }));
      pm.start(getServer(server.id));
      break;
    case 'backup':
      inst.log(t('sched_ran', { task: label }));
      await createBackup(server, { auto: true });
      break;
    case 'command':
      if (!running) return skip();
      inst.log(t('sched_ran', { task: `${label} : ${schedule.command}` }));
      inst.log(`> ${schedule.command}`);
      pm.sendCommand(server.id, schedule.command);
      break;
  }
}

const fired = new Set(); // évite de lancer deux fois la même action dans la même minute

export function startScheduler() {
  setInterval(() => {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    for (const key of fired) if (Number(key.split('|')[0]) < minute - 2) fired.delete(key);

    for (const { id } of listServers()) {
      const server = getServer(id);
      for (const schedule of server?.schedules || []) {
        const action = dueAction(schedule, now);
        if (!action) continue;
        const key = `${minute}|${id}|${schedule.id}|${action}`;
        if (fired.has(key)) continue;
        fired.add(key);
        execute(server, schedule, action).catch((e) => pm.getInstance(id).log(t('sched_failed', { error: e.message })));
      }
    }
  }, 15_000).unref();
}
