const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { discoverLocalTools, callLocalTool } = require('./local-mcp-client.cjs')
const { validateConnectorData } = require('./marketplace-connector-data.cjs')

const ownKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every((key) => allowed.includes(key))

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
const keyFor = (projectId, packageId, componentId) => digest(JSON.stringify([projectId, packageId, componentId]))
const dataHash = (component) => digest(JSON.stringify(component.data))
const delayBound = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max

async function fingerprint(executable) {
  if (!path.isAbsolute(executable) || executable.includes('\0')) throw new Error('LOCAL_MCP_EXECUTABLE_INVALID')
  const info = await fs.lstat(executable).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024 || info.size < 1
    || await fs.realpath(executable).catch(() => '') !== executable) throw new Error('LOCAL_MCP_EXECUTABLE_INVALID')
  if (process.platform === 'win32' && path.extname(executable).toLowerCase() !== '.exe') throw new Error('LOCAL_MCP_EXECUTABLE_INVALID')
  if (process.platform !== 'win32') await fs.access(executable, require('node:fs').constants.X_OK).catch(() => { throw new Error('LOCAL_MCP_EXECUTABLE_INVALID') })
  const handle = await fs.open(executable, require('node:fs').constants.O_RDONLY | (require('node:fs').constants.O_NOFOLLOW || 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size !== info.size) throw new Error('LOCAL_MCP_EXECUTABLE_CHANGED')
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(128 * 1024)
    let position = 0
    while (position < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position)
      if (!bytesRead) throw new Error('LOCAL_MCP_EXECUTABLE_CHANGED')
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead
    }
    const after = await handle.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('LOCAL_MCP_EXECUTABLE_CHANGED')
    return hash.digest('hex')
  } finally { await handle.close() }
}

function createMarketplaceConnectorService(userDataDirectory, { discover = discoverLocalTools, call = callLocalTool } = {}) {
  const statePath = path.join(userDataDirectory, 'marketplace-connectors.json')
  const tickets = new Map()
  let queue = Promise.resolve()
  const serial = (operation) => { const pending = queue.then(operation, operation); queue = pending.catch(() => {}); return pending }
  async function load() {
    const info = await fs.lstat(statePath).catch((error) => { if (error.code === 'ENOENT') return null; throw error })
    if (!info) return { schemaVersion: 1, bindings: [] }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('LOCAL_MCP_CONFIG_INVALID')
    let data
    try { data = JSON.parse(await fs.readFile(statePath, 'utf8')) } catch { throw new Error('LOCAL_MCP_CONFIG_INVALID') }
    if (!ownKeys(data, ['schemaVersion', 'bindings']) || data.schemaVersion !== 1 || !Array.isArray(data.bindings) || data.bindings.length > 100) throw new Error('LOCAL_MCP_CONFIG_INVALID')
    const seen = new Set()
    for (const binding of data.bindings) {
      if (!ownKeys(binding, ['key', 'componentHash', 'executable', 'hash', 'tool'])
        || !/^[a-f0-9]{64}$/u.test(binding.key) || !/^[a-f0-9]{64}$/u.test(binding.componentHash)
        || !delayBound(binding.executable, 4096) || !path.isAbsolute(binding.executable) || !/^[a-f0-9]{64}$/u.test(binding.hash)
        || (binding.tool !== null && (!ownKeys(binding.tool, ['name', 'schema']) || !delayBound(binding.tool.name, 128)
          || !/^[A-Za-z0-9_.-]+$/u.test(binding.tool.name) || !delayBound(binding.tool.schema, 32_768)))
        || seen.has(binding.key)) throw new Error('LOCAL_MCP_CONFIG_INVALID')
      seen.add(binding.key)
    }
    return data
  }
  async function save(data) {
    const encoded = JSON.stringify(data)
    if (Buffer.byteLength(encoded, 'utf8') > 1024 * 1024) throw new Error('LOCAL_MCP_CONFIG_FULL')
    const temp = `${statePath}.${crypto.randomUUID()}.tmp`
    let handle
    try {
      handle = await fs.open(temp, 'wx', 0o600)
      await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = null
      await fs.rename(temp, statePath)
    } finally { await handle?.close().catch(() => {}); await fs.rm(temp, { force: true }).catch(() => {}) }
  }
  function publicBinding(binding) {
    return binding ? { executable: binding.executable, toolName: binding.tool?.name ?? null } : null
  }
  function activeComponent(component) {
    validateConnectorData(component?.data)
    if (component.type !== 'connector' || component.data.kind !== 'local-mcp') throw new Error('LOCAL_MCP_COMPONENT_INVALID')
  }
  function bindingFrom(data, key, component) {
    const binding = data.bindings.find((item) => item.key === key)
    if (binding && binding.componentHash !== dataHash(component)) throw new Error('LOCAL_MCP_COMPONENT_CHANGED')
    return binding
  }
  async function unchanged(binding) {
    if (await fingerprint(binding.executable) !== binding.hash) throw new Error('LOCAL_MCP_EXECUTABLE_CHANGED')
  }
  return {
    get: (key, component) => serial(async () => {
      activeComponent(component)
      return publicBinding(bindingFrom(await load(), key, component))
    }),
    clear: (key, component, ensure) => serial(async () => {
      activeComponent(component)
      const data = await load()
      await ensure()
      data.bindings = data.bindings.filter((binding) => binding.key !== key)
      await save(data)
      for (const [token, ticket] of tickets) if (ticket.key === key) tickets.delete(token)
      return null
    }),
    choose: (key, component, executable, ensure) => serial(async () => {
      activeComponent(component)
      const normalized = await fs.realpath(executable).catch(() => { throw new Error('LOCAL_MCP_EXECUTABLE_INVALID') })
      // The chosen file itself cannot be a symlink, even when the OS dialog resolves it.
      const selectedInfo = await fs.lstat(executable).catch(() => null)
      if (!selectedInfo?.isFile() || selectedInfo.isSymbolicLink()) throw new Error('LOCAL_MCP_EXECUTABLE_INVALID')
      const hash = await fingerprint(normalized)
      await ensure()
      const data = await load()
      const binding = { key, componentHash: dataHash(component), executable: normalized, hash, tool: null }
      const index = data.bindings.findIndex((item) => item.key === key)
      if (index < 0) {
        if (data.bindings.length >= 100) throw new Error('LOCAL_MCP_CONFIG_FULL')
        data.bindings.push(binding)
      } else data.bindings[index] = binding
      await save(data)
      for (const [token, ticket] of tickets) if (ticket.key === key) tickets.delete(token)
      return publicBinding(binding)
    }),
    discover: (key, component, ensure) => serial(async () => {
      activeComponent(component)
      const binding = bindingFrom(await load(), key, component)
      if (!binding) throw new Error('LOCAL_MCP_EXECUTABLE_REQUIRED')
      await unchanged(binding); await ensure()
      const tools = await discover(binding.executable)
      await ensure(); await unchanged(binding)
      if (!Array.isArray(tools) || tools.length > 100 || tools.some((tool) => !delayBound(tool.name, 128)
        || !/^[A-Za-z0-9_.-]+$/u.test(tool.name) || !delayBound(tool.schema, 32_768) || typeof tool.description !== 'string')) throw new Error('LOCAL_MCP_TOOLS_INVALID')
      for (const [token, ticket] of tickets) if (ticket.expires < Date.now() || ticket.key === key) tickets.delete(token)
      const token = crypto.randomUUID()
      tickets.set(token, { key, hash: binding.hash, executable: binding.executable, componentHash: binding.componentHash, tools, expires: Date.now() + 120_000 })
      return { token, tools: tools.map(({ name, description }) => ({ name, description: description.slice(0, 500) })) }
    }),
    select: (key, component, token, name, ensure) => serial(async () => {
      activeComponent(component)
      const ticket = tickets.get(token)
      tickets.delete(token)
      if (!ticket || ticket.key !== key || ticket.expires < Date.now()) throw new Error('LOCAL_MCP_SELECTION_EXPIRED')
      const tool = ticket.tools.find((entry) => entry.name === name)
      if (!tool) throw new Error('LOCAL_MCP_TOOL_INVALID')
      const data = await load()
      const binding = bindingFrom(data, key, component)
      if (!binding || binding.hash !== ticket.hash || binding.executable !== ticket.executable || binding.componentHash !== ticket.componentHash) throw new Error('LOCAL_MCP_EXECUTABLE_CHANGED')
      await unchanged(binding); await ensure()
      binding.tool = { name: tool.name, schema: tool.schema }
      await save(data)
      return publicBinding(binding)
    }),
    run: (key, component, input, ensure) => serial(async () => {
      activeComponent(component)
      const binding = bindingFrom(await load(), key, component)
      if (!binding?.tool) throw new Error('LOCAL_MCP_TOOL_REQUIRED')
      await unchanged(binding); await ensure()
      const output = await call(binding.executable, binding.tool, input, ensure)
      await ensure()
      return output
    }),
  }
}

function registerMarketplaceConnectorIpc(ipcMain, { assertTrustedSender, withProject, dialog, window, userDataDirectory, service, uiText = (text) => text }) {
  const connectors = createMarketplaceConnectorService(userDataDirectory)
  const handle = (name, fn) => ipcMain.handle(`desktop:marketplace:connector:${name}`, async (event, projectId, packageId, componentId, ...args) => {
    assertTrustedSender(event)
    return withProject(projectId, async (directory) => {
      const ensure = async () => {
        const component = await service.getInstalledComponent(directory, packageId, componentId, 'connector')
        validateConnectorData(component.data)
        if (component.data.kind !== 'local-mcp') throw new Error('LOCAL_MCP_COMPONENT_INVALID')
        return component
      }
      const component = await ensure()
      const key = keyFor(projectId, packageId, componentId)
      return fn({ key, component, ensure }, ...args)
    })
  })
  handle('get', ({ key, component }) => connectors.get(key, component))
  handle('clear', ({ key, component, ensure }) => connectors.clear(key, component, ensure))
  handle('choose', async ({ key, component, ensure }) => {
    const result = await dialog.showOpenDialog(window(), { title: uiText('选择信任的本地 MCP 服务程序'), properties: ['openFile'] })
    if (result.canceled || result.filePaths.length !== 1) return null
    return connectors.choose(key, component, result.filePaths[0], ensure)
  })
  handle('discover', ({ key, component, ensure }) => connectors.discover(key, component, ensure))
  handle('select', ({ key, component, ensure }, token, name) => connectors.select(key, component, token, name, ensure))
  handle('run', ({ key, component, ensure }, input) => connectors.run(key, component, input, ensure))
}
module.exports = { validateConnectorData, createMarketplaceConnectorService, registerMarketplaceConnectorIpc, keyFor }
