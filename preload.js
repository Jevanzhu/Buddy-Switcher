'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStatus: (product) => ipcRenderer.invoke('get-status', product),
  saveProfile: (product, name) => ipcRenderer.invoke('save-profile', product, name),
  switchTo: (product, name) => ipcRenderer.invoke('switch-to', product, name),
  deleteProfile: (product, name) => ipcRenderer.invoke('delete-profile', product, name),
  startFresh: (product) => ipcRenderer.invoke('start-fresh', product),
  openProfilesFolder: (product) => ipcRenderer.invoke('open-profiles-folder', product),
  syncGet: () => ipcRenderer.invoke('sync-get'),
  syncSave: (cfg) => ipcRenderer.invoke('sync-save', cfg),
  syncTest: () => ipcRenderer.invoke('sync-test'),
  syncList: () => ipcRenderer.invoke('sync-list'),
  syncPush: () => ipcRenderer.invoke('sync-push'),
  syncPull: () => ipcRenderer.invoke('sync-pull'),
  onLog: (cb) => ipcRenderer.on('app-log', (_e, msg) => cb(msg)),
  onStatus: (cb) => ipcRenderer.on('status-changed', (_e, payload) => cb(payload)),
  onSyncDone: (cb) => ipcRenderer.on('sync-done', (_e, payload) => cb(payload))
});
