const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('vibepaperDesktop', {
  getActiveProject: () => ipcRenderer.invoke('desktop:project:get-active'),
  createProject: (name) => ipcRenderer.invoke('desktop:project:create', name),
  openProject: () => ipcRenderer.invoke('desktop:project:open'),
  backupProject: (projectId) => ipcRenderer.invoke('desktop:project:backup', projectId),
  restoreBackup: () => ipcRenderer.invoke('desktop:project:restore-backup'),
  importImage: (projectId) => ipcRenderer.invoke('desktop:asset:import-image', projectId),
  listAssets: (projectId) => ipcRenderer.invoke('desktop:asset:list', projectId),
  loadCanvas: (projectId, canvasId) => ipcRenderer.invoke('desktop:canvas:load', projectId, canvasId),
  saveCanvas: (input) => ipcRenderer.invoke('desktop:canvas:save', input),
  listTasks: (projectId, limit) => ipcRenderer.invoke('desktop:task:list', projectId, limit),
  cancelTask: (projectId, taskId) => ipcRenderer.invoke('desktop:task:cancel', projectId, taskId),
  createTextTask: (input) => ipcRenderer.invoke('desktop:task:create-text', input),
  readTaskOutput: (projectId, taskId) => ipcRenderer.invoke('desktop:task:read-output', projectId, taskId),
  getLocalTextModel: () => ipcRenderer.invoke('desktop:model:get-local-text'),
  discoverLocalModels: (endpoint) => ipcRenderer.invoke('desktop:model:discover-local', endpoint),
  saveLocalTextModel: (config) => ipcRenderer.invoke('desktop:model:save-local-text', config),
  clearLocalTextModel: () => ipcRenderer.invoke('desktop:model:clear-local-text'),
})
