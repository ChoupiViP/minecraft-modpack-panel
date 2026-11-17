// Interface du panel (vanilla JS, sans build).
import { t, setLang, getLang, locale, browserLang, LANGS } from './i18n.js';

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');

const state = {
  servers: new Map(),
  view: null, // { name: 'server'|'new'|'settings'|'home', id?, tab? }
};

// ---------- Utilitaires ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtSize = (b) =>
  b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} ${t('units.gb')}` : b >= 1048576 ? `${(b / 1048576).toFixed(1)} ${t('units.mb')}` : `${Math.max(1, Math.round(b / 1024))} ${t('units.kb')}`;
const fmtRam = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} ${t('units.gb')}` : `${Math.round(mb)} ${t('units.mb')}`);
const fmtDate = (d) => new Date(d).toLocaleString(locale());
const fmtTime = (d, opts) => new Date(d).toLocaleTimeString(locale(), opts);
const fmtNum = (n) => Intl.NumberFormat(locale(), { notation: 'compact' }).format(n);
const statusLabel = (st) => t(`status.${st}`);
const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

async function api(path, { method = 'GET', body, text } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': text ? 'text/plain' : 'application/json' } : {},
    body: body === undefined ? undefined : text ? body : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(data?.error || data || `HTTP ${res.status}`), { code: data?.code });
  return data;
}

let toastTimer;
function toast(msg, error = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (error ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), error ? 6000 : 3000);
}

async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- Langue ----------
async function changeLang(l) {
  setLang(l);
  try {
    localStorage.setItem('lang', l);
  } catch {
    /* stockage indisponible */
  }
  // La langue du panel s'applique aussi aux messages du serveur (logs, erreurs)
  api('/settings', { method: 'PUT', body: { language: l } }).catch(() => {});
  renderChrome();
  renderSidebar();
  render();
}

// ---------- Navigation ----------
function navigate(view) {
  state.view = view;
  const hash = view.name === 'server' ? `#/server/${view.id}/${view.tab || 'console'}` : `#/${view.name}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  renderSidebar();
  render();
}

function viewFromHash() {
  const [, name, id, tab] = location.hash.split('/');
  if (name === 'server' && id) return { name, id, tab: tab || 'console' };
  if (name === 'new' || name === 'settings') return { name };
  return { name: 'home' };
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) navigate({ name: nav.dataset.nav });
});

// ---------- Barre latérale ----------
function renderChrome() {
  $('#nav-new').textContent = t('nav.new');
  $('#nav-settings').textContent = t('nav.settings');
  $('#lang-switch').innerHTML = Object.keys(LANGS)
    .map((l) => `<button class="lang-btn ${l === getLang() ? 'active' : ''}" data-lang="${l}" title="${esc(LANGS[l])}">${l.toUpperCase()}</button>`)
    .join('');
  $('#lang-switch').querySelectorAll('[data-lang]').forEach((b) =>
    b.addEventListener('click', () => b.dataset.lang !== getLang() && changeLang(b.dataset.lang)),
  );
}

function renderSidebar() {
  const list = $('#server-list');
  list.innerHTML = [...state.servers.values()]
    .map((s) => {
      const st = s.runtime.status;
      const active = state.view?.name === 'server' && state.view.id === s.id ? ' active' : '';
      const players = st === 'running' ? `<span class="muted small">${s.runtime.players.length}👤</span>` : '';
      return `<a class="server-item${active}" data-id="${esc(s.id)}" title="${esc(statusLabel(st))}">
        <span class="dot st-${esc(st)}"></span><span class="name">${esc(s.name)}</span>${players}</a>`;
    })
    .join('') || `<div class="muted small" style="padding:8px">${t('nav.noServers')}</div>`;
  list.querySelectorAll('.server-item').forEach((el) =>
    el.addEventListener('click', () => navigate({ name: 'server', id: el.dataset.id, tab: 'console' })),
  );
}

async function refreshServers() {
  const list = await api('/servers');
  state.servers = new Map(list.map((s) => [s.id, s]));
  renderSidebar();
}

// ---------- Rendu principal ----------
function render() {
  const v = state.view;
  if (v.name === 'settings') return renderSettings();
  if (v.name === 'new') return renderNew();
  if (v.name === 'server' && state.servers.has(v.id)) return renderServer();
  main.innerHTML = `
    <h1>${t('home.title')}</h1>
    <p class="muted">${t('home.text')}</p>
    <div class="row" style="margin-top:20px">
      <button class="btn primary" data-nav="new">${t('nav.new')}</button>
      <button class="btn" data-nav="settings">${t('nav.settings')}</button>
    </div>`;
}

// ---------- Paramètres ----------
async function renderSettings() {
  main.innerHTML = `<h1>${t('settings.title')}</h1><p class="muted">${t('common.loading')}</p>`;
  const [settings, javas] = await Promise.all([api('/settings'), getJavas()]);
  if (state.view.name !== 'settings') return;
  const javaRow = (v) => {
    const have = javas.find((j) => j.version === v);
    return `<tr><td><b>Java ${v}</b></td><td class="muted small">${t('java.for' + v)}</td>
      <td style="text-align:right">${have ? `<span class="small">${t('java.installed')}${have.managed ? t('java.byPanel') : ''}</span>` : javaDownloadButton(v)}</td></tr>`;
  };
  main.innerHTML = `
    <h1>${t('settings.title')}</h1>
    <form class="form" id="settings-form" style="margin-top:20px">
      <label class="field"><span>${t('settings.language')}</span>
        <select name="language">${Object.entries(LANGS)
          .map(([k, label]) => `<option value="${k}" ${k === getLang() ? 'selected' : ''}>${esc(label)}</option>`)
          .join('')}</select>
      </label>
      <label class="field"><span>${t('settings.apiKey')}</span>
        <input name="curseforgeApiKey" value="${esc(settings.curseforgeApiKey)}" placeholder="$2a$10$..." autocomplete="off">
        <span class="small muted">${t('settings.apiKeyHelp', { link: link('https://console.curseforge.com/', 'console.curseforge.com') })}</span>
      </label>
      <label class="field"><span>${t('settings.defaultJava')}</span>
        ${javaSelect('defaultJavaPath', settings.defaultJavaPath, javas)}
      </label>
      <label class="field"><span>${t('settings.defaultRam')}</span>
        <input name="defaultRamMB" type="number" min="1024" step="512" value="${esc(settings.defaultRamMB)}">
      </label>
      <h2>${t('settings.discord')}</h2>
      <p class="muted small">${t('settings.discordHelp')}</p>
      <label class="field"><span>${t('settings.webhook')}</span>
        <input name="discordWebhook" value="${esc(settings.discordWebhook)}" placeholder="https://discord.com/api/webhooks/…" autocomplete="off">
      </label>
      <div class="field"><span class="small muted">${t('settings.events')}</span>
        ${Object.keys(settings.discordEvents)
          .map((k) => `<label class="check" style="margin:4px 0"><input type="checkbox" data-ev="${k}" ${settings.discordEvents[k] ? 'checked' : ''}> ${t('ev.' + k)}</label>`)
          .join('')}
      </div>
      <div class="row">
        <button class="btn primary">${t('common.save')}</button>
        <button type="button" class="btn" id="discord-test" ${settings.discordWebhook ? '' : 'disabled'}>${t('settings.test')}</button>
      </div>
    </form>
    <h2>${t('settings.autostart')}</h2>
    <div class="card form">
      <p class="muted small" style="margin-top:0">${settings.autostart.supported ? t('settings.autostartHelp') : t('settings.autostartUnsupported')}</p>
      ${settings.autostart.supported
        ? `<div class="row"><span>${settings.autostart.enabled ? t('settings.autostartOn') : t('settings.autostartOff')}</span><span class="spacer"></span>
          <button class="btn ${settings.autostart.enabled ? '' : 'primary'}" id="autostart-toggle">${settings.autostart.enabled ? t('settings.autostartDisable') : t('settings.autostartEnable')}</button></div>`
        : ''}
    </div>
    <h2>${t('bot.title')}</h2>
    <div class="card form" id="bot-card"><p class="muted">${t('common.loading')}</p></div>
    <h2>${t('java.title')}</h2>
    <p class="muted small">${t('java.help')}</p>
    <div class="card form"><table>${[21, 17, 8].map(javaRow).join('')}</table></div>`;
  renderBotCard();
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    body.discordEvents = Object.fromEntries([...e.target.querySelectorAll('[data-ev]')].map((c) => [c.dataset.ev, c.checked]));
    const ok = await act(() => api('/settings', { method: 'PUT', body }), t('settings.saved'));
    if (ok && body.language !== getLang()) changeLang(body.language);
    else if (ok) renderSettings();
  });
  $('#discord-test').addEventListener('click', () => act(() => api('/notify/test', { method: 'POST' }), t('settings.testSent')));
  $('#autostart-toggle')?.addEventListener('click', async () => {
    const ok = await act(() => api('/autostart', { method: 'POST', body: { enabled: !settings.autostart.enabled } }));
    if (ok) renderSettings();
  });
  bindJavaButtons(main);
}

// ---------- Bot Discord ----------
const BOT_REPO = 'https://github.com/ChoupiViP/minecraft-modpack-panel-bot';

async function renderBotCard(data) {
  const card = $('#bot-card');
  if (!card) return;
  const b = data || (await api('/bot').catch(() => null));
  if (!b || !$('#bot-card')) return;
  const ago = (ts) => (ts ? new Date(ts).toLocaleTimeString() : '');
  const tunnelLine = {
    off: t('bot.tunnelOff'),
    downloading: t('bot.tunnelDownloading'),
    starting: t('bot.tunnelStarting'),
    on: t('bot.tunnelOn', { url: link(b.tunnelState.url, b.tunnelState.url) }),
    error: `<span class="err">${t('bot.tunnelError', { error: esc(b.tunnelState.error) })}</span>`,
  }[b.tunnelState.status];
  let linkLine = b.url ? t('bot.linkPending') : t('bot.linkNone');
  if (b.link.ok === true) linkLine = `✔ ${t('bot.linkOk', { bot: esc(b.link.bot || '?'), time: ago(b.link.at) })}`;
  else if (b.link.ok === false) linkLine = `<span class="err">✖ ${t('bot.linkFailed', { error: esc(b.link.error), time: ago(b.link.at) })}</span>`;
  const warn = b.link.ok === true && b.link.error ? `<br><span class="err">${esc(b.link.error)}</span>` : '';
  card.innerHTML = `
    <p class="muted small" style="margin-top:0">${t('bot.help', { link: link(BOT_REPO, 'minecraft-modpack-panel-bot') })}</p>
    <form id="bot-form" class="form">
      <label class="field"><span>${t('bot.url')}</span>
        <input name="url" value="${esc(b.url)}" placeholder="https://mon-bot.onrender.com" autocomplete="off">
      </label>
      <div class="field"><span>${t('bot.secret')}</span>
        <div class="row"><input id="bot-secret" value="${esc(b.secret)}" readonly style="flex:1;font-family:monospace">
          <button type="button" class="btn" id="bot-copy">${t('bot.copy')}</button>
          <button type="button" class="btn" id="bot-regen">${t('bot.regenerate')}</button></div>
        <span class="small muted">${t('bot.secretHelp')}</span>
      </div>
      <label class="check"><input type="checkbox" name="tunnel" ${b.tunnel ? 'checked' : ''} ${b.hasPassword ? '' : 'disabled'}> ${t('bot.tunnel')}</label>
      <span class="small muted" style="display:block;margin-bottom:14px">${b.hasPassword ? t('bot.tunnelHelp') : `<span class="err">${t('bot.needPassword')}</span>`}</span>
      <label class="field"><span>${t('bot.publicUrl')}</span>
        <input name="publicUrl" value="${esc(b.publicUrl)}" placeholder="https://panel.mondomaine.fr" autocomplete="off">
        <span class="small muted">${t('bot.publicUrlHelp')}</span>
      </label>
      <p class="small" style="margin:0">🌐 ${tunnelLine}<br>🤖 ${linkLine}${warn}</p>
      <div class="row">
        <button class="btn primary">${t('common.save')}</button>
        <button type="button" class="btn" id="bot-ping" ${b.url ? '' : 'disabled'}>${t('bot.ping')}</button>
        ${b.url ? `<a class="btn" href="${esc(`${b.link.configUrl || b.url}/#key=${encodeURIComponent(b.secret)}`)}" target="_blank" rel="noopener noreferrer">${t('bot.openConfig')}</a>` : ''}
        <button type="button" class="btn ghost" id="bot-refresh">↻</button>
      </div>
    </form>`;
  $('#bot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { url: f.url.value, publicUrl: f.publicUrl.value };
    if (b.hasPassword) body.tunnel = f.tunnel.checked;
    let res;
    const ok = await act(async () => (res = await api('/bot', { method: 'PUT', body })), t('settings.saved'));
    if (ok) renderBotCard(res);
  });
  $('#bot-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(b.secret);
      toast(t('bot.copied'));
    } catch {
      $('#bot-secret').select();
    }
  });
  $('#bot-regen').addEventListener('click', async () => {
    if (!confirm(t('bot.regenerateConfirm'))) return;
    let res;
    if (await act(async () => (res = await api('/bot/secret', { method: 'POST' })))) renderBotCard(res);
  });
  $('#bot-ping').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = t('bot.pinging');
    const res = await api('/bot/ping', { method: 'POST' }).catch(() => null);
    renderBotCard(res || undefined);
  });
  $('#bot-refresh').addEventListener('click', () => renderBotCard());
}

// ---------- Java ----------
// Les chemins Windows ne sont pas sensibles à la casse (d: == D:)
const normPath = (p) => String(p).replace(/\//g, '\\').toLowerCase();
const samePath = (a, b) => normPath(a) === normPath(b);
const javaProgress = {}; // version -> { status, pct, error }

async function getJavas(fresh = false) {
  try {
    const r = await api('/java' + (fresh ? '?fresh=1' : ''));
    for (const v of r.downloading) javaProgress[v] ??= { status: 'downloading', pct: 0 };
    return r.installs;
  } catch {
    return [];
  }
}

function javaBusyText(v) {
  const p = javaProgress[v];
  if (p?.status === 'downloading') return t('java.downloading', { pct: p.pct ?? 0 });
  if (p?.status === 'extracting') return t('java.extracting');
  return null;
}

function javaDownloadButton(v, serverId = '') {
  const busy = javaBusyText(v);
  return `<button class="btn sm primary" data-java-install="${v}" data-server="${esc(serverId)}" ${busy ? 'disabled' : ''}>
    ${esc(busy || t('java.install', { v }))}</button>`;
}

function bindJavaButtons(root) {
  root.querySelectorAll('[data-java-install]').forEach((b) =>
    b.addEventListener('click', () => {
      const version = Number(b.dataset.javaInstall);
      javaProgress[version] = { status: 'downloading', pct: 0 };
      b.disabled = true;
      b.textContent = javaBusyText(version);
      act(() => api('/java/install', { method: 'POST', body: { version, serverId: b.dataset.server || undefined } }));
    }),
  );
}

function onJavaProgress(msg) {
  javaProgress[msg.version] = msg;
  document.querySelectorAll(`[data-java-install="${msg.version}"]`).forEach((b) => {
    const busy = javaBusyText(msg.version);
    b.textContent = busy || t('java.install', { v: msg.version });
    b.disabled = Boolean(busy);
  });
  if (msg.status === 'error') {
    delete javaProgress[msg.version];
    toast(t('java.failed', { error: msg.error }), true);
  }
  if (msg.status === 'done') {
    delete javaProgress[msg.version];
    toast(t('java.installedToast', { v: msg.version }));
    refreshServers().then(() => (state.view.name === 'server' && state.view.tab === 'perf' ? renderStatus() : render()));
  }
}

/** Avertit (avec bouton d'installation) si le Java du serveur ne correspond pas à sa version de Minecraft. */
async function checkJavaAlert(s) {
  const rec = s.recommendedJava;
  if (!rec || !$('#java-alert')) return;
  const javas = await getJavas();
  const box = $('#java-alert');
  const current = javas.find((j) => samePath(j.path, s.javaPath));
  if (!box || current?.version === rec) return;
  const available = javas.find((j) => j.version === rec);
  const currentHtml = current ? `Java ${current.version}` : `<code>${esc(s.javaPath)}</code> ${t('java.notFound')}`;
  box.innerHTML = `<div class="warn-box">${t('java.mismatch', { mc: esc(s.mcVersion), rec, current: currentHtml })}
    ${available ? `<button class="btn sm primary" id="use-java">${t('java.use', { v: rec })}</button>` : javaDownloadButton(rec, s.id)}</div>`;
  bindJavaButtons(box);
  $('#use-java')?.addEventListener('click', async () => {
    const updated = await act(() => api(`/servers/${s.id}`, { method: 'PATCH', body: { javaPath: available.path } }), t('java.selected', { v: rec }));
    if (updated) {
      state.servers.set(s.id, updated);
      box.innerHTML = '';
    }
  });
}

function javaSelect(name, current, javas) {
  const opts = javas.map((j) => ({ value: j.path, label: `Java ${j.version}${j.managed ? t('java.panelTag') : ''} — ${j.path}` }));
  const match = opts.find((o) => samePath(o.value, current || ''));
  if (match) current = match.value;
  else if (current) opts.unshift({ value: current, label: current });
  return `<select name="${name}">${opts
    .map((o) => `<option value="${esc(o.value)}" ${o.value === current ? 'selected' : ''}>${esc(o.label)}</option>`)
    .join('')}</select>`;
}

// ---------- Nouveau serveur ----------
function nextFreePort() {
  const used = new Set([...state.servers.values()].map((s) => Number(s.port)));
  let p = 25565;
  while (used.has(p)) p++;
  return p;
}

async function renderNew() {
  main.innerHTML = `
    <h1>${t('new.title')}</h1>
    <p class="muted">${t('new.subtitle')}</p>
    <form id="search-form" class="row" style="margin-top:16px">
      <input name="q" placeholder="${esc(t('new.searchPh'))}" style="flex:1;min-width:220px" autofocus>
      <input name="version" placeholder="${esc(t('new.versionPh'))}" style="width:170px">
      <button class="btn primary">${t('new.search')}</button>
    </form>
    <div id="pack-results" class="packs"></div>
    <div id="pack-setup"></div>`;
  const results = $('#pack-results');
  const search = async (q = '', version = '') => {
    results.innerHTML = `<p class="muted">${t('new.searching')}</p>`;
    try {
      const { results: packs, restricted } = await api(`/curseforge/search?q=${encodeURIComponent(q)}&version=${encodeURIComponent(version)}`);
      results.innerHTML = (restricted ? `<div class="warn-box" style="grid-column:1/-1">${t('new.restricted')}</div>` : '') + (packs.length
        ? packs
            .map(
              (p) => `<div class="pack" data-id="${p.id}" data-name="${esc(p.name)}">
                <img src="${esc(p.logo || '')}" alt="" loading="lazy">
                <div style="min-width:0"><div class="title">${esc(p.name)}</div>
                <div class="small muted">${t('new.downloads', { n: fmtNum(p.downloads) })} · ${esc(p.gameVersions.join(', '))}</div>
                <div class="sum">${esc(p.summary)}</div></div></div>`,
            )
            .join('')
        : `<p class="muted">${t('new.noResults')}</p>`);
      results.querySelectorAll('.pack').forEach((el) =>
        el.addEventListener('click', () => {
          results.querySelectorAll('.pack').forEach((x) => x.classList.toggle('active', x === el));
          renderPackSetup(Number(el.dataset.id), el.dataset.name);
        }),
      );
    } catch (e) {
      const keyIssue = e.code === 'NO_API_KEY' || e.code === 'API_KEY_REFUSED';
      results.innerHTML = `<div class="err-box">${esc(e.message)} ${
        keyIssue ? `<br><a href="#/settings" data-nav="settings">${t('new.goSettings')}</a>` : ''
      }</div>`;
    }
  };
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    search(f.get('q'), f.get('version'));
  });
  search();
}

async function renderPackSetup(modId, packName) {
  const box = $('#pack-setup');
  box.innerHTML = `<p class="muted">${t('new.loadingVersions')}</p>`;
  box.scrollIntoView({ behavior: 'smooth' });
  const [files, javas, settings] = await Promise.all([
    api(`/curseforge/modpacks/${modId}/files`),
    getJavas(),
    api('/settings'),
  ]).catch((e) => {
    box.innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
    return [];
  });
  if (!files) return;
  const releaseLabel = { 1: '', 2: ' [beta]', 3: ' [alpha]' };
  box.innerHTML = `
    <div class="card form" style="margin-top:24px">
      <h2 style="margin-top:0">${esc(packName)}</h2>
      <form id="create-form">
        <label class="field"><span>${t('new.packVersion')}</span>
          <select name="fileId">${files
            .map(
              (f) => `<option value="${f.id}">${esc(f.name)}${releaseLabel[f.releaseType] || ''} — MC ${esc(
                f.gameVersions.filter((v) => /^\d/.test(v)).join(', '),
              )}${f.hasServerPack ? ' ✓ server pack' : ''}</option>`,
            )
            .join('')}</select>
          <span class="small muted">${t('new.serverPackHint')}</span>
        </label>
        <div class="grid2">
          <label class="field"><span>${t('new.name')}</span><input name="name" value="${esc(packName)}" required></label>
          <label class="field"><span>${t('new.port')}</span><input name="port" type="number" value="${nextFreePort()}" min="1024" max="65535"></label>
          <label class="field"><span>${t('new.ram')}</span><input name="ramMB" type="number" min="1024" step="512" value="${esc(settings.defaultRamMB)}"></label>
          <label class="field"><span>Java</span>${javaSelect('javaPath', settings.defaultJavaPath, javas)}</label>
        </div>
        <label class="check"><input type="checkbox" name="acceptEula" required>
          ${t('new.eula', { link: link('https://aka.ms/MinecraftEULA', t('new.eulaLink')) })}</label>
        <button class="btn primary">${t('new.create')}</button>
      </form>
    </div>`;
  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const sel = e.target.fileId;
    const server = await act(() =>
      api('/servers', {
        method: 'POST',
        body: { ...f, acceptEula: !!f.acceptEula, modId, packName, versionName: sel.options[sel.selectedIndex].text.split(' — ')[0] },
      }),
    );
    if (server) {
      state.servers.set(server.id, server);
      navigate({ name: 'server', id: server.id, tab: 'console' });
    }
  });
}

// ---------- Vue serveur ----------
function renderServer() {
  const s = state.servers.get(state.view.id);
  const tab = state.view.tab || 'console';
  const tabs = ['console', 'players', 'perf', 'mods', 'files', 'schedules', 'settings', 'backups'];
  main.innerHTML = `
    <div class="server-head">
      <div style="flex:1;min-width:260px">
        <h1>${esc(s.name)}</h1>
        <div class="muted small">${esc(s.pack?.name || '')} ${esc(s.pack?.version || '')}
          ${s.loader ? ' · ' + esc(s.loader) : ''}${s.mcVersion ? ' · MC ' + esc(s.mcVersion) : ''} · port ${esc(s.port)}</div>
        <div class="row" style="margin-top:10px" id="status-line"></div>
      </div>
      <div class="row" id="controls"></div>
    </div>
    <div id="alerts"></div>
    <div class="tabs">${tabs
      .map((k) => `<button class="tab ${k === tab ? 'active' : ''}" data-tab="${k}">${t('tabs.' + k)}</button>`)
      .join('')}<button class="tab ${tab === 'properties' ? 'active' : ''}" data-tab="properties">server.properties</button></div>
    <div id="tab-content"></div>`;
  main.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => navigate({ name: 'server', id: s.id, tab: b.dataset.tab })),
  );
  renderStatus();
  renderAlerts(s);
  const tabFn = {
    console: tabConsole,
    players: tabPlayers,
    perf: tabPerf,
    mods: tabMods,
    files: tabFiles,
    schedules: tabSchedules,
    settings: tabSettings,
    backups: tabBackups,
    properties: tabProperties,
  };
  (tabFn[tab] || tabConsole)(s);
}

function renderStatus() {
  const s = state.servers.get(state.view?.id);
  if (!s || !$('#status-line')) return;
  const st = s.runtime.status;
  const players = s.runtime.players;
  const uptime = st === 'running' && s.runtime.startedAt ? t('status.since', { time: fmtTime(s.runtime.startedAt) }) : '';
  $('#status-line').innerHTML = `
    <span class="badge"><span class="dot st-${esc(st)}"></span>${esc(statusLabel(st))}${uptime}</span>
    ${st === 'running' ? `<span class="badge" title="${esc(players.join(', '))}">${t('status.players', { n: players.length })}${players.length ? ' : ' + esc(players.join(', ')) : ''}</span>` : ''}
    ${perfBadges(s)}`;

  const on = ['starting', 'running'].includes(st);
  const busy = ['installing', 'stopping', 'restoring'].includes(st);
  const ctrl = $('#controls');
  ctrl.innerHTML = `
    <button class="btn primary" data-a="start" ${on || busy || !s.installed ? 'disabled' : ''}>${t('ctrl.start')}</button>
    <button class="btn" data-a="restart" ${!on ? 'disabled' : ''}>${t('ctrl.restart')}</button>
    <button class="btn" data-a="stop" ${!on ? 'disabled' : ''}>${t('ctrl.stop')}</button>
    <button class="btn danger" data-a="kill" ${!(on || st === 'stopping') ? 'disabled' : ''} title="${esc(t('ctrl.killTitle'))}">${t('ctrl.kill')}</button>`;
  ctrl.querySelectorAll('[data-a]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.a === 'kill' && !confirm(t('ctrl.killConfirm'))) return;
      act(() => api(`/servers/${s.id}/${b.dataset.a}`, { method: 'POST' }));
    }),
  );
}

function renderAlerts(s) {
  const box = $('#alerts');
  if (!box) return;
  let html = '';
  if (s.missingMods?.length) {
    html += `<div class="warn-box">${t('alerts.missingMods', { n: s.missingMods.length, dir: `<code>${esc(s.dir)}\\mods</code>` })}
      <ul>${s.missingMods
        .map((m) => `<li>${m.url ? link(m.url, m.name) : esc(m.name)} ${m.fileName ? `<span class="muted">(${esc(m.fileName)})</span>` : ''}</li>`)
        .join('')}</ul></div>`;
  }
  if (s.runtime.status === 'install-failed') {
    html += `<div class="err-box">${t('alerts.installFailed')} <button class="btn sm" id="reinstall">${t('alerts.retry')}</button></div>`;
  }
  box.innerHTML = html + '<div id="crash-alert"></div><div id="java-alert"></div>';
  $('#reinstall')?.addEventListener('click', () => act(() => api(`/servers/${s.id}/reinstall`, { method: 'POST', body: {} })));
  if (s.installed) checkJavaAlert(s);
  if (s.runtime.status === 'crashed') showCrashAlert(s);
}

/** Résumé du dernier crash report (description, mods suspects) avec lien vers le rapport complet. */
async function showCrashAlert(s) {
  const crash = await api(`/servers/${s.id}/crashes/latest`).catch(() => null);
  const box = $('#crash-alert');
  if (!box || state.view.id !== s.id) return;
  const lines = [];
  if (crash?.description) lines.push(`<b>${esc(crash.description)}</b>`);
  if (crash?.exception) lines.push(`<code class="small">${esc(crash.exception)}</code>`);
  if (crash?.suspects?.length) lines.push(t('crash.suspects', { mods: `<b>${esc(crash.suspects.join(', '))}</b>` }));
  if (crash?.missingDeps?.length) lines.push(t('crash.missing', { deps: `<b>${esc(crash.missingDeps.join(', '))}</b>` }));
  box.innerHTML = `<div class="err-box"><div style="font-weight:600;margin-bottom:6px">${t('crash.title')}</div>
    ${crash ? lines.map((l) => `<div>${l}</div>`).join('') : `<div class="small">${t('crash.noReport')}</div>`}
    ${crash ? `<button class="btn sm" id="open-crash" style="margin-top:8px">${t('crash.open')}</button>` : ''}</div>`;
  $('#open-crash')?.addEventListener('click', () => {
    filesView.openFile = crash.path;
    filesView.path = 'crash-reports';
    filesView.id = s.id;
    navigate({ name: 'server', id: s.id, tab: 'files' });
  });
}

// --- Onglet console ---
function lineClass(line) {
  if (/^\[(Panel|Gestionnaire)\]/.test(line) || /^[✔✖ℹ⚠]/.test(line)) return 'l-mgr';
  if (line.startsWith('> ')) return 'l-cmd';
  if (/\b(ERROR|FATAL|Exception)\b/.test(line)) return 'l-err';
  if (/\bWARN\b/.test(line)) return 'l-warn';
  return '';
}

function appendLine(el, line) {
  const div = document.createElement('div');
  div.textContent = line;
  const c = lineClass(line);
  if (c) div.className = c;
  el.appendChild(div);
  while (el.childElementCount > 2000) el.firstChild.remove();
}

async function tabConsole(s) {
  $('#tab-content').innerHTML = `
    <div class="console" id="console"></div>
    <form class="console-input" id="cmd-form">
      <input name="command" placeholder="${esc(t('console.placeholder'))}" autocomplete="off">
      <button class="btn">${t('console.send')}</button>
    </form>`;
  const el = $('#console');
  const logs = await api(`/servers/${s.id}/logs`);
  if (state.view.id !== s.id) return;
  logs.forEach((l) => appendLine(el, l));
  el.scrollTop = el.scrollHeight;

  const history = [];
  let hIdx = 0;
  const input = $('#cmd-form').command;
  $('#cmd-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const command = input.value.trim();
    if (!command) return;
    history.push(command);
    hIdx = history.length;
    input.value = '';
    act(() => api(`/servers/${s.id}/command`, { method: 'POST', body: { command } }));
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && hIdx > 0) input.value = history[--hIdx];
    else if (e.key === 'ArrowDown') input.value = history[++hIdx] ?? ((hIdx = history.length), '');
    else return;
    e.preventDefault();
  });
}

// --- Onglet joueurs ---
const avatar = (name) => `<img class="avatar" src="https://mc-heads.net/avatar/${encodeURIComponent(name)}/32" alt="" loading="lazy">`;

function tabPlayers(s) {
  $('#tab-content').innerHTML = `<div id="players-box"><p class="muted">${t('common.loading')}</p></div>`;
  loadPlayers(s.id);
}

async function loadPlayers(id) {
  const box = $('#players-box');
  if (!box) return;
  let p;
  try {
    p = await api(`/servers/${id}/players`);
  } catch (e) {
    box.innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
    return;
  }
  if (state.view.id !== id || state.view.tab !== 'players') return;
  const dis = p.running ? '' : 'disabled';
  const isOp = new Set(p.ops.map((o) => o.name.toLowerCase()));
  const btn = (action, player, label, cls = '') =>
    `<button class="btn sm ${cls}" data-pa="${action}" data-player="${esc(player)}" ${dis}>${label}</button>`;
  const section = (title, items, renderItem, empty) => `
    <div class="card"><h2 style="margin-top:0">${title} <span class="muted small">(${items.length})</span></h2>
    ${items.length ? `<div class="plist">${items.map(renderItem).join('')}</div>` : `<p class="muted small">${empty}</p>`}</div>`;

  box.innerHTML = `
    ${p.running ? '' : `<div class="warn-box">${t('players.mustRun')}</div>`}
    ${p.onlineMode ? '' : `<p class="small muted">${t('players.offlineMode')}</p>`}
    <form class="row" id="add-player" style="margin-bottom:16px">
      <input name="player" placeholder="${esc(t('players.namePh'))}" maxlength="16" autocomplete="off" style="flex:1;min-width:160px" ${dis}>
      <button class="btn" value="whitelist-add" ${dis}>${t('players.wlAdd')}</button>
      <button class="btn" value="op" ${dis}>${t('players.op')}</button>
      <button class="btn danger" value="ban" ${dis}>${t('players.ban')}</button>
    </form>
    <div class="players-grid">
      ${section(t('players.online', { n: p.online.length, max: p.maxPlayers }), p.online, (n) => `
        <div class="prow">${avatar(n)}<span class="pname">${esc(n)}${isOp.has(n.toLowerCase()) ? ' <span class="tag">op</span>' : ''}</span>
          <select class="gm" data-player="${esc(n)}" ${dis} title="${esc(t('players.gamemode'))}">
            <option value="">${t('players.gmPick')}</option><option value="gamemode-survival">${t('players.gmSurvival')}</option>
            <option value="gamemode-creative">${t('players.gmCreative')}</option><option value="gamemode-spectator">${t('players.gmSpectator')}</option></select>
          ${isOp.has(n.toLowerCase()) ? btn('deop', n, t('players.deop')) : btn('op', n, t('players.op'))}
          ${btn('kick', n, t('players.kick'))}${btn('ban', n, t('players.banShort'), 'danger')}</div>`, t('players.nobody'))}
      <div class="card"><div class="row" style="margin-bottom:10px"><h2 style="margin:0">${t('players.whitelist')} <span class="muted small">(${p.whitelist.length})</span></h2><span class="spacer"></span>
        <label class="check" style="margin:0"><input type="checkbox" id="wl-toggle" ${p.whitelistEnabled ? 'checked' : ''} ${dis}> ${t('players.enabled')}</label></div>
        ${p.whitelistEnabled ? '' : `<p class="small muted">${t('players.wlOff')}</p>`}
        ${p.whitelist.length ? `<div class="plist">${p.whitelist.map((w) => `<div class="prow">${avatar(w.name)}<span class="pname">${esc(w.name)}</span>${btn('whitelist-remove', w.name, t('players.remove'))}</div>`).join('')}</div>` : `<p class="muted small">${t('players.empty')}</p>`}
      </div>
      ${section(t('players.ops'), p.ops, (o) => `<div class="prow">${avatar(o.name)}<span class="pname">${esc(o.name)} <span class="muted small">${t('players.level', { n: esc(o.level) })}</span></span>${btn('deop', o.name, t('players.deop'))}</div>`, t('players.noOps'))}
      ${section(t('players.banned'), p.banned, (b) => `<div class="prow">${avatar(b.name)}<span class="pname">${esc(b.name)}<br><span class="muted small">${esc(b.reason || '')}</span></span>${btn('pardon', b.name, t('players.pardon'))}</div>`, t('players.noBanned'))}
      ${section(t('players.known'), p.known.slice(0, 50), (k) => `<div class="prow">${avatar(k.name)}<span class="pname">${esc(k.name)}</span>
          ${p.online.includes(k.name) ? `<span class="tag on">${t('players.onlineTag')}</span>` : ''}
          ${p.whitelistEnabled && !p.whitelist.some((w) => w.name === k.name) ? btn('whitelist-add', k.name, t('players.wlAdd')) : ''}</div>`, t('players.noKnown'))}
    </div>`;

  const run = async (action, player) => {
    let reason;
    if (action === 'ban' || action === 'kick') {
      reason = prompt(t(action === 'ban' ? 'players.reasonBan' : 'players.reasonKick', { p: player }), '');
      if (reason === null) return;
    }
    const ok = await act(() => api(`/servers/${id}/players`, { method: 'POST', body: { action, player, reason } }), t('players.sent'));
    if (ok) setTimeout(() => loadPlayers(id), 900);
  };
  box.querySelectorAll('[data-pa]').forEach((b) => b.addEventListener('click', () => run(b.dataset.pa, b.dataset.player)));
  box.querySelectorAll('select.gm').forEach((sel) =>
    sel.addEventListener('change', () => sel.value && run(sel.value, sel.dataset.player).then(() => (sel.value = ''))),
  );
  $('#wl-toggle')?.addEventListener('change', (e) => run(e.target.checked ? 'whitelist-on' : 'whitelist-off'));
  $('#add-player').addEventListener('submit', (e) => {
    e.preventDefault();
    const player = e.target.player.value.trim();
    if (!player) return toast(t('players.enterName'), true);
    run(e.submitter.value, player).then(() => (e.target.player.value = ''));
  });
}

// --- Onglet performances ---
const perf = { id: null, samples: [], ramMax: 0, tpsAvailable: false, system: null, lagEvents: [] };

function tpsLevel(tps) {
  if (tps == null) return null;
  if (tps >= 19) return { cls: 'good', icon: '✓', label: t('perf.good') };
  if (tps >= 15) return { cls: 'warn', icon: '⚠', label: t('perf.warn') };
  return { cls: 'crit', icon: '✕', label: t('perf.crit') };
}

function perfBadges(s) {
  const st = s.runtime.stats;
  if (!st || !['running', 'starting'].includes(s.runtime.status)) return '';
  const lvl = tpsLevel(st.tps);
  return `<span class="badge" title="${esc(t('perf.cpuTitle'))}">CPU ${st.cpu}%</span>
    <span class="badge" title="${esc(t('perf.ramTitle'))}">RAM ${fmtRam(st.ram)}</span>
    ${lvl ? `<span class="badge st-${lvl.cls}" title="${esc(lvl.label)}">${lvl.icon} TPS ${st.tps}</span>` : ''}`;
}

async function tabPerf(s) {
  const box = $('#tab-content');
  box.innerHTML = `<p class="muted">${t('common.loading')}</p>`;
  const data = await api(`/servers/${s.id}/stats`).catch((e) => ((box.innerHTML = `<div class="err-box">${esc(e.message)}</div>`), null));
  if (!data || state.view.id !== s.id || state.view.tab !== 'perf') return;
  Object.assign(perf, data, { id: s.id });
  box.innerHTML = `
    <div class="tiles" id="perf-tiles"></div>
    <div class="charts">
      <div class="card"><div class="chart-title">CPU <span class="muted small">${t('perf.cpuChart', { n: data.system.cores })}</span></div><div class="chart" id="ch-cpu"></div></div>
      <div class="card"><div class="chart-title">${t('perf.ram')} <span class="muted small">${t('perf.ramChart')}</span></div><div class="chart" id="ch-ram"></div></div>
      <div class="card"><div class="chart-title">TPS <span class="muted small">${t('perf.tpsChart')}</span></div><div class="chart" id="ch-tps"></div></div>
    </div>
    <p class="small muted" id="perf-note"></p>`;
  renderPerf();
}

function perfAddSample(sample) {
  if (!$('#perf-tiles')) return;
  perf.samples.push(sample);
  if (perf.samples.length > 720) perf.samples.shift();
  renderPerf();
}

function renderPerf() {
  const s = state.servers.get(perf.id);
  const last = perf.samples.at(-1);
  const running = ['running', 'starting'].includes(s?.runtime.status);
  const lvl = tpsLevel(last?.tps);
  const tile = (label, value, sub, cls = '') =>
    `<div class="tile ${cls}"><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-sub">${sub}</div></div>`;
  const lags = perf.lagEvents.filter((e) => Date.now() - e.t < 3_600_000).length;
  const tpsSub = lvl
    ? `${lvl.icon} ${lvl.label}${last.mspt != null ? ` · ${last.mspt} ms/tick` : ''}`
    : perf.tpsAvailable ? t('perf.measuring') : t('perf.tpsNA');
  $('#perf-tiles').innerHTML = running && last
    ? tile('CPU', `${last.cpu}%`, t('perf.cores', { n: perf.system.cores })) +
      tile(t('perf.ram'), fmtRam(last.ram), t('perf.ramSub', { max: fmtRam(perf.ramMax), free: fmtRam(last.sysFree) })) +
      tile('TPS', last.tps ?? '—', tpsSub, lvl ? 'st-' + lvl.cls : '') +
      tile(t('perf.players'), last.players, t('perf.lags', { n: lags }))
    : `<div class="muted">${running ? t('perf.firstSample') : t('perf.startToSee')}</div>`;

  lineChart($('#ch-cpu'), { samples: perf.samples, key: 'cpu', max: 100, fmt: (v) => `${Math.round(v)}%` });
  lineChart($('#ch-ram'), { samples: perf.samples, key: 'ram', ref: perf.ramMax, fmt: fmtRam });
  if (perf.tpsAvailable) lineChart($('#ch-tps'), { samples: perf.samples, key: 'tps', max: 20, fmt: (v) => (Math.round(v * 10) / 10).toString() });
  else $('#ch-tps').innerHTML = `<div class="chart-empty">${esc(t('perf.tpsUnsupported'))}</div>`;
  $('#perf-note').textContent = t('perf.note');
}

/** Graphique en ligne SVG minimal avec infobulle au survol / toucher. */
function lineChart(el, { samples, key, max, ref, fmt }) {
  if (!el) return;
  const pts = samples.filter((p) => p[key] != null);
  if (pts.length < 2) {
    el.innerHTML = `<div class="chart-empty">${t('perf.notEnough')}</div>`;
    return;
  }
  const W = Math.max(280, el.clientWidth || 600);
  const H = 170;
  const pad = { l: 52, r: 12, t: 12, b: 24 };
  const t0 = pts[0].t;
  const t1 = pts.at(-1).t;
  const peak = Math.max(...pts.map((p) => p[key]), ref || 0);
  const yMax = max ?? niceCeil(peak * 1.1 || 1);
  const x = (tm) => pad.l + ((tm - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - Math.min(v, yMax) / yMax) * (H - pad.t - pad.b);
  let d = '';
  let prevT = null;
  for (const p of pts) {
    d += `${prevT && p.t - prevT < 40_000 ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`;
    prevT = p.t;
  }
  const grid = [0, 0.5, 1]
    .map((f) => {
      const v = yMax * f;
      return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end" class="axis">${esc(fmt(v))}</text>`;
    })
    .join('');
  const hhmm = (tm) => fmtTime(tm, { hour: '2-digit', minute: '2-digit' });
  const refLine = ref ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(ref)}" y2="${y(ref)}" class="ref"/>` : '';
  el.innerHTML = `
    <svg width="${W}" height="${H}" role="img" aria-label="${esc(t('perf.chartLabel', { k: key.toUpperCase() }))}">
      ${grid}${refLine}
      <text x="${pad.l}" y="${H - 6}" class="axis">${hhmm(t0)}</text>
      <text x="${W - pad.r}" y="${H - 6}" text-anchor="end" class="axis">${hhmm(t1)}</text>
      <path d="${d}" class="line"/>
      <line class="cross hidden" y1="${pad.t}" y2="${H - pad.b}"/>
      <circle class="hover-dot hidden" r="4.5"/>
      <rect x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}" fill="transparent" class="hit"/>
    </svg>
    <div class="chart-tip hidden"></div>`;
  const svg = el.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const dot = svg.querySelector('.hover-dot');
  const tip = el.querySelector('.chart-tip');
  const show = (clientX) => {
    const mx = clientX - svg.getBoundingClientRect().left;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.t) - mx) < Math.abs(x(best.t) - mx)) best = p;
    const px = x(best.t);
    const py = y(best[key]);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    dot.setAttribute('cx', px);
    dot.setAttribute('cy', py);
    [cross, dot, tip].forEach((n) => n.classList.remove('hidden'));
    tip.innerHTML = `<b>${esc(fmt(best[key]))}</b><br><span class="muted">${fmtTime(best.t)}</span>`;
    tip.style.left = `${Math.min(px + 12, W - 110)}px`;
    tip.style.top = `${Math.max(0, py - 44)}px`;
  };
  const hide = () => [cross, dot, tip].forEach((n) => n.classList.add('hidden'));
  const hit = svg.querySelector('.hit');
  hit.addEventListener('pointermove', (e) => show(e.clientX));
  hit.addEventListener('pointerdown', (e) => show(e.clientX));
  hit.addEventListener('pointerleave', hide);
}

function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((n) => n >= v);
}

// --- Onglet mods ---
const modsView = { id: null, mods: [], running: false, query: '', filter: 'all' };

async function tabMods(s) {
  const box = $('#tab-content');
  box.innerHTML = `<p class="muted">${t('common.loading')}</p>`;
  await loadMods(s.id);
}

async function loadMods(id) {
  const box = $('#tab-content');
  let data;
  try {
    data = await api(`/servers/${id}/mods`);
  } catch (e) {
    box.innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
    return;
  }
  if (state.view.id !== id || state.view.tab !== 'mods') return;
  const keep = modsView.id === id ? { query: modsView.query, filter: modsView.filter } : { query: '', filter: 'all' };
  Object.assign(modsView, { id, ...data, ...keep });
  const dis = data.running ? 'disabled' : '';
  box.innerHTML = `
    ${data.running ? `<div class="warn-box">${t('mods.mustStop')}</div>` : ''}
    <div class="row" style="margin-bottom:12px">
      <input id="mod-q" placeholder="${esc(t('mods.filterPh'))}" value="${esc(modsView.query)}" style="flex:1;min-width:180px">
      <select id="mod-filter">${['all', 'enabled', 'disabled', 'client']
        .map((f) => `<option value="${f}" ${f === modsView.filter ? 'selected' : ''}>${t('mods.filter' + f[0].toUpperCase() + f.slice(1))}</option>`)
        .join('')}</select>
      <label class="btn primary ${dis}" id="mod-upload-label">${t('mods.upload')}
        <input type="file" id="mod-upload" accept=".jar" multiple hidden ${dis}></label>
    </div>
    <p class="small muted" id="mod-count"></p>
    <div id="mod-list" class="mod-list ${data.running ? '' : 'droppable'}"></div>
    <p class="small muted" style="margin-top:12px">${t('mods.restartHint')}${data.running ? '' : ' · ' + t('mods.dropHint')}</p>`;

  $('#mod-q').addEventListener('input', (e) => {
    modsView.query = e.target.value;
    renderModList();
  });
  $('#mod-filter').addEventListener('change', (e) => {
    modsView.filter = e.target.value;
    renderModList();
  });
  $('#mod-upload').addEventListener('change', (e) => uploadMods(id, [...e.target.files]));
  const list = $('#mod-list');
  if (!data.running) {
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      list.classList.add('drag');
    });
    list.addEventListener('dragleave', () => list.classList.remove('drag'));
    list.addEventListener('drop', (e) => {
      e.preventDefault();
      list.classList.remove('drag');
      uploadMods(id, [...e.dataTransfer.files].filter((f) => f.name.toLowerCase().endsWith('.jar')));
    });
  }
  renderModList();
}

function renderModList() {
  const list = $('#mod-list');
  if (!list) return;
  const { mods, running, query, filter } = modsView;
  const q = query.trim().toLowerCase();
  const shown = mods.filter((m) => {
    if (filter === 'enabled' && !m.enabled) return false;
    if (filter === 'disabled' && m.enabled) return false;
    if (filter === 'client' && !m.clientOnly) return false;
    return !q || [m.name, m.modId, m.fileName, m.description].some((v) => String(v || '').toLowerCase().includes(q));
  });
  $('#mod-count').textContent = t('mods.count', { n: mods.length, enabled: mods.filter((m) => m.enabled).length });
  const dis = running ? 'disabled' : '';
  list.innerHTML = shown.length
    ? shown
        .map(
          (m) => `<div class="mod-row ${m.enabled ? '' : 'off'}">
        <div class="mod-main">
          <div><b>${esc(m.name || m.fileName)}</b> <span class="muted small">${esc(m.version || '')}</span>
            ${m.enabled ? '' : `<span class="tag">${t('mods.disabledTag')}</span>`}
            ${m.clientOnly ? `<span class="tag warn" title="${esc(t('mods.clientOnlyTitle'))}">⚠ ${t('mods.clientOnly')}</span>` : ''}</div>
          ${m.description ? `<div class="small muted mod-desc">${esc(m.description)}</div>` : ''}
          <div class="small muted mono">${esc(m.fileName)} · ${fmtSize(m.size)}</div>
        </div>
        <div class="row">
          <button class="btn sm" data-toggle="${esc(m.fileName)}" data-enabled="${m.enabled ? 0 : 1}" ${dis}>${m.enabled ? t('mods.disable') : t('mods.enable')}</button>
          <button class="btn sm danger" data-delmod="${esc(m.fileName)}" data-name="${esc(m.name || m.fileName)}" ${dis}>${t('common.delete')}</button>
        </div></div>`,
        )
        .join('')
    : `<p class="muted">${mods.length ? t('mods.noMatch') : t('mods.none')}</p>`;

  const id = modsView.id;
  list.querySelectorAll('[data-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      const ok = await act(() =>
        api(`/servers/${id}/mods/${encodeURIComponent(b.dataset.toggle)}/toggle`, { method: 'POST', body: { enabled: b.dataset.enabled === '1' } }),
      );
      if (ok) loadMods(id);
    }),
  );
  list.querySelectorAll('[data-delmod]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(t('mods.deleteConfirm', { name: b.dataset.name }))) return;
      const ok = await act(() => api(`/servers/${id}/mods/${encodeURIComponent(b.dataset.delmod)}`, { method: 'DELETE' }), t('mods.deleted'));
      if (ok) loadMods(id);
    }),
  );
}

async function uploadMods(id, files) {
  if (!files.length) return;
  let added = 0;
  for (const file of files) {
    toast(t('mods.uploading', { name: file.name }));
    try {
      const res = await fetch(`/api/servers/${id}/mods?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/java-archive' },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      added++;
    } catch (e) {
      toast(`${file.name} : ${e.message}`, true);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (added) toast(t('mods.uploaded', { n: added }));
  loadMods(id);
}

// --- Onglet fichiers ---
const filesView = { id: null, path: '', openFile: null, editor: null };

async function tabFiles(s) {
  if (filesView.id !== s.id) Object.assign(filesView, { id: s.id, path: '', openFile: null, editor: null });
  if (filesView.openFile) {
    const file = filesView.openFile;
    filesView.openFile = null;
    return openEditor(file);
  }
  if (filesView.editor) return renderEditor();
  return loadDir(filesView.path);
}

const fileUrl = (sub, p) => `/servers/${filesView.id}/files${sub}?path=${encodeURIComponent(p)}`;

function breadcrumb(p, { linkLast = false } = {}) {
  const parts = p ? p.split('/') : [];
  const crumbs = [`<a href="#" data-dir="">${t('files.root')}</a>`];
  parts.forEach((part, i) => {
    const sub = parts.slice(0, i + 1).join('/');
    crumbs.push(i === parts.length - 1 && !linkLast ? `<b>${esc(part)}</b>` : `<a href="#" data-dir="${esc(sub)}">${esc(part)}</a>`);
  });
  return `<div class="crumbs">${crumbs.join('<span class="muted">/</span>')}</div>`;
}

function bindCrumbs(root) {
  root.querySelectorAll('[data-dir]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (filesView.editor?.dirty && !confirm(t('files.unsaved'))) return;
      filesView.editor = null;
      loadDir(a.dataset.dir);
    }),
  );
}

async function loadDir(p) {
  const box = $('#tab-content');
  let data;
  try {
    data = await api(fileUrl('', p));
  } catch (e) {
    if (p) return loadDir(''); // dossier supprimé entre-temps : retour à la racine
    box.innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
    return;
  }
  if (state.view.tab !== 'files' || state.view.id !== filesView.id) return;
  filesView.path = data.path;
  const join = (name) => (data.path ? `${data.path}/${name}` : name);
  box.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      ${breadcrumb(data.path)}
      <span class="spacer"></span>
      <button class="btn sm" id="mkdir">${t('files.newFolder')}</button>
      <label class="btn sm primary">${t('files.upload')}<input type="file" id="file-upload" multiple hidden></label>
    </div>
    <div class="card file-table">${
      data.items.length
        ? `<table><thead><tr><th>${t('files.name')}</th><th class="hide-sm">${t('files.size')}</th><th class="hide-sm">${t('files.modified')}</th><th></th></tr></thead><tbody>
          ${data.items
            .map(
              (it) => `<tr>
              <td><a href="#" class="file-link" data-name="${esc(it.name)}" data-isdir="${it.dir ? 1 : 0}">${it.dir ? '📁' : '📄'} ${esc(it.name)}</a></td>
              <td class="hide-sm muted small">${it.dir ? '' : fmtSize(it.size)}</td>
              <td class="hide-sm muted small">${it.mtime ? fmtDate(it.mtime) : ''}</td>
              <td class="row" style="justify-content:flex-end;flex-wrap:nowrap">
                ${it.dir ? '' : `<a class="btn sm" href="/api${fileUrl('/download', join(it.name))}" download>${t('bk.download')}</a>`}
                <button class="btn sm danger" data-del="${esc(it.name)}">${t('common.delete')}</button></td></tr>`,
            )
            .join('')}</tbody></table>`
        : `<p class="muted" style="margin:0">${t('files.empty')}</p>`
    }</div>`;
  bindCrumbs(box);
  box.querySelectorAll('.file-link').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = join(a.dataset.name);
      if (a.dataset.isdir === '1') loadDir(target);
      else openEditor(target);
    }),
  );
  box.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(t('files.deleteConfirm', { name: b.dataset.del }))) return;
      const ok = await act(() => api(fileUrl('', join(b.dataset.del)), { method: 'DELETE' }), t('files.deleted'));
      if (ok) loadDir(data.path);
    }),
  );
  $('#mkdir').addEventListener('click', async () => {
    const name = prompt(t('files.folderPrompt'), '');
    if (!name) return;
    const ok = await act(() => api(`/servers/${filesView.id}/files/mkdir`, { method: 'POST', body: { path: join(name.trim()) } }));
    if (ok) loadDir(data.path);
  });
  $('#file-upload').addEventListener('change', async (e) => {
    let n = 0;
    for (const file of e.target.files) {
      try {
        const res = await fetch(`/api/servers/${filesView.id}/files/upload?path=${encodeURIComponent(data.path)}&name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        n++;
      } catch (err) {
        toast(`${file.name} : ${err.message}`, true);
      }
    }
    if (n) toast(t('files.uploaded', { n }));
    loadDir(data.path);
  });
}

async function openEditor(p) {
  try {
    const file = await api(fileUrl('/content', p));
    filesView.editor = { path: file.path, content: file.content, original: file.content, dirty: false };
    renderEditor();
  } catch (e) {
    toast(e.message, true);
    if (!$('.file-table')) loadDir(p.split('/').slice(0, -1).join('/'));
  }
}

function renderEditor() {
  const ed = filesView.editor;
  const box = $('#tab-content');
  const parent = ed.path.split('/').slice(0, -1).join('/');
  box.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      ${breadcrumb(ed.path)}
      <span class="spacer"></span>
      <span class="small muted" id="ed-state"></span>
      <a class="btn sm" href="/api${fileUrl('/download', ed.path)}" download>${t('bk.download')}</a>
      <button class="btn sm" id="ed-close">${t('files.close')}</button>
      <button class="btn sm primary" id="ed-save" disabled>${t('common.save')}</button>
    </div>
    <textarea id="editor" class="editor" spellcheck="false">${esc(ed.content)}</textarea>
    <p class="small muted">${t('files.hint')}</p>`;
  bindCrumbs(box);
  const area = $('#editor');
  const sync = () => {
    ed.content = area.value;
    ed.dirty = ed.content !== ed.original;
    $('#ed-save').disabled = !ed.dirty;
    $('#ed-state').textContent = ed.dirty ? t('sched.unsaved') : '';
  };
  const save = async () => {
    if (!ed.dirty) return;
    const ok = await act(() => api(fileUrl('/content', ed.path), { method: 'PUT', body: ed.content, text: true }), t('files.saved'));
    if (ok) {
      ed.original = ed.content;
      sync();
    }
  };
  area.addEventListener('input', sync);
  area.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
      sync();
    }
  });
  $('#ed-save').addEventListener('click', save);
  $('#ed-close').addEventListener('click', () => {
    if (ed.dirty && !confirm(t('files.unsaved'))) return;
    filesView.editor = null;
    loadDir(parent);
  });
  sync();
}

// --- Onglet tâches planifiées ---
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // lundi → dimanche
const dayName = (d) => new Intl.DateTimeFormat(locale(), { weekday: 'short' }).format(new Date(2024, 0, 7 + d)); // 07/01/2024 = dimanche
const schedView = { id: null, list: [], dirty: false };

async function tabSchedules(s) {
  const box = $('#tab-content');
  box.innerHTML = `<p class="muted">${t('common.loading')}</p>`;
  try {
    schedView.list = await api(`/servers/${s.id}/schedules`);
  } catch (e) {
    box.innerHTML = `<div class="err-box">${esc(e.message)}</div>`;
    return;
  }
  if (state.view.id !== s.id || state.view.tab !== 'schedules') return;
  schedView.id = s.id;
  schedView.dirty = false;
  renderSchedules();
}

function renderSchedules() {
  const box = $('#tab-content');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const types = ['restart', 'start', 'stop', 'backup', 'command'];
  box.innerHTML = `
    <p class="small muted">${t('sched.help', { tz: esc(tz) })}</p>
    <div id="sched-list" class="sched-list">${
      schedView.list.length
        ? schedView.list
            .map(
              (sc, i) => `<div class="sched-row card ${sc.enabled ? '' : 'off'}" data-i="${i}">
          <div class="row">
            <label class="check" style="margin:0" title="${esc(t('sched.enabled'))}"><input type="checkbox" data-f="enabled" ${sc.enabled ? 'checked' : ''}></label>
            <select data-f="type">${types.map((ty) => `<option value="${ty}" ${ty === sc.type ? 'selected' : ''}>${t('sched.type.' + ty)}</option>`).join('')}</select>
            <span class="muted">${t('sched.at')}</span>
            <input type="time" data-f="time" value="${esc(sc.time)}" required>
            ${sc.type === 'command' ? `<input data-f="command" value="${esc(sc.command)}" placeholder="${esc(t('sched.commandPh'))}" style="flex:1;min-width:160px">` : ''}
            <span class="spacer"></span>
            <button class="btn sm danger" data-remove="${i}">${t('sched.remove')}</button>
          </div>
          <div class="row" style="margin-top:10px">
            <div class="days">${DAY_ORDER.map((d) => `<button type="button" class="day-btn ${sc.days.includes(d) ? 'on' : ''}" data-day="${d}">${esc(dayName(d))}</button>`).join('')}</div>
            <span class="small muted">${sc.days.length ? '' : t('sched.everyday')}</span>
            ${sc.type === 'restart' || sc.type === 'stop' ? `<label class="check small" style="margin:0"><input type="checkbox" data-f="warn" ${sc.warn ? 'checked' : ''}> ${t('sched.warn')}</label>` : ''}
          </div>
          <div class="small muted" style="margin-top:8px">${
            !sc.enabled ? t('sched.disabled') : sc.nextRun && !schedView.dirty ? t('sched.next', { date: fmtDate(sc.nextRun) }) : ''
          }</div>
        </div>`,
            )
            .join('')
        : `<p class="muted">${t('sched.none')}</p>`
    }</div>
    <div class="row" style="margin-top:14px">
      <button class="btn" id="sched-add">${t('sched.add')}</button>
      <span class="spacer"></span>
      <span class="small muted">${schedView.dirty ? t('sched.unsaved') : ''}</span>
      <button class="btn primary" id="sched-save" ${schedView.dirty ? '' : 'disabled'}>${t('common.save')}</button>
    </div>`;

  const changed = () => {
    schedView.dirty = true;
    renderSchedules();
  };
  box.querySelectorAll('.sched-row').forEach((row) => {
    const sc = schedView.list[Number(row.dataset.i)];
    row.querySelectorAll('[data-f]').forEach((input) =>
      input.addEventListener('change', () => {
        const f = input.dataset.f;
        sc[f] = input.type === 'checkbox' ? input.checked : input.value;
        if (f === 'type' && (sc.type === 'restart' || sc.type === 'stop') && sc.warn === undefined) sc.warn = true;
        changed();
      }),
    );
    row.querySelectorAll('[data-day]').forEach((b) =>
      b.addEventListener('click', () => {
        const d = Number(b.dataset.day);
        sc.days = sc.days.includes(d) ? sc.days.filter((x) => x !== d) : [...sc.days, d];
        changed();
      }),
    );
  });
  box.querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', () => {
      schedView.list.splice(Number(b.dataset.remove), 1);
      changed();
    }),
  );
  $('#sched-add').addEventListener('click', () => {
    schedView.list.push({ type: 'restart', time: '04:00', days: [], command: '', warn: true, enabled: true });
    changed();
  });
  $('#sched-save').addEventListener('click', async () => {
    const saved = await act(() => api(`/servers/${schedView.id}/schedules`, { method: 'PUT', body: schedView.list }), t('sched.saved'));
    if (saved) {
      schedView.list = saved;
      schedView.dirty = false;
      renderSchedules();
    }
  });
}

// --- Onglet réglages ---
async function tabSettings(s) {
  const javas = await getJavas();
  const rec = s.recommendedJava;
  $('#tab-content').innerHTML = `
    <form class="form" id="srv-form">
      <div class="grid2">
        <label class="field"><span>${t('srv.name')}</span><input name="name" value="${esc(s.name)}"></label>
        <label class="field"><span>Port</span><input name="port" type="number" value="${esc(s.port)}"></label>
        <label class="field"><span>${t('srv.ramMax')}</span><input name="ramMB" type="number" step="512" min="512" value="${esc(s.ramMB)}"></label>
        <label class="field"><span>Java${rec ? t('srv.javaRec', { v: rec }) : ''}</span>${javaSelect('javaPath', s.javaPath, javas)}</label>
      </div>
      <label class="field"><span>${t('srv.jvmArgs')}</span>
        <input name="jvmArgs" value="${esc(s.jvmArgs)}" placeholder="-XX:+UseG1GC -XX:MaxGCPauseMillis=200"></label>
      <label class="check"><input type="checkbox" name="autoRestart" ${s.autoRestart ? 'checked' : ''}> ${t('srv.autoRestart')}</label>
      <label class="check"><input type="checkbox" name="autoStart" ${s.autoStart ? 'checked' : ''}> ${t('srv.autoStart')}</label>
      <h2>${t('srv.autoBackups')}</h2>
      <label class="check"><input type="checkbox" name="abEnabled" ${s.autoBackup?.enabled ? 'checked' : ''}> ${t('srv.abEnable')}</label>
      <div class="grid2">
        <label class="field"><span>${t('srv.abInterval')}</span><input name="abInterval" type="number" step="0.25" min="0.25" value="${esc(s.autoBackup?.intervalHours)}"></label>
        <label class="field"><span>${t('srv.abKeep')}</span><input name="abKeep" type="number" min="1" value="${esc(s.autoBackup?.keep)}"></label>
      </div>
      <div class="row">
        <button class="btn primary">${t('common.save')}</button>
        <span class="spacer"></span>
        <button type="button" class="btn danger" id="delete-srv">${t('srv.delete')}</button>
      </div>
      <p class="small muted" style="margin-top:20px">${t('srv.folder')} <code>${esc(s.dir)}</code><br>${t('srv.applyNext')}</p>
    </form>`;
  $('#srv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const updated = await act(
      () =>
        api(`/servers/${s.id}`, {
          method: 'PATCH',
          body: {
            name: f.name.value,
            port: f.port.value,
            ramMB: f.ramMB.value,
            javaPath: f.javaPath.value,
            jvmArgs: f.jvmArgs.value,
            autoRestart: f.autoRestart.checked,
            autoStart: f.autoStart.checked,
            autoBackup: { enabled: f.abEnabled.checked, intervalHours: f.abInterval.value, keep: f.abKeep.value },
          },
        }),
      t('srv.saved'),
    );
    if (updated) {
      state.servers.set(s.id, updated);
      navigate({ name: 'server', id: s.id, tab: 'settings' });
    }
  });
  $('#delete-srv').addEventListener('click', async () => {
    if (!confirm(t('srv.deleteConfirm', { name: s.name }))) return;
    const withBackups = confirm(t('srv.deleteBackups'));
    const ok = await act(() => api(`/servers/${s.id}?backups=${withBackups ? 1 : 0}`, { method: 'DELETE' }), t('srv.deleted'));
    if (ok) {
      state.servers.delete(s.id);
      navigate({ name: 'home' });
    }
  });
}

// --- Onglet sauvegardes ---
async function tabBackups(s) {
  const box = $('#tab-content');
  const load = async () => {
    const list = await api(`/servers/${s.id}/backups`);
    if (state.view.id !== s.id || state.view.tab !== 'backups') return;
    box.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <button class="btn primary" id="new-backup">${t('bk.now')}</button>
        <span class="muted small">${t('bk.hint', { folder: '<code>world.before-restore</code>' })}</span>
      </div>
      ${list.length ? `<table><thead><tr><th>${t('bk.name')}</th><th>${t('bk.date')}</th><th>${t('bk.size')}</th><th></th></tr></thead><tbody>${list
        .map(
          (b) => `<tr><td>${b.auto ? '⏱' : '👤'} ${esc(b.name)}</td><td>${fmtDate(b.date)}</td><td>${fmtSize(b.size)}</td>
          <td class="row" style="justify-content:flex-end">
            <a class="btn sm" href="/api/servers/${esc(s.id)}/backups/${encodeURIComponent(b.name)}/download">${t('bk.download')}</a>
            <button class="btn sm" data-restore="${esc(b.name)}">${t('bk.restore')}</button>
            <button class="btn sm danger" data-del="${esc(b.name)}">${t('common.delete')}</button></td></tr>`,
        )
        .join('')}</tbody></table>` : `<p class="muted">${t('bk.none')}</p>`}`;
    $('#new-backup').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = t('bk.running');
      await act(() => api(`/servers/${s.id}/backups`, { method: 'POST' }), t('bk.created'));
      load();
    });
    box.querySelectorAll('[data-restore]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm(t('bk.restoreConfirm', { name: b.dataset.restore }))) return;
        await act(() => api(`/servers/${s.id}/backups/${encodeURIComponent(b.dataset.restore)}/restore`, { method: 'POST' }), t('bk.restored'));
        load();
      }),
    );
    box.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm(t('bk.deleteConfirm', { name: b.dataset.del }))) return;
        await act(() => api(`/servers/${s.id}/backups/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }));
        load();
      }),
    );
  };
  box.innerHTML = `<p class="muted">${t('common.loading')}</p>`;
  await load().catch((e) => (box.innerHTML = `<div class="err-box">${esc(e.message)}</div>`));
}

// --- Onglet server.properties ---
async function tabProperties(s) {
  const text = await api(`/servers/${s.id}/properties`);
  $('#tab-content').innerHTML = `
    <p class="muted small">${t('props.hint')}</p>
    <textarea id="props" spellcheck="false" style="width:100%;height:calc(100vh - 360px);min-height:300px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px">${esc(text)}</textarea>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="save-props">${t('common.save')}</button></div>`;
  $('#save-props').addEventListener('click', async () => {
    const ok = await act(() => api(`/servers/${s.id}/properties`, { method: 'PUT', body: $('#props').value, text: true }), t('props.saved'));
    if (ok) refreshServers();
  });
}

// ---------- WebSocket temps réel ----------
function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const viewing = state.view?.name === 'server' && state.view.id === msg.id;
    if (msg.type === 'log' && viewing) {
      const el = $('#console');
      if (el) {
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        appendLine(el, msg.line);
        if (atBottom) el.scrollTop = el.scrollHeight;
      }
    } else if (msg.type === 'status') {
      const s = state.servers.get(msg.id);
      if (!s) return;
      const prev = s.runtime.status;
      s.runtime = { ...s.runtime, ...msg };
      renderSidebar();
      if (viewing) {
        // Fin d'installation : recharger les infos (version MC, loader, mods manquants)
        if (prev === 'installing' && msg.status !== 'installing') {
          refreshServers().then(() => state.view.id === msg.id && render());
        } else {
          renderStatus();
          if (prev !== msg.status) renderAlerts(s);
          if (state.view.tab === 'players') loadPlayers(s.id);
          if (state.view.tab === 'mods' && Boolean(prev === 'stopped' || prev === 'crashed') !== Boolean(msg.status === 'stopped' || msg.status === 'crashed')) loadMods(s.id);
        }
      }
    } else if (msg.type === 'stats') {
      const s = state.servers.get(msg.id);
      if (!s) return;
      s.runtime.stats = msg.sample;
      if (viewing) {
        renderStatus();
        if (state.view.tab === 'perf') perfAddSample(msg.sample);
      }
    } else if (msg.type === 'java') {
      onJavaProgress(msg);
    }
  };
  ws.onclose = () =>
    setTimeout(() => {
      refreshServers().catch(() => {});
      connectWs();
    }, 2000);
}

// ---------- Initialisation ----------
async function initLang() {
  let saved = null;
  try {
    saved = localStorage.getItem('lang');
  } catch {
    /* stockage indisponible */
  }
  const settings = await api('/settings').catch(() => ({}));
  const l = saved || settings.language || browserLang();
  setLang(l);
  // Premier lancement : le backend adopte la langue détectée
  if (!settings.language) api('/settings', { method: 'PUT', body: { language: l } }).catch(() => {});
}

window.addEventListener('hashchange', () => {
  const v = viewFromHash();
  if (JSON.stringify(v) !== JSON.stringify(state.view)) navigate(v);
});

await initLang();
renderChrome();
await refreshServers().catch((e) => toast(e.message, true));
navigate(viewFromHash());
connectWs();
