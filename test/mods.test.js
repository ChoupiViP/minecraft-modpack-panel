import { tempDir } from './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { parseModMeta, listMods, setModEnabled, deleteMod, addMod } from '../src/mods.js';

/** Construit un faux .jar (zip) contenant les fichiers donnés. */
function makeJar(file, entries) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const zip = archiver('zip');
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    for (const [name, content] of Object.entries(entries)) zip.append(content, { name });
    zip.finalize();
  });
}

test('métadonnées Fabric (avec mod client uniquement)', () => {
  const meta = parseModMeta(
    new Map([['fabric.mod.json', JSON.stringify({ id: 'sodium', name: 'Sodium', version: '0.6.0', environment: 'client', authors: ['JellySquid', { name: 'IMS' }] })]]),
  );
  assert.equal(meta.loader, 'fabric');
  assert.equal(meta.name, 'Sodium');
  assert.equal(meta.version, '0.6.0');
  assert.equal(meta.clientOnly, true);
  assert.deepEqual(meta.authors, ['JellySquid', 'IMS']);
});

test('métadonnées Forge : version ${file.jarVersion} lue dans le MANIFEST', () => {
  const toml = `modLoader="javafml"
loaderVersion="[47,)"
license="MIT"
[[mods]]
modId="create"
version="\${file.jarVersion}"
displayName="Create"
description='''
Building tools
and machines
'''
[[dependencies.create]]
modId="forge"`;
  const meta = parseModMeta(
    new Map([
      ['META-INF/mods.toml', toml],
      ['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\r\nImplementation-Version: 0.5.1.f\r\n'],
    ]),
  );
  assert.equal(meta.loader, 'forge');
  assert.equal(meta.modId, 'create');
  assert.equal(meta.name, 'Create');
  assert.equal(meta.version, '0.5.1.f');
  assert.equal(meta.description, 'Building tools and machines');
});

test('métadonnées NeoForge et ancien mcmod.info', () => {
  const neo = parseModMeta(new Map([['META-INF/neoforge.mods.toml', '[[mods]]\nmodId="jei"\nversion="19.0.0"\ndisplayName="Just Enough Items"']]));
  assert.equal(neo.loader, 'neoforge');
  assert.equal(neo.name, 'Just Enough Items');
  const old = parseModMeta(new Map([['mcmod.info', JSON.stringify([{ modid: 'ic2', name: 'IndustrialCraft 2', version: '2.8' }])]]));
  assert.equal(old.name, 'IndustrialCraft 2');
  assert.equal(old.version, '2.8');
});

test('liste, désactive, réactive, ajoute et supprime des mods', async () => {
  const dir = tempDir('server-');
  const server = { id: 'test-mods', dir };
  fs.mkdirSync(path.join(dir, 'mods'));
  await makeJar(path.join(dir, 'mods', 'jei-1.0.jar'), {
    'META-INF/neoforge.mods.toml': '[[mods]]\nmodId="jei"\nversion="1.0"\ndisplayName="JEI"',
  });

  let mods = await listMods(server);
  assert.equal(mods.length, 1);
  assert.equal(mods[0].name, 'JEI');
  assert.equal(mods[0].enabled, true);

  assert.equal(await setModEnabled(server, 'jei-1.0.jar', false), 'jei-1.0.jar.disabled');
  mods = await listMods(server);
  assert.equal(mods[0].enabled, false);
  assert.equal(mods[0].name, 'JEI', 'les métadonnées restent lisibles quand le mod est désactivé');
  assert.equal(await setModEnabled(server, 'jei-1.0.jar.disabled', true), 'jei-1.0.jar');

  const jar = path.join(dir, 'upload.jar');
  await makeJar(jar, { 'fabric.mod.json': JSON.stringify({ id: 'lithium', name: 'Lithium', version: '0.14' }) });
  await addMod(server, 'lithium.jar', fs.readFileSync(jar));
  await assert.rejects(addMod(server, 'lithium.jar', fs.readFileSync(jar)), /existe déjà|already exists/);
  await assert.rejects(addMod(server, 'faux.jar', Buffer.from('pas un zip')));
  assert.equal((await listMods(server)).length, 2);

  await deleteMod(server, 'lithium.jar');
  assert.deepEqual((await listMods(server)).map((m) => m.fileName), ['jei-1.0.jar']);
});

test('refuse les noms de fichiers dangereux', async () => {
  const server = { id: 'test-mods-2', dir: tempDir('server-') };
  for (const name of ['../evil.jar', '..\\evil.jar', 'mods/x.jar', 'x.exe', 'C:x.jar']) {
    await assert.rejects(deleteMod(server, name), `${name} devrait être refusé`);
  }
});
