const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } = require('electron');
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
const runs = new Map();
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
function startBackend(conversationId) {
  const pending = new Map();
  const engine = { pending, child: null };
  const bundled = path.join(process.resourcesPath, 'patric-bun');
  const bun = process.env.PATRIC_BUN || [path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun'].find(fs.existsSync) || 'bun';
  const child = engine.child = spawn(app.isPackaged ? bundled : bun, [path.join(__dirname, 'backend.ts')], {
    cwd: workspace || os.homedir(), stdio: ['pipe', 'pipe', 'pipe'], env: process.env
  });
  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.event) window?.webContents.send('patric:event', { ...message, conversationId });
    else if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error)) : resolve(message.result);
    }
  });
  child.stderr.on('data', data => process.stderr.write(data));
  const fail = () => {
    for (const { reject } of pending.values()) reject(new Error('The Patric engine stopped. Restart the app. Development mode requires Bun.'));
    pending.clear();
    engine.child = null;
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', () => {});
  return engine;
}
function request(method, data, engine = backend) {
  if (!engine?.child) return Promise.reject(new Error('Patric engine is unavailable. Restart the app.'));
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    engine.pending.set(id, { resolve, reject });
    engine.child.stdin.write(JSON.stringify({ id, method, data }) + '\n');
  });
}
function signal(method, data) {
  runs.get(data?.conversationId)?.child?.stdin.write(JSON.stringify({ method, data }) + '\n');
}
function trusted(event) {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('Untrusted desktop request.');
}
function registerHandlers() {
  ipcMain.handle('patric:request', async (event, method, data) => {
    trusted(event);
    if (!['settings', 'saveSettings', 'models', 'chat'].includes(method)) throw new Error('Unknown request.');
    if (method !== 'chat') return request(method, data);
    const conversationId = data?.conversationId;
    if (typeof conversationId !== 'string' || !conversationId) throw new Error('Invalid conversation ID.');
    if (runs.has(conversationId)) throw new Error('A response is already running in this chat.');
    const requested = data.mode === 'chat' ? 'chat' : 'code';
    if (requested === 'code') {
      if (!workspace) throw new Error('Open a project folder to use Code mode.');
      if (!isDirectory(workspace)) throw new Error('That project folder is no longer available. Open it again.');
    }
    // Tools use process.cwd(), so each running conversation needs its own process.
    const engine = startBackend(conversationId);
    runs.set(conversationId, engine);
    try { return await request(method, { messages: data.messages, mode: requested, cwd: requested === 'code' ? workspace : undefined }, engine); }
    finally { runs.delete(conversationId); engine.child?.kill(); }
  });
  ipcMain.on('patric:signal', (event, method, data) => {
    trusted(event);
    if (['stop', 'permission'].includes(method)) signal(method, data);
  });
  ipcMain.handle('patric:workspace', async event => {
    trusted(event);
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
  ipcMain.handle('patric:projectMenu', (event, target) => {
    trusted(event);
    if (!projects.includes(target)) return null;
    return new Promise(resolve => {
      const menu = Menu.buildFromTemplate([
        { label: 'New chat', click: () => resolve('new-chat') },
        { type: 'separator' },
        { label: 'Remove from projects', click: () => resolve('remove') }
      ]);
      menu.popup({ window, callback: () => resolve(null) });
    });
  });
  ipcMain.handle('patric:selectProject', (event, target) => {
    trusted(event);
    if (!projects.includes(target)) throw new Error('That project is not on the list. Open the folder again.');
    if (!isDirectory(target)) throw new Error('That project folder is no longer available. Open it again.');
    workspace = target;
    rememberProject(target);
    saveState();
    return projectState();
  });
  ipcMain.handle('patric:forgetProject', (event, target) => {
    trusted(event);
    projects = projects.filter(project => project !== target);
    // Forgetting the open project unbinds Code mode; the folder itself is untouched.
    if (workspace === target) workspace = null;
    saveState();
    return projectState();
  });
  ipcMain.handle('patric:mode', (event, value) => {
    trusted(event);
    mode = value === 'chat' ? 'chat' : 'code';
    saveState();
    return mode;
  });
  ipcMain.handle('patric:initial', event => { trusted(event); return { ...projectState(), mode }; });
}
function createWindow() {
  window = new BrowserWindow({ width: 1220, height: 840, minWidth: 800, minHeight: 600,
    title: 'Patric', backgroundColor: nativeTheme.shouldUseDarkColors ? '#212121' : '#ffffff', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (runs.size && dialog.showMessageBoxSync(window, { type: 'question', message: 'Quit while Patric is working?', detail: 'The current response will be interrupted. Commands already started may continue.', buttons: ['Keep working', 'Quit'], defaultId: 0, cancelId: 0 }) === 0) event.preventDefault();
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
  backend = startBackend();
  registerHandlers();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (!window) backend?.child?.kill(); });
app.on('will-quit', () => { backend?.child?.kill(); for (const engine of runs.values()) engine.child?.kill(); });
