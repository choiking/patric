const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('patric', {
  initial: () => ipcRenderer.invoke('patric:initial'),
  settings: () => ipcRenderer.invoke('patric:request', 'settings'),
  saveSettings: data => ipcRenderer.invoke('patric:request', 'saveSettings', data),
  models: () => ipcRenderer.invoke('patric:request', 'models'),
  chat: (messages, mode) => ipcRenderer.invoke('patric:request', 'chat', { messages, mode }),
  chooseWorkspace: () => ipcRenderer.invoke('patric:workspace'),
  setMode: mode => ipcRenderer.invoke('patric:mode', mode),
  stop: () => ipcRenderer.send('patric:signal', 'stop'),
  permission: (id, decision) => ipcRenderer.send('patric:signal', 'permission', { id, decision }),
  onEvent: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('patric:event', listener);
    return () => ipcRenderer.removeListener('patric:event', listener);
  }
});
