const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const { createMarketplaceService } = require('./marketplace.cjs')
const { registerMarketplaceConnectorIpc } = require('./marketplace-connector.cjs')
const { MAX_BYTES, writeJson } = require('./marketplace-storage.cjs')
const { createOnlineCatalog, importStandaloneSkill, MAX_SKILL_BYTES } = require('./marketplace-online.cjs')

function registerMarketplaceIpc(ipcMain, { assertTrustedSender, withProject, dialog, window, tempDirectory, userDataDirectory, importImage, checkSkills, notifyChanged = () => {}, uiText = (text) => text }) {
  const service = createMarketplaceService(userDataDirectory, { checkSkills })
  registerMarketplaceConnectorIpc(ipcMain, { assertTrustedSender, withProject, dialog, window, userDataDirectory, service, uiText })
  // Reuse Pi's frontmatter parser, which is bundled with project-agent-skills in packaged builds.
  const parseFrontmatter = (content) => require('./project-agent-skills.cjs').parseFrontmatter(content)
  const online = createOnlineCatalog(userDataDirectory, { appVersion: require('../package.json').version, importPackage: service.importPackage, parseFrontmatter })
  const handle = (channel, operation) => ipcMain.handle(`desktop:marketplace:${channel}`, async (event, ...args) => {
    assertTrustedSender(event)
    return operation(...args)
  })
  handle('list', (projectId) => projectId === undefined
    ? service.list()
    : withProject(projectId, (directory) => service.list(directory)))
  handle('online-cached', () => online.cached())
  handle('online-refresh', () => online.refresh())
  handle('online-download', (packageId, commit) => online.download(packageId, commit))
  handle('import-skill', async () => {
    const selected = await dialog.showOpenDialog(window(), { title: uiText('导入独立 Pi Skill'), properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (selected.canceled || !selected.filePaths.length) return null
    const info = await fs.lstat(selected.filePaths[0]).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_SKILL_BYTES) throw new Error('MARKETPLACE_SKILL_INVALID')
    const file = await fs.open(selected.filePaths[0], constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await file.stat()
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size < 1 || opened.size > MAX_SKILL_BYTES) throw new Error('MARKETPLACE_SKILL_INVALID')
      const content = Buffer.alloc(MAX_SKILL_BYTES + 1)
      let length = 0
      while (length < content.length) {
        const { bytesRead } = await file.read(content, length, content.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > MAX_SKILL_BYTES) throw new Error('MARKETPLACE_SKILL_INVALID')
      return await service.importPackage(importStandaloneSkill(content.subarray(0, length), parseFrontmatter))
    } finally { await file.close() }
  })
  handle('preset-preferences', (projectId, ...args) => projectId === undefined
    ? service.savePresetPreferences(undefined, ...args)
    : withProject(projectId, (directory) => service.savePresetPreferences(directory, ...args)))
  const projectMutation = async (projectId, operation) => {
    const result = await withProject(projectId, operation)
    notifyChanged(projectId)
    return result
  }
  handle('install', (projectId, packageId, componentIds) => projectMutation(projectId, (directory) => service.install(directory, packageId, componentIds)))
  handle('enabled', (projectId, packageId, componentId, enabled) => projectMutation(projectId, (directory) => service.setEnabled(directory, packageId, componentId, enabled)))
  handle('uninstall', (projectId, packageId, componentId) => projectMutation(projectId, (directory) => service.uninstall(directory, packageId, componentId)))
  handle('rollback', (projectId, packageId) => projectMutation(projectId, (directory) => service.rollback(directory, packageId)))
  handle('basic-node-visibility:get', (projectId) => withProject(projectId, (directory) => service.getBasicNodeVisibility(directory)))
  handle('basic-node-visibility:set', (projectId, type, visible) => projectMutation(projectId, (directory) => service.setBasicNodeVisibility(directory, type, visible)))
  handle('save-template', (projectId, draft) => projectMutation(projectId, (directory) => service.saveTemplate(directory, draft)))
  handle('save-node-definition', (projectId, draft) => projectMutation(projectId, (directory) => service.saveNodeDefinition(directory, draft)))
  handle('import-package', async () => {
    const selected = await dialog.showOpenDialog(window(), { title: uiText('导入本地插件包'), properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (selected.canceled || !selected.filePaths.length) return null
    const file = selected.filePaths[0]
    const info = await fs.lstat(file).catch(() => null)
    if (!info?.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_BYTES / 2) throw new Error('MARKETPLACE_IMPORT_FILE_INVALID')
    let manifest
    try { manifest = JSON.parse(await fs.readFile(file, 'utf8')) } catch { throw new Error('MARKETPLACE_IMPORT_FILE_INVALID') }
    return service.importPackage(manifest)
  })
  handle('export-package', async (projectId, packageId) => {
    const manifest = await withProject(projectId, (directory) => service.exportPackage(directory, packageId))
    const selected = await dialog.showSaveDialog(window(), { title: uiText('导出本地插件包'), defaultPath: `${manifest.id}-${manifest.version}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (selected.canceled || !selected.filePath) return false
    await writeJson(selected.filePath, manifest)
    return true
  })
  handle('import-asset', (projectId, packageId, componentId) => withProject(projectId, async (directory) => {
    const component = await service.getInstalledComponent(directory, packageId, componentId, 'asset')
    const staging = await fs.mkdtemp(path.join(tempDirectory(), 'vibepaper-market-'))
    try {
      const file = path.join(staging, 'background.png')
      await fs.writeFile(file, Buffer.from(component.data.base64, 'base64'), { flag: 'wx', mode: 0o600 })
      return await importImage(projectId, file)
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    }
  }))
  return service
}
module.exports = { registerMarketplaceIpc }
