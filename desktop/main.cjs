const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const { randomUUID } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdir, readFile, rename, writeFile, unlink } = require('node:fs/promises');

app.setName('JarviSync');
if (process.platform === 'win32') app.setAppUserModelId('Jarvis.JarviSync');
// A packaged .app carries its own icon and Dock name. Running from source the host process is
// Electron itself, so at least the Dock icon is replaced; its name stays Electron until packaged.
if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(join(__dirname, 'assets', 'jarvisync.png'));
const projectRoot = resolve(__dirname, '..');
const desktopShellId = require('./shell-identity.cjs').computeDesktopShellId(projectRoot);
const workspaceMode = process.env.NODEBOARD_DESKTOP_MODE === 'workspace';
const workspaceUrl = 'http://127.0.0.1:4317';
const publishedDistDir = join(projectRoot, 'dist');
const artifactRoot = join(projectRoot, 'artifacts');
const requestedDesktopDistDir = process.env.NODEBOARD_DESKTOP_DIST_DIR;
const requestedDistRelative = requestedDesktopDistDir ? relative(artifactRoot, resolve(requestedDesktopDistDir)) : null;
if (requestedDistRelative && (requestedDistRelative === '..' || requestedDistRelative.startsWith(`..${sep}`) || isAbsolute(requestedDistRelative))) {
  throw new Error('NODEBOARD_DESKTOP_DIST_DIR 只能指向仓库 artifacts 下的候选产物。');
}
const desktopDistDir = requestedDesktopDistDir ? resolve(requestedDesktopDistDir) : publishedDistDir;
const desktopDataDir = resolve(process.env.NODEBOARD_DESKTOP_DATA_DIR || join(app.getPath('appData'), 'Nodeboard'));
mkdirSync(desktopDataDir, { recursive: true });
app.setPath('userData', desktopDataDir);
const oneInstance = app.requestSingleInstanceLock();
let window;
let service;
let stopping = false;
let loadedBuildId = null;
let desktopOrigin = null;
const endpointPath = () => join(app.getPath('userData'), 'connection.json');
const readyStatePath = () => join(app.getPath('userData'), 'workspace-ready.json');

function windowState() {
  return {
    isMaximized: Boolean(window?.isMaximized()),
    isFullScreen: Boolean(window?.isFullScreen()),
  };
}

function sendWindowState() {
  const target = window;
  // Windows can emit a fullscreen event before isFullScreen() reflects it.
  setImmediate(() => {
    if (!target || target.isDestroyed() || target !== window) return;
    target.webContents.send('desktop-window:state', windowState());
  });
}

function isCurrentDesktopRenderer(event) {
  if (!window || event.sender.id !== window.webContents.id || !desktopOrigin) return false;
  try {
    return new URL(event.senderFrame.url).origin === desktopOrigin;
  } catch {
    return false;
  }
}

function requireCurrentDesktopRenderer(event) {
  if (!isCurrentDesktopRenderer(event)) throw new Error('桌面窗口控制只允许来自当前应用。');
}

function registerWindowControls() {
  ipcMain.handle('desktop-window:get-state', event => {
    requireCurrentDesktopRenderer(event);
    return windowState();
  });
  ipcMain.handle('desktop-window:minimize', event => {
    requireCurrentDesktopRenderer(event);
    window?.minimize();
  });
  ipcMain.handle('desktop-window:toggle-maximize', event => {
    requireCurrentDesktopRenderer(event);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.handle('desktop-window:toggle-full-screen', event => {
    requireCurrentDesktopRenderer(event);
    if (window) window.setFullScreen(!window.isFullScreen());
  });
  ipcMain.handle('desktop-window:close', event => {
    requireCurrentDesktopRenderer(event);
    window?.close();
  });
}

async function writeReadyState(url) {
  const path = readyStatePath();
  const temp = `${path}.${process.pid}-${randomUUID()}.tmp`;
  await mkdir(app.getPath('userData'), { recursive: true });
  try {
    await writeFile(temp, `${JSON.stringify({ mode: 'workspace', ready: true, pid: process.pid, url, profile: app.getPath('userData'), buildId: loadedBuildId, desktopShellId, loadedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function removeOwnReadyState() {
  try {
    const state = JSON.parse(await readFile(readyStatePath(), 'utf8'));
    if (state.pid === process.pid) await unlink(readyStatePath());
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}

if (!oneInstance) app.quit();
else {
  app.on('second-instance', async () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
    if (workspaceMode) {
      try {
        const response = await fetch(`${workspaceUrl}/api/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
        const nextBuildId = response.ok ? (await response.json()).buildId : null;
        if (nextBuildId && nextBuildId !== loadedBuildId && window) {
          await window.loadURL(workspaceUrl);
          loadedBuildId = nextBuildId;
          await writeReadyState(workspaceUrl);
        }
      } catch { /* Keep the current window usable if the service is restarting. */ }
    }
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    let url;
    if (workspaceMode) {
      await unlink(readyStatePath()).catch(error => { if (error.code !== 'ENOENT') throw error; });
      url = workspaceUrl;
    } else {
      const dataDir = join(app.getPath('userData'), 'data');
      let endpoint;
      try {
        const identity = JSON.parse(await readFile(join(dataDir, 'instance.json'), 'utf8'));
        const candidate = JSON.parse(await readFile(join(dataDir, 'agent-endpoint.json'), 'utf8'));
        if (identity.boardInstanceId === candidate.boardInstanceId && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(candidate.url)) {
          const response = await fetch(`${candidate.url}/api/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
          if (response.ok && (await response.json()).boardInstanceId === identity.boardInstanceId) endpoint = candidate;
        }
      } catch { /* A stopped service is started below with the same data directory. */ }
      if (endpoint) url = endpoint.url;
      else {
        const { startServer } = await import(pathToFileURL(join(projectRoot, 'server', 'index.mjs')).href);
        service = await startServer({ port: 0, dataDir, distDir: desktopDistDir });
        url = service.url;
      }
      await mkdir(app.getPath('userData'), { recursive: true });
      await writeFile(endpointPath(), JSON.stringify({ url, pid: endpoint?.pid || process.pid }));
    }
    desktopOrigin = new URL(url).origin;
    registerWindowControls();
    // A workspace can still serve the previous verified frontend during an
    // update. Keep native controls until that frontend advertises its own.
    let hasDesktopControls = false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      hasDesktopControls = response.ok && (await response.text()).includes('name="jarvisync-desktop-controls" content="1"');
    } catch { /* The native frame remains a usable fallback. */ }
    // macOS puts its window buttons in the frame itself. Hiding the title bar keeps the traffic
    // lights and still hands the strip to the frontend; a frameless window would drop them.
    const insetTitleBar = hasDesktopControls && process.platform === 'darwin';
    window = new BrowserWindow({
      width: 1480, height: 960, minWidth: 860, minHeight: 600,
      title: 'JarviSync · 项目画布', backgroundColor: '#F3EEE6', show: false,
      icon: join(__dirname, 'assets', process.platform === 'win32' ? 'jarvisync.ico' : 'jarvisync.png'),
      frame: insetTitleBar ? true : !hasDesktopControls,
      ...(insetTitleBar ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 13, y: 9 } } : {}),
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: join(__dirname, 'preload.cjs'),
      },
    });
    if (process.platform === 'win32') {
      const relaunchCommand = workspaceMode
        ? `"${join(__dirname, 'JarviSync.exe')}"`
        : app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${projectRoot}"`;
      window.setAppDetails({ appId: 'Jarvis.JarviSync', appIconPath: join(__dirname, 'assets', 'jarvisync.ico'), appIconIndex: 0, relaunchCommand, relaunchDisplayName: 'JarviSync 看板' });
    }
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url) || /^codex:\/\/plugins\/jarvisync\?marketplacePath=/i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    const allowedOrigin = new URL(url).origin;
    window.webContents.on('will-navigate', (event, targetUrl) => {
      if (new URL(targetUrl).origin !== allowedOrigin) { event.preventDefault(); if (/^https?:\/\//i.test(targetUrl) || /^codex:\/\/plugins\/jarvisync\?marketplacePath=/i.test(targetUrl)) void shell.openExternal(targetUrl); }
    });
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => { window = null; });
    window.on('maximize', sendWindowState);
    window.on('unmaximize', sendWindowState);
    window.on('enter-full-screen', sendWindowState);
    window.on('leave-full-screen', sendWindowState);
    window.webContents.on('did-finish-load', sendWindowState);
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      if (input.key === 'F11') {
        event.preventDefault();
        window?.setFullScreen(!window.isFullScreen());
      } else if (input.key === 'Escape' && window?.isFullScreen()) {
        event.preventDefault();
        window.setFullScreen(false);
      }
    });
    if (workspaceMode) {
      try {
        const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
        if (response.ok) loadedBuildId = (await response.json()).buildId || null;
      } catch { /* A legacy service still opens through the existing launcher. */ }
    }
    await window.loadURL(url);
    if (workspaceMode) await writeReadyState(url);
  }).catch(async error => {
    dialog.showErrorBox('JarviSync 未能启动', error.message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (stopping) return;
    event.preventDefault();
    stopping = true;
    void (async () => {
      try {
        if (service) { await service.close(); await unlink(endpointPath()).catch(() => {}); }
        if (workspaceMode) await removeOwnReadyState().catch(() => {});
      }
      finally { app.quit(); }
    })();
  });
}
