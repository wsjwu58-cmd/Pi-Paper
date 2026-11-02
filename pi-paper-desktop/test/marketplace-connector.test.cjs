const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { validateConnectorData } = require('../src/marketplace-connector-data.cjs')
const { createMarketplaceConnectorService, registerMarketplaceConnectorIpc, keyFor } = require('../src/marketplace-connector.cjs')
const { supportsTextTool } = require('../src/local-mcp-client.cjs')
const example = require('../src/marketplace-connector-example.cjs')
const { validatePackage } = require('../src/marketplace-storage.cjs')

const local = example.components.find((component) => component.data.kind === 'local-mcp')
const textSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
const clone = (value) => JSON.parse(JSON.stringify(value))

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'connector-test-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { root, service: createMarketplaceConnectorService(root), key: keyFor('project-a', 'pack', 'component'), component: clone(local) }
}
async function makeServer(root, mode = 'normal') {
  const script = path.join(root, `server-${mode}.cjs`)
  const executable = path.join(root, `server-${mode}`)
  const log = path.join(root, `${mode}.log`)
  const pidFile = path.join(root, `${mode}.pid`)
  const source = `
const fs = require('node:fs'); const readline = require('node:readline');
fs.appendFileSync(${JSON.stringify(log)}, 'start\\n');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
if (${JSON.stringify(mode)} === 'hang') { setInterval(() => {}, 1000); }
else readline.createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line); if (r.id === undefined) return;
  let result;
  if (r.method === 'initialize') result = { protocolVersion: r.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
  else if (r.method === 'tools/list') result = { tools: [{ name: 'uppercase', description: 'Uppercase text', inputSchema: ${JSON.stringify(textSchema)} }, { name: 'other', inputSchema: {type: 'object', properties:{path:{type:'string'}}, required:['path']} }] };
  else if (r.method === 'tools/call') { fs.appendFileSync(${JSON.stringify(log)}, 'call\\n'); result = { content: [{ type: 'text', text: r.params.arguments.text.toUpperCase() + '|' + (process.env.VIBEPAPER_TEST_SECRET || process.env.HOME || process.env.APPDATA ? 'leaked' : 'clean') + '|' + process.cwd() }] }; }
  else return;
  process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:r.id, result }) + '\\n');
});
`
  await fs.writeFile(script, source)
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`
  await fs.writeFile(executable, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(script)}\n`, { mode: 0o700 })
  await fs.chmod(executable, 0o700)
  return { executable, script, log, pidFile }
}

test('connector manifests only accept narrow recipes and never commands, URLs, paths, keys or grants', () => {
  validatePackage(example)
  for (const component of example.components) validateConnectorData(component.data)
  const base = example.components[0].data
  for (const mutation of [
    { ...base, command: '/bin/sh' }, { ...base, url: 'https://example.com' }, { ...base, key: 'secret' },
    { ...base, permissions: ['provider.configure'] }, { ...base, permissions: ['canvas.read', 'canvas.read'] },
    { kind: 'local-mcp', capability: 'text-transform', args: [] },
    { kind: 'local-mcp', capability: 'execute-command' },
  ]) assert.throws(() => validateConnectorData(mutation), /MARKETPLACE_PACKAGE_INVALID/)
  assert.equal(supportsTextTool({ name: 'ok', inputSchema: textSchema }), true)
  for (const schema of [
    { ...textSchema, properties: { text: { type: 'string' }, path: { type: 'string' } } },
    { ...textSchema, properties: { text: { type: 'string', enum: ['yes'] } } },
    { ...textSchema, properties: { text: { type: 'string', maxLength: 1 } } },
    { ...textSchema, additionalProperties: true }, { ...textSchema, anyOf: [] },
  ]) assert.equal(supportsTextTool({ name: 'unsafe', inputSchema: schema }), false)
})

test('real stdio MCP lifecycle starts only after user actions, sends only text, isolates cwd/env, rechecks scope and hash', { skip: process.platform === 'win32' }, async (t) => {
  const { root, service, key, component } = await fixture(t)
  const { executable, log } = await makeServer(root)
  const oldSecret = process.env.VIBEPAPER_TEST_SECRET
  process.env.VIBEPAPER_TEST_SECRET = 'not-for-child'
  t.after(() => { if (oldSecret === undefined) delete process.env.VIBEPAPER_TEST_SECRET; else process.env.VIBEPAPER_TEST_SECRET = oldSecret })
  let allowed = true
  const ensure = async () => { if (!allowed) throw new Error('MARKETPLACE_COMPONENT_NOT_AVAILABLE') }
  assert.equal(await service.get(key, component), null)
  assert.deepEqual(await service.choose(key, component, executable, ensure), { executable, toolName: null })
  await assert.rejects(fs.stat(log), { code: 'ENOENT' })
  const discovered = await service.discover(key, component, ensure)
  assert.deepEqual(discovered.tools.map((tool) => tool.name), ['uppercase'])
  await service.select(key, component, discovered.token, 'uppercase', ensure)
  await assert.rejects(service.select(key, component, discovered.token, 'uppercase', ensure), /LOCAL_MCP_SELECTION_EXPIRED/)
  const output = await service.run(key, component, 'hello 世界', ensure)
  assert.match(output, /^HELLO 世界\|clean\|/u)
  const cwd = output.split('|')[2]
  assert.notEqual(cwd, root)
  await assert.rejects(fs.stat(cwd), { code: 'ENOENT' })
  assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split('\n'), ['start', 'start', 'call'])
  allowed = false
  await assert.rejects(service.run(key, component, 'do not run', ensure), /MARKETPLACE_COMPONENT_NOT_AVAILABLE/)
  assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split('\n'), ['start', 'start', 'call'])
  allowed = true
  await fs.appendFile(executable, '# replaced\n')
  await assert.rejects(service.run(key, component, 'do not run', ensure), /LOCAL_MCP_EXECUTABLE_CHANGED/)
  await service.clear(key, component, ensure)
  assert.equal(await service.get(key, component), null)
})

test('disabled component blocks call after discovery and before sending the text', { skip: process.platform === 'win32' }, async (t) => {
  const { root, service, key, component } = await fixture(t)
  const { executable, log } = await makeServer(root)
  await service.choose(key, component, executable, async () => {})
  const discovered = await service.discover(key, component, async () => {})
  await service.select(key, component, discovered.token, 'uppercase', async () => {})
  let calls = 0
  await assert.rejects(service.run(key, component, 'private', async () => {
    if (++calls > 1) throw new Error('MARKETPLACE_COMPONENT_NOT_AVAILABLE')
  }), /MARKETPLACE_COMPONENT_NOT_AVAILABLE/)
  assert.equal((await fs.readFile(log, 'utf8')).includes('call\n'), false)
})

test('hung MCP service times out and is forcibly terminated', { skip: process.platform === 'win32', timeout: 25_000 }, async (t) => {
  const { root, service, key, component } = await fixture(t)
  const { executable, pidFile } = await makeServer(root, 'hang')
  await service.choose(key, component, executable, async () => {})
  await assert.rejects(service.discover(key, component, async () => {}), /LOCAL_MCP_CONNECTION_FAILED/)
  const pid = Number(await fs.readFile(pidFile, 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('connector IPC rejects unavailable components and file paths cannot be provided by renderer', async (t) => {
  const { root } = await fixture(t)
  const handlers = new Map()
  let active = true
  let chosen = 0
  let dialogTitle = ''
  registerMarketplaceConnectorIpc({ handle: (name, handler) => handlers.set(name, handler) }, {
    assertTrustedSender: (event) => { if (!event?.trusted) throw new Error('UNTRUSTED') },
    withProject: async (project, action) => { if (project !== 'project-a') throw new Error('WRONG_PROJECT'); return action(root) },
    dialog: { showOpenDialog: async (_window, options) => { chosen++; dialogTitle = options.title; return { canceled: true, filePaths: [] } } },
    window: () => null, userDataDirectory: root,
    uiText: () => 'Select trusted server',
    service: { getInstalledComponent: async () => { if (!active) throw new Error('MARKETPLACE_COMPONENT_NOT_AVAILABLE'); return local } },
  })
  const invoke = (name, ...args) => handlers.get(`desktop:marketplace:connector:${name}`)({ trusted: true }, ...args)
  assert.equal(await invoke('choose', 'project-a', 'pack', 'component', '/bin/sh'), null)
  assert.equal(chosen, 1)
  assert.equal(dialogTitle, 'Select trusted server')
  active = false
  await assert.rejects(invoke('discover', 'project-a', 'pack', 'component'), /MARKETPLACE_COMPONENT_NOT_AVAILABLE/)
  await assert.rejects(invoke('get', 'wrong-project', 'pack', 'component'), /WRONG_PROJECT/)
  await assert.rejects(handlers.get('desktop:marketplace:connector:get')({ trusted: false }, 'project-a', 'pack', 'component'), /UNTRUSTED/)
})

test('configuration size check fails atomically instead of writing an unreadable store', async (t) => {
  const { root, key, component } = await fixture(t)
  const { executable } = await makeServer(root)
  const largeSchema = 'x'.repeat(32_000)
  const service = createMarketplaceConnectorService(root, { discover: async () => [{ name: 'large', description: '', schema: largeSchema }] })
  let full = false
  for (let index = 0; index < 40; index++) {
    const targetKey = keyFor('project-a', 'pack', `component-${index}`)
    try {
      await service.choose(targetKey, component, executable, async () => {})
      const discovered = await service.discover(targetKey, component, async () => {})
      await service.select(targetKey, component, discovered.token, 'large', async () => {})
    } catch (error) { assert.match(error.message, /LOCAL_MCP_CONFIG_FULL/); full = true; break }
  }
  assert.equal(full, true)
  assert.ok((await fs.stat(path.join(root, 'marketplace-connectors.json'))).size <= 1024 * 1024)
  assert.equal(await service.get(key, component), null)
})
