// Gestion des joueurs : en ligne, opérateurs, whitelist, bannis, joueurs connus.
import fs from 'node:fs';
import path from 'node:path';
import { getInstance, sendCommand } from './process-manager.js';
import { readProperties } from './util.js';
import { err } from './i18n.js';

const NAME_RE = /^\.?[A-Za-z0-9_]{1,16}$/;

function readList(server, file) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(server.dir, file), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function getPlayers(server) {
  const inst = getInstance(server.id);
  const props = readProperties(path.join(server.dir, 'server.properties'));
  const ops = readList(server, 'ops.json').map((p) => ({ name: p.name, uuid: p.uuid, level: p.level }));
  const whitelist = readList(server, 'whitelist.json').map((p) => ({ name: p.name, uuid: p.uuid }));
  const banned = readList(server, 'banned-players.json').map((p) => ({
    name: p.name,
    uuid: p.uuid,
    reason: p.reason,
    created: p.created,
    source: p.source,
  }));
  const known = readList(server, 'usercache.json')
    .map((p) => ({ name: p.name, uuid: p.uuid, lastSeen: p.expiresOn }))
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  return {
    running: Boolean(inst.proc),
    online: [...inst.players],
    maxPlayers: Number(props['max-players']) || 20,
    whitelistEnabled: props['white-list'] === 'true',
    onlineMode: props['online-mode'] !== 'false',
    ops,
    whitelist,
    banned,
    known,
  };
}

const ACTIONS = {
  op: (p) => `op ${p}`,
  deop: (p) => `deop ${p}`,
  kick: (p, r) => `kick ${p}${r ? ' ' + r : ''}`,
  ban: (p, r) => `ban ${p}${r ? ' ' + r : ''}`,
  pardon: (p) => `pardon ${p}`,
  'whitelist-add': (p) => `whitelist add ${p}`,
  'whitelist-remove': (p) => `whitelist remove ${p}`,
  'whitelist-on': () => 'whitelist on',
  'whitelist-off': () => 'whitelist off',
  'gamemode-survival': (p) => `gamemode survival ${p}`,
  'gamemode-creative': (p) => `gamemode creative ${p}`,
  'gamemode-spectator': (p) => `gamemode spectator ${p}`,
};

export function playerAction(server, { action, player, reason }) {
  const build = ACTIONS[action];
  if (!build) throw err('unknown_action', {}, 400);
  const needsPlayer = !action.startsWith('whitelist-o');
  if (needsPlayer && !NAME_RE.test(String(player || ''))) {
    throw err('invalid_name', {}, 400);
  }
  if (!getInstance(server.id).proc) {
    throw err('must_run_players', {}, 409);
  }
  const cleanReason = String(reason || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const command = build(player, cleanReason);
  getInstance(server.id).log(`> ${command}`);
  sendCommand(server.id, command);
  return command;
}
