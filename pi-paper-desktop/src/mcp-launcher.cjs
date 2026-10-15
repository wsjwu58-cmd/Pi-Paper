'use strict'

const path = require('node:path')
const { runMcpStdioBridge } = require('./mcp-stdio.cjs')

const ID_RE = /^[A-Za-z0-9_-]{8,160}$/u
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u
const RUNTIME_ENV_NAMES = new Set([
  'appdata', 'localappdata', 'comspec', 'home', 'userprofile', 'path', 'pathext',
  'systemroot', 'windir', 'temp', 'tmp', 'tmpdir', 'display', 'wayland_display',
  'xdg_runtime_dir', 'dbus_session_bus_address', 'xauthority', 'lang', 'lc_all',
  'lc_ctype', 'tz',
])

function samePath(left, right) {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function parseMcpLauncherArgs(argv, { sourceDirectory = __dirname } = {}) {
  if (!Array.isArray(argv) || argv.length < 2 || typeof argv[0] !== 'string') {
    throw new Error('MCP_LAUNCH_CONFIGURATION_INVALID')
  }
  const args = argv.slice(1)
  let entryFile = null
  if (args[0] && !args[0].startsWith('--')) {
    entryFile = args.shift()
    if (!path.isAbsolute(entryFile) || !samePath(entryFile, path.join(sourceDirectory, 'main.cjs'))) {
      throw new Error('MCP_LAUNCH_CONFIGURATION_INVALID')
    }
  }

  const values = new Map()
  const envNames = new Map()
  let hasStdioFlag = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--mcp-stdio') {
      if (hasStdioFlag) throw new Error('MCP_LAUNCH_CONFIGURATION_INVALID')
      hasStdioFlag = true
      continue
    }
    if (arg === '--mcp-env-name') {
      const name = args[index + 1]
      if (index + 1 >= args.length || typeof name !== 'string' || name.startsWith('--') || !ENV_NAME_RE.test(name)) {
        throw new Error('MCP_LAUNCH_CONFIGURATION_INVALID')
      }
      const normalized = name.toLowerCase()
      if (envNames.has(normalized) || envNames.size >= 32) throw new Error('MCP_LAUNCH_CONFIGURATION_INVALID')
      envNames.set(normalized, name)
      index += 1
      continue
    }
    if (!['--mcp-instance-file', '--mcp-client-id', '--mcp-grant-id'].includes(arg)
      || values.has(arg) || index + 1 >= args.length || args[index + 1].startsWith('--')) {
      throw new Error('MCP_LAUNCH_CONFIGURATION_INVALID')
    }
    values.set(arg, args[index + 1])
    index += 1
  }

  const instanceFilePath = values.get('--mcp-instance-file')
  const clientId = values.get('--mcp-client-id')
  const grantId = values.get('--mcp-grant-id')
  if (!hasStdioFlag || typeof instanceFilePath !== 'string' || !path.isAbsolute(instanceFilePath)
    || typeof clientId !== 'string' || !ID_RE.test(clientId)
    || typeof grantId !== 'string' || !ID_RE.test(grantId)) {
    throw new Error('MCP_LAUNCH_CONFIGURATION_INVALID')
  }
  return { entryFile, instanceFilePath, clientId, grantId, authorizedEnvNames: [...envNames.values()] }
}

function filterMcpEnvironment(env, authorizedEnvNames) {
  if (!env || typeof env !== 'object' || Array.isArray(env) || !Array.isArray(authorizedEnvNames)) {
    throw new Error('MCP_LAUNCH_CONFIGURATION_INVALID')
  }
  const allow = new Set([...RUNTIME_ENV_NAMES, ...authorizedEnvNames.map((name) => name.toLowerCase())])
  const filtered = {}
  for (const name of Object.keys(env)) {
    if (allow.has(name.toLowerCase()) && typeof env[name] === 'string') filtered[name] = env[name]
  }
  return filtered
}

function fixedLaunchMessage(error) {
  if (error?.code === 'DESKTOP_NOT_RUNNING') return 'VibePaper desktop is not running.'
  if (error?.message === 'MCP_LAUNCH_CONFIGURATION_INVALID') return 'The VibePaper MCP launch configuration is invalid.'
  return 'The VibePaper MCP bridge could not start.'
}

async function runMcpLauncher(options = {}) {
  const {
    argv = process.argv,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    appDataPath,
    sourceDirectory = __dirname,
    bridgeRunner = runMcpStdioBridge,
  } = options

  try {
    const parsed = parseMcpLauncherArgs(argv, { sourceDirectory })
    if (typeof appDataPath !== 'string' || !path.isAbsolute(appDataPath)) {
      throw new Error('MCP_LAUNCH_CONFIGURATION_INVALID')
    }
    const expectedInstancePath = path.join(appDataPath, 'VibePaper', 'mcp-instance.json')
    if (!samePath(parsed.instanceFilePath, expectedInstancePath)) {
      throw new Error('MCP_LAUNCH_CONFIGURATION_INVALID')
    }
    const bridgeEnv = filterMcpEnvironment(env, parsed.authorizedEnvNames)
    await bridgeRunner({
      ...parsed,
      appDataPath,
      stdin,
      stdout,
      stderr,
      env: bridgeEnv,
    })
    return 0
  } catch (error) {
    try { stderr.write(`[vibepaper-mcp] ${fixedLaunchMessage(error)}\n`) } catch { /* never write diagnostics to stdout */ }
    return 1
  }
}

module.exports = { filterMcpEnvironment, parseMcpLauncherArgs, runMcpLauncher }
