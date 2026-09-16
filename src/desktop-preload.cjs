const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('patric', {
  initial: () => ipcRenderer.invoke('patric:initial'),
  settings: () => ipcRenderer.invoke('patric:request', 'settings'),
  saveSettings: data => ipcRenderer.invoke('patric:request', 'saveSettings', data),
  models: () => ipcRenderer.invoke('patric:request', 'models'),
  chat: messages => ipcRenderer.invoke('patric:request', 'chat', { messages }),
  chooseWorkspace: () => ipcRenderer.invoke('patric:workspace'),
  stop: () => ipcRenderer.send('patric:signal', 'stop'),
  permission: (id, decision) => ipcRenderer.send('patric:signal', 'permission', { id, decision }),
  onEvent: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('patric:event', listener);
    return () => ipcRenderer.removeListener('patric:event', listener);
  }
});
