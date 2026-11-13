import { tempDir } from './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detectLaunch } from '../src/installer.js';
import { readProperties, setProperties } from '../src/util.js';

const touch = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
};
const argsFile = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';

test('détection du lancement : Forge moderne (fichier args)', () => {
  const dir = tempDir();
  touch(path.join(dir, 'libraries/net/minecraftforge/forge/1.20.1-47.2.0', argsFile));
  touch(path.join(dir, 'forge-1.20.1-47.2.0-installer.jar'));
  assert.deepEqual(detectLaunch(dir), { type: 'forge', args: [`@libraries/net/minecraftforge/forge/1.20.1-47.2.0/${argsFile}`] });
});

test('détection du lancement : NeoForge prend la version la plus récente', () => {
  const dir = tempDir();
  touch(path.join(dir, 'libraries/net/neoforged/neoforge/21.1.9', argsFile));
  touch(path.join(dir, 'libraries/net/neoforged/neoforge/21.1.77', argsFile));
  assert.equal(detectLaunch(dir).args[0], `@libraries/net/neoforged/neoforge/21.1.77/${argsFile}`);
});

test('détection du lancement : Fabric, ancien Forge, vanilla, rien', () => {
  const fabric = tempDir();
  touch(path.join(fabric, 'fabric-server-launch.jar'));
  touch(path.join(fabric, 'server.jar'));
  assert.deepEqual(detectLaunch(fabric), { type: 'fabric', args: ['-jar', 'fabric-server-launch.jar'] });

  const oldForge = tempDir();
  touch(path.join(oldForge, 'forge-1.12.2-14.23.5.2860.jar'));
  touch(path.join(oldForge, 'forge-1.12.2-14.23.5.2860-installer.jar'));
  assert.deepEqual(detectLaunch(oldForge), { type: 'forge', args: ['-jar', 'forge-1.12.2-14.23.5.2860.jar'] });

  const vanilla = tempDir();
  touch(path.join(vanilla, 'server.jar'));
  assert.equal(detectLaunch(vanilla).type, 'vanilla');

  assert.equal(detectLaunch(tempDir()), null);
});

test('server.properties : modification en conservant commentaires et ordre', () => {
  const file = path.join(tempDir(), 'server.properties');
  fs.writeFileSync(file, '#Minecraft server properties\nmotd=Ancien\nserver-port=25565\npvp=true\n');
  setProperties(file, { 'server-port': 25570, motd: 'Nouveau', 'white-list': true });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^#Minecraft server properties\nmotd=Nouveau\nserver-port=25570\npvp=true\nwhite-list=true\n$/);
  assert.deepEqual(readProperties(file), { motd: 'Nouveau', 'server-port': '25570', pvp: 'true', 'white-list': 'true' });
});

test('Forge 1.16.5 : détection des versions qui plantent avec les Java récents', async () => {
  const { isBrokenForge1165 } = await import('../src/installer.js');
  assert.equal(isBrokenForge1165('forge-1.16.5-36.2.20.jar'), true);
  assert.equal(isBrokenForge1165('forge-1.16.5-36.1.0.jar'), true);
  assert.equal(isBrokenForge1165('forge-1.16.5-36.2.26.jar'), false);
  assert.equal(isBrokenForge1165('forge-1.16.5-36.2.39.jar'), false);
  assert.equal(isBrokenForge1165('forge-1.12.2-14.23.5.2860.jar'), false);
});
