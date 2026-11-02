const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const args = process.argv.slice(2)
const executableArg = args.find((arg) => arg.startsWith('--executable='))
const appDirectoryArg = args.find((arg) => arg.startsWith('--app-dir='))
if (Boolean(executableArg) !== Boolean(appDirectoryArg)) {
  throw new Error('Both --executable and --app-dir are required when verifying an installed package.')
}
if (args.some((arg) => arg.startsWith('--') && arg !== executableArg && arg !== appDirectoryArg)
  || args.filter((arg) => !arg.startsWith('--')).length > 1
  || (executableArg && args.some((arg) => !arg.startsWith('--')))) {
  throw new Error('Usage: node verify-packaged.cjs [release-directory] | --executable=<path> --app-dir=<path>')
}
const root = path.resolve(args.find((arg) => !arg.startsWith('--')) || path.join(__dirname, '..', 'release'))
let executable
let appDirectory
if (executableArg && appDirectoryArg) {
  const executableValue = executableArg.slice('--executable='.length)
  const appDirectoryValue = appDirectoryArg.slice('--app-dir='.length)
  if (!executableValue || !appDirectoryValue) throw new Error('Executable and app directory paths must not be empty.')
  executable = path.resolve(executableValue)
  appDirectory = path.resolve(appDirectoryValue)
} else if (process.platform === 'win32') {
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
