import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchedules, dueAction, nextRun } from '../src/scheduler.js';

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0);

test('normalisation : valeurs par défaut et nettoyage', () => {
  const [s] = normalizeSchedules([{ type: 'restart', time: '04:00', days: [3, 1, 1, 9] }]);
  assert.match(s.id, /^[a-f0-9]{8}$/);
  assert.deepEqual(s.days, [1, 3]);
  assert.equal(s.warn, true);
  assert.equal(s.enabled, true);
  const [c] = normalizeSchedules([{ type: 'command', time: '12:30', command: '/say salut\nop moi' }]);
  assert.equal(c.command, 'say salut op moi');
  assert.equal(c.warn, false);
});

test('normalisation : refuse les tâches invalides', () => {
  assert.throws(() => normalizeSchedules([{ type: 'reboot', time: '04:00' }]));
  assert.throws(() => normalizeSchedules([{ type: 'restart', time: '25:00' }]));
  assert.throws(() => normalizeSchedules([{ type: 'command', time: '04:00', command: '  ' }]));
  assert.throws(() => normalizeSchedules('pas une liste'));
});

test('redémarrage : annonces à -5 et -1 min puis exécution', () => {
  const [s] = normalizeSchedules([{ type: 'restart', time: '04:00' }]);
  assert.equal(dueAction(s, at(2026, 11, 13, 3, 55)), 'warn:5');
  assert.equal(dueAction(s, at(2026, 11, 13, 3, 56)), null);
  assert.equal(dueAction(s, at(2026, 11, 13, 3, 59)), 'warn:1');
  assert.equal(dueAction(s, at(2026, 11, 13, 4, 0)), 'run');
  assert.equal(dueAction(s, at(2026, 11, 13, 4, 1)), null);
});

test("annonce la veille quand la tâche est juste après minuit", () => {
  const [s] = normalizeSchedules([{ type: 'restart', time: '00:02', days: [6] }]); // samedi
  // vendredi 13/11/2026 23:57 → samedi 00:02 dans 5 min
  assert.equal(dueAction(s, at(2026, 11, 13, 23, 57)), 'warn:5');
});

test('jours de la semaine, tâche désactivée, pas d’annonce pour une sauvegarde', () => {
  const [weekend] = normalizeSchedules([{ type: 'backup', time: '10:00', days: [0, 6] }]);
  assert.equal(dueAction(weekend, at(2026, 11, 14, 10, 0)), 'run'); // samedi
  assert.equal(dueAction(weekend, at(2026, 11, 16, 10, 0)), null); // lundi
  assert.equal(dueAction(weekend, at(2026, 11, 14, 9, 55)), null);
  const [off] = normalizeSchedules([{ type: 'restart', time: '10:00', enabled: false }]);
  assert.equal(dueAction(off, at(2026, 11, 14, 10, 0)), null);
});

test('prochaine exécution', () => {
  const [s] = normalizeSchedules([{ type: 'restart', time: '04:00', days: [1] }]); // lundi
  const next = new Date(nextRun(s, at(2026, 11, 13, 12, 0))); // vendredi
  assert.equal(next.getDay(), 1);
  assert.equal(next.getHours(), 4);
  assert.equal(next.getDate(), 16);
});
