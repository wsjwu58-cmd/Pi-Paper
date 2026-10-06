const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..', 'release')
let executable
let appDirectory
if (process.platform === 'win32') {
  executable = path.join(root, 'win-unpacked', 'Pi-Paper.exe')
  appDirectory = path.join(root, 'win-unpacked', 'resources', 'app')
} else if (process.platform === 'linux') {
  executable = path.join(root, 'linux-unpacked', 'pi-paper')
  appDirectory = path.join(root, 'linux-unpacked', 'resources', 'app')
} else if (process.platform === 'darwin') {
  const app = path.join(root, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Pi-Paper.app', 'Contents')
  executable = path.join(app, 'MacOS', 'Pi-Paper')
  appDirectory = path.join(app, 'Resources', 'app')
} else {
  throw new Error('Unsupported desktop package platform.')
}
fs.accessSync(executable)
for (const script of ['smoke-package.cjs', 'smoke-agent-worker.cjs']) {
  const result = spawnSync(executable, [path.join(__dirname, script), appDirectory], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
console.log('Packaged Electron runtime smoke checks passed.')
