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
// Code mode stays unbound until the user opens a project; chat mode needs no folder.
let workspace = null;
// Every folder the user has opened, most recent first, so Code mode can switch between them.
let projects = [];
let mode = 'chat';
const MAX_PROJECTS = 12;
let busy = false;
const pending = new Map();
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;

function statePath() { return path.join(app.getPath('userData'), 'workspace.json'); }
function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}
function saveState() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({ workspace, projects, mode }));
  } catch { /* A read-only profile just means the next launch starts unbound. */ }
}
function rememberProject(target) {
  projects = [target, ...projects.filter(project => project !== target)].slice(0, MAX_PROJECTS);
}
function projectState() {
  return { workspace, projects };
}
function startBackend() {
  const bundled = path.join(process.resourcesPath, 'patric-bun');
  const bun = process.env.PATRIC_BUN || [path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun'].find(fs.existsSync) || 'bun';
  backend = spawn(app.isPackaged ? bundled : bun, [path.join(__dirname, 'backend.ts')], {
    cwd: workspace || os.homedir(), stdio: ['pipe', 'pipe', 'pipe'], env: process.env
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
    const requested = data.mode === 'chat' ? 'chat' : 'code';
    if (requested === 'code') {
      if (!workspace) throw new Error('Open a project folder to use Code mode.');
      if (!isDirectory(workspace)) throw new Error('That project folder is no longer available. Open it again.');
    }
    busy = true;
    try { return await request(method, { messages: data.messages, mode: requested, cwd: requested === 'code' ? workspace : undefined }); }
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
      rememberProject(workspace);
      saveState();
    }
    return projectState();
  });
  // Only folders the user already picked from the dialog can be bound, so the
  // renderer can switch projects without being able to name a new path itself.
  ipcMain.handle('patric:selectProject', (event, target) => {
    trusted(event);
    if (busy) throw new Error('Stop the response before changing projects.');
    if (!projects.includes(target)) throw new Error('That project is not on the list. Open the folder again.');
    if (!isDirectory(target)) throw new Error('That project folder is no longer available. Open it again.');
    workspace = target;
    rememberProject(target);
    saveState();
    return projectState();
  });
  ipcMain.handle('patric:forgetProject', (event, target) => {
    trusted(event);
    if (busy) throw new Error('Stop the response before changing projects.');
    projects = projects.filter(project => project !== target);
    // Forgetting the open project unbinds Code mode; the folder itself is untouched.
    if (workspace === target) workspace = null;
    saveState();
    return projectState();
  });
  ipcMain.handle('patric:mode', (event, value) => {
    trusted(event);
    if (busy) throw new Error('Stop the response before switching modes.');
    mode = value === 'chat' ? 'chat' : 'code';
    saveState();
    return mode;
  });
  ipcMain.handle('patric:initial', event => { trusted(event); return { ...projectState(), mode }; });
}
function createWindow() {
  window = new BrowserWindow({ width: 1220, height: 840, minWidth: 800, minHeight: 600,
    title: 'Patric', backgroundColor: '#f8f7f4', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (busy && dialog.showMessageBoxSync(window, { type: 'question', message: 'Quit while Patric is working?', detail: 'The current response will be interrupted. Commands already started may continue.', buttons: ['Keep working', 'Quit'], defaultId: 0, cancelId: 0 }) === 0) event.preventDefault();
  });
  window.on('closed', () => { window = null; });
  window.loadFile(path.join(__dirname, 'index.html'));
}
app.whenReady().then(() => {
  app.setName('Patric');
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Patric', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
  ]));
  try {
    const saved = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    // Folders that moved or were deleted drop off the list instead of failing later.
    const remembered = Array.isArray(saved.projects) ? saved.projects : [];
    projects = remembered.filter(project => typeof project === 'string' && isDirectory(project)).slice(0, MAX_PROJECTS);
    if (typeof saved.workspace === 'string' && isDirectory(saved.workspace)) {
      workspace = saved.workspace;
      rememberProject(workspace);
    }
    if (saved.mode === 'chat' || saved.mode === 'code') mode = saved.mode;
  } catch { /* First launch or a moved project: start in chat mode with no project. */ }
  if (mode === 'code' && !workspace) mode = 'chat';
  startBackend();
  registerHandlers();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (!window) backend?.kill(); });
app.on('will-quit', () => backend?.kill());
