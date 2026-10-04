const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('vibepaperDesktop', {
  getActiveProject: () => ipcRenderer.invoke('desktop:project:get-active'),
  listRecentProjects: () => ipcRenderer.invoke('desktop:project:list-recent'),
  openRecentProject: (projectId) => ipcRenderer.invoke('desktop:project:open-recent', projectId),
  createProject: (name) => ipcRenderer.invoke('desktop:project:create', name),
  renameProject: (projectId, name) => ipcRenderer.invoke('desktop:project:rename', projectId, name),
  deleteProject: (projectId) => ipcRenderer.invoke('desktop:project:delete', projectId),
  openProject: () => ipcRenderer.invoke('desktop:project:open'),
  backupProject: (projectId) => ipcRenderer.invoke('desktop:project:backup', projectId),
  restoreBackup: () => ipcRenderer.invoke('desktop:project:restore-backup'),
  importImage: (projectId) => ipcRenderer.invoke('desktop:asset:import-image', projectId),
  importLocalAsset: (projectId) => ipcRenderer.invoke('desktop:asset:import-local', projectId),
  importLocalAssets: (projectId) => ipcRenderer.invoke('desktop:asset:import-local-assets', projectId),
  saveTaskOutputToLibrary: (projectId, taskId) => ipcRenderer.invoke('desktop:asset:save-task-output', projectId, taskId),
  exportNodeOutput: (input) => ipcRenderer.invoke('desktop:node:export-output', input),
  saveDirectorCapture: (input) => ipcRenderer.invoke('desktop:asset:save-director-capture', input),
  listAssets: (projectId) => ipcRenderer.invoke('desktop:asset:list', projectId),
  renameAsset: (projectId, assetId, name) => ipcRenderer.invoke('desktop:asset:rename', projectId, assetId, name),
  replaceImage: (projectId, assetId) => ipcRenderer.invoke('desktop:asset:replace-image', projectId, assetId),
  replaceAudio: (projectId, assetId) => ipcRenderer.invoke('desktop:asset:replace-audio', projectId, assetId),
  replaceAsset: (projectId, assetId) => ipcRenderer.invoke('desktop:asset:replace', projectId, assetId),
  deleteAsset: (projectId, assetId) => ipcRenderer.invoke('desktop:asset:delete', projectId, assetId),
  loadCanvas: (projectId, canvasId) => ipcRenderer.invoke('desktop:canvas:load', projectId, canvasId),
  listDramaAssets: (projectId, canvasId, filters) => ipcRenderer.invoke('desktop:canvas:drama-assets:list', projectId, canvasId, filters),
  upsertDramaAsset: (input) => ipcRenderer.invoke('desktop:canvas:drama-assets:upsert', input),
  createDramaSeries: (input) => ipcRenderer.invoke('desktop:drama:state', 'createSeries', input),
  createDramaCharacter: (input) => ipcRenderer.invoke('desktop:drama:state', 'createCharacter', input),
  addDramaReferencePack: (input) => ipcRenderer.invoke('desktop:drama:state', 'addReferencePack', input),
  createDramaShot: (input) => ipcRenderer.invoke('desktop:drama:state', 'createShot', input),
  prepareDramaKeyframeNode: (input) => ipcRenderer.invoke('desktop:drama:state', 'prepareKeyframeNode', input),
  recordDramaKeyframe: (input) => ipcRenderer.invoke('desktop:drama:state', 'recordKeyframe', input),
  prepareDramaVideoNode: (input) => ipcRenderer.invoke('desktop:drama:state', 'prepareVideoNode', input),
  recordDramaLineage: (input) => ipcRenderer.invoke('desktop:drama:state', 'recordLineage', input),
  staleDramaLineagesForCharacter: (input) => ipcRenderer.invoke('desktop:drama:state', 'staleLineagesForCharacter', input),
  listDramaRenderBatches: (projectId, canvasId) => ipcRenderer.invoke('desktop:drama:render-batches:list', projectId, canvasId),
  getDramaRenderBatch: (projectId, canvasId, batchId) => ipcRenderer.invoke('desktop:drama:render-batches:get', projectId, canvasId, batchId),
  listDramaRenderCandidates: (projectId, canvasId) => ipcRenderer.invoke('desktop:drama:render-batches:candidates:list', projectId, canvasId),
  createDramaRenderBatch: (input) => ipcRenderer.invoke('desktop:drama:render-batches:create', input),
  prepareDramaRenderBatchConfirmation: (input) => ipcRenderer.invoke('desktop:drama:render-batches:confirmation:prepare', input),
  submitDramaRenderBatch: (input) => ipcRenderer.invoke('desktop:drama:render-batches:submit', input),
  rejectDramaRenderBatchConfirmation: (input) => ipcRenderer.invoke('desktop:drama:render-batches:confirmation:reject', input),
  rerunDramaRenderBatchJob: (input) => ipcRenderer.invoke('desktop:drama:render-batches:rerun', input),
  listRenderReviews: (projectId, canvasId, targetNodeId) => ipcRenderer.invoke('desktop:render-reviews:list', projectId, canvasId, targetNodeId),
  createRenderReview: (input) => ipcRenderer.invoke('desktop:render-reviews:create', input),
  exportCanvas: (projectId, canvasId) => ipcRenderer.invoke('desktop:canvas:export', projectId, canvasId),
  importCanvasDocument: (document) => ipcRenderer.invoke('desktop:canvas:import', document),
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
  retryTask: (projectId, taskId) => ipcRenderer.invoke('desktop:task:retry', projectId, taskId),
  createGenerationTask: (input) => ipcRenderer.invoke('desktop:task:create-generation', input),
  composeVideos: (input) => ipcRenderer.invoke('desktop:task:compose', input),
  readTaskOutput: (projectId, taskId) => ipcRenderer.invoke('desktop:task:read-output', projectId, taskId),
  getAgnesModels: () => ipcRenderer.invoke('desktop:model:get-agnes'),
  getProviderConfiguration: () => ipcRenderer.invoke('desktop:model:providers:get'),
  saveProviderConfiguration: (input) => ipcRenderer.invoke('desktop:model:providers:save', input),
  clearProviderConfiguration: (providerId) => ipcRenderer.invoke('desktop:model:providers:clear', providerId),
  testProviderConfiguration: (input) => ipcRenderer.invoke('desktop:model:providers:test', input),
  saveAgnesApiKey: (apiKey) => ipcRenderer.invoke('desktop:model:save-agnes-key', apiKey),
  clearAgnesApiKey: () => ipcRenderer.invoke('desktop:model:clear-agnes-key'),
  getArkModels: () => ipcRenderer.invoke('desktop:model:get-ark'),
  saveArkApiKey: (apiKey) => ipcRenderer.invoke('desktop:model:save-ark-key', apiKey),
  clearArkApiKey: () => ipcRenderer.invoke('desktop:model:clear-ark-key'),
  getLocalTextModel: () => ipcRenderer.invoke('desktop:model:get-local-text'),
  discoverLocalModels: (endpoint) => ipcRenderer.invoke('desktop:model:discover-local', endpoint),
  saveLocalTextModel: (config) => ipcRenderer.invoke('desktop:model:save-local-text', config),
  clearLocalTextModel: () => ipcRenderer.invoke('desktop:model:clear-local-text'),
  getLocalAudioModel: () => ipcRenderer.invoke('desktop:model:get-local-audio'),
  getAgentModelCatalog: () => ipcRenderer.invoke('desktop:agent:get-model-catalog'),
  setAgentSessionModel: (projectId, sessionId, modelId) => ipcRenderer.invoke('desktop:agent:set-session-model', projectId, sessionId, modelId),
  listAgentSessions: (projectId, filter) => ipcRenderer.invoke('desktop:agent:list-sessions', projectId, filter),
  getAgentSession: (projectId, sessionId) => ipcRenderer.invoke('desktop:agent:get-session', projectId, sessionId),
  updateAgentSession: (projectId, sessionId, patch) => ipcRenderer.invoke('desktop:agent:update-session', projectId, sessionId, patch),
  deleteAgentSession: (projectId, sessionId) => ipcRenderer.invoke('desktop:agent:delete-session', projectId, sessionId),
  copyAgentSession: (projectId, sessionId, input) => ipcRenderer.invoke('desktop:agent:copy-session', projectId, sessionId, input),
  setAgentSessionSkills: (projectId, sessionId, skillIds) => ipcRenderer.invoke('desktop:agent:set-session-skills', projectId, sessionId, skillIds),
  attachAgentSessionSkill: (projectId, sessionId, skillId) => ipcRenderer.invoke('desktop:agent:attach-session-skill', projectId, sessionId, skillId),
  createAgentPlan: (projectId, sessionId, input) => ipcRenderer.invoke('desktop:agent:plan:create', projectId, sessionId, input),
  getAgentPlan: (projectId, planId) => ipcRenderer.invoke('desktop:agent:plan:get', projectId, planId),
  getAgentPlanReadySet: (projectId, planId, profile) => ipcRenderer.invoke('desktop:agent:plan:ready-set', projectId, planId, profile),
  rerunAgentPlan: (projectId, planId, stepId) => ipcRenderer.invoke('desktop:agent:plan:rerun', projectId, planId, stepId),
  executeAgentPlan: (projectId, planId, input) => ipcRenderer.invoke('desktop:agent:plan:execute', projectId, planId, input),
  getAgentPlanExecution: (projectId, planId) => ipcRenderer.invoke('desktop:agent:plan:execution', projectId, planId),
  cancelAgentPlan: (projectId, planId) => ipcRenderer.invoke('desktop:agent:plan:cancel', projectId, planId),
  listAgentFragments: (projectId) => ipcRenderer.invoke('desktop:agent:list-fragments', projectId),
  saveAgentSessionFragment: (projectId, sessionId, title) => ipcRenderer.invoke('desktop:agent:save-fragment', projectId, sessionId, title),
  importAgentFragment: (projectId, fragmentId, canvasId) => ipcRenderer.invoke('desktop:agent:import-fragment', projectId, fragmentId, canvasId),
  listAgentMemories: (projectId, scope, sessionId) => ipcRenderer.invoke('desktop:agent:memory:list', projectId, scope, sessionId),
  createAgentMemory: (projectId, content, scope, sessionId) => ipcRenderer.invoke('desktop:agent:memory:create', projectId, content, scope, sessionId),
  updateAgentMemory: (projectId, memoryId, content, scope, sessionId) => ipcRenderer.invoke('desktop:agent:memory:update', projectId, memoryId, content, scope, sessionId),
  deleteAgentMemory: (projectId, memoryId, scope, sessionId) => ipcRenderer.invoke('desktop:agent:memory:delete', projectId, memoryId, scope, sessionId),
  exportAgentMemories: (projectId) => ipcRenderer.invoke('desktop:agent:memory:export', projectId),
  listAgentMemoryCandidates: (projectId) => ipcRenderer.invoke('desktop:agent:memory-candidates:list', projectId),
  reviewAgentMemoryCandidate: (projectId, candidateId, action) => ipcRenderer.invoke('desktop:agent:memory-candidates:review', projectId, candidateId, action),
  listAgentSkills: (projectId, sessionId, keyword) => ipcRenderer.invoke('desktop:agent:list-skills', projectId, sessionId, keyword),
  createAgentSkill: (projectId, draft) => ipcRenderer.invoke('desktop:agent:skill:create', projectId, draft),
  updateAgentSkill: (projectId, skillId, patch) => ipcRenderer.invoke('desktop:agent:skill:update', projectId, skillId, patch),
  deleteAgentSkill: (projectId, skillId) => ipcRenderer.invoke('desktop:agent:skill:delete', projectId, skillId),
  importAgentSkill: (projectId) => ipcRenderer.invoke('desktop:agent:skill:import', projectId),
  createAgentSession: (projectId, title) => ipcRenderer.invoke('desktop:agent:create-session', projectId, title),
  getAgentMessages: (projectId, sessionId) => ipcRenderer.invoke('desktop:agent:get-messages', projectId, sessionId),
  getAgentUsage: (projectId, sessionId) => ipcRenderer.invoke('desktop:agent:get-usage', projectId, sessionId),
  sendAgentMessage: (projectId, sessionId, content, selectedSkillId, modelId) => ipcRenderer.invoke('desktop:agent:send-message', projectId, sessionId, content, selectedSkillId, modelId),
  getAgentSessionSnapshot: (projectId, sessionId) => ipcRenderer.invoke('desktop:agent:get-snapshot', projectId, sessionId),
  startAgentRun: (input) => ipcRenderer.invoke('desktop:agent:start-run', input),
  cancelAgentRun: (projectId, sessionId, runId) => ipcRenderer.invoke('desktop:agent:cancel-run', projectId, sessionId, runId),
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
