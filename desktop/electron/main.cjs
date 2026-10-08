/**
 * Panorama Maps — desktop/electron/main.cjs
 *
 * OPTIONAL: the same desktop app inside an Electron window, so it can be
 * packaged as an installer for Windows (.exe), macOS (.dmg) and Linux
 * (.AppImage / .deb) — no Node installation needed on the target machine.
 *
 *   cd desktop && npm install && npm start                 run in a window
 *   cd desktop && npm run dist:win|dist:mac|dist:linux     build installers
 *
 * Everything real lives in ../server.mjs, which this file only starts and
 * points a window at. Without Electron installed, `node desktop/main.mjs`
 * runs the exact same application in the browser with no install at all.
 */
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');

const DESKTOP_DIR = path.resolve(__dirname, '..');
let server = null;
let win = null;

/** Menu items drive the app through its own deep links (no IPC needed). */
function goto(link) {
  if (!server || !win) return;
  win.loadURL(`${server.url}#${link}`);
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Worlds library', accelerator: 'CmdOrCtrl+L', click: () => goto('worlds') },
        { type: 'separator' },
        { label: 'Save world file…', accelerator: 'CmdOrCtrl+S', click: () => goto('save-world') },
        { label: 'Open world file…', accelerator: 'CmdOrCtrl+O', click: () => goto('open-world') },
        { type: 'separator' },
        { label: 'Show worlds folder', click: () => shell.openPath(server?.app?.db?.dir || DESKTOP_DIR) },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Database location…',
          click: () => dialog.showMessageBox(win, {
            type: 'info', title: 'Worlds database', buttons: ['OK'],
            message: `Worlds database (${server?.app?.db?.engine})\n\n${server?.app?.db?.path}`,
          }),
        },
        { label: 'Panorama Maps on the web', click: () => shell.openExternal('https://github.com/ChibuikeOnuigbo/3dmapmaker') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { try { server?.app?.close(); } catch { /* already closed */ } });

app.whenReady().then(async () => {
  try {
    const { startDesktopApp } = await import(path.join(DESKTOP_DIR, 'server.mjs'));
    server = await startDesktopApp({
      port: Number(process.env.PM_PORT) || 7654,
      host: '127.0.0.1',
      quiet: true,
    });
  } catch (err) {
    dialog.showErrorBox('Panorama Maps could not start', String(err.message || err));
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#10131a',
    title: 'Panorama Maps',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  buildMenu();
  win.loadURL(server.url);
});
