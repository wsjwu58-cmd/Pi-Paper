'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

function resolveAppDataPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    const candidate = env.APPDATA
    return typeof candidate === 'string' && path.isAbsolute(candidate)
      ? candidate : path.join(home, 'AppData', 'Roaming')
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support')
  const candidate = env.XDG_CONFIG_HOME
  return typeof candidate === 'string' && path.isAbsolute(candidate) ? candidate : path.join(home, '.config')
}

function resolveLauncherPath() {
  const packaged = path.resolve(__dirname, '..', 'dist', 'mcp-launcher.cjs')
  if (fs.existsSync(packaged)) return packaged
  return path.join(__dirname, 'mcp-launcher.cjs')
}

async function main() {
  const { runMcpLauncher } = require(resolveLauncherPath())
  const args = [process.execPath, path.join(__dirname, 'main.cjs'), ...process.argv.slice(2)]
  const code = await runMcpLauncher({ argv: args, stdin: process.stdin, stdout: process.stdout,
    stderr: process.stderr, env: process.env, appDataPath: resolveAppDataPath(), sourceDirectory: __dirname })
  process.exitCode = Number.isInteger(code) ? code : 1
}

if (require.main === module) {
  void main().catch(() => {
    try { process.stderr.write('VibePaper MCP bridge startup failed.\n') } catch {}
    process.exitCode = 1
  })
}

module.exports = { main, resolveAppDataPath, resolveLauncherPath }
