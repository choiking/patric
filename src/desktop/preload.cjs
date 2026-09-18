const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('patric', {
  initial: () => ipcRenderer.invoke('patric:initial'),
  settings: () => ipcRenderer.invoke('patric:request', 'settings'),
  saveSettings: data => ipcRenderer.invoke('patric:request', 'saveSettings', data),
  models: () => ipcRenderer.invoke('patric:request', 'models'),
  chat: (messages, mode, conversationId) => ipcRenderer.invoke('patric:request', 'chat', { messages, mode, conversationId }),
  chooseWorkspace: () => ipcRenderer.invoke('patric:workspace'),
  selectProject: path => ipcRenderer.invoke('patric:selectProject', path),
  projectMenu: path => ipcRenderer.invoke('patric:projectMenu', path),
  forgetProject: path => ipcRenderer.invoke('patric:forgetProject', path),
  setMode: mode => ipcRenderer.invoke('patric:mode', mode),
  stop: conversationId => ipcRenderer.send('patric:signal', 'stop', { conversationId }),
  permission: (id, decision, conversationId) => ipcRenderer.send('patric:signal', 'permission', { id, decision, conversationId }),
  onEvent: callback => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('patric:event', listener);
    return () => ipcRenderer.removeListener('patric:event', listener);
  }
});
