const { createLocalProjectStore } = require('./project-store.cjs')

const parentPort = process.parentPort
if (!parentPort) throw new Error('Local Core must run as an Electron utility process.')

const store = createLocalProjectStore()

async function dispatch(method, payload) {
  switch (method) {
    case 'project:get-active':
      return store.getActiveProject()
    case 'project:create':
      if (!payload || typeof payload.parentDirectory !== 'string') throw new Error('新项目保存位置无效。')
      return store.createProject(payload.parentDirectory, payload.name)
    case 'project:open':
      if (!payload || typeof payload.directory !== 'string') throw new Error('项目目录无效。')
      if ((payload.expectedProjectId === undefined) !== (payload.expectedCanvasId === undefined)
        || (payload.expectedProjectId !== undefined
          && (typeof payload.expectedProjectId !== 'string' || typeof payload.expectedCanvasId !== 'string'))) {
        throw new Error('最近项目身份校验请求无效。')
      }
      return store.openProject(payload.directory, payload.expectedProjectId === undefined ? undefined : {
        projectId: payload.expectedProjectId,
        canvasId: payload.expectedCanvasId,
      })
    case 'project:inspect':
      if (!payload || typeof payload.directory !== 'string'
        || (payload.expectedProjectId === undefined) !== (payload.expectedCanvasId === undefined)
        || (payload.expectedProjectId !== undefined
          && (typeof payload.expectedProjectId !== 'string' || typeof payload.expectedCanvasId !== 'string'))) {
        throw new Error('项目检查请求无效。')
      }
      return store.inspectProject(payload.directory, payload.expectedProjectId === undefined ? undefined : {
        projectId: payload.expectedProjectId,
        canvasId: payload.expectedCanvasId,
      })
    case 'project:backup':
      if (!payload || typeof payload.parentDirectory !== 'string' || typeof payload.projectId !== 'string') {
        throw new Error('备份请求无效。')
      }
      return store.backupProject(payload.parentDirectory, payload.projectId)
    case 'project:restore-backup':
      if (!payload || typeof payload.sourceDirectory !== 'string' || typeof payload.parentDirectory !== 'string') {
        throw new Error('项目恢复请求无效。')
      }
      return store.restoreBackup(payload.sourceDirectory, payload.parentDirectory)
    case 'asset:import':
      if (!payload || typeof payload.sourcePath !== 'string' || typeof payload.projectId !== 'string') {
        throw new Error('素材导入请求无效。')
      }
      return store.importAsset(payload.sourcePath, payload.projectId)
    case 'asset:list':
      return store.listAssets(payload?.projectId)
    case 'asset:rename':
      return store.renameAsset(payload?.projectId, payload?.assetId, payload?.name)
    case 'asset:replace':
      return store.replaceAsset(payload?.projectId, payload?.assetId, payload?.sourcePath)
    case 'asset:delete':
      return store.deleteAsset(payload?.projectId, payload?.assetId)
    case 'asset:resolve':
      return store.resolveAsset(payload?.assetId)
    case 'canvas:load':
      return store.loadCanvas(payload?.projectId, payload?.canvasId)
    case 'canvas:export':
      return store.exportCanvas(payload?.projectId, payload?.canvasId)
    case 'canvas:create-node':
      return store.createNode(payload)
    case 'canvas:update-node': {
      const result = await store.updateNode(payload)
      const canvas = store.loadCanvas(payload?.projectId, payload?.canvasId)
      return {
        ...result,
        // updateNode also marks downstream nodes stale in the authoritative
        // canvas snapshot. Return that snapshot so the renderer can reconcile
        // those backend-owned status changes without shipping the whole graph.
        staleNodes: canvas.nodes.flatMap((node) => {
          const data = node.data ?? {}
          if (data.stale !== true) return []
          const nested = data.node && typeof data.node === 'object' && !Array.isArray(data.node)
            ? data.node
            : null
          return [{
            id: node.id,
            stale: true,
            ...(typeof data.execStatus === 'string' ? { execStatus: data.execStatus } : {}),
            ...(nested ? { nested: {
              stale: nested.stale === true,
              ...(typeof nested.execStatus === 'string' ? { execStatus: nested.execStatus } : {}),
            } } : {}),
          }]
        }),
      }
    }
    case 'canvas:delete-node': {
      const impact = await store.deleteNode(payload)
      const canvas = store.loadCanvas(payload?.projectId, payload?.canvasId)
      return {
        ...impact,
        version: canvas.version,
        canvas,
      }
    }
    case 'canvas:save':
      return store.saveCanvas(payload)
    case 'canvas:connect':
      return store.connectEdge(payload)
    case 'canvas:delete-edge':
      return store.deleteEdge(payload)
    case 'canvas:group:add':
      return store.addGroup(payload)
    case 'canvas:group:update':
      return store.updateGroup(payload)
    case 'canvas:group:delete':
      return store.deleteGroup(payload)
    case 'canvas:stack:add':
      return store.addStack(payload)
    case 'canvas:stack:update':
      return store.updateStack(payload)
    case 'canvas:stack:extract':
      return store.extractFromStack(payload)
    case 'canvas:stack:delete':
      return store.deleteStack(payload)
    case 'task:create':
      return store.createTask(payload)
    case 'task:cancel':
      return store.cancelTask(payload?.projectId, payload?.taskId)
    case 'task:list':
      return store.listTasks(payload?.projectId, payload?.limit)
    case 'task:search':
      return store.searchTasks(payload?.projectId, payload?.query)
    case 'task:get':
      return store.getTask(payload?.projectId, payload?.taskId)
    case 'task:get-input':
      return store.getTaskInput(payload?.projectId, payload?.taskId)
    case 'task:resolve-compose-inputs':
      return store.resolveComposeInputPaths(payload?.projectId, payload?.taskId)
    case 'task:read-output':
      return store.readTaskOutputText(payload?.projectId, payload?.taskId)
    case 'task:resolve-output-preview':
      return store.resolveTaskOutputForPreview(payload?.projectId, payload?.taskId)
    case 'task:events':
      return store.listTaskEvents(payload?.projectId, payload?.taskId, payload?.afterSeq)
    case 'task:claim-next':
      return store.claimNextTask(payload?.projectId)
    case 'task:succeeded':
      return store.recordTaskSucceeded(payload?.projectId, payload?.taskId, payload?.outputPath, payload?.outputMeta)
    case 'task:failed':
      return store.recordTaskFailed(payload?.projectId, payload?.taskId, payload?.errorCode)
    case 'core:close':
      await store.close()
      return null
    default:
      throw new Error('本地核心不支持此操作。')
  }
}

parentPort.on('message', async (event) => {
  const request = event?.data ?? event
  if (!request || !Number.isSafeInteger(request.id) || typeof request.method !== 'string') return
  try {
    const result = await dispatch(request.method, request.payload)
    parentPort.postMessage({ id: request.id, ok: true, result })
  } catch (error) {
    parentPort.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : '本地项目操作失败。',
    })
  }
})
