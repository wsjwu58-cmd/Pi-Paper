const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const NODE_TYPES = new Set(['text', 'image', 'video', 'audio', 'compose', 'director'])
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu

function nodeUrls(node) {
  const params = node.params ?? {}
  const output = node.output ?? {}
  const captures = Array.isArray(params.captures) ? params.captures : []
  const outputs = Array.isArray(output.outputs) ? output.outputs : []
  return [params.url, params.lastOutputUrl, params.output_url, output.url,
    ...captures.map((capture) => typeof capture === 'string' ? capture : capture?.url),
    ...outputs.map((item) => item?.url)].filter((url) => typeof url === 'string')
}

async function resolveNodeExport(input, dependencies) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 200
    || typeof input.canvasId !== 'string' || !input.canvasId || input.canvasId.length > 200
    || typeof input.nodeId !== 'string' || !input.nodeId || input.nodeId.length > 256
    || !NODE_TYPES.has(input.nodeType) || !input.source || typeof input.source !== 'object') {
    throw new Error('节点下载请求无效。')
  }
  await dependencies.assertActive(input.projectId, input.canvasId)
  const canvas = await dependencies.loadCanvas(input.projectId, input.canvasId)
  const node = canvas.nodes?.find((item) => item.id === input.nodeId)
  if (!node || node.type !== input.nodeType) throw new Error('当前节点已更改，无法下载结果。')
  const source = input.source
  if (source.kind === 'text') {
    if (node.type !== 'text' || typeof source.content !== 'string' || !source.content
      || Buffer.byteLength(source.content, 'utf8') > 1024 * 1024) {
      throw new Error('文本结果尚未保存或已更改，请重试下载。')
    }
    let matches = [node.params?.content, node.params?.text, node.params?.lastOutputText, node.output?.text, node.output?.content].includes(source.content)
    // The task feed can display the completed text before its passive UI effect
    // has copied it into node params. Verify against the durable task instead.
    if (!matches && dependencies.listTasks && dependencies.readTextTask) {
      const tasks = await dependencies.listTasks(input.projectId)
      const candidates = tasks.filter((task) => task.canvasId === input.canvasId && task.nodeId === input.nodeId
        && task.modality === 'text' && task.status === 'succeeded')
      const task = candidates.find((item) => item.taskId === node.currentOutputId) ?? candidates[0]
      if (task) matches = await dependencies.readTextTask(input.projectId, task.taskId) === source.content
    }
    if (!matches) throw new Error('文本结果尚未保存或已更改，请重试下载。')
    return { content: source.content, extension: '.txt' }
  }
  const urls = nodeUrls(node)
  let media
  if (source.kind === 'task' && UUID.test(source.taskId)
    && (source.outputIndex === undefined || Number.isSafeInteger(source.outputIndex) && source.outputIndex >= 0 && source.outputIndex <= 3)) {
    const index = source.outputIndex ?? 0
    const url = `vibe://app/tasks/${source.taskId}/output${index ? `?index=${index}` : ''}`
    const task = await dependencies.getTask(input.projectId, source.taskId)
    if (!task || task.status !== 'succeeded' || task.canvasId !== input.canvasId
      || (task.nodeId !== input.nodeId && !urls.includes(url))) throw new Error('此结果不属于当前节点。')
    media = await dependencies.resolveTask(input.projectId, source.taskId, index)
  } else if (source.kind === 'asset' && UUID.test(source.assetId)) {
    if (!urls.includes(`vibe://app/assets/${source.assetId}`)) throw new Error('此素材不属于当前节点。')
    media = await dependencies.resolveAsset(source.assetId)
  } else {
    throw new Error('节点没有可下载的本地结果。')
  }
  if (!media || !/^image\/|^video\/|^audio\//u.test(media.mimeType) || !media.filePath) throw new Error('媒体结果不可用。')
  return { ...media, extension: path.extname(media.filePath) }
}

function exportFilename(suggestedName, nodeType, extension) {
  const name = (typeof suggestedName === 'string' ? suggestedName : `vibepaper-${nodeType}`)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/u, '').slice(0, 100) || `vibepaper-${nodeType}`
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`
}

async function exportNodeOutput(input, dependencies) {
  const initial = await resolveNodeExport(input, dependencies)
  const selected = await dependencies.showSaveDialog({
    title: '下载节点结果', defaultPath: exportFilename(input.suggestedName, input.nodeType, initial.extension),
    filters: [{ name: '节点结果', extensions: [initial.extension.slice(1)] }],
  })
  if (selected.canceled || !selected.filePath) return { status: 'cancelled' }
  const output = await resolveNodeExport(input, dependencies)
  const destination = path.resolve(selected.filePath)
  const projectDirectory = dependencies.projectDirectory()
  if (!projectDirectory) throw new Error('当前项目已更改，无法下载结果。')
  const relative = path.relative(path.join(projectDirectory, '.vibepaper'), destination)
  if (!relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
    throw new Error('下载位置不能覆盖项目内部数据，请选择其他位置。')
  }
  const existing = await fs.lstat(destination).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('下载位置不是普通文件。')
  const temporary = path.join(path.dirname(destination), `.vibepaper-download-${randomUUID()}.tmp`)
  try {
    if (output.content !== undefined) await fs.writeFile(temporary, output.content, { encoding: 'utf8', flag: 'wx' })
    else await fs.copyFile(output.filePath, temporary, fs.constants.COPYFILE_EXCL)
    await dependencies.assertActive(input.projectId, input.canvasId)
    await fs.rename(temporary, destination)
    return { status: 'saved' }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

module.exports = { resolveNodeExport, exportNodeOutput }
