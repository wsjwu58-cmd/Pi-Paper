const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('vibepaperDesktop', {
  getActiveProject: () => ipcRenderer.invoke('desktop:project:get-active'),
  listRecentProjects: () => ipcRenderer.invoke('desktop:project:list-recent'),
  openRecentProject: (projectId) => ipcRenderer.invoke('desktop:project:open-recent', projectId),
  createProject: (name) => ipcRenderer.invoke('desktop:project:create', name),
  openProject: () => ipcRenderer.invoke('desktop:project:open'),
  backupProject: (projectId) => ipcRenderer.invoke('desktop:project:backup', projectId),
  restoreBackup: () => ipcRenderer.invoke('desktop:project:restore-backup'),
  importImage: (projectId) => ipcRenderer.invoke('desktop:asset:import-image', projectId),
  importLocalAsset: (projectId) => ipcRenderer.invoke('desktop:asset:import-local', projectId),
  saveTaskOutputToLibrary: (projectId, taskId) => ipcRenderer.invoke('desktop:asset:save-task-output', projectId, taskId),
  listAssets: (projectId) => ipcRenderer.invoke('desktop:asset:list', projectId),
  renameAsset: (projectId, assetId, name) => ipcRenderer.invoke('desktop:asset:rename', projectId, assetId, name),
  replaceImage: (projectId, assetId) => ipcRenderer.invoke('desktop:asset:replace-image', projectId, assetId),
  replaceAudio: (projectId, assetId) => ipcRenderer.invoke('desktop:asset:replace-audio', projectId, assetId),
  deleteAsset: (projectId, assetId) => ipcRenderer.invoke('desktop:asset:delete', projectId, assetId),
  loadCanvas: (projectId, canvasId) => ipcRenderer.invoke('desktop:canvas:load', projectId, canvasId),
  exportCanvas: (projectId, canvasId) => ipcRenderer.invoke('desktop:canvas:export', projectId, canvasId),
  createNode: (input) => ipcRenderer.invoke('desktop:canvas:create-node', input),
  updateNode: (input) => ipcRenderer.invoke('desktop:canvas:update-node', input),
  deleteNode: (input) => ipcRenderer.invoke('desktop:canvas:delete-node', input),
  saveCanvas: (input) => ipcRenderer.invoke('desktop:canvas:save', input),
  connectEdge: (input) => ipcRenderer.invoke('desktop:canvas:connect', input),
  deleteEdge: (input) => ipcRenderer.invoke('desktop:canvas:delete-edge', input),
  addGroup: (input) => ipcRenderer.invoke('desktop:canvas:group:add', input),
  updateGroup: (input) => ipcRenderer.invoke('desktop:canvas:group:update', input),
  deleteGroup: (input) => ipcRenderer.invoke('desktop:canvas:group:delete', input),
  addStack: (input) => ipcRenderer.invoke('desktop:canvas:stack:add', input),
  updateStack: (input) => ipcRenderer.invoke('desktop:canvas:stack:update', input),
  extractFromStack: (input) => ipcRenderer.invoke('desktop:canvas:stack:extract', input),
  deleteStack: (input) => ipcRenderer.invoke('desktop:canvas:stack:delete', input),
  listTasks: (projectId, limit) => ipcRenderer.invoke('desktop:task:list', projectId, limit),
  searchTasks: (projectId, query) => ipcRenderer.invoke('desktop:task:search', projectId, query),
  getTask: (projectId, taskId) => ipcRenderer.invoke('desktop:task:get', projectId, taskId),
  getTaskInput: (projectId, taskId) => ipcRenderer.invoke('desktop:task:get-input', projectId, taskId),
  cancelTask: (projectId, taskId) => ipcRenderer.invoke('desktop:task:cancel', projectId, taskId),
  createGenerationTask: (input) => ipcRenderer.invoke('desktop:task:create-generation', input),
  composeVideos: (input) => ipcRenderer.invoke('desktop:task:compose', input),
  readTaskOutput: (projectId, taskId) => ipcRenderer.invoke('desktop:task:read-output', projectId, taskId),
  getAgnesModels: () => ipcRenderer.invoke('desktop:model:get-agnes'),
  saveAgnesApiKey: (apiKey) => ipcRenderer.invoke('desktop:model:save-agnes-key', apiKey),
  clearAgnesApiKey: () => ipcRenderer.invoke('desktop:model:clear-agnes-key'),
  getLocalTextModel: () => ipcRenderer.invoke('desktop:model:get-local-text'),
  discoverLocalModels: (endpoint) => ipcRenderer.invoke('desktop:model:discover-local', endpoint),
  saveLocalTextModel: (config) => ipcRenderer.invoke('desktop:model:save-local-text', config),
  clearLocalTextModel: () => ipcRenderer.invoke('desktop:model:clear-local-text'),
  getLocalAudioModel: () => ipcRenderer.invoke('desktop:model:get-local-audio'),
  listAgentSessions: (projectId) => ipcRenderer.invoke('desktop:agent:list-sessions', projectId),
  listAgentSkills: (projectId, sessionId, keyword) => ipcRenderer.invoke('desktop:agent:list-skills', projectId, sessionId, keyword),
  createAgentSession: (projectId, title) => ipcRenderer.invoke('desktop:agent:create-session', projectId, title),
  getAgentMessages: (projectId, sessionId) => ipcRenderer.invoke('desktop:agent:get-messages', projectId, sessionId),
  sendAgentMessage: (projectId, sessionId, content, selectedSkillId) => ipcRenderer.invoke('desktop:agent:send-message', projectId, sessionId, content, selectedSkillId),
  getAgentSessionSnapshot: (projectId, sessionId) => ipcRenderer.invoke('desktop:agent:get-snapshot', projectId, sessionId),
  startAgentRun: (input) => ipcRenderer.invoke('desktop:agent:start-run', input),
  subscribeAgentEvents: (projectId, sessionId, afterSeq, listener) => {
    let active = true
    let polling = false
    let cursor = Number.isSafeInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0
    const poll = async () => {
      if (!active || polling) return
      polling = true
      try {
        const events = await ipcRenderer.invoke('desktop:agent:list-events', projectId, sessionId, cursor)
        if (!active || !Array.isArray(events)) return
        for (const event of events) {
          if (!event || !Number.isSafeInteger(event.eventSeq) || event.eventSeq <= cursor) continue
          cursor = event.eventSeq
          listener(event)
        }
      } catch {
        // Session snapshot provides the durable recovery path if a poll fails.
      } finally {
        polling = false
      }
    }
    const timer = setInterval(() => { void poll() }, 300)
    void poll()
    return () => {
      active = false
      clearInterval(timer)
    }
  },
  confirmAgentAction: (input) => ipcRenderer.invoke('desktop:agent:confirm-action', input),
})
