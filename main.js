const { app, BrowserWindow, ipcMain, shell, dialog, session } = require('electron');
const path = require('path'), fs = require('fs');

// Аппаратное ускорение выключается только до старта приложения — читаем флаг из файла
const flagFile = path.join(app.getPath('userData'), 'flags.json');
try { if (JSON.parse(fs.readFileSync(flagFile, 'utf8')).noHw) app.disableHardwareAcceleration(); } catch (e) {}

// Настройки, которые приходят из окна браузера (команда 'cfg')
let C = { ask: false, dlDir: '', blockAds: false, blockImages: false, dnt: false, thirdCookies: false, httpsOnly: false,
  blockPopups: true, perm: { media: 'ask', geo: 'ask', notif: 'ask' }, lang: '', spell: true, clearOnExit: false };
let seq = 0;
const items = new Map(), hooked = new WeakSet(), sessions = [];
const ADS = ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com', 'googletagmanager.com',
  'adservice.google.com', 'connect.facebook.net', 'adnxs.com', 'taboola.com', 'outbrain.com', 'scorecardresearch.com', 'hotjar.com',
  'mc.yandex.ru', 'an.yandex.ru', 'yandexadexchange.net', 'top-fwz1.mail.ru', 'criteo.com', 'amazon-adsystem.com'];
const hostOf = u => { try { return new URL(u).hostname; } catch (e) { return ''; } };
const base = h => h.split('.').slice(-2).join('.');

function create(incognito) {
  const w = new BrowserWindow({
    width: 1280, height: 800, minWidth: 700, minHeight: 450, backgroundColor: '#1c1b1f', autoHideMenuBar: true,
    webPreferences: { webviewTag: true, nodeIntegration: true, contextIsolation: false }
  });
  w.loadFile('index.html', incognito ? { query: { incognito: '1' } } : undefined);
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
  ses.webRequest.onBeforeRequest((d, cb) => {
    const h = hostOf(d.url);
    if (C.blockAds && ADS.some(a => h === a || h.endsWith('.' + a))) return cb({ cancel: true });
    if (C.blockImages && d.resourceType === 'image') return cb({ cancel: true });
    if (C.httpsOnly && d.resourceType === 'mainFrame' && d.url.startsWith('http://') && !/^(localhost|127\.|\[::1\])/.test(h))
      return cb({ redirectURL: 'https://' + d.url.slice(7) });
    cb({});
  });
  ses.webRequest.onBeforeSendHeaders((d, cb) => {
    const h = { ...d.requestHeaders };
    if (C.dnt) { h.DNT = '1'; h['Sec-GPC'] = '1'; }
    if (C.lang) h['Accept-Language'] = C.lang;
    cb({ requestHeaders: h });
  });
  ses.webRequest.onHeadersReceived((d, cb) => {
    if (C.thirdCookies && d.resourceType !== 'mainFrame' && d.referrer && base(hostOf(d.referrer)) !== base(hostOf(d.url))) {
      const h = { ...d.responseHeaders };
      for (const k of Object.keys(h)) if (k.toLowerCase() === 'set-cookie') delete h[k];
      return cb({ responseHeaders: h });
    }
    cb({});
  });
  ses.setPermissionRequestHandler((wc, perm, cb, det) => {
    const key = { media: 'media', geolocation: 'geo', notifications: 'notif' }[perm];
    if (!key) return cb(['fullscreen', 'clipboard-sanitized-write', 'pointerLock'].includes(perm));
    const mode = C.perm[key];
    if (mode !== 'ask') return cb(mode === 'allow');
    const what = { media: 'камере и микрофону', geo: 'вашему местоположению', notif: 'уведомлениям' }[key];
    const win = BrowserWindow.fromWebContents(wc.hostWebContents || wc);
    dialog.showMessageBox(win, { type: 'question', buttons: ['Разрешить', 'Блокировать'], defaultId: 1, cancelId: 1,
      message: `${hostOf(det.requestingUrl || wc.getURL()) || 'Сайт'} запрашивает доступ к ${what}` }).then(r => cb(r.response === 0));
  });
}

// Горячие клавиши, которые перехватываются даже когда фокус внутри страницы
const KEYS = new Set(['c:t', 'c:w', 'c:l', 'c:r', 'c:h', 'c:j', 'cs:n', 'cs:t', 'c:tab', 'cs:tab', 'c:=', 'c:+', 'cs:+', 'c:-', 'c:0', ':f5', ':f11']);
for (let n = 1; n <= 9; n++) KEYS.add('c:' + n);

app.on('web-contents-created', (_, c) => {
  if (c.getType() !== 'webview') return;
  hook(c.session);
  c.setWindowOpenHandler(d => {
    if (C.blockPopups && d.disposition === 'new-window') return { action: 'deny' }; // скриптовые всплывающие окна
    c.hostWebContents.send('open-tab', d.url, d.disposition === 'background-tab');
    return { action: 'deny' };
  });
  c.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const combo = (i.control ? 'c' : '') + (i.shift ? 's' : '') + (i.alt ? 'a' : '') + ':' + i.key.toLowerCase();
    if (KEYS.has(combo)) { e.preventDefault(); c.hostWebContents.send('combo', combo); }
  });
});

ipcMain.on('cfg', (e, c) => {
  C = { ...C, ...c };
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) { w.setAlwaysOnTop(!!c.onTop); if (!w._init) { w._init = true; if (c.startMax) w.maximize(); } }
  [session.defaultSession, ...sessions].forEach(s => { try { s.setSpellCheckerEnabled(!!C.spell); } catch (x) {} });
  try { fs.writeFileSync(flagFile, JSON.stringify({ noHw: !!c.noHw })); } catch (x) {}
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
ipcMain.on('incognito', () => create(true));
ipcMain.on('fullscreen', e => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setFullScreen(!w.isFullScreen()); });
ipcMain.on('relaunch', () => { app.relaunch(); app.exit(0); });
ipcMain.on('dl-open', (_, p) => { if (p) shell.openPath(p); });
ipcMain.on('dl-show', (_, p) => { if (p) shell.showItemInFolder(p); });
ipcMain.on('dl-cancel', (_, id) => { const i = items.get(id); if (i) i.cancel(); });

app.whenReady().then(() => create(false));
app.on('window-all-closed', async () => {
  if (C.clearOnExit) {
    try { await session.defaultSession.clearCache(); await session.defaultSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }); } catch (e) {}
  }
  app.quit();
});
