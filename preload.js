'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  saveProfile: (name) => ipcRenderer.invoke('save-profile', name),
  switchTo: (name) => ipcRenderer.invoke('switch-to', name),
  deleteProfile: (name) => ipcRenderer.invoke('delete-profile', name),
  openProfilesFolder: () => ipcRenderer.invoke('open-profiles-folder'),
  onLog: (cb) => ipcRenderer.on('app-log', (_e, msg) => cb(msg))
});
