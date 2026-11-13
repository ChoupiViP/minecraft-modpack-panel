import { tempDir } from './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as files from '../src/files.js';
import { analyzeCrash } from '../src/crashes.js';

function makeServer() {
  const dir = tempDir('files-');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'mod.toml'), 'enabled = true\n');
  fs.writeFileSync(path.join(dir, 'world.dat'), Buffer.from([1, 0, 2, 0]));
  return { id: 'files-test', dir };
}

test('liste un dossier (dossiers en premier) et lit / écrit un fichier texte', async () => {
  const server = makeServer();
  const root = await files.listDir(server, '');
  assert.equal(root.items[0].name, 'config');
  assert.equal(root.items[0].dir, true);

  const file = await files.readText(server, 'config/mod.toml');
  assert.equal(file.content, 'enabled = true\n');
  await files.writeText(server, 'config/mod.toml', 'enabled = false\n');
  assert.equal(fs.readFileSync(path.join(server.dir, 'config', 'mod.toml'), 'utf8'), 'enabled = false\n');
});

test('refuse les fichiers binaires dans l’éditeur', async () => {
  await assert.rejects(files.readText(makeServer(), 'world.dat'), (e) => e.code === 'file_binary');
});

test('refuse toute sortie du dossier du serveur', async () => {
  const server = makeServer();
  // Un chemin commençant par "/" est relatif à la racine du serveur : il ne doit jamais en sortir
  const rooted = await files.resolveInside(server, '/etc/passwd');
  assert.ok(rooted.full.startsWith(fs.realpathSync(server.dir) + path.sep), '/etc/passwd doit rester dans le dossier du serveur');
  for (const bad of ['../secret.txt', 'config/../../secret.txt', '..\\secret.txt', 'C:\\Windows\\win.ini', 'C:/Windows']) {
    await assert.rejects(files.readText(server, bad), (e) => e.code === 'path_invalid', `${bad} devrait être refusé`);
    await assert.rejects(files.writeText(server, bad, 'x'), (e) => e.code === 'path_invalid', `${bad} devrait être refusé en écriture`);
  }
  await assert.rejects(files.deletePath(server, ''), (e) => e.code === 'path_invalid', 'la racine ne doit pas pouvoir être supprimée');
  await assert.rejects(files.uploadFile(server, '', '../evil.jar', Buffer.from('x')), (e) => e.code === 'path_invalid');
});

test('envoi de fichier, création de dossier et suppression', async () => {
  const server = makeServer();
  await files.makeDir(server, 'kubejs/scripts');
  await files.uploadFile(server, 'kubejs/scripts', 'main.js', Buffer.from('console.log(1)'));
  assert.equal((await files.readText(server, 'kubejs/scripts/main.js')).content, 'console.log(1)');
  await files.deletePath(server, 'kubejs');
  assert.equal(fs.existsSync(path.join(server.dir, 'kubejs')), false);
});

test('analyse d’un crash report Forge (mods suspects)', () => {
  const report = `---- Minecraft Crash Report ----
// Why did you do that?

Time: 2026-11-13 19:00:00
Description: Ticking entity

java.lang.NullPointerException: Cannot invoke "Object.toString()" because "x" is null
	at com.example.badmod.Entity.tick(Entity.java:42)
	at net.minecraft.world.level.Level.tick(Level.java:1)

-- Head --
Thread: Server thread
Suspected Mods:
	Bad Mod (badmod), Version: 1.2.3
		Issue tracker URL: https://example.com
	Other Mod (othermod), Version: 2.0
Stacktrace:
	at com.example.badmod.Entity.tick(Entity.java:42)`;
  const r = analyzeCrash(report);
  assert.equal(r.description, 'Ticking entity');
  assert.match(r.exception, /^java\.lang\.NullPointerException/);
  assert.deepEqual(r.suspects, ['Bad Mod (badmod)', 'Other Mod (othermod)']);
});

test('analyse : dépendances manquantes et erreurs de mixin', () => {
  const forge = `Description: Mod loading error has occurred

Missing or unsupported mandatory dependencies:
	Mod ID: 'geckolib', Requested by: 'alexsmobs', Expected range: '[4.2,)', Actual version: '[MISSING]'`;
  assert.deepEqual(analyzeCrash(forge).missingDeps, ['geckolib ← alexsmobs']);

  const mixin = 'Description: Exception in server tick loop\n\norg.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: An unexpected critical error was encountered\nMixin apply for mod sodiumextra failed';
  assert.deepEqual(analyzeCrash(mixin).suspects, ['sodiumextra']);

  // Format réel de Forge 1.20.1 (relevé sur un vrai crash : GeckoLib désactivé)
  const forge120 = `Description: Mod loading error has occurred
	Failure message: Mod dmzcharacterslots requires geckolib 4 or above
		Currently, geckolib is not installed
	Failure message: Mod dragonminez requires geckolib 4.8.3 or above
		Currently, geckolib is not installed`;
  assert.deepEqual(analyzeCrash(forge120).missingDeps, ['geckolib ← dmzcharacterslots, dragonminez']);

  const fabric = "Description: Incompatible mods found!\n\nMod 'Create Fabric' (create) 0.5.1 requires version 0.92.0 or later of mod 'Fabric API' (fabric-api), but only the wrong version is present: 0.90.0!";
  assert.equal(analyzeCrash(fabric).missingDeps.length, 1);
});
