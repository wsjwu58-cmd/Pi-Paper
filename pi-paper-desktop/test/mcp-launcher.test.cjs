const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { filterMcpEnvironment, parseMcpLauncherArgs, runMcpLauncher } = require('../src/mcp-launcher.cjs')
const { resolveAppDataPath } = require('../src/mcp-node-entry.cjs')

test('Node mode bridge resolves the same Electron appData directory without loading Electron', () => {
  const home = path.join('C:', 'Users', 'Test User')
  assert.equal(resolveAppDataPath({ APPDATA: path.join('C:', 'Users', 'Test User', 'Roaming') }, 'win32', home),
    path.join('C:', 'Users', 'Test User', 'Roaming'))
  assert.equal(resolveAppDataPath({}, 'win32', home), path.join(home, 'AppData', 'Roaming'))
  assert.equal(resolveAppDataPath({ XDG_CONFIG_HOME: path.join('home', 'test', '.config') }, 'linux', '/home/test'),
    path.join('/home/test', '.config'))
  assert.equal(resolveAppDataPath({}, 'darwin', '/Users/test'), path.join('/Users/test', 'Library', 'Application Support'))
})

test('launcher parses the development Electron entry and paths containing spaces without shell tokenization', () => {
  const sourceDirectory = path.join('E:', 'VibePaper Project', 'pi-paper-desktop', 'src')
  const mainFile = path.join(sourceDirectory, 'main.cjs')
  const instanceFile = path.join('C:', 'Users', 'Test User', 'AppData', 'Roaming', 'VibePaper', 'mcp-instance.json')
  const parsed = parseMcpLauncherArgs([
    path.join('C:', 'Program Files', 'Pi-Paper.exe'), mainFile, '--mcp-stdio',
    '--mcp-instance-file', instanceFile, '--mcp-client-id', '00000000-0000-4000-8000-000000000001',
    '--mcp-grant-id', '00000000-0000-4000-8000-000000000002',
  ], { sourceDirectory })
  assert.deepEqual(parsed, {
    entryFile: mainFile,
    instanceFilePath: instanceFile,
    clientId: '00000000-0000-4000-8000-000000000001',
    grantId: '00000000-0000-4000-8000-000000000002',
    authorizedEnvNames: [],
  })
})

test('launcher accepts the packaged Electron form with no main.cjs argument', () => {
  const parsed = parseMcpLauncherArgs([
    'Pi-Paper.exe', '--mcp-stdio', '--mcp-instance-file', path.join('C:', 'User Data', 'VibePaper', 'mcp-instance.json'),
    '--mcp-client-id', '00000000-0000-4000-8000-000000000001', '--mcp-grant-id', '00000000-0000-4000-8000-000000000002',
  ])
  assert.equal(parsed.entryFile, null)
})

test('launcher rejects arbitrary entry files, extra flags, duplicate flags, and instance paths outside fixed userData', async () => {
  const baseArgs = ['Pi-Paper.exe', '--mcp-stdio', '--mcp-instance-file', path.join('C:', 'Other Data', 'VibePaper', 'mcp-instance.json'),
    '--mcp-client-id', '00000000-0000-4000-8000-000000000001', '--mcp-grant-id', '00000000-0000-4000-8000-000000000002']
  assert.throws(() => parseMcpLauncherArgs([...baseArgs, '--unknown']))
  assert.throws(() => parseMcpLauncherArgs([...baseArgs, '--mcp-stdio']))
  assert.throws(() => parseMcpLauncherArgs([...baseArgs, '--mcp-env-name', 'bad-name']))
  assert.throws(() => parseMcpLauncherArgs([...baseArgs, '--mcp-env-name', 'API_KEY', '--mcp-env-name', 'api_key']))
  assert.throws(() => parseMcpLauncherArgs(['Pi-Paper.exe', path.join('C:', 'Temp', 'other-main.cjs'), ...baseArgs.slice(1)]))

  let diagnostic = ''
  let called = false
  const result = await runMcpLauncher({
    argv: baseArgs,
    appDataPath: path.join('C:', 'Data'),
    stderr: { write: (chunk) => { diagnostic += chunk } },
    bridgeRunner: async () => { called = true },
  })
  assert.equal(result, 1)
  assert.equal(called, false)
  assert.match(diagnostic, /launch configuration is invalid/u)
  assert.equal(diagnostic.includes('C:\\Data'), false)
})

test('launcher keeps only runtime and grant-listed environment values for the stdio bridge', async () => {
  const appDataPath = path.join('C:', 'User Data')
  const instanceFilePath = path.join(appDataPath, 'VibePaper', 'mcp-instance.json')
  const argv = ['Pi-Paper.exe', '--mcp-stdio', '--mcp-instance-file', instanceFilePath,
    '--mcp-client-id', '00000000-0000-4000-8000-000000000001', '--mcp-grant-id', '00000000-0000-4000-8000-000000000002',
    '--mcp-env-name', 'VIBEPAPER_TEST_KEY']
  const stdin = {}
  const stdout = {}
  const stderr = { write() {} }
  const env = { VIBEPAPER_TEST_KEY: 'registered-key', OTHER_API_KEY: 'unrelated-secret', APPDATA: 'safe-runtime-path' }
  let received
  const result = await runMcpLauncher({ argv, appDataPath, stdin, stdout, stderr, env,
    bridgeRunner: async (options) => { received = options } })
  assert.equal(result, 0)
  assert.equal(received.instanceFilePath, instanceFilePath)
  assert.equal(received.clientId, argv[5])
  assert.equal(received.grantId, argv[7])
  assert.equal(received.stdin, stdin)
  assert.equal(received.stdout, stdout)
  assert.notEqual(received.env, env)
  assert.deepEqual(received.env, { VIBEPAPER_TEST_KEY: 'registered-key', APPDATA: 'safe-runtime-path' })
  assert.equal(Object.hasOwn(received, 'credentialValues'), false)
  assert.equal(JSON.stringify(argv).includes('registered-key'), false)
})

test('environment filtering is case-insensitive and rejects arbitrary mapping values', () => {
  assert.deepEqual(filterMcpEnvironment({ Path: 'runtime', OPENAI_KEY: 'allowed', OTHER_KEY: 'no' }, ['openai_key']), {
    Path: 'runtime', OPENAI_KEY: 'allowed',
  })
})
