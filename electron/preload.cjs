const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('camnet', {
  getInfo: () => ipcRenderer.invoke('get-info'),
  openBrowser: (url) => ipcRenderer.send('open-browser', url),
  quit: () => ipcRenderer.send('quit'),
  onStartError: (callback) => ipcRenderer.on('start-error', (_event, message) => callback(message)),
  getPermissions: () => ipcRenderer.invoke('get-permissions'),
  getCameras: () => ipcRenderer.invoke('get-cameras'),
  deleteCamera: (id) => ipcRenderer.invoke('delete-camera', id),
  removeFirewallRule: () => ipcRenderer.invoke('remove-firewall-rule'),
  addFirewallRule: () => ipcRenderer.invoke('add-firewall-rule'),
  getDataDir: () => ipcRenderer.invoke('get-data-dir'),
  onPublisherOnline: (cb) => ipcRenderer.on('publisher-online', (_e, info) => cb(info)),
  onPublisherOffline: (cb) => ipcRenderer.on('publisher-offline', (_e, info) => cb(info))
});
