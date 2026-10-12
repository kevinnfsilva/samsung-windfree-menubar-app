const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, callback) {
  ipcRenderer.on(channel, (_event, payload) => callback(payload));
}

contextBridge.exposeInMainWorld('ac', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('state:get'),
  set: (key, value) => ipcRenderer.send('ac:set', key, value),
  refresh: () => ipcRenderer.send('ac:refresh'),
  login: () => ipcRenderer.send('ac:login'),
  cancelLogin: () => ipcRenderer.send('ac:cancel-login'),
  listDevices: () => ipcRenderer.send('ac:list-devices'),
  useDevice: (id) => ipcRenderer.send('ac:use-device', id),
  run: (action) => ipcRenderer.send('ac:run', action),
  hide: () => ipcRenderer.send('panel:hide'),
  setTrayIcon: (images) => ipcRenderer.send('tray:icon', images),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (enabled) => ipcRenderer.send('autostart:set', enabled),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  saveFavorite: (nome) => ipcRenderer.invoke('favorite:save', nome),
  applyFavorite: (id) => ipcRenderer.invoke('favorite:apply', id),
  deleteFavorite: (id) => ipcRenderer.invoke('favorite:delete', id),
  setTimer: (acao, minutos) => ipcRenderer.invoke('timer:set', acao, minutos),
  clearTimer: () => ipcRenderer.invoke('timer:clear'),
  saveSchedule: (agenda) => ipcRenderer.invoke('schedule:save', agenda),
  deleteSchedule: (id) => ipcRenderer.invoke('schedule:delete', id),
  getHistory: () => ipcRenderer.invoke('history:get'),
  openUpdate: () => ipcRenderer.send('update:open'),
  onState: (callback) => listen('state', callback),
  onSettings: (callback) => listen('settings', callback),
  onTheme: (callback) => listen('theme', callback),
  onLocale: (callback) => listen('locale', callback),
  onUpdate: (callback) => listen('update', callback),
  onShow: (callback) => listen('panel:show', callback),
  onHide: (callback) => listen('panel:hide', callback),
});
