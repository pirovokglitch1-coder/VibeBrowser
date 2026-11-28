const { app, BrowserWindow, ipcMain, shell, dialog, session, Menu, webContents, screen } = require('electron');
const path = require('path'), fs = require('fs');

// Аппаратное ускорение выключается только до старта приложения — читаем флаг из файла
const flagFile = path.join(app.getPath('userData'), 'flags.json');
let F = {};
try { F = JSON.parse(fs.readFileSync(flagFile, 'utf8')); } catch (e) {}
if (F.noHw) app.disableHardwareAcceleration();
let lastFlags = JSON.stringify({ noHw: !!F.noHw, lowEnd: !!F.lowEnd, bgc: F.bgc || '' });

// Скорость: лишние службы Chromium выключены, включены параллельные загрузки и кэш страниц назад/вперёд
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,MediaRouter,Translate,OptimizationHints,AutofillServerCommunication');
app.commandLine.appendSwitch('enable-features', 'ParallelDownloading,BackForwardCache');
app.commandLine.appendSwitch('disk-cache-size', String(512 * 1024 * 1024));
// без фоновых служб Chromium (обновление компонентов, телеметрия, проверки) — меньше нагрузки в простое
['disable-background-networking', 'disable-component-update', 'disable-domain-reliability', 'disable-client-side-phishing-detection', 'no-pings', 'disable-breakpad', 'disable-default-apps']
  .forEach(f => app.commandLine.appendSwitch(f));
if (!F.noHw) { app.commandLine.appendSwitch('enable-gpu-rasterization'); app.commandLine.appendSwitch('enable-zero-copy'); }
if (F.lowEnd) { app.commandLine.appendSwitch('enable-low-end-device-mode'); app.commandLine.appendSwitch('renderer-process-limit', '4'); app.commandLine.appendSwitch('disable-smooth-scrolling'); }
app.setAppUserModelId('dev.vibe.browser');
const ICON = path.join(__dirname, 'icon.png');
// Один процесс на все окна: повторный запуск открывает новое окно мгновенно
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// Настройки, которые приходят из окна браузера (команда 'cfg')
let C = { ask: false, dlDir: '', blockAds: false, blockImages: false, dnt: false, thirdCookies: false, httpsOnly: false,
  blockPopups: true, perm: { media: 'ask', geo: 'ask', notif: 'ask' }, lang: '', spell: true, clearOnExit: false };
let seq = 0;
const items = new Map(), hooked = new WeakSet(), sessions = [], incIds = new Set();
const ADS = ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com', 'googletagmanager.com',
  'adservice.google.com', 'connect.facebook.net', 'adnxs.com', 'taboola.com', 'outbrain.com', 'scorecardresearch.com', 'hotjar.com',
  'mc.yandex.ru', 'an.yandex.ru', 'yandexadexchange.net', 'top-fwz1.mail.ru', 'criteo.com', 'amazon-adsystem.com'];
const hostOf = u => { try { return new URL(u).hostname; } catch (e) { return ''; } };
const originOf = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.origin : ''; } catch (e) { return ''; } };
const base = h => h.split('.').slice(-2).join('.');
/* ---------- разрешения сайтов: решения хранит окно браузера, здесь только кэш ---------- */
const KEYMAP = { media: 'media', geolocation: 'geo', notifications: 'notif' };
const SAFE = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock'];
let P = {}, pseq = 0;
const pending = new Map();
function decision(host, origin, key) {
  const d = !incIds.has(host.id) && P[origin] && P[origin][key];
  if (d) return d === 'allow';
  const g = C.perm[key];
  if (g !== 'ask') return g === 'allow';
  return null; // решения нет — нужно спросить в окне браузера
}

function create(incognito) {
  const w = new BrowserWindow({
    width: 1280, height: 800, minWidth: 700, minHeight: 450, show: false, icon: ICON, backgroundColor: F.bgc || '#1c1b1f', autoHideMenuBar: true, frame: false,
    webPreferences: { webviewTag: true, nodeIntegration: true, contextIsolation: false, spellcheck: false }
  });
  if (incognito) incIds.add(w.webContents.id);
  const sendState = () => { if (!w.isDestroyed()) w.webContents.send('win-state', { max: w.isMaximized(), full: w.isFullScreen() }); };
  ['maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen'].forEach(ev => w.on(ev, sendState));
  w.once('ready-to-show', () => w.show());
  setTimeout(() => { if (!w.isDestroyed() && !w.isVisible()) w.show(); }, 2500);
  w.loadFile('index.html', incognito ? { query: { incognito: '1' } } : undefined);
}

function applyNet(ses) {
  const urls = [];
  if (C.blockAds) ADS.forEach(a => urls.push('*://*.' + a + '/*'));
  if (C.blockImages) urls.push('*://*/*'); else if (C.httpsOnly) urls.push('http://*/*');
  if (urls.length) ses.webRequest.onBeforeRequest({ urls }, (d, cb) => {
    const h = hostOf(d.url);
    if (C.blockAds && ADS.some(a => h === a || h.endsWith('.' + a))) return cb({ cancel: true });
    if (C.blockImages && d.resourceType === 'image') return cb({ cancel: true });
    if (C.httpsOnly && d.resourceType === 'mainFrame' && d.url.startsWith('http://') && !/^(localhost|127\.|\[::1\])/.test(h))
      return cb({ redirectURL: 'https://' + d.url.slice(7) });
    cb({});
  }); else ses.webRequest.onBeforeRequest(null);
  if (C.dnt) ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (d, cb) => { const h = { ...d.requestHeaders }; h.DNT = '1'; h['Sec-GPC'] = '1'; cb({ requestHeaders: h }); });
  else ses.webRequest.onBeforeSendHeaders(null);
  if (C.thirdCookies) ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (d, cb) => {
    if (d.resourceType !== 'mainFrame' && d.referrer && base(hostOf(d.referrer)) !== base(hostOf(d.url))) {
      const h = { ...d.responseHeaders };
      for (const k of Object.keys(h)) if (k.toLowerCase() === 'set-cookie') delete h[k];
      return cb({ responseHeaders: h });
    }
    cb({});
  }); else ses.webRequest.onHeadersReceived(null);
  // язык сайтов задаётся на уровне сессии, без перехвата каждого запроса
  if (ses._lang !== C.lang) { ses._lang = C.lang; try { ses.setUserAgent(ses.getUserAgent(), C.lang || undefined); } catch (e) {} }
}

function hook(ses) {
  if (hooked.has(ses)) return; hooked.add(ses); sessions.push(ses);
  ses.on('will-download', (e, item, wc) => {
    const host = wc.hostWebContents || wc, id = ++seq;
    items.set(id, item);
    if (!C.ask) {
      const dir = C.dlDir && fs.existsSync(C.dlDir) ? C.dlDir : app.getPath('downloads');
      let p = path.join(dir, item.getFilename());
      const { name, ext } = path.parse(p); let n = 1;
      while (fs.existsSync(p)) p = path.join(dir, `${name} (${n++})${ext}`);
      item.setSavePath(p);
    }
    const send = m => { if (!host.isDestroyed()) host.send('dl', { id, ...m }); };
    send({ type: 'start', name: item.getFilename(), total: item.getTotalBytes() });
    item.on('updated', (_, state) => send({ type: 'progress', state, name: item.getFilename(), received: item.getReceivedBytes(), total: item.getTotalBytes() }));
    item.once('done', (_, state) => { items.delete(id); send({ type: 'done', state, name: item.getFilename(), path: item.getSavePath() }); });
  });
  applyNet(ses);
  // Запрос разрешения: вместо системного окна спрашиваем в интерфейсе браузера
  ses.setPermissionRequestHandler((wc, perm, cb, det) => {
    const key = KEYMAP[perm];
    if (!key) return cb(SAFE.includes(perm));
    const host = wc.hostWebContents || wc;
    if (host.isDestroyed()) return cb(false);
    const origin = originOf(det.requestingUrl || wc.getURL());
    const d = decision(host, origin, key);
    if (d !== null) return cb(d);
    const id = ++pseq; pending.set(id, cb);
    host.send('perm-ask', { id, origin, key, media: det.mediaTypes || [] });
  });
  ses.setPermissionCheckHandler((wc, perm, origin) => {
    const key = KEYMAP[perm];
    if (!key) return true;
    const host = wc && (wc.hostWebContents || wc);
    return host ? decision(host, originOf(origin) || origin, key) === true : false;
  });
}

// Горячие клавиши, которые перехватываются даже когда фокус внутри страницы
const KEYS = new Set(['c:t', 'c:w', 'c:l', 'c:r', 'c:h', 'c:j', 'cs:n', 'cs:t', 'c:tab', 'cs:tab', 'c:=', 'c:+', 'cs:+', 'c:-', 'c:0', ':f5', ':f11']);
for (let n = 1; n <= 9; n++) KEYS.add('c:' + n);

app.on('web-contents-created', (_, c) => {
  if (c.getType() !== 'webview') return;
  hook(c.session);
  // правая кнопка в странице: меню рисует сам браузер (в интерфейсе), здесь только передаём данные
  c.on('context-menu', (e, p) => {
    const host = c.hostWebContents; if (!host || host.isDestroyed()) return;
    // координаты берём у самого курсора (а не из параметров страницы): они точны при любом масштабе экрана и страницы
    let cx, cy; const w = BrowserWindow.fromWebContents(host);
    if (w) { const pt = screen.getCursorScreenPoint(), b = w.getContentBounds(); cx = pt.x - b.x; cy = pt.y - b.y; }
    host.send('ctx', { wcid: c.id, x: p.x, y: p.y, cx, cy, link: p.linkURL, src: p.srcURL, media: p.mediaType, hasImg: p.hasImageContents,
      sel: p.selectionText, edit: p.isEditable, flags: p.editFlags, page: p.pageURL, spell: p.misspelledWord, sugg: p.dictionarySuggestions || [] });
  });
  c.setWindowOpenHandler(d => {
    if (C.blockPopups && d.disposition === 'new-window') return { action: 'deny' };
    c.hostWebContents.send('open-tab', d.url, d.disposition === 'background-tab');
    return { action: 'deny' };
  });
  c.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const combo = (i.control ? 'c' : '') + (i.shift ? 's' : '') + (i.alt ? 'a' : '') + ':' + i.key.toLowerCase();
    if (KEYS.has(combo)) { e.preventDefault(); c.hostWebContents.send('combo', combo); }
  });
});

/* ---------- расширения (распакованные, из папки) ---------- */
const extFile = path.join(app.getPath('userData'), 'extensions.json');
let EXT = [];
try { EXT = JSON.parse(fs.readFileSync(extFile, 'utf8')); } catch (e) {}
const saveExt = () => { try { fs.writeFileSync(extFile, JSON.stringify(EXT.map(({ path, enabled, name, version }) => ({ path, enabled, name, version })))); } catch (e) {} };
async function loadExt(e) {
  e.id = null; e.err = '';
  if (!e.enabled) return;
  try {
    const x = await session.defaultSession.loadExtension(e.path, { allowFileAccess: true });
    e.id = x.id; e.name = x.name; e.version = x.version;
  } catch (err) { e.err = String(err.message || err).slice(0, 160); }
}
const extView = () => EXT.map(({ path, enabled, name, version, err }) => ({ path, enabled, name, version, err }));
ipcMain.handle('ext-list', () => extView());
ipcMain.handle('ext-add', async e => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: 'Папка с расширением (где лежит manifest.json)', properties: ['openDirectory'] });
  if (r.canceled) return { ok: false };
  const dir = r.filePaths[0];
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) return { error: 'В этой папке нет файла manifest.json' };
  if (EXT.some(x => x.path === dir)) return { error: 'Это расширение уже добавлено' };
  const ent = { path: dir, enabled: true, name: path.basename(dir) };
  await loadExt(ent); EXT.push(ent); saveExt();
  return ent.err ? { error: ent.err } : { ok: true };
});
ipcMain.handle('ext-toggle', async (e, p, on) => {
  const x = EXT.find(i => i.path === p); if (!x) return;
  if (!on && x.id) { try { session.defaultSession.removeExtension(x.id); } catch (err) {} }
  x.enabled = on; await loadExt(x); saveExt();
});
ipcMain.handle('ext-remove', async (e, p) => {
  const x = EXT.find(i => i.path === p);
  if (x && x.id) { try { session.defaultSession.removeExtension(x.id); } catch (err) {} }
  EXT = EXT.filter(i => i.path !== p); saveExt();
});

/* ---------- прочие команды окна ---------- */
ipcMain.on('perm-reply', (_, id, allow) => { const cb = pending.get(id); if (cb) { pending.delete(id); cb(!!allow); } });
ipcMain.on('perm-set', (_, m) => { if (m.inc) return; P[m.o] = P[m.o] || {}; if (m.v) P[m.o][m.k] = m.v; else delete P[m.o][m.k]; });
ipcMain.on('perm-init', (_, p) => { P = p || {}; });
ipcMain.on('cfg', (e, c) => {
  C = { ...C, ...c };
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) { w.setAlwaysOnTop(!!c.onTop); if (!w._init) { w._init = true; if (c.startMax) w.maximize(); } }
  [session.defaultSession, ...sessions].forEach(s => { try { s.setSpellCheckerEnabled(!!C.spell); } catch (x) {} });
  [session.defaultSession, ...sessions].forEach(applyNet);
  const fl = JSON.stringify({ noHw: !!c.noHw, lowEnd: !!c.lowEnd, bgc: c.bgc || F.bgc || '' });
  if (fl !== lastFlags) { lastFlags = fl; try { fs.writeFileSync(flagFile, fl); } catch (x) {} }
});
ipcMain.handle('clear', async (e, what) => {
  for (const s of new Set([session.defaultSession, ...sessions])) {
    if (what !== 'cookies') await s.clearCache();
    if (what !== 'cache') await s.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
  }
  return true;
});
ipcMain.handle('pick-dir', async e => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory'] });
  return r.canceled ? '' : r.filePaths[0];
});
ipcMain.handle('import-file', async (e, kind) => {
  const f = kind === 'font' ? [{ name: 'Шрифты', extensions: ['ttf', 'otf', 'woff', 'woff2'] }]
    : [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] }];
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openFile'], filters: f });
  if (r.canceled || !r.filePaths[0]) return null;
  const src = r.filePaths[0], dir = path.join(app.getPath('userData'), kind + 's');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, Date.now() + '-' + path.basename(src));
  fs.copyFileSync(src, dest);
  return { path: dest, name: path.parse(src).name };
});
const winOf = e => BrowserWindow.fromWebContents(e.sender);
ipcMain.on('win-min', e => { const w = winOf(e); if (w) w.minimize(); });
ipcMain.on('win-max', e => { const w = winOf(e); if (w) (w.isMaximized() ? w.unmaximize() : w.maximize()); });
ipcMain.on('win-close', e => { const w = winOf(e); if (w) w.close(); });
ipcMain.handle('win-state', e => { const w = winOf(e); return { max: !!w && w.isMaximized(), full: !!w && w.isFullScreen() }; });
ipcMain.on('preconnect', (_, u) => { if (/^https?:/i.test(u || '')) { try { session.defaultSession.preconnect({ url: u, numSockets: 2 }); } catch (e) {} } });
ipcMain.on('ctx-do', (e, a) => {
  const wc = webContents.fromId(a.wcid); if (!wc || wc.isDestroyed()) return;
  if (a.op === 'copyImage') wc.copyImageAt(a.x, a.y);
  else if (a.op === 'inspect') wc.inspectElement(a.x, a.y);
});
ipcMain.on('incognito', () => create(true));
ipcMain.on('fullscreen', e => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setFullScreen(!w.isFullScreen()); });
ipcMain.on('relaunch', () => { app.relaunch(); app.exit(0); });
ipcMain.on('dl-open', (_, p) => { if (p) shell.openPath(p); });
ipcMain.on('dl-show', (_, p) => { if (p) shell.showItemInFolder(p); });
ipcMain.on('dl-cancel', (_, id) => { const i = items.get(id); if (i) i.cancel(); });

app.on('second-instance', () => { if (app.isReady()) create(false); });
app.whenReady().then(() => {
  if (!gotLock) return;
  Menu.setApplicationMenu(null);   // без стандартного меню: окно открывается быстрее
  create(false);                    // окно создаётся первым, расширения грузятся уже после
  setTimeout(async () => { for (const x of EXT) await loadExt(x); }, 0);
});
app.on('window-all-closed', async () => {
  if (C.clearOnExit) {
    try { await session.defaultSession.clearCache(); await session.defaultSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }); } catch (e) {}
  }
  app.quit();
});
