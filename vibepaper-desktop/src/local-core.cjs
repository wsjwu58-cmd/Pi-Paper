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
      return store.openProject(payload.directory)
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
    case 'asset:resolve':
      return store.resolveAsset(payload?.assetId)
    case 'canvas:load':
      return store.loadCanvas(payload?.projectId, payload?.canvasId)
    case 'canvas:save':
      return store.saveCanvas(payload)
    case 'task:create':
      return store.createTask(payload)
    case 'task:cancel':
      return store.cancelTask(payload?.projectId, payload?.taskId)
    case 'task:list':
      return store.listTasks(payload?.projectId, payload?.limit)
    case 'task:get':
      return store.getTask(payload?.projectId, payload?.taskId)
    case 'task:get-input':
      return store.getTaskInput(payload?.projectId, payload?.taskId)
    case 'task:read-output':
      return store.readTaskOutputText(payload?.projectId, payload?.taskId)
    case 'task:events':
      return store.listTaskEvents(payload?.projectId, payload?.taskId, payload?.afterSeq)
    case 'task:claim-next':
      return store.claimNextTask(payload?.projectId)
    case 'task:succeeded':
      return store.recordTaskSucceeded(payload?.projectId, payload?.taskId, payload?.outputPath)
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
