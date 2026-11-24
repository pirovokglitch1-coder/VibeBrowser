const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path'), fs = require('fs');
let ask = false, seq = 0;
const items = new Map(), hooked = new WeakSet();

function create(incognito) {
  const w = new BrowserWindow({
    width: 1280, height: 800, minWidth: 700, minHeight: 450,
    backgroundColor: '#1c1b1f', autoHideMenuBar: true,
    webPreferences: { webviewTag: true, nodeIntegration: true, contextIsolation: false }
  });
  w.loadFile('index.html', incognito ? { query: { incognito: '1' } } : undefined);
}

// Загрузки: ловим скачивание в любой сессии (обычной и инкогнито)
function hook(ses) {
  if (hooked.has(ses)) return; hooked.add(ses);
  ses.on('will-download', (e, item, wc) => {
    const host = wc.hostWebContents || wc, id = ++seq;
    items.set(id, item);
    if (!ask) {
      const dir = app.getPath('downloads');
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
}

app.on('web-contents-created', (_, c) => {
  if (c.getType() !== 'webview') return;
  hook(c.session);
  c.setWindowOpenHandler(({ url }) => { c.hostWebContents.send('open-tab', url); return { action: 'deny' }; });
  c.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown' || !i.control) return;
    const k = i.key.toLowerCase();
    if (i.shift && k === 'n') { e.preventDefault(); c.hostWebContents.send('key', 'n'); }
    else if (!i.shift && 'twlrhj'.includes(k) && k.length === 1) { e.preventDefault(); c.hostWebContents.send('key', k); }
  });
});

ipcMain.on('incognito', () => create(true));
ipcMain.on('set-ask', (_, v) => { ask = !!v; });
ipcMain.on('dl-open', (_, p) => { if (p) shell.openPath(p); });
ipcMain.on('dl-show', (_, p) => { if (p) shell.showItemInFolder(p); });
ipcMain.on('dl-cancel', (_, id) => { const i = items.get(id); if (i) i.cancel(); });

app.whenReady().then(() => create(false));
app.on('window-all-closed', () => app.quit());
