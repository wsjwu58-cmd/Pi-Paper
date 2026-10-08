const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { resolveNodeExport, canvasNodePayload } = require('./node-export.cjs')

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'

function assertScopeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ['projectId', 'canvasId'].some((key) => typeof input[key] !== 'string' || !input[key] || input[key].length > 256)) {
    throw new Error('画布媒体请求无效。')
  }
}

function safeName(value, fallback) {
  return String(value ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/u, '').slice(0, 80) || fallback
}

function normalizeCanvasPng(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 33 || value.byteLength > 32 * 1024 * 1024) {
    throw new Error('裁剪图片为空或超过 32 MiB。')
  }
  const bytes = Buffer.from(value)
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13
    || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('裁剪结果必须是 PNG 图片。')
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64 * 1024 * 1024) {
    throw new Error('裁剪图片尺寸超过本地处理范围。')
  }
  return bytes
}

async function saveCanvasImage(input, dependencies) {
  assertScopeInput(input)
  if (typeof input.nodeId !== 'string' || !input.nodeId || input.nodeId.length > 256) throw new Error('裁剪源节点无效。')
  const bytes = normalizeCanvasPng(input.pngBytes)
  const assertSource = async () => {
    await dependencies.assertActive(input.projectId, input.canvasId)
    const canvas = await dependencies.loadCanvas(input.projectId, input.canvasId)
    if (!canvas.nodes?.some((node) => node.id === input.nodeId && node.type === 'image')) throw new Error('裁剪源图片节点已不存在。')
  }
  await assertSource()
  const temporary = path.join(dependencies.tempDirectory(), `vibepaper-crop-${randomUUID()}.png`)
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await assertSource()
    const asset = await dependencies.importImage(temporary, input.projectId)
    const name = safeName(input.name, 'Crop')
    await dependencies.assertActive(input.projectId, input.canvasId)
    await dependencies.renameAsset(input.projectId, asset.assetId, `${name.replace(/\.png$/iu, '')}.png`)
    return { assetId: asset.assetId, url: `vibe://app/assets/${asset.assetId}` }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

function nodeExportSource(node) {
  const p = node.params ?? {}, output = node.output ?? {}
  if (node.type === 'text') {
    const content = p.lastOutputText || output.text || output.content || p.content || p.text
    return typeof content === 'string' && content ? { kind: 'text', content } : null
  }
  const captures = Array.isArray(p.captures) ? p.captures : []
  const firstCapture = typeof captures[0] === 'string' ? captures[0] : captures[0]?.url
  const url = p.lastOutputUrl || p.url || p.output_url || output.url || firstCapture
  if (typeof url !== 'string') return null
  const asset = new RegExp(`^vibe://app/assets/(${UUID})$`, 'iu').exec(url)
  if (asset) return { kind: 'asset', assetId: asset[1] }
  const task = new RegExp(`^vibe://app/tasks/(${UUID})/output(?:\\?index=([0-3]))?$`, 'iu').exec(url)
  return task ? { kind: 'task', taskId: task[1], outputIndex: Number(task[2] ?? 0) } : null
}

async function resolveGroup(input, dependencies) {
  await dependencies.assertActive(input.projectId, input.canvasId)
  const canvas = await dependencies.loadCanvas(input.projectId, input.canvasId)
  const group = canvas.groups?.find((item) => String(item.id) === String(input.groupId))
  if (!group) throw new Error('编组已不存在，无法下载。')
  const nodes = group.nodeIds.map((id) => canvas.nodes.find((node) => String(node.id) === String(id))).filter(Boolean)
  const outputs = []
  for (const storedNode of nodes) {
    const node = canvasNodePayload(storedNode)
    const source = nodeExportSource(node)
    if (!source) continue
    const output = await resolveNodeExport({ ...input, nodeId: node.id, nodeType: node.type, source }, dependencies)
    outputs.push({ node, output })
  }
  if (!outputs.length) throw new Error('编组中尚无可下载的结果。')
  return { name: group.name, signature: JSON.stringify({ group, nodes }), outputs }
}

async function exportGroupOutputs(input, dependencies) {
  assertScopeInput(input)
  if (!['string', 'number'].includes(typeof input.groupId) || !String(input.groupId) || String(input.groupId).length > 256) throw new Error('编组下载请求无效。')
  const initial = await resolveGroup(input, dependencies)
  const selected = await dependencies.showDirectoryDialog()
  if (selected.canceled || !selected.filePaths?.[0]) return { status: 'cancelled' }
  const current = await resolveGroup(input, dependencies)
  if (current.signature !== initial.signature) throw new Error('编组内容已更改，请重新下载。')
  const parent = await fs.realpath(selected.filePaths[0])
  const projectDirectory = dependencies.projectDirectory()
  if (!projectDirectory) throw new Error('当前项目已更改，无法下载编组。')
  const dataRoot = await fs.realpath(path.join(projectDirectory, '.vibepaper'))
  const relative = path.relative(dataRoot, parent)
  if (!relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) throw new Error('下载位置不能位于项目内部数据目录。')
  const nonce = randomUUID()
  const staging = path.join(parent, `.vibepaper-group-${nonce}`)
  const destination = path.join(parent, `${safeName(current.name, 'Group')}-${nonce.slice(0, 8)}`)
  await fs.mkdir(staging)
  try {
    for (let i = 0; i < current.outputs.length; i += 1) {
      await dependencies.assertActive(input.projectId, input.canvasId)
      const { node, output } = current.outputs[i]
      const name = safeName(node.params?.name || node.params?.title, node.type)
      const basename = name.toLowerCase().endsWith(output.extension.toLowerCase()) ? name.slice(0, -output.extension.length) : name
      const file = path.join(staging, `${String(i + 1).padStart(2, '0')}-${basename}${output.extension}`)
      if (output.content !== undefined) await fs.writeFile(file, output.content, { encoding: 'utf8', flag: 'wx' })
      else await fs.copyFile(output.filePath, file, fs.constants.COPYFILE_EXCL)
    }
    const final = await resolveGroup(input, dependencies)
    if (final.signature !== current.signature) throw new Error('编组内容已更改，请重新下载。')
    await fs.rename(staging, destination)
    return { status: 'saved', count: current.outputs.length }
  } finally {
    // This newly created staging folder contains only files written by this export.
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

function registerCanvasMediaIpc(ipcMain, dependencies) {
  ipcMain.handle('desktop:asset:save-canvas-image', (event, input) => {
    dependencies.assertTrustedSender(event)
    return saveCanvasImage(input, dependencies)
  })
  ipcMain.handle('desktop:group:export-outputs', (event, input) => {
    dependencies.assertTrustedSender(event)
    return exportGroupOutputs(input, dependencies)
  })
}

module.exports = { saveCanvasImage, exportGroupOutputs, registerCanvasMediaIpc, normalizeCanvasPng }
