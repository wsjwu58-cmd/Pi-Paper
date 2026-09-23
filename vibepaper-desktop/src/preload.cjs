const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('vibepaperDesktop', {
  getActiveProject: () => ipcRenderer.invoke('desktop:project:get-active'),
  createProject: (name) => ipcRenderer.invoke('desktop:project:create', name),
  openProject: () => ipcRenderer.invoke('desktop:project:open'),
  backupProject: (projectId) => ipcRenderer.invoke('desktop:project:backup', projectId),
  importImage: (projectId) => ipcRenderer.invoke('desktop:asset:import-image', projectId),
  listAssets: (projectId) => ipcRenderer.invoke('desktop:asset:list', projectId),
  loadCanvas: (projectId, canvasId) => ipcRenderer.invoke('desktop:canvas:load', projectId, canvasId),
  saveCanvas: (input) => ipcRenderer.invoke('desktop:canvas:save', input),
})
