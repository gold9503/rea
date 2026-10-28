// REA Studio — desktop shell (Electron). Serves the web app from a private app:// origin
// so IndexedDB autosave, AudioWorklet recording and microphone access behave like on https.
const { app, BrowserWindow, protocol, net, session, systemPreferences, shell, Menu } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#15181d',
    title: 'REA Studio',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL('app://rea/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(ROOT, rel || 'index.html'));
    if (!file.startsWith(ROOT)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Only the microphone (for recording) is ever granted.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(permission === 'media' && !(details.mediaTypes || []).includes('video'));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media');

  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch (e) { /* user can grant later */ }
  } else {
    Menu.setApplicationMenu(null);
  }

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
