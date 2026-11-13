import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTps, tpsCommand } from '../src/stats.js';
import { recommendedJava } from '../src/java.js';

test('TPS : sortie de "forge tps"', () => {
  const r = parseTps([
    '[12:00:00] [Server thread/INFO]: Dim minecraft:overworld (minecraft:overworld): Mean tick time: 3.210 ms. Mean TPS: 20.000',
    '[12:00:00] [Server thread/INFO]: Overall: Mean tick time: 61.500 ms. Mean TPS: 16.260',
  ]);
  assert.deepEqual(r, { mspt: 61.5, tps: 16.26 });
});

test('TPS : sortie de "neoforge tps"', () => {
  assert.deepEqual(parseTps(['[12:00:00] [Server thread/INFO]: Overall: 18.500 TPS (54.054 ms/tick)']), { tps: 18.5, mspt: 54.054 });
});

test('TPS : sortie vanilla de "tick query" (plafonnée à la cible)', () => {
  const slow = parseTps(['The game is running normally', 'Target tick rate: 20.0 per second.', 'Average time per tick: 80.0ms (Target: 50.0ms)']);
  assert.equal(slow.mspt, 80);
  assert.equal(slow.tps, 12.5);
  const fast = parseTps(['Target tick rate: 20.0 per second.', 'Average time per tick: 2.0ms (Target: 50.0ms)']);
  assert.equal(fast.tps, 20);
});

test('TPS : virgule décimale et sortie inconnue', () => {
  assert.equal(parseTps(['Overall: Mean tick time: 2,5 ms. Mean TPS: 19,8']).tps, 19.8);
  assert.equal(parseTps(['Unknown or incomplete command']), null);
});

test('commande TPS selon le loader et la version', () => {
  assert.equal(tpsCommand({ loader: 'forge-47.2.0', mcVersion: '1.20.1' }), 'forge tps');
  assert.equal(tpsCommand({ loader: 'neoforge-21.1.77', mcVersion: '1.21.1' }), 'neoforge tps');
  assert.equal(tpsCommand({ loader: 'neoforge-47.1.100', mcVersion: '1.20.1' }), 'forge tps');
  assert.equal(tpsCommand({ loader: 'fabric-0.16.9', mcVersion: '1.21.1' }), 'tick query');
  assert.equal(tpsCommand({ loader: 'fabric-0.16.9', mcVersion: '1.20.1' }), null);
});

test('version de Java recommandée', () => {
  assert.equal(recommendedJava('1.12.2'), 8);
  assert.equal(recommendedJava('1.16.5'), 8);
  assert.equal(recommendedJava('1.13.2'), 8);
  assert.equal(recommendedJava('1.7.10'), 8);
  assert.equal(recommendedJava('1.17.1'), 17);
  assert.equal(recommendedJava('1.20.4'), 17);
  assert.equal(recommendedJava('1.20.5'), 21);
  assert.equal(recommendedJava('1.21.1'), 21);
  assert.equal(recommendedJava(null), null);
});
