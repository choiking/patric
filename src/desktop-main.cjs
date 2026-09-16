const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
let window;
let backend;
let sequence = 0;
let workspace = app.isPackaged ? os.homedir() : process.cwd();
let busy = false;
const pending = new Map();
const page = pathToFileURL(path.join(__dirname, 'desktop.html')).href;

function startBackend() {
  const bundled = path.join(process.resourcesPath, 'patric-bun');
  const bun = process.env.PATRIC_BUN || [path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun'].find(fs.existsSync) || 'bun';
  backend = spawn(app.isPackaged ? bundled : bun, [path.join(__dirname, 'desktop-backend.ts')], {
    cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], env: process.env
  });
  createInterface({ input: backend.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.event) window?.webContents.send('patric:event', message);
    else if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error)) : resolve(message.result);
    }
  });
  backend.stderr.on('data', data => process.stderr.write(data));
  const fail = () => {
    for (const { reject } of pending.values()) reject(new Error('The Patric engine stopped. Restart the app. Development mode requires Bun.'));
    pending.clear();
    backend = null;
    window?.webContents.send('patric:event', { event: 'error', data: 'The Patric engine stopped. Restart the app.' });
  };
  backend.on('error', fail);
  backend.on('exit', fail);
  backend.stdin.on('error', () => {});
}
function request(method, data) {
  if (!backend) return Promise.reject(new Error('Patric engine is unavailable. Restart the app.'));
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    backend.stdin.write(JSON.stringify({ id, method, data }) + '\n');
  });
}
function signal(method, data) {
  backend?.stdin.write(JSON.stringify({ method, data }) + '\n');
}
function trusted(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('Untrusted desktop request.');
}
function registerHandlers() {
  ipcMain.handle('patric:request', async (event, method, data) => {
    trusted(event);
    if (!['settings', 'saveSettings', 'models', 'chat'].includes(method)) throw new Error('Unknown request.');
    if (method !== 'chat') return request(method, data);
    if (busy) throw new Error('A response is already running.');
    busy = true;
    try { return await request(method, { messages: data.messages, cwd: workspace }); }
    finally { busy = false; }
  });
  ipcMain.on('patric:signal', (event, method, data) => {
    trusted(event);
    if (['stop', 'permission'].includes(method)) signal(method, data);
  });
  ipcMain.handle('patric:workspace', async event => {
    trusted(event);
    if (busy) throw new Error('Stop the response before changing projects.');
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: 'Open a project' });
    if (!result.canceled) {
      workspace = result.filePaths[0];
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(path.join(app.getPath('userData'), 'workspace.json'), JSON.stringify({ workspace }));
    }
    return workspace;
  });
  ipcMain.handle('patric:initial', event => { trusted(event); return { workspace }; });
}
function createWindow() {
  window = new BrowserWindow({ width: 1220, height: 840, minWidth: 800, minHeight: 600,
    title: 'Patric', backgroundColor: '#f8f7f4', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'desktop-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (busy && dialog.showMessageBoxSync(window, { type: 'question', message: 'Quit while Patric is working?', detail: 'The current response will be interrupted. Commands already started may continue.', buttons: ['Keep working', 'Quit'], defaultId: 0, cancelId: 0 }) === 0) event.preventDefault();
  });
  window.on('closed', () => { window = null; });
  window.loadFile(path.join(__dirname, 'desktop.html'));
}
app.whenReady().then(() => {
  app.setName('Patric');
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Patric', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
  ]));
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'workspace.json'), 'utf8'));
    if (typeof saved.workspace === 'string' && fs.statSync(saved.workspace).isDirectory()) workspace = saved.workspace;
  } catch { /* First launch or a moved project: use the default workspace. */ }
  startBackend();
  registerHandlers();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (!window) backend?.kill(); });
app.on('will-quit', () => backend?.kill());
