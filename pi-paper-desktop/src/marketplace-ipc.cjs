const fs = require('node:fs/promises')
const path = require('node:path')
const { createMarketplaceService } = require('./marketplace.cjs')
const { MAX_BYTES, writeJson } = require('./marketplace-storage.cjs')

function registerMarketplaceIpc(ipcMain, { assertTrustedSender, withProject, dialog, window, tempDirectory, userDataDirectory, importImage, checkSkills }) {
  const service = createMarketplaceService(userDataDirectory, { checkSkills })
  const handle = (channel, operation) => ipcMain.handle(`desktop:marketplace:${channel}`, async (event, ...args) => {
    assertTrustedSender(event)
    return operation(...args)
  })
  handle('list', (projectId) => projectId === undefined
    ? service.list()
    : withProject(projectId, (directory) => service.list(directory)))
  handle('install', (projectId, packageId, componentIds) => withProject(projectId, (directory) => service.install(directory, packageId, componentIds)))
  handle('enabled', (projectId, packageId, componentId, enabled) => withProject(projectId, (directory) => service.setEnabled(directory, packageId, componentId, enabled)))
  handle('uninstall', (projectId, packageId, componentId) => withProject(projectId, (directory) => service.uninstall(directory, packageId, componentId)))
  handle('rollback', (projectId, packageId) => withProject(projectId, (directory) => service.rollback(directory, packageId)))
  handle('save-template', (projectId, draft) => withProject(projectId, (directory) => service.saveTemplate(directory, draft)))
  handle('import-package', async () => {
    const selected = await dialog.showOpenDialog(window(), { title: '导入本地插件包', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
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
    const selected = await dialog.showSaveDialog(window(), { title: '导出本地插件包', defaultPath: `${manifest.id}-${manifest.version}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
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
}
module.exports = { registerMarketplaceIpc }
