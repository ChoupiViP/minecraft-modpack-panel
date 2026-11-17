import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as botlink from '../src/botlink.js';

test('clé du bot : générée une fois, vérifiée en temps constant, régénérable', () => {
  const secret = botlink.ensureSecret();
  assert.ok(secret.length >= 32);
  assert.equal(botlink.ensureSecret(), secret, 'la clé ne doit pas changer à chaque appel');
  assert.equal(botlink.isBotToken(`Bearer ${secret}`), true);
  assert.equal(botlink.isBotToken(`Bearer ${secret}x`), false);
  assert.equal(botlink.isBotToken(`Basic ${secret}`), false);
  assert.equal(botlink.isBotToken(''), false);
  const next = botlink.regenerateSecret();
  assert.notEqual(next, secret);
  assert.equal(botlink.isBotToken(`Bearer ${secret}`), false);
});

test('la clé du bot ne donne accès qu’aux routes nécessaires', () => {
  const allowed = [
    ['GET', '/api/servers'],
    ['GET', '/api/servers/atm9-1a2b3c'],
    ['POST', '/api/servers/atm9-1a2b3c/start'],
    ['POST', '/api/servers/atm9-1a2b3c/command'],
    ['GET', '/api/bot-config'],
    ['PUT', '/api/bot-config'],
    ['GET', '/ws'],
  ];
  const denied = [
    ['GET', '/api/settings'],
    ['PUT', '/api/settings'],
    ['GET', '/api/bot'],
    ['POST', '/api/bot/secret'],
    ['DELETE', '/api/servers/atm9-1a2b3c'],
    ['PATCH', '/api/servers/atm9-1a2b3c'],
    ['POST', '/api/servers/atm9-1a2b3c/kill'],
    ['GET', '/api/servers/atm9-1a2b3c/files/content'],
    ['POST', '/api/servers/atm9-1a2b3c/mods'],
    ['GET', '/api/servers/atm9-1a2b3c/backups'],
    ['POST', '/api/servers'],
    ['GET', '/index.html'],
  ];
  for (const [m, p] of allowed) assert.equal(botlink.botRouteAllowed(m, p), true, `${m} ${p} devrait être autorisé`);
  for (const [m, p] of denied) assert.equal(botlink.botRouteAllowed(m, p), false, `${m} ${p} devrait être refusé`);
});

test('configuration du bot : validation et fusion', () => {
  const ID = '123456789012345678';
  const clean = botlink.sanitizeBotConfig(
    {
      language: 'de',
      guildId: ID,
      adminRoleIds: [ID, ID, ''],
      statusInterval: 2,
      serverAddress: '  play.example.com  ',
      chatChannels: { 'srv-1': ID, 'supprime-9': ID, 'srv-2': '' },
      inconnu: 'ignoré',
    },
    ['srv-1', 'srv-2'],
  );
  assert.deepEqual(clean, {
    language: 'fr',
    guildId: ID,
    adminRoleIds: [ID],
    statusInterval: 15,
    serverAddress: 'play.example.com',
    chatChannels: { 'srv-1': ID },
  });
  assert.throws(() => botlink.sanitizeBotConfig({ statusChannelId: 'abc' }), (e) => e.code === 'bot_config_invalid' && e.status === 400);
  assert.throws(() => botlink.sanitizeBotConfig({ chatChannels: [] }), (e) => e.code === 'bot_config_invalid');

  botlink.updateBotConfig({ guildId: ID, statusChannelId: ID });
  const saved = botlink.updateBotConfig({ statusMessageId: ID });
  assert.equal(saved.guildId, ID, 'une mise à jour partielle garde les autres valeurs');
  assert.equal(saved.statusMessageId, ID);
  assert.deepEqual(botlink.getBotConfig(), saved);
});

test('adresses : tunnel Cloudflare et validation', async () => {
  const line = '2026-11-17T20:00:00Z INF |  https://quiet-river-1234.trycloudflare.com                                      |';
  assert.equal(line.match(botlink.TUNNEL_URL_RE)[0], 'https://quiet-river-1234.trycloudflare.com');
  await botlink.updateLink({ url: 'https://mon-bot.onrender.com/' }, 8080);
  assert.equal(botlink.linkSettings().url, 'https://mon-bot.onrender.com');
  await assert.rejects(botlink.updateLink({ url: 'ftp://x' }, 8080), (e) => e.code === 'bot_url_invalid');
  delete process.env.PANEL_PASSWORD;
  await assert.rejects(botlink.updateLink({ tunnel: true }, 8080), (e) => e.code === 'tunnel_needs_password');
  botlink.stopBotLink();
});
